import { readFileSync } from "node:fs"
import { test, expect } from "./fixtures"
import { ENGINE, WORKSPACE, canalE2eSql, consulta, contatoSql, limpezaSql, novoTag, sql } from "./helpers"

const largo = (page: import("@playwright/test").Page) => (page.viewportSize()?.width ?? 1440) >= 640
async function acaoDaLista(page: import("@playwright/test").Page, nome: string) {
  if (largo(page)) return page.getByRole("button", { name: nome, exact: true }).click()
  await page.getByRole("button", { name: "Mais ações da lista" }).click()
  await page.getByRole("menuitem", { name: nome, exact: true }).click()
}

test.describe("Usabilidade de Início, Insights e Contatos", { tag: "@celular" }, () => {
  test("Exportar baixa o CSV dos contatos filtrados e, nas ações em lote, só dos selecionados", async ({ page }) => {
    const t = novoTag(), canal = `e2e-canal-${t}`
    sql([...canalE2eSql(canal), ...contatoSql({ id: `e2e-exp-a-${t}`, canal, nome: "Exporta", sobrenome: `Alfa${t}` }), ...contatoSql({ id: `e2e-exp-b-${t}`, canal, nome: "Exporta", sobrenome: `Beta${t}` }),
      `UPDATE contacts SET gender='female', email='alfa-${t}@example.test' WHERE id='e2e-exp-a-${t}'`])
    try {
      await page.goto(`/${WORKSPACE}/contacts`)
      await page.getByRole("textbox", { name: "Buscar contato" }).fill(`Alfa${t}`)
      await expect(page.getByRole("button", { name: `Exporta Alfa${t}` })).toBeVisible()
      const baixando = page.waitForEvent("download")
      await acaoDaLista(page, "Exportar")
      const arquivo = await baixando
      expect(arquivo.suggestedFilename()).toMatch(/^contatos-\d{4}-\d{2}-\d{2}\.csv$/)
      const csv = readFileSync(await arquivo.path(), "utf8")
      expect(csv).toContain("Nome,Sobrenome,E-mail,Telefone,Gênero,Status")
      expect(csv).toContain(`Exporta,Alfa${t},alfa-${t}@example.test`)
      expect(csv).toContain("Feminino")
      expect(csv).not.toContain(`Beta${t}`)

      await page.getByRole("textbox", { name: "Buscar contato" }).fill(`Beta${t}`)
      await page.getByRole("checkbox", { name: `Selecionar Exporta Beta${t}` }).check()
      await page.getByRole("button", { name: "Ações em lote" }).click()
      const lote = page.waitForEvent("download")
      await page.getByRole("menuitem", { name: "Exportar selecionados (CSV)" }).click()
      const csvLote = readFileSync(await (await lote).path(), "utf8")
      expect(csvLote).toContain(`Beta${t}`)
      expect(csvLote).not.toContain(`Alfa${t}`)
    } finally { sql(limpezaSql()) }
  })

  test("Gênero aparece em português na lista e no perfil", async ({ page }) => {
    const t = novoTag(), canal = `e2e-canal-${t}`, id = `e2e-gen-${t}`
    sql([...canalE2eSql(canal), ...contatoSql({ id, canal, nome: "Gen", sobrenome: `Ero${t}` }), `UPDATE contacts SET gender='male' WHERE id='${id}'`])
    try {
      await page.goto(`/${WORKSPACE}/contacts`)
      await page.getByRole("textbox", { name: "Buscar contato" }).fill(`Ero${t}`)
      const linha = page.getByRole("row").filter({ hasText: `Gen Ero${t}` })
      await expect(linha).toBeVisible()
      if (largo(page)) await expect(linha.getByRole("cell", { name: "Masculino", exact: true })).toBeVisible()
      await expect(page.getByText(/^(male|female)$/)).toHaveCount(0)
      await page.goto(`/${WORKSPACE}/contacts?contact=${id}`)
      await expect(page.getByRole("dialog").getByRole("combobox", { name: "Gênero" })).toHaveText("Masculino")
    } finally { sql(limpezaSql()) }
  })

  test("o total de contatos é o mesmo no Início e na lista, e a tag da lateral bate com o filtro", async ({ page }) => {
    const t = novoTag(), canal = `e2e-canal-${t}`, tag = `tag-${t}`
    sql([...canalE2eSql(canal), ...contatoSql({ id: `e2e-tot-a-${t}`, canal, nome: "Total", sobrenome: `A${t}` }), ...contatoSql({ id: `e2e-tot-b-${t}`, canal, nome: "Total", sobrenome: `B${t}` }),
      `INSERT INTO tags(id,workspace_id,name) VALUES ('${tag}','${WORKSPACE}','Lateral ${t}')`,
      `INSERT INTO contact_tags(workspace_id,contact_id,tag_id) VALUES ('${WORKSPACE}','e2e-tot-a-${t}','${tag}'),('${WORKSPACE}','e2e-tot-b-${t}','${tag}')`,
      `UPDATE contacts SET status='deleted' WHERE id='e2e-tot-b-${t}'`])
    try {
      const agora = Math.floor(Date.now() / 1000)
      const inicio = await (await page.request.get(`${ENGINE}/api/dashboard?from=${agora - 86400}&to=${agora + 86400}`, { headers: { "x-workspace": WORKSPACE } })).json() as { metrics: { key: string; value: number }[] }
      const lista = await (await page.request.get(`${ENGINE}/api/contacts`, { headers: { "x-workspace": WORKSPACE } })).json() as { total: number }
      expect(inicio.metrics.find(m => m.key === "contacts")?.value).toBe(lista.total)
      await page.goto(`/${WORKSPACE}/contacts`)
      const item = page.getByRole("button", { name: new RegExp(`Lateral ${t}`) })
      await expect(item).toContainText("1")
      await item.click()
      await expect(page.getByRole("status", { name: "Contagem do filtro" })).toHaveText("1 contato encontrado")
    } finally { sql([...limpezaSql(), `DELETE FROM tags WHERE id='${tag}'`]) }
  })

  test("Adicionar tag: busca, Enter escolhe só o item destacado, cria a tag nova e a lista fica dentro do pop-up", async ({ page }) => {
    const t = novoTag(), canal = `e2e-canal-${t}`, id = `e2e-tg-${t}`, existente = `Testes ${t}`, nova = `Inédita ${t}`
    sql([...canalE2eSql(canal), ...contatoSql({ id, canal, nome: "Com", sobrenome: `Tag${t}` }), `INSERT INTO tags(id,workspace_id,name) VALUES ('tg-${t}','${WORKSPACE}','${existente}')`])
    try {
      await page.goto(`/${WORKSPACE}/contacts?contact=${id}`)
      const perfil = page.getByRole("dialog")
      await perfil.getByRole("button", { name: "Adicionar tag", exact: true }).click()
      const busca = page.getByRole("combobox", { name: "Buscar ou criar tag" })
      await expect(busca).toBeFocused()
      // A lista nunca passa das bordas do pop-up da tag.
      const caixa = await page.getByRole("listbox", { name: "Tags" }).boundingBox()
      expect(caixa!.y + caixa!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
      // Nome novo + Enter cria e aplica a tag nova, sem aplicar a parecida por engano.
      await busca.fill(`Testes ${t} novo`)
      await expect(page.getByRole("option", { name: `Criar tag «Testes ${t} novo»` })).toHaveAttribute("aria-selected", "true")
      await busca.fill(nova)
      await expect(page.getByRole("option", { name: existente })).toHaveCount(0)
      await busca.press("Enter")
      await expect(perfil.getByRole("button", { name: `Remover tag ${nova}` })).toBeVisible()
      await expect(perfil.getByRole("button", { name: `Remover tag ${existente}` })).toHaveCount(0)
      // Buscar uma existente e escolher com o mouse.
      await perfil.getByRole("button", { name: "Adicionar tag", exact: true }).click()
      await page.getByRole("combobox", { name: "Buscar ou criar tag" }).fill(`testes ${t}`)
      await page.getByRole("option", { name: existente }).click()
      await expect(perfil.getByRole("button", { name: `Remover tag ${existente}` })).toBeVisible()
      expect(consulta(`SELECT t.name FROM contact_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.contact_id='${id}' ORDER BY t.name`)).toEqual([{ name: nova }, { name: existente }])
    } finally { sql([...limpezaSql(), `DELETE FROM tags WHERE workspace_id='${WORKSPACE}' AND name IN ('${existente}','${nova}')`]) }
  })

  test("a lista de contatos cabe na tela do celular, sem rolagem lateral", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "só no celular")
    const t = novoTag(), canal = `e2e-canal-${t}`
    sql([...canalE2eSql(canal), ...contatoSql({ id: `e2e-cel-${t}`, canal, nome: "Fulana de Tal com Nome Longo", sobrenome: `Sobrenome Muito Comprido ${t}` })])
    try {
      await page.goto(`/${WORKSPACE}/contacts`)
      await expect(page.getByRole("row").filter({ has: page.getByRole("button") }).first()).toBeVisible()
      const medidas = await page.evaluate(() => ({
        pagina: document.documentElement.scrollWidth - innerWidth,
        tabela: (() => { const c = document.querySelector("table")!.parentElement!; return c.scrollWidth - c.clientWidth })(),
      }))
      expect(medidas.pagina).toBeLessThanOrEqual(0)
      expect(medidas.tabela).toBeLessThanOrEqual(0)
      await expect(page.getByRole("columnheader", { name: "Status" })).toBeInViewport()
      await page.goto(`/${WORKSPACE}`)
      await expect(page.getByRole("heading").first()).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    } finally { sql(limpezaSql()) }
  })

  test("campos recusados pelo navegador mostram mensagem em português e o arquivo tem botão próprio", async ({ page }) => {
    await page.goto(`/${WORKSPACE}/contacts`)
    await acaoDaLista(page, "Criar novo contato")
    const criar = page.getByRole("dialog")
    await criar.getByLabel("Telefone", { exact: true }).fill("abc")
    await criar.getByLabel("E-mail", { exact: true }).fill("sem-arroba")
    await criar.getByRole("button", { name: "Salvar contato" }).click()
    const telefone = await criar.getByLabel("Telefone", { exact: true }).evaluate((el: HTMLInputElement) => el.validationMessage)
    expect(telefone).toBe("Use o formato pedido neste campo.")
    await criar.getByLabel("Telefone", { exact: true }).fill("+5511999991234")
    await criar.getByRole("button", { name: "Salvar contato" }).click()
    expect(await criar.getByLabel("E-mail", { exact: true }).evaluate((el: HTMLInputElement) => el.validationMessage)).toBe("Digite um e-mail válido, como nome@exemplo.com.")
    await criar.getByRole("button", { name: "Cancelar" }).click()

    await acaoDaLista(page, "Importar")
    const importar = page.getByRole("dialog")
    await expect(importar.getByText("Escolher arquivo", { exact: true })).toBeVisible()
    await expect(importar.getByText("Nenhum arquivo escolhido")).toBeVisible()
    await expect(importar.getByText(/Choose File|No file chosen/)).toHaveCount(0)
    await importar.getByLabel("Arquivo CSV").setInputFiles({ name: "pessoas.csv", mimeType: "text/csv", buffer: Buffer.from("Nome;Email\nAna;ana@example.test") })
    await expect(importar.getByText("pessoas.csv", { exact: true }).first()).toBeVisible()
  })
})
