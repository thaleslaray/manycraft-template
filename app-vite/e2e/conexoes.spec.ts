import { test, expect } from "./fixtures"
import { ENGINE, WORKSPACE, api, consulta, novoTag, sql } from "./helpers"
import { subirTelegramFalso, type TelegramFalso } from "./telegram-falso"
import { APP_ID, subirInstagramUnificadoFalso } from "./instagram-unificado-falso"

type Catalogo = { development?: { providerApiBase: string } }

/** SQL das sobras desta jornada: o bot falso (id numérico próprio), o contato que ele "trouxe" e a automação e2e-. */
function limpeza(botId: number, tag: string): string[] {
  const w = `workspace_id='${WORKSPACE}'`
  const canais = `SELECT id FROM channels WHERE ${w} AND (external_id='${botId}' OR external_id LIKE 'archived:%:${botId}')`
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
    `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('e2e-auto-${tag}',${w},'e2e conexões ${tag}','${grafo}')`,
    `INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('e2e-ver-${tag}',${w},'e2e-auto-${tag}',1,'${grafo}')`,
    `UPDATE automations SET published_version_id='e2e-ver-${tag}',status='live',has_unpublished_changes=0 WHERE id='e2e-auto-${tag}'`,
    // A conexão é vinculada assim que a jornada a cria.
    `INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES ('e2e-trg-${tag}',${w},'e2e-auto-${tag}',NULL,'e2e quero','keyword','active','every_time','{"node_id":"trigger"}')`,
    `INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES ('e2e-kw-${tag}',${w},'e2e-trg-${tag}','is','["quero-${tag}"]','live',0)`,
  ]
}

