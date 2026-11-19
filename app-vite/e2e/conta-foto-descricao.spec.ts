import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { WORKSPACE, FOTO_PNG, guardarConta } from "./helpers"

// As jornadas que mexem na foto e na descrição da conta (Configurações e Insights) ficam neste arquivo, em série, e devolvem o que havia.
test.describe.configure({ mode: "serial" })

// Em Configurações › Geral o nome, a foto e a descrição moram no pop-up da linha "Nome e foto da conta".
const abrirConta = async (page: Page) => {
  await page.getByRole("button", { name: "Editar nome e foto da conta" }).click()
  return page.getByRole("dialog", { name: "Nome e foto da conta" })
}

test("Configurações › Geral: enviar foto e descrição, ver depois de recarregar, e voltar para a inicial", async ({ page }) => {
  const descricao = "Estúdio de plantas e vasos"
  const restaurar = guardarConta()
  try {
    await page.goto(`/${WORKSPACE}/settings`)
    await expect(page.getByRole("img", { name: /^Conta sem foto, inicial / })).toBeVisible()

    let conta = await abrirConta(page)
    await conta.getByLabel("Foto da conta", { exact: true }).setInputFiles({ name: "conta.png", mimeType: "image/png", buffer: Buffer.from(FOTO_PNG.split(",")[1], "base64") })
    await expect(conta.getByRole("button", { name: "Remover foto" })).toBeVisible()
    await conta.getByRole("textbox", { name: "Descrição da conta" }).fill(descricao)
    await conta.getByRole("button", { name: "Salvar preferências" }).click()
    await expect(page.getByText("Preferências salvas.").first()).toBeVisible()
    await expect(conta).toHaveCount(0)

    const fotoServida = page.waitForResponse(r => r.url().includes("/api/workspace-settings/photo/"))
    await page.reload()
    expect((await fotoServida).status()).toBe(200)
    await expect(page.getByRole("img", { name: "Foto da conta", exact: true })).toBeVisible()
    conta = await abrirConta(page)
    await expect(conta.getByRole("textbox", { name: "Descrição da conta" })).toHaveValue(descricao)
    await expect(conta.getByRole("button", { name: "Trocar foto" })).toBeVisible()

    await conta.getByRole("button", { name: "Remover foto" }).click()
    await conta.getByRole("textbox", { name: "Descrição da conta" }).fill("")
    await conta.getByRole("button", { name: "Salvar preferências" }).click()
    await expect(page.getByText("Preferências salvas.").first()).toBeVisible()
    await expect(conta).toHaveCount(0)

    await page.reload()
    await expect(page.getByRole("img", { name: /^Conta sem foto, inicial / })).toBeVisible()
    conta = await abrirConta(page)
    await expect(conta.getByRole("textbox", { name: "Descrição da conta" })).toHaveValue("")
  } finally {
    restaurar()
  }
})

test("Configurações › Geral: a foto escolhida antes de as preferências terminarem de carregar não se perde", async ({ page }) => {
  const restaurar = guardarConta()
  try {
    // A leitura das preferências demora; o upload da foto não.
    await page.route("**/api/workspace-settings", async route => {
      if (route.request().method() === "GET") await new Promise(resolve => setTimeout(resolve, 2000))
      await route.continue()
    })
    const preferencias = page.waitForResponse(r => r.url().endsWith("/api/workspace-settings") && r.request().method() === "GET")
    await page.goto(`/${WORKSPACE}/settings`)
    const conta = await abrirConta(page)
    await conta.getByLabel("Foto da conta", { exact: true }).setInputFiles({ name: "conta.png", mimeType: "image/png", buffer: Buffer.from(FOTO_PNG.split(",")[1], "base64") })
    await expect(conta.getByRole("button", { name: "Remover foto" })).toBeVisible()
    await conta.getByRole("textbox", { name: "Descrição da conta" }).fill("Escrita antes do carregamento")
    // Depois que as preferências chegam, a foto e a descrição que acabei de pôr continuam na tela e são as que vão ser salvas.
    await preferencias
    // Deixa o painel pintar com as preferências recebidas (dois quadros) antes de conferir que o digitado ficou.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(conta.getByRole("textbox", { name: "Descrição da conta" })).toHaveValue("Escrita antes do carregamento")
    await expect(conta.getByRole("img", { name: "Foto da conta", exact: true })).toBeVisible()
    await expect(conta.getByRole("button", { name: "Remover foto" })).toBeVisible()
    await conta.getByRole("button", { name: "Salvar preferências" }).click()
    await expect(page.getByText("Preferências salvas.").first()).toBeVisible()
    await page.unroute("**/api/workspace-settings")
    await page.reload()
    await expect(page.getByRole("img", { name: "Foto da conta", exact: true })).toBeVisible()
  } finally {
    restaurar()
  }
})

test("Insights: foto e descrição editadas em Configurações › Geral aparecem no topo; sem foto, a inicial", async ({ page }) => {
  const descricao = "Estúdio de plantas e vasos"
  const restaurar = guardarConta()
  try {
    await page.goto(`/${WORKSPACE}/insights`)
    await expect(page.getByRole("img", { name: /^Conta sem foto, inicial / })).toBeVisible()

    // O lápis do Insights leva direto ao pop-up de nome e foto.
    await page.getByRole("link", { name: "Editar conta" }).click()
    const conta = page.getByRole("dialog", { name: "Nome e foto da conta" })
    await conta.getByLabel("Foto da conta", { exact: true }).setInputFiles({ name: "conta.png", mimeType: "image/png", buffer: Buffer.from(FOTO_PNG.split(",")[1], "base64") })
    await expect(conta.getByRole("button", { name: "Remover foto" })).toBeVisible()
    await conta.getByRole("textbox", { name: "Descrição da conta" }).fill(descricao)
    await conta.getByRole("button", { name: "Salvar preferências" }).click()
    await expect(page.getByText("Preferências salvas.").first()).toBeVisible()

    await page.getByRole("link", { name: "Insights", exact: true }).first().click()
    await expect(page.getByRole("img", { name: "Foto da conta", exact: true })).toBeVisible()
    await expect(page.getByText(descricao, { exact: true })).toBeVisible()
  } finally {
    restaurar()
  }
})
