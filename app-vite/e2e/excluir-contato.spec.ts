import { test, expect } from "./fixtures"
import { WORKSPACE, canalE2eSql, contatoSql, limpezaSql, novoTag, sql } from "./helpers"

test.describe("Excluir contato", () => {
  test("some da lista e não vira 'Contato sem identificação'", async ({ page }) => {
    const t = novoTag(), canal = `e2e-canal-${t}`, id = `e2e-del-${t}`
    sql([...canalE2eSql(canal), ...contatoSql({ id, canal, nome: "Excluir", sobrenome: `Alvo${t}` })])
    try {
      await page.goto(`/${WORKSPACE}/contacts`)
      const busca = page.getByRole("textbox", { name: "Buscar contato" })
      await busca.fill(`Alvo${t}`)
      await page.getByRole("button", { name: `Excluir Alvo${t}` }).click()

      const perfil = page.getByRole("dialog")
      await perfil.getByRole("button", { name: "Mais ações do contato" }).click()
      await page.getByRole("menuitem", { name: "Excluir contato" }).click()
      const confirmar = page.getByRole("dialog", { name: "Excluir contato" }).last()
      await confirmar.getByLabel("Digite EXCLUIR para confirmar").fill("EXCLUIR")
      await confirmar.getByRole("button", { name: "Excluir dados" }).click()
      await expect(page.getByText("Dados do contato excluídos.")).toBeVisible()

      // Sumiu da busca pelo nome...
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await expect(page.getByRole("row", { name: new RegExp(`Alvo${t}`) })).toHaveCount(0)
      // ...e com a lista inteira (sem filtro) não sobra nenhuma linha "sem identificação".
      await busca.fill("")
      await expect(page.getByRole("table", { name: "Contatos" })).toBeVisible()
      await expect(page.getByText("Contato sem identificação")).toHaveCount(0)
      await page.reload()
      await expect(page.getByRole("table", { name: "Contatos" })).toBeVisible()
      await expect(page.getByText("Contato sem identificação")).toHaveCount(0)
    } finally {
      sql(limpezaSql())
    }
  })
})
