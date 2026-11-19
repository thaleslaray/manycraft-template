import { test, expect } from "./fixtures"
import { ENGINE, FOTO_PNG, WORKSPACE, api, consulta, novoTag, sql } from "./helpers"
import { subirZapiFalso, type ZapiFalso } from "./zapi-falso"

/** O D1 local é lido pelo wrangler, que às vezes falha enquanto o engine escreve: dentro de um poll, falhar é só "ainda não". */
function tentar<T>(comando: string): T[] {
  try { return consulta<T>(comando) } catch { return [] }
}

type Catalogo = { development?: { providerApiBase: string } }

/** SQL das sobras desta jornada: a conexão do canal falso, o contato que ela "trouxe" e a automação e2e-. */
function limpeza(instancia: string, tag: string): string[] {
  const w = `workspace_id='${WORKSPACE}'`
  const canais = `SELECT id FROM channels WHERE ${w} AND (external_id='zapi:${instancia}' OR external_id LIKE 'archived:%:zapi:${instancia}')`
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
    `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('e2e-auto-${tag}',${w},'e2e zapi ${tag}','${grafo}')`,
    `INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('e2e-ver-${tag}',${w},'e2e-auto-${tag}',1,'${grafo}')`,
    `UPDATE automations SET published_version_id='e2e-ver-${tag}',status='live',has_unpublished_changes=0 WHERE id='e2e-auto-${tag}'`,
    // A conexão é vinculada assim que a jornada a cria.
    `INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES ('e2e-trg-${tag}',${w},'e2e-auto-${tag}',NULL,'e2e quero','keyword','active','every_time','{"node_id":"trigger"}')`,
    `INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES ('e2e-kw-${tag}',${w},'e2e-trg-${tag}','is','["quero-${tag}"]','live',0)`,
  ]
}

