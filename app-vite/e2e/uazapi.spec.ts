import { test, expect } from "./fixtures"
import { ENGINE, FOTO_PNG, WORKSPACE, api, consulta, novoTag, sql } from "./helpers"
import { subirUazapiFalso, type UazapiFalso } from "./uazapi-falso"

type Catalogo = { development?: { providerApiBase: string } }

/** SQL das sobras desta jornada: a conexão da instância falsa, o contato que ela "trouxe" e a automação e2e-. */
function limpeza(instancia: string, tag: string): string[] {
  const w = `workspace_id='${WORKSPACE}'`
  const canais = `SELECT id FROM channels WHERE ${w} AND (external_id='uazapi:${instancia}' OR external_id LIKE 'archived:%:uazapi:${instancia}')`
  return [
    `DELETE FROM contacts WHERE ${w} AND id IN (SELECT contact_id FROM contact_channels WHERE ${w} AND channel_id IN (${canais}))`,
    `DELETE FROM inbound_events WHERE ${w} AND channel_id IN (${canais})`,
    `DELETE FROM channels WHERE ${w} AND id IN (${canais})`,
    `DELETE FROM keywords WHERE ${w} AND id='e2e-kw-${tag}'`,
    `DELETE FROM triggers WHERE ${w} AND id='e2e-trg-${tag}'`,
    `DELETE FROM automation_versions WHERE ${w} AND automation_id='e2e-auto-${tag}'`,
    `DELETE FROM automations WHERE ${w} AND id='e2e-auto-${tag}'`,
  ]
}

function automacaoSql(tag: string, resposta: string): string[] {
  const grafo = JSON.stringify({ nodes: [
    { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, config: {} },
    { id: "hello", type: "message", position: { x: 300, y: 0 }, config: { blocks: [{ kind: "text", text: resposta }] } },
  ], edges: [{ from: "trigger", port: "next", to: "hello" }] }).replaceAll("'", "''")
  const w = `'${WORKSPACE}'`
  return [
    `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('e2e-auto-${tag}',${w},'e2e uazapi ${tag}','${grafo}')`,
    `INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('e2e-ver-${tag}',${w},'e2e-auto-${tag}',1,'${grafo}')`,
    `UPDATE automations SET published_version_id='e2e-ver-${tag}',status='live',has_unpublished_changes=0 WHERE id='e2e-auto-${tag}'`,
    // A conexão é vinculada assim que a jornada a cria.
    `INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES ('e2e-trg-${tag}',${w},'e2e-auto-${tag}',NULL,'e2e quero','keyword','active','every_time','{"node_id":"trigger"}')`,
    `INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES ('e2e-kw-${tag}',${w},'e2e-trg-${tag}','is','["quero-${tag}"]','live',0)`,
  ]
}

