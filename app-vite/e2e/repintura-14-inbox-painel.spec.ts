import { test, expect } from "./fixtures"
import type { Page } from "@playwright/test"
import { WORKSPACE } from "./helpers"

// Ação da barra do topo: botão no desktop, item do menu ⋮ ("Mais ações") no celular.
async function acaoDaBarra(page: Page, nome: string) {
  const barra = page.getByRole("banner")
  const botao = barra.getByRole("button", { name: nome })
  const menu = barra.getByRole("button", { name: "Mais ações" })
  await expect(botao.or(menu)).toBeVisible()
  if (await botao.isVisible()) return
  await barra.getByRole("button", { name: "Mais ações" }).click()
  await expect(page.getByRole("menuitem", { name: nome })).toBeVisible()
  await page.keyboard.press("Escape")
}

// Repintura (ficha 14): título e ações na barra do topo; nenhum título repetido no conteúdo.
test.describe("repintura 14: caixa de entrada e painel inicial", { tag: "@celular" }, () => {
  test("caixa de entrada: título e ação na barra do topo, filtros numa faixa só", async ({ page }) => {
    await page.goto(`/${WORKSPACE}/inbox`)
    const barra = page.getByRole("banner")
    await expect(barra.getByRole("heading", { level: 1, name: "Caixa de entrada" })).toBeVisible()
    await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toHaveCount(0)
    await acaoDaBarra(page, "Nova conversa")
    await expect(page.getByText("Converse com seus contatos e organize")).toHaveCount(0)
    // A busca fica no centro da barra do topo no desktop; no celular vai para a faixa de filtros.
    const busca = page.getByRole("textbox", { name: /Buscar conversa/ })
    await expect(busca).toBeVisible()
    await expect(page.getByRole("status").filter({ hasText: /Ao vivo|Conectando|Reconectando|Sem conexão|demonstração/i })).toBeVisible()
    await expect(page.getByText("Respostas são enviadas pelo canal conectado")).toHaveCount(0)
    const faixa = page.getByRole("toolbar", { name: "Filtros das conversas" })
    if (page.viewportSize()!.width >= 640) await expect(barra.getByRole("textbox", { name: /Buscar conversa/ })).toBeVisible()
    else await expect(faixa.getByRole("textbox", { name: /Buscar conversa/ })).toBeVisible()
    await expect(faixa.getByRole("button", { name: /não lidas/i })).toBeVisible()
    await expect(faixa.getByRole("button", { name: "Filtro", exact: true })).toBeVisible()
  })

  test("painel inicial: título e ação na barra do topo, canal em abas", async ({ page }) => {
    await page.goto(`/${WORKSPACE}/dashboard`)
    const barra = page.getByRole("banner")
    await expect(barra.getByRole("heading", { level: 1, name: "Início" })).toBeVisible()
    await page.getByRole("button", { name: "Pular" }).click({ timeout: 3000 }).catch(() => {})
    await acaoDaBarra(page, "Atualizar resumo")
    await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toHaveCount(0)
    const abas = page.getByRole("tablist", { name: "Canal" })
    await expect(abas.getByRole("tab", { name: "Todos os canais" })).toHaveAttribute("aria-selected", "true")
    await abas.getByRole("tab", { name: "Telegram" }).click()
    await expect(abas.getByRole("tab", { name: "Telegram" })).toHaveAttribute("aria-selected", "true")
  })
})
