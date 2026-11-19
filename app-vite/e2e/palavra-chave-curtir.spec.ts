import { test, expect } from "./fixtures"
import { ENGINE, WORKSPACE, api, consulta, escolher, escolherAutomacao, gatilhoDeRascunho, novoTag, q, sql } from "./helpers"
import { subirTelegramFalso, type TelegramFalso } from "./telegram-falso"

// Ficha volta-gatilhos-mensagens/03: a regra Curtir é escolhida na página Palavras-chave e dispara com o 👍 sozinho (com tom de pele também),
// mas não com o 👍 no meio de um texto.
test("palavras-chave: regra Curtir escolhida na tela dispara só com o polegar para cima", async ({ page }, info) => {
  test.setTimeout(150_000)
  page.setDefaultTimeout(15_000)
  const catalog = await api<{ development?: { providerApiBase: string } }>("/api/connections/catalog")
  expect(catalog.development, "Esta jornada exige o transporte falso local.").toBeTruthy()
  const provider = new URL(catalog.development!.providerApiBase)
  expect(["localhost", "127.0.0.1"]).toContain(provider.hostname)
  const tag = novoTag(), bot = 6_000_000 + Math.floor(Math.random() * 999_999)
  const id = `e2e-curtir-${tag}`, automation = `Agradecer curtida ${tag}`, name = `Curtida ${tag}`, reply = `Obrigado pela curtida ${tag}`
  let fake: TelegramFalso | undefined, connection: string | undefined
  try {
    fake = await subirTelegramFalso(Number(provider.port), { [`${bot}:e2e-${tag}`]: { id: bot, username: `e2e_${tag}` } })
    connection = (await api<{ connection: { id: string } }>("/api/connections", { method: "POST", body: JSON.stringify({ kind: "telegram", displayName: `e2e Curtir ${tag}`, credentials: { botToken: `${bot}:e2e-${tag}` } }) })).connection.id
    const graph = { nodes: [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 }, config: {} },
      { id: "reply", type: "message", position: { x: 300, y: 0 }, config: { channel: "telegram", blocks: [{ kind: "text", text: reply }] } }],
    edges: [{ from: "trigger", port: "next", to: "reply" }] }
    sql([`INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${id}','${WORKSPACE}','${q(automation)}','${q(JSON.stringify(graph))}')`])
    // Publicar sem gatilho é barrado: este nasce desligado só para a publicação passar e sai da lista depois.
    await gatilhoDeRascunho(id, connection, `rascunho${tag}`, `Rascunho ${tag}`)
    await api(`/api/automations/${id}/publish`, { method: "POST" })
    const draft = (await api<{ id: string; name: string; automation_id: string }[]>("/api/keywords")).find(row => row.automation_id === id && row.name === `Rascunho ${tag}`)!
    await api(`/api/keywords/${draft.id}`, { method: "DELETE" })

    if (info.project.name === "desktop") await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/keywords`)
    await page.getByRole("button", { name: "Criar palavra-chave", exact: true }).first().click()
    const panel = page.getByRole("dialog")
    await panel.getByLabel("Nome da palavra-chave").fill(name)
    await escolher(page, "Canal da mensagem", "Telegram", panel)
    await escolher(page, "Conexão da mensagem", `e2e Curtir ${tag}`, panel)
    await escolher(page, "Condição 1", "Curtir (só o polegar para cima)", panel)
    // Curtir não usa palavras: o campo some e a explicação aparece.
    await expect(panel.getByText("Responde quando a pessoa manda só o polegar para cima", { exact: false })).toBeVisible()
    await expect(panel.getByLabel("Nova palavra: Palavras da condição 1")).toHaveCount(0)
    await escolherAutomacao(page, panel, automation, "Automação de resposta")
    await expect(panel.getByRole("button", { name: "Automação de resposta", exact: true })).toContainText(automation)
    const barra = panel.getByRole("group", { name: "Ações do painel" })
    // Com a automação publicada escolhida, a regra nova já vem ativa.
    await expect(barra.getByRole("switch", { name: "Regra ativa", exact: true })).toBeChecked()
    const saved = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/keywords"))
    await barra.getByRole("button", { name: "Salvar palavra-chave", exact: true }).click()
    expect((await saved).status()).toBe(201)
    const row = (await api<{ id: string; name: string; active: boolean; connection_id: string; rules: unknown[] }[]>("/api/keywords")).find(r => r.name === name)
    expect(row).toMatchObject({ active: true, connection_id: connection, rules: [{ condition: "thumbs_up", words: [] }] })
    await page.reload()
    const item = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: true }) })
    await expect(item).toContainText("é só o polegar para cima")
    await expect(item.getByRole("switch", { name: `Ativar regra ${name}`, exact: true })).toBeChecked()
    // Reabrir mostra a regra Curtir escolhida.
    await item.getByRole("button", { name: `Mais ações de ${name}`, exact: true }).click()
    await page.getByRole("menuitem", { name: "Editar", exact: true }).click()
    await expect(panel.getByRole("combobox", { name: "Condição 1", exact: true })).toContainText("Curtir (só o polegar para cima)")
    await panel.getByRole("button", { name: "Fechar painel", exact: true }).click()

    let serial = Date.now(), delivered = 0, person = bot
    const deliver = async (text: string) => {
      const hook = fake!.webhook()!, update = ++serial
      person++ // uma pessoa por mensagem: a política de disparo não interfere
      const res = await fetch(hook.url.replace(/^https?:\/\/[^/]+/, ENGINE), { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": hook.secret_token },
        body: JSON.stringify({ update_id: update, message: { message_id: update, from: { id: person, first_name: "Pessoa de teste" }, chat: { id: person, type: "private" }, text } }) })
      expect(res.status).toBe(200)
      delivered++
      await expect(async () => expect(consulta<{ n: number }>(`SELECT count(*) n FROM inbound_events WHERE channel_id='${q(connection!)}' AND planned_at IS NOT NULL`)[0]?.n).toBe(delivered)).toPass({ timeout: 30_000 })
    }
    await deliver("👍")
    await expect.poll(() => fake!.enviadas().map(m => m.text), { timeout: 30_000 }).toEqual([reply])
    await deliver("👍🏽")
    await expect.poll(() => fake!.enviadas().map(m => m.text), { timeout: 30_000 }).toEqual([reply, reply])
    // O polegar no meio de um texto não é curtir.
    await deliver("gostei 👍")
    expect(consulta<{ n: number }>(`SELECT count(*) n FROM flow_runs WHERE channel_id='${q(connection)}'`)[0]?.n).toBe(2)
    expect(fake.enviadas()).toHaveLength(2)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath("palavra-chave-curtir.png"), scale: "css" })
  } finally {
    await fake?.fechar()
    const ws = `workspace_id='${WORKSPACE}'`
    if (connection) sql([
      `DELETE FROM contacts WHERE ${ws} AND id IN (SELECT contact_id FROM contact_channels WHERE ${ws} AND channel_id='${q(connection)}')`,
      `DELETE FROM inbound_events WHERE ${ws} AND channel_id='${q(connection)}'`,
      `DELETE FROM channels WHERE ${ws} AND id='${q(connection)}'`,
    ])
    sql([`DELETE FROM automations WHERE ${ws} AND id='${id}'`])
  }
})
