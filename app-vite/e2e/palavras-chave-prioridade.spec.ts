import { test, expect } from "./fixtures"
import { ENGINE, WORKSPACE, api, consulta, gatilhoDeRascunho, novoTag, q, sql } from "./helpers"
import { subirTelegramFalso, type TelegramFalso } from "./telegram-falso"

// Ficha volta-gatilhos-mensagens/01: duas palavras-chave casam com a mesma mensagem; responde a que está mais acima na lista.
// A ordem muda pelo menu da linha (Subir) na página Palavras-chave e vale no disparo seguinte.
test("palavras-chave: reordenar na lista muda qual responde quando duas casam", async ({ page }, info) => {
  test.setTimeout(150_000)
  page.setDefaultTimeout(15_000)
  const catalog = await api<{ development?: { providerApiBase: string } }>("/api/connections/catalog")
  expect(catalog.development, "Esta jornada exige o transporte falso local.").toBeTruthy()
  const provider = new URL(catalog.development!.providerApiBase)
  expect(["localhost", "127.0.0.1"]).toContain(provider.hostname)
  const tag = novoTag(), bot = 7_000_000 + Math.floor(Math.random() * 999_999), word = `promo${tag}`
  const first = { id: `e2e-prio-a-${tag}`, name: `Promoção geral ${tag}`, reply: `Resposta da promoção geral ${tag}` }
  const second = { id: `e2e-prio-b-${tag}`, name: `Promoção de inverno ${tag}`, reply: `Resposta da promoção de inverno ${tag}` }
  let fake: TelegramFalso | undefined, connection: string | undefined
  const keywords: string[] = []
  try {
    fake = await subirTelegramFalso(Number(provider.port), { [`${bot}:e2e-${tag}`]: { id: bot, username: `e2e_${tag}` } })
    connection = (await api<{ connection: { id: string } }>("/api/connections", { method: "POST", body: JSON.stringify({ kind: "telegram", displayName: `e2e Prioridade ${tag}`, credentials: { botToken: `${bot}:e2e-${tag}` } }) })).connection.id
    for (const auto of [first, second]) {
      const graph = { nodes: [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 }, config: {} },
        { id: "reply", type: "message", position: { x: 300, y: 0 }, config: { channel: "telegram", blocks: [{ kind: "text", text: auto.reply }] } }],
      edges: [{ from: "trigger", port: "next", to: "reply" }] }
      sql([`INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${auto.id}','${WORKSPACE}','${q(auto.name)}','${q(JSON.stringify(graph))}')`])
      // Publicar sem gatilho é barrado: este nasce desligado, com outra palavra, só para a publicação passar.
      await gatilhoDeRascunho(auto.id, connection, `rascunho${tag}`, `Rascunho ${tag}`)
      await api(`/api/automations/${auto.id}/publish`, { method: "POST" })
      // O gatilho de rascunho também é uma linha da lista; sai para as duas palavras-chave do teste ficarem vizinhas.
      const draft = (await api<{ id: string; name: string; automation_id: string }[]>("/api/keywords")).find(row => row.automation_id === auto.id && row.name === `Rascunho ${tag}`)!
      await api(`/api/keywords/${draft.id}`, { method: "DELETE" })
      // Palavras-chave novas entram no fim da lista: a primeira criada fica acima da segunda.
      keywords.push((await api<{ id: string }>("/api/keywords", { method: "POST", body: JSON.stringify({ name: auto.name, channel: "telegram", automation_id: auto.id, connection_id: connection, active: true, rules: [{ condition: "contains", words: [word] }] }) })).id)
    }
    if (info.project.name === "desktop") await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/keywords`)
    const lista = page.getByRole("list", { name: "Regras por prioridade" })
    const nomes = lista.getByRole("heading").filter({ hasText: tag })
    await expect(nomes).toHaveText([first.name, second.name])
    await expect(page.getByText("Quando mais de uma regra combina com a mensagem, responde a que está mais acima na lista.")).toBeVisible()

    let serial = Date.now(), delivered = 0, person = bot
    const deliver = async (text: string) => {
      const hook = fake!.webhook()!, update = ++serial
      person++ // cada mensagem vem de uma pessoa nova: a política de disparo não interfere
      const res = await fetch(hook.url.replace(/^https?:\/\/[^/]+/, ENGINE), { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": hook.secret_token },
        body: JSON.stringify({ update_id: update, message: { message_id: update, from: { id: person, first_name: "Pessoa de teste" }, chat: { id: person, type: "private" }, text } }) })
      expect(res.status).toBe(200)
      delivered++
      await expect(async () => expect(consulta<{ n: number }>(`SELECT count(*) n FROM inbound_events WHERE channel_id='${q(connection!)}' AND planned_at IS NOT NULL`)[0]?.n).toBe(delivered)).toPass({ timeout: 30_000 })
    }
    // Ordem gravada: a de cima responde.
    await deliver(`Quero a ${word} de hoje`)
    await expect.poll(() => fake!.enviadas().map(m => m.text), { timeout: 30_000 }).toEqual([first.reply])

    // Sobe a segunda pelo menu da linha: ela passa para cima e responde a próxima mensagem.
    await page.getByRole("button", { name: `Mais ações de ${second.name}`, exact: true }).click()
    const moved = page.waitForResponse(r => r.request().method() === "PATCH" && /\/keywords\/[^/]+\/priority$/.test(new URL(r.url()).pathname))
    await page.getByRole("menuitem", { name: "Subir", exact: true }).click()
    expect((await moved).status()).toBe(200)
    await expect(nomes).toHaveText([second.name, first.name])
    await page.reload()
    await expect(nomes).toHaveText([second.name, first.name])
    await deliver(`Quero a ${word} de hoje`)
    await expect.poll(() => fake!.enviadas().map(m => m.text), { timeout: 30_000 }).toEqual([first.reply, second.reply])

    // Descer volta a ordem original e a primeira volta a responder.
    await page.getByRole("button", { name: `Mais ações de ${second.name}`, exact: true }).click()
    await page.getByRole("menuitem", { name: "Descer", exact: true }).click()
    await expect(nomes).toHaveText([first.name, second.name])
    await deliver(`${word}!`)
    await expect.poll(() => fake!.enviadas().map(m => m.text), { timeout: 30_000 }).toEqual([first.reply, second.reply, first.reply])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath("palavras-chave-prioridade.png"), scale: "css" })
  } finally {
    await fake?.fechar()
    const ws = `workspace_id='${WORKSPACE}'`
    if (connection) sql([
      `DELETE FROM contacts WHERE ${ws} AND id IN (SELECT contact_id FROM contact_channels WHERE ${ws} AND channel_id='${q(connection)}')`,
      `DELETE FROM inbound_events WHERE ${ws} AND channel_id='${q(connection)}'`,
      `DELETE FROM channels WHERE ${ws} AND id='${q(connection)}'`,
    ])
    sql([`DELETE FROM automations WHERE ${ws} AND id IN ('${first.id}','${second.id}')`])
  }
})