test.describe("Conexões de canal", () => {
  test("conecta um bot de Telegram do zero pela tela, a automação responde pela conexão e a credencial troca e arquiva", async ({ page }) => {
    const catalogo = await api<Catalogo>("/api/connections/catalog")
    test.skip(!catalogo.development, "O engine precisa de DEV_PROVIDER_API_BASE (veja engine/.dev.vars.example) para falar com um Telegram falso.")
    const t = novoTag(), botId = 9_000_000 + Math.floor(Math.random() * 999_999)
    const tokenA = `${botId}:E2E-token-${t}`, tokenB = `${botId}:E2E-novo-${t}`
    const resposta = `Resposta e2e ${t}`
    let falso: TelegramFalso | undefined
    try {
      falso = await subirTelegramFalso(Number(new URL(catalogo.development!.providerApiBase).port),
        { [tokenA]: { id: botId, username: `e2e_bot_${t}` }, [tokenB]: { id: botId, username: `e2e_bot_${t}` } })
      sql(automacaoSql(t, resposta))

      await page.goto(`/${WORKSPACE}/settings/channels`)
      await page.getByRole("button", { name: "Conectar canal" }).first().click()
      const dialogo = page.getByRole("dialog", { name: "Conectar canal" })
      // Só há um provedor de Telegram: o passo do provedor não aparece.
      await dialogo.getByRole("radio", { name: "Telegram" }).check()
      await expect(dialogo.getByText("Provedor", { exact: true })).toHaveCount(0)
      await expect(dialogo.getByLabel("Token do bot")).toHaveAttribute("type", "password")
      await dialogo.getByLabel("Token do bot").fill(tokenA)
      await dialogo.getByLabel(/Nome na lista/).fill(`Bot e2e ${t}`)
      await page.screenshot({ path: test.info().outputPath("conexoes-dialogo.png") })
      await dialogo.getByRole("button", { name: "Conectar" }).click()
      await expect(page.getByText("Canal conectado.")).toBeVisible()

      const cartao = page.getByRole("listitem").filter({ hasText: `Bot e2e ${t}` })
      await expect(cartao.getByText("Conectada", { exact: true })).toBeVisible()
      await expect(cartao.getByText("Webhook registrado automaticamente.")).toBeVisible()
      await expect(cartao.getByText(`conta ${botId}`)).toBeVisible()
      await page.screenshot({ path: test.info().outputPath("conexoes-lista.png") })
      // A credencial nunca volta ao navegador: nem a resposta da lista nem a página a contêm.
      expect(await page.content()).not.toContain(tokenA)
      const lista = JSON.stringify(await api("/api/connections"))
      expect(lista).not.toContain(tokenA)

      // O Telegram (falso) recebeu o registro do webhook com a URL e o segredo desta conexão.
      const webhook = falso.webhook()!
      expect(webhook.url).toMatch(/\/api\/hooks\/[0-9a-f-]{36}$/)
      const conexaoId = webhook.url.split("/").pop()!
      sql([`UPDATE triggers SET channel_id='${conexaoId}' WHERE workspace_id='${WORKSPACE}' AND id='e2e-trg-${t}'`])

      // O Telegram "entrega" uma mensagem no webhook registrado: a automação responde pelo bot desta conexão.
      const entrega = (texto: string, segredo = webhook.secret_token) => fetch(webhook.url.replace(/^https?:\/\/[^/]+/, ENGINE), {
        method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": segredo },
        body: JSON.stringify({ update_id: Date.now(), message: { message_id: 1, from: { id: 5550100, first_name: `E2e${t}` }, chat: { id: 5550100, type: "private" }, text: texto } }),
      })
      expect((await entrega(`quero-${t}`, "segredo-errado")).status).toBe(401)
      expect((await entrega(`quero-${t}`)).status).toBe(200)
      await expect.poll(() => falso!.enviadas().map(m => `${m.token}|${m.chat_id}|${m.text}`), { timeout: 30_000 }).toContain(`${tokenA}|5550100|${resposta}`)
      expect(consulta<{ connection_id: string }>(`SELECT m.connection_id FROM messages m WHERE m.workspace_id='${WORKSPACE}' AND m.source='automation' AND m.connection_id='${conexaoId}'`)).toHaveLength(1)

      // A conversa aparece na caixa de entrada.
      await page.goto(`/${WORKSPACE}/inbox`)
      await page.getByRole("textbox", { name: /Buscar conversa/ }).fill(`E2e${t}`)
      await expect(page.getByRole("button", { name: new RegExp(`E2e${t}.*Telegram`) })).toBeVisible()

      // Troca de credencial: o webhook é registrado de novo e os contatos continuam.
      await page.goto(`/${WORKSPACE}/settings/channels`)
      const cartao2 = page.getByRole("listitem").filter({ hasText: `Bot e2e ${t}` })
      await cartao2.getByRole("button", { name: "Trocar credencial" }).click()
      const trocar = page.getByRole("dialog", { name: "Trocar credencial" })
      await trocar.getByLabel("Token do bot").fill(tokenB)
      await trocar.getByRole("button", { name: "Trocar credencial" }).click()
      await expect(page.getByText("Credencial trocada.")).toBeVisible()
      expect(falso.chamadas.filter(c => c.token === tokenB).map(c => c.metodo)).toEqual(["getMe", "setWebhook"])
      expect(await page.content()).not.toContain(tokenB)

      // Arquivar: sai da lista, o Telegram é avisado, a entrega deixa de ser aceita e os contatos ficam.
      const antes = consulta<{ n: number }>(`SELECT count(*) n FROM contact_channels WHERE channel_id='${conexaoId}'`)[0].n
      await page.getByRole("listitem").filter({ hasText: `Bot e2e ${t}` }).getByRole("button", { name: "Arquivar" }).click()
      await page.getByRole("dialog", { name: "Arquivar conexão" }).getByRole("button", { name: "Arquivar" }).click()
      await expect(page.getByText("Conexão arquivada.")).toBeVisible()
      await expect(page.getByRole("listitem").filter({ hasText: `Bot e2e ${t}` })).toHaveCount(0)
      expect(falso.chamadas.some(c => c.metodo === "deleteWebhook" && c.token === tokenB)).toBe(true)
      expect((await entrega(`quero-${t}`)).status).toBe(404)
      expect(consulta<{ n: number }>(`SELECT count(*) n FROM contact_channels WHERE channel_id='${conexaoId}'`)[0].n).toBe(antes)
      expect(consulta<{ n: number }>(`SELECT count(*) n FROM conversations`)[0].n).toBeGreaterThan(0)
    } finally {
      await falso?.fechar()
      sql(limpeza(botId, t))
    }
  })

  test("passo guiado da Meta: webhook do app de outro sistema, o Instagram mostra o motivo, a URL e o token para colar e fica aguardando o webhook", async ({ page }) => {
    const catalogo = await api<Catalogo>("/api/connections/catalog")
    test.skip(!catalogo.development, "O engine precisa de DEV_PROVIDER_API_BASE (veja engine/.dev.vars.example) para falar com uma Graph API falsa.")
    const t = novoTag(), numero = `8${Math.floor(Math.random() * 1e9)}`
    let falso: Awaited<ReturnType<typeof subirInstagramUnificadoFalso>> | undefined
    try {
      falso = await subirInstagramUnificadoFalso(Number(new URL(catalogo.development!.providerApiBase).port), numero, `ig_e2e_${t}`)
      // O webhook do Instagram do app já aponta para outro sistema: o ManyCraft não troca sozinho e mostra o passo manual com o motivo.
      falso.webhookApp.outroSistema = "https://outro-sistema.example.com/webhook"
      await page.goto(`/${WORKSPACE}/settings/channels`)
      await page.getByRole("button", { name: "Conectar canal" }).first().click()
      const dialogo = page.getByRole("dialog", { name: "Conectar canal" })
      await dialogo.getByRole("radio", { name: "Instagram" }).check()
      // Um provedor só: não há passo "Provedor", os campos aparecem direto.
      await expect(dialogo.getByRole("group", { name: "Provedor" })).toHaveCount(0)
      await dialogo.getByLabel("Token de acesso").fill(`EAAG-e2e-${t}`)
      await dialogo.getByLabel("ID da conta do Instagram").fill(numero)
      await dialogo.getByLabel("Chave secreta do app da Meta").fill(`segredo-${t}`)
      await dialogo.getByLabel(/Nome na lista/).fill(`Instagram e2e ${t}`)
      await dialogo.getByRole("button", { name: "Conectar" }).click()
      const guia = page.getByRole("dialog", { name: "Falta um passo no app da Meta" })
      await expect(guia.getByRole("textbox", { name: "URL de retorno" })).toHaveValue(/\/api\/webhooks\/meta$/)
      await expect(guia.getByRole("textbox", { name: "Token de verificação" })).not.toHaveValue("")
      await expect(guia.getByText(/Não deu para assinar o webhook sozinho: .*já aponta para outro-sistema\.example\.com/)).toBeVisible()
      expect(falso.chamadas.filter(c => c.metodo === "POST" && c.path.startsWith(`/v26.0/${APP_ID}/subscriptions`)), "o webhook de outro sistema não é sobrescrito").toEqual([])
      await page.screenshot({ path: test.info().outputPath("conexoes-guia.png") })
      await guia.getByRole("button", { name: "Concluir" }).click()
      const cartao = page.getByRole("listitem").filter({ hasText: `Instagram e2e ${t}` })
      await expect(cartao.getByText("Aguardando webhook")).toBeVisible()
      expect(await page.content()).not.toContain(`EAAG-e2e-${t}`)
    } finally {
      await falso?.fechar()
      sql([`DELETE FROM channels WHERE workspace_id='${WORKSPACE}' AND external_id='${numero}'`])
    }
  })
})

test("Configurações: canal desconhecido em /settings/channels/:kind volta para a lista de canais", async ({ page }) => {
  await page.goto(`/${WORKSPACE}/settings/channels/messenger`)
  await expect(page).toHaveURL(new RegExp(`/${WORKSPACE}/settings/channels$`))
  await expect(page.getByRole("button", { name: "Conectar canal", exact: true })).toBeVisible()
})
