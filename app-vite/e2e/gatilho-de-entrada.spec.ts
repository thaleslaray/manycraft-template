import { test, expect } from "./fixtures"
import { ENGINE, WORKSPACE, api, consulta, novoTag, q, sql } from "./helpers"
import { subirTelegramFalso, type TelegramFalso } from "./telegram-falso"

// Ficha 12: uma pessoa nova escreve a palavra-chave pelo Telegram falso; a lateral de Contatos passa a mostrar 1 no gatilho
// e o número sobrevive ao recarregar. O único transporte é o servidor falso em loopback.
test("gatilho de entrada: contato novo entra marcado e a lateral de contatos conta e filtra", async ({ page }) => {
  test.setTimeout(120_000)
  const catalog = await api<{ development?: { providerApiBase: string } }>("/api/connections/catalog")
  expect(catalog.development, "Exige transporte falso local").toBeTruthy()
  const tag = novoTag(), bot = 7_000_000 + Math.floor(Math.random() * 999_999)
  const word = `entrada${tag}`, ruleName = `Entrada ${tag}`
  let fake: TelegramFalso | undefined, connection: string | undefined, id: string | undefined
  try {
    fake = await subirTelegramFalso(Number(new URL(catalog.development!.providerApiBase).port), { [`${bot}:e2e-${tag}`]: { id: bot, username: `e2e_${tag}` } })
    connection = (await api<{ connection: { id: string } }>("/api/connections", { method: "POST", body: JSON.stringify({ kind: "telegram", displayName: `Entrada local ${tag}`, credentials: { botToken: `${bot}:e2e-${tag}` } }) })).connection.id
    id = (await api<{ id: string }>("/api/automations", { method: "POST", body: JSON.stringify({ name: `Boas-vindas ${tag}` }) })).id
    await api(`/api/automations/${id}/draft`, { method: "PUT", body: JSON.stringify({ graph: {
      nodes: [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 }, config: {} }, { id: "message", type: "message", position: { x: 360, y: 0 }, config: { blocks: [{ kind: "text", text: "Oi, que bom ter você aqui." }] } }],
      edges: [{ from: "trigger", port: "next", to: "message" }],
    } }) })
    await api(`/api/automations/${id}/publish`, { method: "POST" })
    const rule = await api<{ id: string }>("/api/keywords", { method: "POST", body: JSON.stringify({ name: ruleName, channel: "telegram", automation_id: id, active: true, rules: [{ condition: "equals", words: [word] }] }) })
    const own = `workspace_id='${WORKSPACE}' AND automation_id='${q(id)}' AND id=(SELECT trigger_id FROM keywords WHERE workspace_id='${WORKSPACE}' AND id='${q(rule.id)}')`
    sql([`UPDATE triggers SET channel_id='${q(connection)}' WHERE ${own}`])
    const trigger = consulta<{ id: string; name: string }>(`SELECT id,name FROM triggers WHERE ${own}`)[0]!

    const hook = fake.webhook()!, update = Date.now()
    const res = await fetch(hook.url.replace(/^https?:\/\/[^/]+/, ENGINE), { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": hook.secret_token },
      body: JSON.stringify({ update_id: update, message: { message_id: update, from: { id: bot + 1, first_name: "Pessoa nova" }, chat: { id: bot + 1, type: "private" }, text: word } }) })
    expect(res.status).toBe(200)
    await expect.poll(() => fake!.enviadas().length, { timeout: 30_000 }).toBe(1)
    expect(consulta<{ optin_source: string }>(`SELECT c.optin_source FROM contacts c JOIN contact_channels cc ON cc.contact_id=c.id WHERE cc.channel_id='${q(connection)}'`))
      .toEqual([{ optin_source: `trigger:${trigger.id}` }])

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/contacts`)
    // A região lista só os gatilhos com mais contatos; com muitos gatilhos no espaço, o desta jornada fica atrás de "Mostrar todos".
    const lateral = page.getByRole("region", { name: "Gatilhos de entrada", exact: true })
    const item = lateral.getByRole("button", { name: new RegExp(`^${trigger.name}`) })
    const abrirTodos = async () => {
      const todos = lateral.getByRole("button", { name: "Mostrar todos", exact: true })
      await expect(item.or(todos).first()).toBeVisible()
      if (!(await item.count())) await todos.click()
    }
    await expect(lateral).toBeVisible()
    await abrirTodos()
    await expect(item).toContainText("1")
    await page.reload()
    await expect(lateral).toBeVisible()
    await abrirTodos()
    await expect(lateral.getByRole("button", { name: new RegExp(`^${trigger.name}`) })).toContainText("1")
    await lateral.getByRole("button", { name: new RegExp(`^${trigger.name}`) }).click()
    await expect(page.getByRole("region", { name: "Lista de contatos" })).toContainText("Pessoa nova")

    // Telas estreitas: o mesmo atalho continua alcançável.
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByRole("button", { name: new RegExp(`^${trigger.name}`) })).toBeVisible()
  } finally {
    await fake?.fechar()
    const ws = `workspace_id='${WORKSPACE}'`
    if (connection) sql([
      `DELETE FROM contacts WHERE ${ws} AND id IN (SELECT contact_id FROM contact_channels WHERE ${ws} AND channel_id='${q(connection)}')`,
      `DELETE FROM inbound_events WHERE ${ws} AND channel_id='${q(connection)}'`,
      `DELETE FROM channels WHERE ${ws} AND id='${q(connection)}'`,
    ])
    if (id) sql([`DELETE FROM automations WHERE ${ws} AND id='${q(id)}'`])
  }
})
