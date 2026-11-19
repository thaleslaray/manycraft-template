import { test, expect } from "./fixtures"
import { ENGINE, FOTO_PNG, WORKSPACE, api, consulta, escolher, escolherAutomacao, novoTag, sql } from "./helpers"
import { subirUazapiFalso, type UazapiFalso } from "./uazapi-falso"

type Catalogo = { development?: { providerApiBase: string } }
type Conexao = { connection: { id: string } }
/** Contagem que tolera o banco ocupado (o servidor de desenvolvimento escreve ao mesmo tempo): na dúvida, ainda não chegou. */
const contar = (comando: string) => { try { return consulta<{ n: number }>(comando)[0].n } catch { return -1 } }

/** Sobras desta jornada: a conexão da instância falsa, o que ela trouxe (contatos, grupos, execuções) e a automação e2e-. */
function limpeza(instancia: string, tag: string): string[] {
  const w = `workspace_id='${WORKSPACE}'`
  const canais = `SELECT id FROM channels WHERE ${w} AND (external_id='uazapi:${instancia}' OR external_id LIKE 'archived:%:uazapi:${instancia}')`
  return [
    `DELETE FROM flow_runs WHERE ${w} AND channel_id IN (${canais})`,
    `DELETE FROM contacts WHERE ${w} AND id IN (SELECT contact_id FROM contact_channels WHERE ${w} AND channel_id IN (${canais}))`,
    `DELETE FROM inbound_events WHERE ${w} AND channel_id IN (${canais})`,
    `DELETE FROM keywords WHERE ${w} AND trigger_id IN (SELECT id FROM triggers WHERE ${w} AND automation_id='e2e-auto-${tag}')`,
    `DELETE FROM triggers WHERE ${w} AND automation_id='e2e-auto-${tag}'`,
    `DELETE FROM channels WHERE ${w} AND id IN (${canais})`,
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
    `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('e2e-auto-${tag}',${w},'e2e grupo ${tag}','${grafo}')`,
    `INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('e2e-ver-${tag}',${w},'e2e-auto-${tag}',1,'${grafo}')`,
    `UPDATE automations SET published_version_id='e2e-ver-${tag}',status='live',has_unpublished_changes=0 WHERE id='e2e-auto-${tag}'`,
  ]
}