test.describe("WhatsApp não oficial (Z-API clássica)", () => {
  test("parear por QR, receber 'quero', responder pela Z-API, ver o recibo, assumir pelo celular, responder da caixa de entrada e arquivar", async ({ page }) => {
    const catalogo = await api<Catalogo>("/api/connections/catalog")
    test.skip(!catalogo.development, "O engine precisa de DEV_PROVIDER_API_BASE (veja engine/.dev.vars.example) para falar com uma Z-API falsa.")
    const t = novoTag(), instancia = `E2E${t.toUpperCase()}`.padEnd(32, "0"), token = `TOK${t.toUpperCase()}`.padEnd(24, "0"), clientToken = `E2E-client-${t}`
    const contato = `55119${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`
    const resposta = `Resposta e2e ${t}`, nome = `E2e${t}`
    let falso: ZapiFalso | undefined
    try {
      falso = await subirZapiFalso(Number(new URL(catalogo.development!.providerApiBase).port), { instancia, token, clientToken, qr: FOTO_PNG, engine: ENGINE })
      sql(automacaoSql(t, resposta))
      const agora = () => Date.now() - 1000
      /** Um ReceivedCallback (docs-zapi: webhooks/on-message-received-examples). */
      const mensagem = (id: string, texto: string, extra: { fromMe?: boolean; fromApi?: boolean } = {}) => ({
        isStatusReply: false, connectedPhone: "5511900000000", waitingMessage: false, isEdit: false, isGroup: false, isNewsletter: false, instanceId: instancia,
        messageId: id.padEnd(32, "0"), phone: contato, fromMe: !!extra.fromMe, momment: agora(), status: extra.fromMe ? "SENT" : "RECEIVED", chatName: nome,
        senderName: extra.fromMe ? "5511900000000" : nome, broadcast: false, type: "ReceivedCallback", ...(extra.fromApi === undefined ? {} : { fromApi: extra.fromApi }), text: { message: texto } })
      const status = (estado: string, id: string) => ({ instanceId: instancia, status: estado, ids: [id], momment: agora(), phoneDevice: 0, phone: contato, type: "MessageStatusCallback", isGroup: false })

      // 1. Conectar: canal, provedor, aviso de bloqueio, token e Client-Token escondidos.
      await page.goto(`/${WORKSPACE}/settings/channels`)
      await page.getByRole("button", { name: "Conectar canal" }).first().click()
      const dialogo = page.getByRole("dialog", { name: "Conectar canal" })
      await dialogo.getByRole("radio", { name: "WhatsApp", exact: true }).check()
      await dialogo.getByRole("radio", { name: /Z-API/ }).check()
      await expect(dialogo.getByText(/WhatsApp pode bloquear o número/)).toBeVisible()
      await expect(dialogo.getByLabel("Token da instância", { exact: true })).toHaveAttribute("type", "password")
      await expect(dialogo.getByLabel(/Client-Token/)).toHaveAttribute("type", "password")
      await dialogo.getByLabel("ID da instância").fill(instancia)
      await dialogo.getByLabel("Token da instância", { exact: true }).fill(token)
      await dialogo.getByLabel(/Client-Token/).fill(clientToken)
      await dialogo.getByLabel(/Nome na lista/).fill(`Loja zapi ${t}`)
      await dialogo.getByRole("button", { name: "Conectar" }).click()

      // 2. QR aparece; ler o QR (pelo servidor falso) fecha a janela sozinha.
      const qr = page.getByRole("dialog", { name: "Conectar o WhatsApp" })
      await expect(qr.getByRole("img", { name: /QR code/ })).toBeVisible()
      await page.screenshot({ path: test.info().outputPath("zapi-qr.png") })
      expect(falso.webhook()).toMatch(/\/api\/hooks\/[0-9a-f-]{36}\?k=[A-Za-z0-9_-]{20,}$/)
      for (const evento of ["received", "delivery", "message-status", "connected", "disconnected"]) expect(falso.chamadas.some(c => c.rota === `/update-webhook-${evento}`)).toBe(true)
      expect(falso.notificaEnviadasPorMim()).toBe(true)
      falso.parear()
      await expect(qr.getByText(/Número conectado/)).toBeVisible({ timeout: 15_000 })
      await qr.getByRole("button", { name: "Concluir" }).click()
      const cartao = page.getByRole("listitem").filter({ hasText: `Loja zapi ${t}` })
      await expect(cartao.getByText("Conectada", { exact: true })).toBeVisible()
      const segredoDoHook = new URL(falso.webhook()!).searchParams.get("k")!
      for (const escondido of [token, clientToken, segredoDoHook]) {
        expect(await page.content()).not.toContain(escondido)
        expect(JSON.stringify(await api("/api/connections"))).not.toContain(escondido)
      }
      const conexaoId = new URL(falso.webhook()!).pathname.split("/").pop()!
      sql([`UPDATE triggers SET channel_id='${conexaoId}' WHERE workspace_id='${WORKSPACE}' AND id='e2e-trg-${t}'`])

      // 3. Webhook sem o segredo ou com outro é recusado; com o certo, "quero" dispara a automação.
      expect((await falso.emitir(mensagem("IN1", `quero-${t}`), { segredo: "outro" })).status).toBe(401)
      expect((await falso.emitir(mensagem("IN1", `quero-${t}`), { segredo: null })).status).toBe(401)
      expect((await falso.emitir(mensagem("IN1", `quero-${t}`))).status).toBe(200)
      await expect.poll(() => falso!.enviadas().map(m => `${m.telefone}|${m.rota}|${m.corpo.message}`), { timeout: 30_000 }).toContain(`${contato}|/send-text|${resposta}`)
      expect(consulta<{ n: number }>(`SELECT count(*) n FROM contact_channels WHERE channel_id='${conexaoId}' AND external_user_id='${contato}' AND address_kind='wa_pn' AND identity_kind='provider_id'`)[0].n).toBe(1)
      expect((await falso.emitir(mensagem("IN2", `quero-${t}`))).status).toBe(200)
      await expect.poll(() => tentar<{ n: number }>(`SELECT count(*) n FROM messages WHERE connection_id='${conexaoId}' AND source='contact'`)[0]?.n, { timeout: 20_000 }).toBe(2)

      // 4. Recibo: a Z-API avisa que a resposta foi lida; o estado da mensagem na conversa muda.
      const idEnviado = `E2EOUT1`.padEnd(32, "0")
      expect((await falso.emitir(mensagem(idEnviado, resposta, { fromMe: true, fromApi: true }))).status).toBe(200)   // eco do envio: não entra
      expect((await falso.emitir(status("READ", idEnviado))).status).toBe(200)
      await expect.poll(() => tentar<{ s: string }>(`SELECT delivery_status s FROM messages WHERE connection_id='${conexaoId}' AND source='automation'`)[0]?.s, { timeout: 20_000 }).toBe("read")

      // 5. Na caixa de entrada: a conversa com a mensagem e a resposta.
      await page.goto(`/${WORKSPACE}/inbox`)
      await page.getByRole("textbox", { name: /Buscar conversa/ }).fill(nome)
      const conversa = page.getByRole("button", { name: new RegExp(`${nome}.*WhatsApp`) })
      await expect(conversa).toBeVisible()
      await conversa.click()
      const historico = page.getByRole("log", { name: "Histórico da conversa" })
      await expect(historico.getByText(`quero-${t}`, { exact: true })).toHaveCount(2)   // IN1 e IN2 têm o mesmo texto de propósito
      await expect(historico.getByText(resposta)).toHaveCount(2)   // cada "quero" (IN1 e IN2) dispara a automação
      await page.screenshot({ path: test.info().outputPath("zapi-inbox.png") })

      // 6. Assumir pelo celular: o dono responde do aparelho; entra como resposta humana, pausa a automação e não dispara gatilho.
      const antes = falso.enviadas().length
      expect((await falso.emitir(mensagem("OWN1", "Já te respondo por aqui", { fromMe: true, fromApi: false }))).status).toBe(200)
      await expect(historico.getByText("Já te respondo por aqui")).toBeVisible({ timeout: 20_000 })
      expect(consulta<{ p: number }>(`SELECT automation_paused_until p FROM contacts WHERE id IN (SELECT contact_id FROM contact_channels WHERE channel_id='${conexaoId}')`)[0].p).toBeGreaterThan(Date.now())
      expect((await falso.emitir(mensagem("IN3", `quero-${t}`))).status).toBe(200)
      await expect.poll(() => tentar<{ n: number }>(`SELECT count(*) n FROM messages WHERE connection_id='${conexaoId}' AND source='contact'`)[0]?.n, { timeout: 20_000 }).toBe(3)
      expect(falso.enviadas().length).toBe(antes)

      // 7. Resposta pela caixa de entrada sai pela Z-API.
      await page.getByRole("textbox", { name: "Sua resposta" }).fill(`Pelo painel ${t}`)
      await page.getByRole("button", { name: "Enviar pelo WhatsApp" }).click()
      await expect.poll(() => falso!.enviadas().map(m => m.corpo.message), { timeout: 20_000 }).toContain(`Pelo painel ${t}`)

      // 8. As opções da UAZAPI não existem aqui.
      await page.goto(`/${WORKSPACE}/settings/channels`)
      await expect(page.getByRole("listitem").filter({ hasText: `Loja zapi ${t}` }).getByRole("button", { name: "Opções" })).toHaveCount(0)

      // 9. Arquivar: sai da lista, o número continua pareado na Z-API (nada é desfeito lá), as entregas deixam de ser aceitas e os contatos ficam.
      const contatos = consulta<{ n: number }>(`SELECT count(*) n FROM contact_channels WHERE channel_id='${conexaoId}'`)[0].n
      const urlDoWebhook = falso.webhook()!
      const chamadasAntes = falso.chamadas.length
      await page.getByRole("listitem").filter({ hasText: `Loja zapi ${t}` }).getByRole("button", { name: "Arquivar" }).click()
      await page.getByRole("dialog", { name: "Arquivar conexão" }).getByRole("button", { name: "Arquivar" }).click()
      await expect(page.getByText("Conexão arquivada.")).toBeVisible()
      expect(falso.chamadas.length).toBe(chamadasAntes)
      expect((await falso.emitir(mensagem("IN9", `quero-${t}`))).status).toBe(404)
      expect(urlDoWebhook).toContain("/api/hooks/")
      expect(consulta<{ n: number }>(`SELECT count(*) n FROM contact_channels WHERE channel_id='${conexaoId}'`)[0].n).toBe(contatos)
    } finally {
      await falso?.fechar()
      sql(limpeza(instancia, t))
    }
  })
})
