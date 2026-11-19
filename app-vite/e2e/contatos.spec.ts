import { test, expect } from "./fixtures"
import { FOTO_PNG, WORKSPACE, canalE2eSql, consulta, contatoSql, limpezaSql, novoTag, sql } from "./helpers"

test.describe("Contatos", { tag: "@celular" }, () => {
  test("edições do perfil persistem ao recarregar e no D1", async ({ page }) => {
    const t = novoTag(), canal = `e2e-canal-${t}`, id = `e2e-perfil-${t}`
    const field = `e2e-campo-${t}`, tagName = `Interesse ${t}`
    sql([...canalE2eSql(canal), ...contatoSql({ id, canal, nome: "Maria", sobrenome: `Perfil${t}` }),
      `INSERT INTO custom_fields(id,workspace_id,name,type) VALUES ('${field}','${WORKSPACE}','Cidade ${t}','text')`])
    try {
      await page.goto(`/${WORKSPACE}/contacts?contact=${id}`)
      const perfil = page.getByRole("dialog")
      await perfil.getByRole("button", { name: "Editar Primeiro nome:" }).click()
      await perfil.getByRole("textbox", { name: "Primeiro nome", exact: true }).fill("Mariana")
      await perfil.getByRole("textbox", { name: "Primeiro nome", exact: true }).press("Enter")
      await expect(perfil.getByRole("heading", { name: `Mariana Perfil${t}` })).toBeVisible()
      await perfil.getByRole("button", { name: `Editar Cidade ${t}:` }).click()
      await perfil.getByRole("textbox", { name: `Cidade ${t}`, exact: true }).fill("Recife")
      await perfil.getByRole("textbox", { name: `Cidade ${t}`, exact: true }).press("Enter")
      await expect(perfil.getByRole("button", { name: `Editar Cidade ${t}: Recife` })).toBeVisible()
      await perfil.getByRole("button", { name: "Adicionar tag", exact: true }).click()
      await page.getByRole("combobox", { name: "Buscar ou criar tag" }).fill(tagName)
      await page.getByRole("option", { name: `Criar tag «${tagName}»` }).click()
      await expect(perfil.getByRole("button", { name: `Remover tag ${tagName}` })).toBeVisible()
      await perfil.getByRole("button", { name: "Pausar automação", exact: true }).click()
      await expect(perfil.getByText(/^Pausadas até/)).toBeVisible()
      await perfil.getByRole("button", { name: "Cancelar inscrição", exact: true }).click()
      await expect(perfil.getByRole("button", { name: "Reinscrever", exact: true })).toBeVisible()
      await page.reload()
      await expect(perfil.getByRole("heading", { name: `Mariana Perfil${t}` })).toBeVisible()
      await expect(perfil.getByRole("button", { name: `Remover tag ${tagName}` })).toBeVisible()
      await expect(perfil.getByRole("button", { name: `Editar Cidade ${t}: Recife` })).toBeVisible()
      await expect(perfil.getByText(/^Pausadas até/)).toBeVisible()
      await expect(perfil.getByRole("button", { name: "Reinscrever", exact: true })).toBeVisible()
      await expect(perfil.getByRole("region", { name: "Inscrição por conexão" })).toContainText("Canal de teste e2e")
      await expect(perfil.getByRole("region", { name: "Inscrição por conexão" })).toContainText("Inscrição cancelada")
      const saved = consulta<{ first_name: string; status: string; automation_paused_until: number }>(`SELECT first_name,status,automation_paused_until FROM contacts WHERE id='${id}'`)[0]
      expect(saved.first_name).toBe("Mariana")
      expect(saved.status).toBe("unsubscribed")
      expect(saved.automation_paused_until).toBeGreaterThan(Date.now())
      expect(consulta(`SELECT value FROM contact_field_values WHERE contact_id='${id}' AND field_id='${field}'`)).toEqual([{ value: '"Recife"' }])
      expect(consulta(`SELECT t.name FROM contact_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.contact_id='${id}'`)).toEqual([{ name: tagName }])
      await perfil.getByRole("button", { name: `Remover tag ${tagName}` }).click()
      await expect(perfil.getByRole("button", { name: `Remover tag ${tagName}` })).toHaveCount(0)
      await perfil.getByRole("button", { name: "Retomar automação", exact: true }).click()
      await expect(perfil.getByText(/^Pausadas até/)).toHaveCount(0)
      await perfil.getByRole("button", { name: "Reinscrever", exact: true }).click()
      await expect(perfil.getByRole("button", { name: "Cancelar inscrição", exact: true })).toBeVisible()
      await page.reload()
      await expect(perfil.getByRole("button", { name: "Cancelar inscrição", exact: true })).toBeVisible()
      await expect(perfil.getByText(/^Pausadas até/)).toHaveCount(0)
      expect(consulta(`SELECT status,automation_paused_until FROM contacts WHERE id='${id}'`)).toEqual([{ status: "subscribed", automation_paused_until: null }])
      expect(consulta(`SELECT * FROM contact_tags WHERE contact_id='${id}'`)).toEqual([])
    } finally { sql([...limpezaSql(), `DELETE FROM custom_fields WHERE id='${field}'`, `DELETE FROM tags WHERE workspace_id='${WORKSPACE}' AND name='${tagName}'`]) }
  })

  test("filtro abre como faixa acima da tabela e o perfil é um pop-up de duas colunas", async ({ page }) => {
    const t = novoTag(), canal = `e2e-canal-${t}`, id = `e2e-faixa-${t}`
    sql([...canalE2eSql(canal), ...contatoSql({ id, canal, nome: "Faixa", sobrenome: `Perfil${t}` })])
    try {
      await page.goto(`/${WORKSPACE}/contacts`)
      // No desktop as duas ações ficam no topo; no celular vão para o menu ⋮ da lista.
      if ((page.viewportSize()?.width ?? 1440) >= 640) {
        await expect(page.getByRole("button", { name: "Criar novo contato", exact: true })).toBeVisible()
        await expect(page.getByRole("button", { name: "Importar", exact: true })).toBeVisible()
      }
      for (const titulo of ["Segmentos", "Tags"]) await expect(page.getByRole("heading", { name: titulo, exact: true })).toBeVisible()
      await expect(page.getByRole("columnheader", { name: "Imagem do perfil" })).toBeVisible()
      // Filtro: faixa tracejada "+ Condição" no corpo da página, nunca um pop-up.
      await page.getByRole("button", { name: "Filtrar contatos", exact: true }).click()
      const faixa = page.getByRole("region", { name: "Filtro de contatos" })
      await expect(faixa.getByRole("button", { name: "+ Condição", exact: true })).toBeVisible()
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await expect(faixa.getByRole("region", { name: "Construtor de filtro" })).toHaveCount(0)
      await faixa.getByRole("button", { name: "+ Condição", exact: true }).click()
      await expect(faixa.getByRole("region", { name: "Construtor de filtro" })).toBeVisible()
      await page.getByRole("button", { name: "Filtrar contatos", exact: true }).click()
      await expect(faixa).toHaveCount(0)
      // Perfil: pop-up com as duas colunas e os blocos do original.
      await page.goto(`/${WORKSPACE}/contacts?contact=${id}`)
      const perfil = page.getByRole("dialog")
      await expect(perfil.getByRole("button", { name: "Pausar automação", exact: true })).toBeVisible()
      for (const bloco of ["Tags do contato", "Inscrito nas sequências", "Optou por aderir", "Campos do sistema"]) await expect(perfil.getByRole("heading", { name: bloco, exact: true })).toBeVisible()
      await expect(perfil.getByRole("button", { name: "Assinar", exact: true })).toBeVisible()
      await expect(perfil.getByRole("button", { name: "Adicionar tag", exact: true })).toBeVisible()
      // Lateral do perfil: a pausa logo sob a foto, o canal em "Optou pelo ..." e "Abrir conversa" como ação secundária, mais abaixo.
      await expect(perfil.getByText("Optou pelo Telegram", { exact: true })).toBeVisible()
      const pausa = await perfil.getByRole("button", { name: "Pausar automação", exact: true }).boundingBox()
      const conversa = await perfil.getByRole("button", { name: "Abrir conversa", exact: true }).boundingBox()
      expect(conversa!.y).toBeGreaterThan(pausa!.y + pausa!.height)
    } finally { sql(limpezaSql()) }
  })

  test("atendente pausa a automação no perfil, vê o estado e retoma", async ({ page }) => {
    const t = novoTag(), canal = `e2e-canal-${t}`, id = `e2e-atendente-${t}`
    sql([...canalE2eSql(canal), ...contatoSql({ id, canal, nome: "Paula", sobrenome: `Atende${t}` })])
    try {
      // O painel enxerga o papel de atendente da caixa; a recusa para o leitor é testada no motor.
      await page.route("**/api/session/workspace", async route => {
        const resposta = await route.fetch()
        await route.fulfill({ response: resposta, json: { ...(await resposta.json()), role: "livechat_agent" } })
      })
      await page.goto(`/${WORKSPACE}/contacts?contact=${id}`)
      const perfil = page.getByRole("dialog")
      const pausar = perfil.getByRole("button", { name: "Pausar automação", exact: true })
      await expect(pausar).toBeEnabled()
      await expect(perfil.getByRole("button", { name: "Cancelar inscrição", exact: true })).toBeDisabled()
      await pausar.click()
      await expect(perfil.getByText(/^Pausadas até/)).toBeVisible()
      await perfil.getByRole("button", { name: "Retomar automação", exact: true }).click()
      await expect(perfil.getByText(/^Pausadas até/)).toHaveCount(0)
      await expect(perfil.getByRole("button", { name: "Pausar automação", exact: true })).toBeEnabled()
      expect(consulta<{ automation_paused_until: number | null }>(`SELECT automation_paused_until FROM contacts WHERE id='${id}'`)[0].automation_paused_until).toBeNull()
    } finally { sql(limpezaSql()) }
  })

  test("adiciona e remove tag em lote em contatos reais", async ({ page }) => {
    const t = novoTag(), canal = `e2e-canal-${t}`, tag = `e2e-tag-${t}`, ids = [`e2e-lote-a-${t}`, `e2e-lote-b-${t}`]
    sql([...canalE2eSql(canal), ...ids.flatMap((id, i) => contatoSql({ id, canal, nome: `Pessoa ${i + 1}`, sobrenome: `Lote${t}` })),
      `INSERT INTO tags(id,workspace_id,name) VALUES ('${tag}','${WORKSPACE}','Lote ${t}')`])
    try {
      await page.goto(`/${WORKSPACE}/contacts`)
      await page.getByRole("textbox", { name: "Buscar contato" }).fill(`Lote${t}`)
      await expect(page.getByRole("button", { name: `Pessoa 1 Lote${t}`, exact: true })).toBeVisible()
      await expect(page.getByRole("button", { name: `Pessoa 2 Lote${t}`, exact: true })).toBeVisible()
      for (const [action, expected] of [["Adicionar tag…", 2], ["Remover tag…", 0]] as const) {
        // A busca deve terminar antes de selecionar todas as linhas visíveis.
        await expect(page.getByRole("table").getByRole("checkbox")).toHaveCount(3)
        await page.getByRole("checkbox", { name: "Selecionar todos", exact: true }).check()
        await page.getByRole("button", { name: "Ações em lote", exact: true }).click()
        await page.getByRole("menuitem", { name: action, exact: true }).click()
        const dialog = page.getByRole("dialog")
        await dialog.getByRole("combobox", { name: "Tag", exact: true }).click()
        await page.getByRole("option", { name: `Lote ${t}`, exact: true }).click()
        await dialog.getByRole("button", { name: "Aplicar", exact: true }).click()
        await expect(dialog).toHaveCount(0)
        await page.reload()
        expect(consulta(`SELECT contact_id FROM contact_tags WHERE tag_id='${tag}' ORDER BY contact_id`)).toEqual(expected ? ids.map(contact_id => ({ contact_id })) : [])
        expect(consulta(`SELECT contact_count FROM tags WHERE id='${tag}'`)).toEqual([{ contact_count: expected }])
        await page.getByRole("textbox", { name: "Buscar contato" }).fill(`Lote${t}`)
        await expect(page.getByRole("button", { name: `Pessoa 2 Lote${t}`, exact: true })).toBeVisible()
      }
    } finally { sql([...limpezaSql(), `DELETE FROM tags WHERE id='${tag}'`]) }
  })

  test("lista mostra foto, iniciais e filtra pela busca", async ({ page }, info) => {
    const t = novoTag(), canal = `e2e-canal-${t}`
    sql([...canalE2eSql(canal),
      ...contatoSql({ id: `e2e-foto-${t}`, canal, nome: "Maria", sobrenome: `Foto${t}`, foto: FOTO_PNG }),
      ...contatoSql({ id: `e2e-sem-${t}`, canal, nome: "Joao", sobrenome: `Sem${t}` })])
    try {
      await page.goto(`/${WORKSPACE}/contacts`)
      await page.getByRole("textbox", { name: "Buscar contato" }).fill(t)
      const comFoto = page.getByRole("row", { name: new RegExp(`Foto${t}`) })
      const semFoto = page.getByRole("row", { name: new RegExp(`Sem${t}`) })
      await expect(comFoto).toBeVisible()
      await expect(semFoto).toBeVisible()

      // A coluna de avatar só aparece a partir de 640px (classe "hidden sm:grid").
      if ((info.project.use.viewport?.width ?? 0) >= 640) {
        const img = comFoto.locator("img")
        await expect(img).toHaveCount(1)
        await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true)
        await expect(semFoto.locator("img")).toHaveCount(0)
        await expect(semFoto.getByText("JS", { exact: true })).toBeVisible()
      }

      // Busca por nome específico filtra a lista para um contato só.
      await page.getByRole("textbox", { name: "Buscar contato" }).fill(`Sem${t}`)
      await expect(comFoto).toHaveCount(0)
      await expect(semFoto).toBeVisible()
    } finally {
      sql(limpezaSql())
    }
  })
})