test.describe("WhatsApp não oficial (UAZAPI)", () => {
  test("parear por QR, receber 'quero', responder pela UAZAPI, assumir pelo celular, ajustar opções e ver tudo na caixa de entrada", async ({ page }) => {
    const catalogo = await api<Catalogo>("/api/connections/catalog")
    test.skip(!catalogo.development, "O engine precisa de DEV_PROVIDER_API_BASE (veja engine/.dev.vars.example) para falar com uma UAZAPI falsa.")
    const t = novoTag(), instancia = `e2e${t}`, token = `E2E-token-${t}`, dono = "5511900000000"
    const contato = `55119${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, jid = `${contato}@s.whatsapp.net`
    const resposta = `Resposta e2e ${t}`, nome = `E2e${t}`
    let falso: UazapiFalso | undefined
    try {
      falso = await subirUazapiFalso(Number(new URL(catalogo.development!.providerApiBase).port), { token, instanciaId: instancia, dono, qr: FOTO_PNG, engine: ENGINE })
      sql(automacaoSql(t, resposta))
      const mensagem = (id: string, texto: string, extra: Record<string, unknown> = {}) => ({ EventType: "messages",
        message: { id: `${dono}:${id}`, messageid: id, chatid: jid, sender: jid, senderName: nome, fromMe: false, isGroup: false, messageType: "Conversation", text: texto, messageTimestamp: Date.now(), ...extra } })

      // 1. Conectar: canal, depois provedor (o WhatsApp tem dois), aviso de bloqueio e credenciais.
      await page.goto(`/${WORKSPACE}/settings/channels`)
      await page.getByRole("button", { name: "Conectar canal" }).first().click()
      const dialogo = page.getByRole("dialog", { name: "Conectar canal" })
      await dialogo.getByRole("radio", { name: "WhatsApp", exact: true }).check()
      await dialogo.getByRole("radio", { name: /UAZAPI/ }).check()
      await expect(dialogo.getByText(/WhatsApp pode bloquear o número/)).toBeVisible()
      await expect(dialogo.getByLabel("Token da instância")).toHaveAttribute("type", "password")
      await dialogo.getByLabel("Endereço do servidor").fill(`https://${instancia}.uazapi.test`)
      await dialogo.getByLabel("Token da instância").fill(token)
      await dialogo.getByLabel(/Nome na lista/).fill(`Loja e2e ${t}`)
      await dialogo.getByRole("button", { name: "Conectar" }).click()

      // 2. QR: aparece, ainda não está conectada; ler o QR (pelo servidor falso) fecha a janela sozinha.
      const qr = page.getByRole("dialog", { name: "Conectar o WhatsApp" })
      await expect(qr.getByRole("img", { name: /QR code/ })).toBeVisible()
      await page.screenshot({ path: test.info().outputPath("uazapi-qr.png") })
      expect(falso.webhook()).toMatchObject({ enabled: true, excludeMessages: ["wasSentByApi"] })
      expect(falso.webhook()!.url).toMatch(/\/api\/hooks\/[0-9a-f-]{36}$/)
      falso.parear(`Loja da ${t}`)
      await expect(qr.getByText(/Número conectado/)).toBeVisible({ timeout: 15_000 })
      await qr.getByRole("button", { name: "Concluir" }).click()
      const cartao = page.getByRole("listitem").filter({ hasText: `Loja e2e ${t}` })
      await expect(cartao.getByText("Conectada", { exact: true })).toBeVisible()
      expect(await page.content()).not.toContain(token)
      expect(JSON.stringify(await api("/api/connections"))).not.toContain(token)
      const conexaoId = falso.webhook()!.url.split("/").pop()!
      sql([`UPDATE triggers SET channel_id='${conexaoId}' WHERE workspace_id='${WORKSPACE}' AND id='e2e-trg-${t}'`])

      // 3. Webhook sem o token da instância é recusado; com ele, "quero" dispara a automação e a resposta sai pela UAZAPI.
      expect((await falso.emitir(mensagem("IN-1", `quero-${t}`), { token: "outro-token" })).status).toBe(401)
      expect((await falso.emitir(mensagem("IN-1", `quero-${t}`))).status).toBe(200)
      await expect.poll(() => falso!.enviadas().map(m => `${m.number}|${m.text}`), { timeout: 30_000 }).toContain(`${jid}|${resposta}`)
      expect(consulta<{ n: number }>(`SELECT count(*) n FROM contact_channels WHERE channel_id='${conexaoId}' AND external_user_id='${jid}' AND address_kind='wa_pn' AND identity_kind='provider_id'`)[0].n).toBe(1)

      // 4. Na caixa de entrada: a conversa do WhatsApp, com a mensagem do contato e a resposta da automação.
      await page.goto(`/${WORKSPACE}/inbox`)
      await page.getByRole("textbox", { name: /Buscar conversa/ }).fill(nome)
      const conversa = page.getByRole("button", { name: new RegExp(`${nome}.*WhatsApp`) })
      await expect(conversa).toBeVisible()
      await conversa.click()
      const historico = page.getByRole("log", { name: "Histórico da conversa" })
      await expect(historico.getByText(`quero-${t}`, { exact: true })).toBeVisible()
      await expect(historico.getByText(resposta)).toBeVisible()
      await page.screenshot({ path: test.info().outputPath("uazapi-inbox.png") })

      // 5. Assumir pelo celular: o dono responde do próprio aparelho; entra como resposta humana, pausa a automação e não dispara gatilho.
      const antes = falso.enviadas().length
      expect((await falso.emitir(mensagem("OWN-1", "Já te respondo por aqui", { fromMe: true, wasSentByApi: false }))).status).toBe(200)
      await expect(historico.getByText("Já te respondo por aqui")).toBeVisible({ timeout: 20_000 })
      expect(consulta<{ n: number }>(`SELECT count(*) n FROM messages WHERE connection_id='${conexaoId}' AND source='contact'`)[0].n).toBe(1)
      expect(consulta<{ p: number }>(`SELECT automation_paused_until p FROM contacts WHERE id IN (SELECT contact_id FROM contact_channels WHERE channel_id='${conexaoId}')`)[0].p).toBeGreaterThan(Date.now())
      // Com a automação pausada, outro "quero" entra na conversa mas não é respondido.
      expect((await falso.emitir(mensagem("IN-2", `quero-${t}`))).status).toBe(200)
      await expect.poll(() => consulta<{ n: number }>(`SELECT count(*) n FROM messages WHERE connection_id='${conexaoId}' AND source='contact'`)[0].n, { timeout: 20_000 }).toBe(2)
      expect(falso.enviadas().length).toBe(antes)
      // O evento só termina quando o motor o marca como processado; se a fila o repetir, a repetição roda antes de as opções mudarem (e não a leitura da IN-2 depois delas).
      await expect.poll(() => consulta<{ n: number }>(`SELECT count(*) n FROM inbound_events WHERE channel_id='${conexaoId}' AND processed_at IS NULL`)[0].n, { timeout: 30_000 }).toBe(0)

      // 6. Resposta pela caixa de entrada sai pela UAZAPI.
      await page.getByRole("textbox", { name: "Sua resposta" }).fill(`Pelo painel ${t}`)
      await page.getByRole("button", { name: "Enviar pelo WhatsApp" }).click()
      await expect.poll(() => falso!.enviadas().map(m => m.text), { timeout: 20_000 }).toContain(`Pelo painel ${t}`)

      // 7. Opções da conexão (padrão desligado): ligar "marcar como lida" e ver a chamada chegar na instância.
      await page.goto(`/${WORKSPACE}/settings/channels`)
      await page.getByRole("listitem").filter({ hasText: `Loja e2e ${t}` }).getByRole("button", { name: "Opções" }).click()
      const opcoes = page.getByRole("dialog", { name: "Opções da conexão" })
      for (const rotulo of [/digitando/, /Marcar como lida/, /Recusar ligações/]) await expect(opcoes.getByRole("switch", { name: rotulo })).not.toBeChecked()
      await opcoes.getByRole("switch", { name: /Marcar como lida/ }).click()
      await page.screenshot({ path: test.info().outputPath("uazapi-opcoes.png") })
      await opcoes.getByRole("button", { name: "Salvar" }).click()
      await expect(page.getByText("Opções salvas.")).toBeVisible()
      expect((await falso.emitir(mensagem("IN-3", "oi"))).status).toBe(200)
      await expect.poll(() => falso!.chamadas.filter(c => c.caminho === "/message/markread").map(c => c.corpo), { timeout: 20_000 }).toEqual([{ id: ["IN-3"] }])
      // O WhatsApp oficial não mostra estas opções.
      await page.getByRole("button", { name: "Conectar canal" }).first().click()
      await page.getByRole("dialog", { name: "Conectar canal" }).getByRole("button", { name: "Cancelar" }).click()

      // 8. Arquivar: sai da lista, o webhook é desligado na instância, as entregas deixam de ser aceitas e os contatos ficam.
      const contatos = consulta<{ n: number }>(`SELECT count(*) n FROM contact_channels WHERE channel_id='${conexaoId}'`)[0].n
      await page.getByRole("listitem").filter({ hasText: `Loja e2e ${t}` }).getByRole("button", { name: "Arquivar" }).click()
      await page.getByRole("dialog", { name: "Arquivar conexão" }).getByRole("button", { name: "Arquivar" }).click()
      await expect(page.getByText("Conexão arquivada.")).toBeVisible()
      expect(falso.chamadas.filter(c => c.caminho === "/webhook").at(-1)!.corpo).toMatchObject({ enabled: false })
      expect(consulta<{ n: number }>(`SELECT count(*) n FROM contact_channels WHERE channel_id='${conexaoId}'`)[0].n).toBe(contatos)
    } finally {
      await falso?.fechar()
      sql(limpeza(instancia, t))
    }
  })
})
