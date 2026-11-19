import { test, expect } from "./fixtures"
import { WORKSPACE, canalE2eSql, contatoSql, limpezaSql, novoTag, sql } from "./helpers"

// Paridade com o original (ticket 12): pastas com Equipe, faixa de filtros, conversas abertas por padrão e estado sem conversa.
// O original não tem versão de celular desta tela; o celular segue coberto por caixa-de-entrada.spec.ts.
test("caixa de entrada: pastas e faixa de filtros como no original, estado vazio e encerrar conversa", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "o original não tem versão de celular da caixa de entrada")
  const t = novoTag(), canal = `e2e-canal-${t}`, conv = `e2e-par-${t}`, sobrenome = `Paridade${t}`
  sql([...canalE2eSql(canal), ...contatoSql({ id: `e2e-par-${t}`, canal, nome: "Dora", sobrenome, conversa: { id: conv, mensagens: [{ id: `e2e-p1-${t}`, texto: `Olá ${t}` }] } })])
  try {
    await page.goto(`/${WORKSPACE}/inbox`)
    const pastas = page.getByRole("navigation", { name: "Filtrar conversas por pasta" })
    for (const nome of [/^Todas as conversas/, /^Não atribuído/, /^Atribuídas a mim/, /^Lembretes/]) await expect(pastas.getByRole("button", { name: nome })).toBeVisible()

    // Equipe é um grupo recolhível: Todos, Você e cada pessoa.
    const equipe = pastas.getByRole("button", { name: "Equipe", exact: true })
    await expect(equipe).toHaveAttribute("aria-expanded", "true")
    await expect(pastas.getByRole("button", { name: /^Todos/ })).toBeVisible()
    await equipe.click()
    await expect(pastas.getByRole("button", { name: /^Todos/ })).toHaveCount(0)
    await equipe.click()
    await expect(pastas.getByRole("button", { name: /^Todos/ })).toBeVisible()

    // Faixa de filtros: abertas por padrão, "Não lidas" é botão, classificar, canais e "+ Filtro".
    const faixa = page.getByRole("toolbar", { name: "Filtros das conversas" })
    await expect(faixa.getByRole("combobox", { name: "Situação" })).toContainText("Conversas abertas")
    await expect(faixa.getByRole("button", { name: "Não lidas" })).toHaveAttribute("aria-pressed", "false")
    await expect(faixa.getByRole("combobox", { name: "Canal" })).toContainText("Todos os canais")
    await expect(faixa.getByRole("combobox", { name: "Ordenar" })).toContainText("Mais recentes")
    await expect(faixa.getByRole("button", { name: "Filtro", exact: true })).toBeVisible()

    // Sem conversa aberta: estado vazio com o botão para as configurações.
    await expect(page.getByRole("heading", { name: /Este é um espaço para conversar com seus contatos/ })).toBeVisible()
    await expect(page.getByRole("button", { name: "Ir para as configurações da caixa de entrada" })).toBeVisible()

    // Encerrar tira a conversa da lista de abertas e ela aparece em "Conversas encerradas".
    const linha = page.getByRole("button", { name: new RegExp(`Dora ${sobrenome},`) })
    await page.getByRole("textbox", { name: /Buscar conversa/ }).fill(sobrenome)
    await linha.click()
    await page.getByRole("button", { name: "Encerrar", exact: true }).click()
    await expect(page.getByRole("button", { name: "Reabrir", exact: true })).toBeVisible()
    await expect(linha).toHaveCount(0)
    await faixa.getByRole("combobox", { name: "Situação" }).click()
    await page.getByRole("option", { name: "Conversas encerradas" }).click()
    await expect(linha).toBeVisible()

    // A engrenagem do topo e o botão do estado vazio levam às configurações da caixa de entrada.
    await page.getByRole("banner").getByRole("button", { name: "Configurações da caixa de entrada" }).click()
    await expect(page).toHaveURL(new RegExp(`/${WORKSPACE}/settings/inbox$`))
    await page.goto(`/${WORKSPACE}/inbox`)
    await page.getByRole("button", { name: "Ir para as configurações da caixa de entrada" }).click()
    await expect(page).toHaveURL(new RegExp(`/${WORKSPACE}/settings/inbox$`))
  } finally {
    sql(limpezaSql())
  }
})
