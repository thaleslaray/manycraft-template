import { test, expect } from "./fixtures"
import { WORKSPACE, ENGINE, caminhoPrint, sql, contatoSql, limpezaSql } from "./helpers"

type Conexao = { id: string; kind: string; displayName: string | null; label: string }

const lerConexoes = async (): Promise<Conexao[]> =>
  (await fetch(`${ENGINE}/api/connections`, { headers: { "x-workspace": WORKSPACE } })).json()

test("Insights: perfil da conta, um cartão por canal, Adicionar canal e Desempenho", { tag: "@celular" }, async ({ page }, info) => {
  const desktop = info.project.name === "desktop"
  await page.setViewportSize(desktop ? { width: 1440, height: 900 } : { width: 390, height: 844 })
  const conexoes = await lerConexoes()
  const conta = (await (await fetch(`${ENGINE}/api/workspace-settings`, { headers: { "x-workspace": WORKSPACE } })).json()).name as string

  await page.goto(`/${WORKSPACE}/insights`)

  // Título na barra do topo: migalha "Início › Insights"
  const migalha = page.getByRole("navigation", { name: "Você está em" })
  await expect(migalha.getByRole("link", { name: "Início", exact: true })).toBeVisible()
  await expect(migalha.getByText("Insights", { exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "Insights", exact: true }).first()).toBeVisible()

  // Perfil: nome da conta com lápis que leva a Configurações › Geral
  await expect(page.getByRole("heading", { level: 1, name: conta })).toBeVisible()
  await page.getByRole("link", { name: "Editar conta" }).click()
  await expect(page).toHaveURL(new RegExp(`/${WORKSPACE}/settings\\?editar=conta$`))
  await page.goBack()

  // Canais: um cartão por conexão, com nome e total de contatos
  await expect(page.getByRole("heading", { level: 2, name: "Canais", exact: true })).toBeVisible()
  expect(conexoes.length).toBeGreaterThan(0)
  for (const c of conexoes) {
    const cartao = page.getByRole("article", { name: c.displayName ?? c.label, exact: true })
    await expect(cartao).toBeVisible()
    await expect(cartao.getByRole("group", { name: "Contatos", exact: true })).toHaveText(/^Contatos\s*\d[\d.]*$/)
  }

  // Desempenho: números e gráfico de antes, com seletores do sistema
  await expect(page.getByRole("heading", { level: 2, name: "Desempenho", exact: true })).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Período" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Contatos com atividade" })).toBeVisible()

  await page.screenshot({ path: caminhoPrint(`insights/insights-${desktop ? "desktop" : "mobile"}.png`) })

  // Cartão tracejado leva à conexão de canais
  await page.getByRole("link", { name: "Adicionar canal" }).click()
  await expect(page).toHaveURL(new RegExp(`/${WORKSPACE}/settings/channels`))
})

test("Insights: duas conexões do mesmo canal mostram totais de contatos diferentes", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "mesma tela, medida no desktop")
  const canais = [["e2e-ig-norte", "Instagram e2e Loja Norte", 3], ["e2e-ig-sul", "Instagram e2e Loja Sul", 1]] as const
  try {
    sql([
      ...canais.map(([id, nome]) => `INSERT OR IGNORE INTO channels(id,workspace_id,type,external_id,status,display_name) VALUES ('${id}','${WORKSPACE}','instagram','${id}-ext','connected','${nome}')`),
      ...canais.flatMap(([id, , total]) => Array.from({ length: total }, (_, i) =>
        contatoSql({ id: `e2e-${id}-${i}`, canal: id, nome: `Pessoa ${i}`, sobrenome: id }))).flat(),
    ])
    await page.goto(`/${WORKSPACE}/insights`)
    for (const [, nome, total] of canais) {
      const cartao = page.getByRole("article", { name: nome, exact: true })
      await expect(cartao).toBeVisible()
      await expect(cartao.getByRole("group", { name: "Contatos", exact: true })).toHaveText(new RegExp(`^Contatos\\s*${total}$`))
    }
  } finally {
    sql(limpezaSql())
  }
})
