import { test, expect } from "./fixtures"
import { WORKSPACE, api, consulta, sql } from "./helpers"

// Configurações no padrão de linhas do original: rótulo, controle à esquerda e ajuda à direita.
test.describe("Configurações: Geral e canais em linhas", () => {
  test("Geral: uma linha por assunto, fuso salvo na hora e ações perigosas atrás de pop-up", async ({ page }) => {
    const fuso = consulta<{ timezone: string }>(`SELECT timezone FROM workspaces WHERE id='${WORKSPACE}'`)[0]?.timezone
    try {
      await page.goto(`/${WORKSPACE}/settings`)
      const linhas = page.getByRole("group", { name: "Geral" })
      for (const rotulo of ["Nome e foto da conta", "Fuso horário", "Encurtamento de link", "Copiar conta", "Usar como modelo", "Modo agência", "Sair da conta", "Excluir conta"]) {
        await expect(linhas.getByText(rotulo, { exact: true })).toBeVisible()
      }
      // O dono não sai: o botão fica desligado e a ajuda aponta para a equipe.
      await expect(linhas.getByRole("button", { name: "Sair", exact: true })).toBeDisabled()
      await expect(linhas.getByRole("link", { name: "equipe" })).toBeVisible()

      const novo = fuso === "America/Manaus" ? "America/Recife" : "America/Manaus"
      await linhas.getByRole("combobox", { name: "Fuso horário" }).click()
      await page.getByRole("option", { name: novo }).click()
      await expect(page.getByText("Fuso horário salvo.").first()).toBeVisible()
      await page.reload()
      await expect(page.getByRole("group", { name: "Geral" }).getByRole("combobox", { name: "Fuso horário" })).toContainText(novo.replace("_", " "))

      await linhas.getByRole("button", { name: "Copiar esta conta" }).click()
      const copiar = page.getByRole("dialog", { name: "Copiar esta conta" })
      await expect(copiar.getByRole("button", { name: "Clonar" })).toBeDisabled()
      await copiar.getByRole("button", { name: "Cancelar" }).click()

      await page.getByRole("button", { name: "Apagar minha conta" }).click()
      const excluir = page.getByRole("dialog", { name: "Excluir minha conta" })
      await expect(excluir.getByRole("button", { name: "Excluir conta" })).toBeDisabled()
      await excluir.getByLabel("Digite EXCLUIR para confirmar").fill("EXCLUIR")
      await expect(excluir.getByRole("button", { name: "Excluir conta" })).toBeEnabled()
      await excluir.getByRole("button", { name: "Cancelar" }).click()
      await expect(excluir).toHaveCount(0)
    } finally {
      if (fuso) sql([`UPDATE workspaces SET timezone='${fuso}' WHERE id='${WORKSPACE}'`])
    }
  })

  test("Instagram: cartão da conta e linhas que levam ao que já existe", async ({ page }) => {
    await page.goto(`/${WORKSPACE}/settings/channels/instagram`)
    await expect(page.getByRole("heading", { name: "Instagram", level: 2 })).toBeVisible()
    const linhas = page.getByRole("group", { name: /^Conexão / })
    for (const rotulo of ["Resposta padrão", "Menu principal", "Iniciadores de conversa", "Cumprimento de novos seguidores", "Webhook", "Gerenciar conexão"]) {
      await expect(linhas.getByText(rotulo, { exact: true })).toBeVisible()
    }
    await linhas.getByRole("link", { name: "Configurar resposta padrão" }).click()
    await expect(page).toHaveURL(new RegExp(`/${WORKSPACE}/automations/basic$`))
    await expect(page.getByRole("heading", { name: "Automações básicas" })).toBeVisible()
  })

  test("E-mail: cartão do canal, tabela Enviar de e dados da empresa em pop-up", async ({ page }) => {
    const antes = await api<{ company: { name: string; address: string } }>("/api/email/settings")
    try {
      await page.goto(`/${WORKSPACE}/settings/email`)
      await expect(page.getByRole("group", { name: "Canal de e-mail" }).getByText("Habilitado", { exact: true })).toBeVisible()
      await expect(page.getByRole("region", { name: "Enviar de" }).getByRole("button", { name: "Novo endereço" })).toBeVisible()
      await page.getByRole("button", { name: "Editar informações do contato" }).click()
      const contato = page.getByRole("dialog", { name: "Informações do contato" })
      await contato.getByLabel("Nome da empresa").fill("Oficina de estudo")
      await contato.getByLabel("Endereço da empresa").fill("Rua de teste, 10")
      await contato.getByRole("button", { name: "Salvar dados da empresa" }).click()
      await expect(page.getByText("Dados da empresa salvos.").first()).toBeVisible()
      await expect(page.getByRole("group", { name: "Canal de e-mail" }).getByText("Oficina de estudo", { exact: true })).toBeVisible()
    } finally {
      await api("/api/email/settings", { method: "PATCH", body: JSON.stringify({ company: antes.company }) })
    }
  })
})
