import { test, expect } from "./fixtures"
import { WORKSPACE, api, gatilhoDeRascunho, novoGatilho, novoTag, q, sql } from "./helpers"
import { subirTelegramFalso, type TelegramFalso } from "./telegram-falso"

// Uma regra "contém teste" acima pega "teste1234" antes da regra nova: a lista marca a de baixo como encoberta,
// o painel avisa (com Pausar a outra / Subir esta / Manter assim) e o editor avisa ao criar o gatilho.
test("palavras-chave: conflito entre regras é avisado na lista, no painel e no editor", async ({ page }, info) => {
  test.setTimeout(150_000)
  page.setDefaultTimeout(15_000)
  const catalog = await api<{ development?: { providerApiBase: string } }>("/api/connections/catalog")
  expect(catalog.development, "Esta jornada exige o transporte falso local.").toBeTruthy()
  const tag = novoTag(), bot = 6_000_000 + Math.floor(Math.random() * 999_999)
  const larga = `teste${tag}`, estreita = `teste${tag}1234`
  const autos = [{ id: `e2e-conf-a-${tag}`, name: `Teste automação ${tag}` }, { id: `e2e-conf-b-${tag}`, name: `Nova resposta ${tag}` }, { id: `e2e-conf-c-${tag}`, name: `Editor ${tag}` }]
  const conexao = `e2e Conflito ${tag}`
  let fake: TelegramFalso | undefined, connection: string | undefined
  try {
    fake = await subirTelegramFalso(Number(new URL(catalog.development!.providerApiBase).port), { [`${bot}:e2e-${tag}`]: { id: bot, username: `e2e_${tag}` } })
    connection = (await api<{ connection: { id: string } }>("/api/connections", { method: "POST", body: JSON.stringify({ kind: "telegram", displayName: conexao, credentials: { botToken: `${bot}:e2e-${tag}` } }) })).connection.id
    for (const auto of autos) {
      const graph = { nodes: [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 }, config: {} },
        { id: "reply", type: "message", position: { x: 300, y: 0 }, config: { channel: "telegram", blocks: [{ kind: "text", text: auto.name }] } }],
      edges: [{ from: "trigger", port: "next", to: "reply" }] }
      sql([`INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${auto.id}','${WORKSPACE}','${q(auto.name)}','${q(JSON.stringify(graph))}')`])
      if (auto === autos[2]) continue
      await gatilhoDeRascunho(auto.id, connection, `rascunho${tag}`, `Rascunho ${tag}`)
      await api(`/api/automations/${auto.id}/publish`, { method: "POST" })
      const draft = (await api<{ id: string; name: string; automation_id: string }[]>("/api/keywords")).find(row => row.automation_id === auto.id && row.name === `Rascunho ${tag}`)!
      await api(`/api/keywords/${draft.id}`, { method: "DELETE" })
    }
    for (const [auto, word] of [[autos[0], larga], [autos[1], estreita]] as const) await api("/api/keywords", { method: "POST", body: JSON.stringify({
      name: auto.name, channel: "telegram", automation_id: auto.id, connection_id: connection, active: true, rules: [{ condition: "contains", words: [word] }] }) })

    if (info.project.name === "desktop") await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/keywords`)
    const lista = page.getByRole("list", { name: "Regras por prioridade" })
    const linha = (nome: string) => lista.getByRole("listitem").filter({ has: page.getByRole("heading", { name: nome, exact: true }) })
    await expect(linha(autos[1].name).getByTestId("keyword-shadowed")).toContainText(`Encoberta: a regra “${autos[0].name}”, acima, também pega “${estreita}” e responde antes desta.`)
    await expect(linha(autos[0].name).getByTestId("keyword-shadowed")).toHaveCount(0)

    // Painel da regra de baixo: aviso forte com as três ações; subir para o topo inverte a ordem e o aviso fica leve.
    await page.getByRole("button", { name: `Mais ações de ${autos[1].name}`, exact: true }).click()
    await page.getByRole("menuitem", { name: "Editar", exact: true }).click()
    const aviso = page.getByTestId("keyword-conflicts")
    await expect(aviso).toContainText(`A regra “${autos[0].name}” (contém “${larga}”) também pega “${estreita}” e vem antes, então ela responde no lugar desta.`)
    await expect(aviso.getByRole("button", { name: "Pausar a outra" })).toBeVisible()
    await expect(aviso.getByRole("button", { name: "Manter assim" })).toBeVisible()
    await aviso.getByRole("button", { name: "Subir esta para o topo" }).click()
    await expect(aviso).toContainText("mas esta vem antes e passa na frente dela.")
    await expect(aviso.getByRole("button", { name: "Subir esta para o topo" })).toHaveCount(0)
    await aviso.getByRole("button", { name: "Manter assim" }).click()
    await expect(aviso).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(lista.getByRole("heading").filter({ hasText: tag })).toHaveText([autos[1].name, autos[0].name])

    // Editor: o gatilho novo com uma palavra que as duas pegam avisa antes de criar.
    if (info.project.name === "desktop") {
      await page.goto(`/${WORKSPACE}/automations/${autos[2].id}`)
      await page.locator(".react-flow__node-trigger").click({ position: { x: 40, y: 16 } })
      await novoGatilho(page, "Telegram", /Mensagem no Telegram|envia uma mensagem/)
      await page.getByLabel("Nome do gatilho").fill("Gatilho novo")
      await page.getByRole("combobox", { name: "Conexão" }).click()
      await page.getByRole("option", { name: conexao, exact: true }).click()
      await page.getByRole("textbox", { name: "Nova palavra: Palavras da mensagem", exact: true }).fill(`${estreita}9`)
      await page.getByRole("textbox", { name: "Nova palavra: Palavras da mensagem", exact: true }).press("Enter")
      const editor = page.getByTestId("keyword-conflicts")
      await expect(editor).toContainText(`também pega “${estreita}9” e vem antes, então ela responde no lugar desta.`)
      await expect(editor.getByRole("button", { name: "Subir esta para o topo" })).toHaveCount(0)
      await expect(page.getByText("O gatilho nasce desligado. Ao publicar a automação, ele é ligado sozinho e passa a disparar.")).toBeVisible()
      await page.screenshot({ path: info.outputPath("palavras-chave-conflito-editor.png"), scale: "css" })
    }
  } finally {
    await fake?.fechar()
    const ws = `workspace_id='${WORKSPACE}'`
    if (connection) sql([`DELETE FROM channels WHERE ${ws} AND id='${q(connection)}'`])
    sql([`DELETE FROM automations WHERE ${ws} AND id IN (${autos.map(a => `'${a.id}'`).join(",")})`])
  }
})
