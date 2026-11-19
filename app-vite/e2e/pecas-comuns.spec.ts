import { test, expect } from "./fixtures"
import { caminhoPrint } from "./helpers"

test.beforeEach(async ({ page }) => {
  await page.goto("/design")
})

test("Escolher existente: busca, setas, Enter escolhe e Esc fecha, só com o teclado", async ({ page }) => {
  await page.getByRole("button", { name: "Escolher automação", exact: true }).click()
  const busca = page.getByRole("combobox", { name: "Buscar automação" })
  await expect(busca).toBeFocused()
  const lista = page.getByRole("listbox", { name: "Escolher automação existente" })
  await expect(lista.getByRole("option")).toHaveCount(3)
  await expect(page.getByRole("region", { name: "Prévia" })).toContainText("Envia uma saudação")

  await page.keyboard.press("ArrowDown")
  await expect(lista.getByRole("option", { name: /Carrinho abandonado/ })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("region", { name: "Prévia" })).toContainText("lembra do carrinho")

  await busca.fill("pascoa")
  await expect(lista.getByRole("option")).toHaveCount(1)
  await page.keyboard.press("Enter")
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect(page.getByText("Escolhida: Promoção de Páscoa")).toBeVisible()

  await page.getByRole("button", { name: "Escolher automação", exact: true }).click()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect(page.getByText("Escolhida: Promoção de Páscoa")).toBeVisible()
})

test("barra inferior do painel: interruptor e ações com nome, corpo rola acima", async ({ page }) => {
  const barra = page.getByRole("group", { name: "Ações do painel" })
  const interruptor = barra.getByRole("switch", { name: "Ativa" })
  await expect(interruptor).toBeChecked()
  await interruptor.click()
  await expect(interruptor).not.toBeChecked()
  await barra.getByRole("button", { name: "Salvar" }).click()
  await expect(page.getByText("Última ação: Salvar")).toBeVisible()
  await expect(barra).toBeInViewport()
  const corpo = page.getByRole("region", { name: "Palavra-chave" })
  await corpo.getByText("Linha 12 do corpo").scrollIntoViewIfNeeded()
  await expect(barra).toBeInViewport()
})

test("menu ⋮ de linha tem nome por item e abre as ações", async ({ page }) => {
  await page.getByRole("button", { name: "Mais ações de Carrinho abandonado" }).click()
  await expect(page.getByRole("menuitem", { name: "Duplicar" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("menuitem", { name: "Duplicar" })).toBeHidden()
  await expect(page.getByRole("button", { name: "Mais ações de Boas-vindas" })).toBeVisible()
})

test("faixa de abas fica numa linha e rola na horizontal no celular", { tag: "@celular" }, async ({ page }, info) => {
  const abas = page.getByRole("tablist", { name: "Seções de automação" })
  const tabs = abas.getByRole("tab")
  await expect(tabs).toHaveCount(7)
  const topos = await tabs.evaluateAll(els => new Set(els.map(e => Math.round(e.getBoundingClientRect().top))).size)
  expect(topos).toBe(1)
  if (info.project.name === "mobile") {
    const rola = await abas.evaluate(el => el.parentElement!.scrollWidth > el.parentElement!.clientWidth)
    expect(rola).toBe(true)
    await page.getByRole("tab", { name: "Modelos" }).scrollIntoViewIfNeeded()
    await expect(page.getByRole("tab", { name: "Modelos" })).toBeInViewport()
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test("print das quatro peças na galeria", { tag: "@celular" }, async ({ page }, info) => {
  test.skip(process.env.E2E_CAPTURE_SCREENS !== "1", "só com E2E_CAPTURE_SCREENS=1")
  await page.setViewportSize(info.project.name === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 })
  await page.getByRole("button", { name: "Escolher automação", exact: true }).click()
  await page.screenshot({ path: caminhoPrint(`clone-screens/repintura/01-escolher-existente-${info.project.name}.png`), animations: "disabled" })
  await page.keyboard.press("Escape")
  await page.getByRole("heading", { name: "Barra inferior do painel" }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: caminhoPrint(`clone-screens/repintura/01-barra-menu-abas-${info.project.name}.png`), animations: "disabled", fullPage: true })
})