test.describe("Grupos de WhatsApp (UAZAPI)", () => {
  test("escolher o grupo, responder só a menção, mudar para palavra, resposta no grupo sem abrir conversa privada", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "A jornada do painel de regras roda no desktop.")
    const catalogo = await api<Catalogo>("/api/connections/catalog")
    test.skip(!catalogo.development, "O engine precisa de DEV_PROVIDER_API_BASE para falar com uma UAZAPI falsa.")
    const t = novoTag(), instancia = `e2eg${t}`, token = `E2E-token-${t}`, dono = "5511900000000"
    const autor = `55119${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, jidAutor = `${autor}@s.whatsapp.net`
    const grupo = `1203630${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}@g.us`, outroGrupo = "120363999999999999@g.us"
    const nomeGrupo = `Clube e2e ${t}`, nomeAutor = `Autor${t}`, resposta = `Oi, grupo ${t}`
    let falso: UazapiFalso | undefined
    try {
      falso = await subirUazapiFalso(Number(new URL(catalogo.development!.providerApiBase).port), { token, instanciaId: instancia, dono, qr: FOTO_PNG, engine: ENGINE,
        grupos: [{ JID: grupo, Name: nomeGrupo }, { JID: outroGrupo, Name: `Outro grupo e2e ${t}` }] })
      sql(automacaoSql(t, resposta))
      const mensagem = (id: string, texto: string, extra: Record<string, unknown> = {}, chat = grupo) => ({ EventType: "messages",
        message: { id: `${dono}:${id}`, messageid: id, chatid: chat, sender: jidAutor, senderName: nomeAutor, fromMe: false, isGroup: true, groupName: nomeGrupo,
          messageType: "ExtendedTextMessage", text: texto, messageTimestamp: Date.now(), ...extra } })
      // Formato de menção SUPOSTO (a doc da UAZAPI não descreve): contextInfo.mentionedJID. Confirmar com um grupo de teste real.
      const mencao = (id: string, texto: string) => mensagem(id, texto, { content: { text: texto, contextInfo: { mentionedJID: [`${dono}@s.whatsapp.net`] } } })

      // 1. Conexão pareada (pela API, para a jornada focar no que é novo).
      const { connection } = await api<Conexao>("/api/connections", { method: "POST", body: JSON.stringify({ kind: "whatsapp", provider: "uazapi", displayName: `Loja grupos ${t}`,
        credentials: { serverUrl: `https://${instancia}.uazapi.test`, token } }) })
      falso.parear(`Loja ${t}`)
      await api(`/api/connections/${connection.id}/connect`, { method: "POST" })
      expect(consulta<{ s: string }>(`SELECT connection_state s FROM channels WHERE id='${connection.id}'`)[0].s).toBe("connected")

      // 2. Regra de grupo "só quando mencionado", num grupo escolhido da lista da conexão.
      await page.goto(`/${WORKSPACE}/automations/keywords`)
      await page.getByRole("button", { name: "Criar palavra-chave" }).first().click()
      const painel = page.getByRole("dialog")
      await painel.getByLabel("Nome da palavra-chave").fill(`Grupo e2e ${t}`)
      await escolher(page, "Canal da mensagem", "WhatsApp", painel)
      await escolher(page, "Onde vale", "Grupo da conexão", painel)
      await escolher(page, "Conexão do grupo", new RegExp(`^Loja grupos ${t}`), painel)
      await escolher(page, "Quando responder", "Só quando mencionarem o número", painel)
      await escolher(page, "Grupo", nomeGrupo, painel)
      await escolherAutomacao(page, painel, `e2e grupo ${t}`, "Automação de resposta")
      await page.screenshot({ path: info.outputPath("grupo-regra-mencao.png") })
      await painel.getByRole("button", { name: "Salvar palavra-chave" }).click()
      await expect(page.getByRole("status").filter({ hasText: "Palavra-chave salva." })).toBeAttached()
      await expect(page.getByText("Grupo · Só quando mencionarem o número")).toBeVisible()
      await expect(page.getByText("Qualquer mensagem que mencione o número.")).toBeVisible()

      // 3. Sem menção não responde (mesmo com a palavra); com menção responde NO GRUPO, marcando o autor.
      expect((await falso.emitir(mensagem("G-1", "quero o guia"))).status).toBe(200)
      expect((await falso.emitir(mencao("G-2", `@${dono} quero o guia`))).status).toBe(200)
      await expect.poll(() => falso!.enviadas().map(m => `${m.number}|${m.text}`), { timeout: 30_000 }).toEqual([`${grupo}|${resposta}`])
      expect(falso.enviadas()[0].corpo).toMatchObject({ mentions: autor, track_source: "replica" })
      // A regra vale só para o grupo escolhido: outro grupo, mesmo com menção, não responde.
      expect((await falso.emitir(mensagem("G-4", `@${dono} oi`, { content: { text: "oi", contextInfo: { mentionedJID: [`${dono}@s.whatsapp.net`] } } }, outroGrupo))).status).toBe(200)
      await expect.poll(() => contar(`SELECT count(*) n FROM group_messages WHERE external_message_id='G-4'`), { timeout: 20_000 }).toBe(1)
      expect(falso.enviadas()).toHaveLength(1)

      // 4. O autor virou contato; nenhuma conversa privada, nenhuma mensagem de DM, nenhum consentimento.
      expect(consulta<{ n: number }>(`SELECT count(*) n FROM contact_channels WHERE channel_id='${connection.id}' AND external_user_id='${jidAutor}' AND opted_in=0 AND first_inbound_id IS NULL`)[0].n).toBe(1)
      expect(consulta<{ n: number }>(`SELECT count(*) n FROM conversations WHERE contact_channel_id IN (SELECT id FROM contact_channels WHERE channel_id='${connection.id}')`)[0].n).toBe(0)
      expect(consulta<{ n: number }>(`SELECT count(*) n FROM messages WHERE connection_id='${connection.id}'`)[0].n).toBe(0)
      expect(consulta<{ d: string }>(`SELECT direction d FROM group_messages WHERE group_thread_id IN (SELECT id FROM group_threads WHERE channel_id='${connection.id}') ORDER BY created_at`).map(r => r.d)).toContain("out")
      await page.goto(`/${WORKSPACE}/contacts`)
      await page.getByRole("searchbox").or(page.getByRole("textbox", { name: /Buscar/ })).first().fill(nomeAutor)
      await expect(page.getByText(nomeAutor).first()).toBeVisible()
      await page.screenshot({ path: info.outputPath("grupo-contato.png") })
      await page.goto(`/${WORKSPACE}/inbox`)
      await page.getByRole("textbox", { name: /Buscar conversa/ }).fill(nomeAutor)
      await expect(page.getByRole("button", { name: new RegExp(nomeAutor) })).toHaveCount(0)

      // 5. Mudar a regra para o modo palavra, em todos os grupos: responde pela palavra sem menção.
      await page.goto(`/${WORKSPACE}/automations/keywords`)
      await page.getByRole("button", { name: new RegExp(`Mais ações de Grupo e2e ${t}`) }).click()
      await page.getByRole("menuitem", { name: "Editar", exact: true }).click()
      const edicao = page.getByRole("dialog")
      await expect(edicao.getByRole("combobox", { name: "Conexão do grupo", exact: true })).toContainText(`Loja grupos ${t}`)
      await expect(edicao.getByRole("button", { name: "Automação de resposta", exact: true })).toContainText(`e2e grupo ${t}`)
      await escolher(page, "Quando responder", "Quando a mensagem tiver a palavra", edicao)
      await escolher(page, "Grupo", "Todos os grupos da conexão", edicao)
      await expect(edicao.getByRole("button", { name: "Adicionar condição com “e”" })).toBeVisible()
      await edicao.getByLabel("Nova palavra: Palavras da condição 1").fill("guia")
      await edicao.getByLabel("Nova palavra: Palavras da condição 1").press("Enter")
      await page.screenshot({ path: info.outputPath("grupo-regra-palavra.png") })
      await edicao.getByRole("button", { name: "Salvar palavra-chave" }).click()
      await expect(page.getByText("Grupo · Quando a mensagem tiver a palavra")).toBeVisible()
      const enviadasAntes = falso.enviadas().length
      expect((await falso.emitir(mensagem("G-5", "bom dia"))).status).toBe(200)
      expect((await falso.emitir(mensagem("G-6", "quero o guia", {}, outroGrupo))).status).toBe(200)
      await expect.poll(() => falso!.enviadas().map(m => m.number).slice(enviadasAntes), { timeout: 30_000 }).toEqual([outroGrupo])
      expect(consulta<{ n: number }>(`SELECT count(*) n FROM conversations WHERE contact_channel_id IN (SELECT id FROM contact_channels WHERE channel_id='${connection.id}')`)[0].n).toBe(0)
    } finally {
      await falso?.fechar()
      sql(limpeza(instancia, t))
    }
  })
})
