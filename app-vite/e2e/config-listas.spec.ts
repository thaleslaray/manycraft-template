import { test, expect } from "./fixtures"
import { appsMenuHidden, installedTemplatesMenuHidden } from "../src/lib/hidden-features"
import { WORKSPACE, api, consulta, novoTag, q, sql } from "./helpers"

// Configurações em lista (ticket 16 da paridade): Campos com Descrição, Aplicativos com pop-up, Registros com Filtros,
// Atribuição e Notificações que gravam na hora, Modelos instalados com o ⋮.
test.describe("Configurações: listas e equipe", () => {
  test("Campos: a coluna Descrição mostra o texto e convida a adicionar quando está vazia", async ({ page }) => {
    const sufixo = novoTag(), comTexto = `com-descricao-${sufixo}`, semTexto = `sem-descricao-${sufixo}`
    await api("/api/fields", { method: "POST", body: JSON.stringify({ name: comTexto, type: "text", description: "Guarda o bairro do cliente" }) })
    await api("/api/fields", { method: "POST", body: JSON.stringify({ name: semTexto, type: "text" }) })
    try {
      await page.goto(`/${WORKSPACE}/settings/fields`)
      await page.getByRole("textbox", { name: "Buscar campos" }).fill(sufixo)
      const linhaCom = page.getByRole("listitem").filter({ has: page.getByText(comTexto, { exact: true }) })
      await expect(linhaCom.getByText("Guarda o bairro do cliente")).toBeVisible()
      await page.getByRole("button", { name: `Adicionar descrição de ${semTexto}` }).click()
      const pop = page.getByRole("dialog")
      await pop.getByRole("textbox", { name: "Descrição" }).fill("Preenchido pela coluna")
      await pop.getByRole("button", { name: "Salvar campo" }).click()
      await expect(pop).toHaveCount(0)
      await expect(page.getByRole("button", { name: `Editar descrição de ${semTexto}` })).toContainText("Preenchido pela coluna")
      expect(consulta<{ description: string }>(`SELECT description FROM custom_fields WHERE workspace_id='${WORKSPACE}' AND name='${q(semTexto)}'`)[0]?.description).toBe("Preenchido pela coluna")
    } finally {
      sql([`DELETE FROM custom_fields WHERE workspace_id='${WORKSPACE}' AND name LIKE '%-descricao-${sufixo}'`])
    }
  })

  test("Aplicativos: o botão abre o pop-up de instalação, a tabela mostra a versão e a lixeira remove", async ({ page }) => {
    test.skip(appsMenuHidden, "Aplicativos está oculto (src/lib/hidden-features.ts); volta junto com o menu")
    const nome = `App de teste ${novoTag()}`
    const spec = { name: nome, version: "2.7", actions: [{ name: "consultar", label: "Consultar", form: [], requests: [{ method: "GET", url: "https://api.example.test/x", headers: {} }], mapping: [] }], triggers: [], sources: {} }
    try {
      await page.goto(`/${WORKSPACE}/settings/apps`)
      await expect(page.getByRole("textbox", { name: "JSON do app" })).toHaveCount(0)
      await page.getByRole("button", { name: "Instalar aplicativo", exact: true }).click()
      const pop = page.getByRole("dialog", { name: "Instalar aplicativo" })
      await pop.getByRole("textbox", { name: "JSON do app" }).fill(JSON.stringify(spec))
      await pop.getByRole("button", { name: "Instalar app" }).click()
      await expect(pop).toHaveCount(0)
      const linha = page.getByRole("listitem").filter({ has: page.getByText(nome, { exact: true }) })
      await expect(linha.getByText("2.7", { exact: true })).toBeVisible()
      page.once("dialog", dialogo => void dialogo.accept())
      await linha.getByRole("button", { name: `Remover ${nome}` }).click()
      await expect(page.getByText(nome, { exact: true })).toHaveCount(0)
      expect(consulta(`SELECT id FROM installed_apps WHERE workspace_id='${WORKSPACE}' AND name='${q(nome)}'`)).toHaveLength(0)
    } finally {
      sql([`DELETE FROM installed_apps WHERE workspace_id='${WORKSPACE}' AND name='${q(nome)}'`])
    }
  })

  test("Registros: os filtros ficam atrás do botão Filtros", async ({ page }) => {
    await page.goto(`/${WORKSPACE}/settings/logs`)
    await expect(page.getByRole("combobox", { name: "Origem" })).toHaveCount(0)
    await page.getByRole("button", { name: /^Filtros/ }).click()
    await expect(page.getByRole("combobox", { name: "Origem" })).toBeVisible()
    await expect(page.getByRole("combobox", { name: "Nível" })).toBeVisible()
    await expect(page.getByRole("checkbox", { name: "Só erros" })).toBeVisible()
  })

  test("Atribuição automática: escolher o modo salva na hora e o limite tem o próprio botão", async ({ page }) => {
    const antes = await api<{ auto_assign: string; assign_limit: number | null }>("/api/inbox/assignment")
    try {
      await page.goto(`/${WORKSPACE}/settings/assignment`)
      await expect(page.getByRole("button", { name: "Salvar atribuição" })).toHaveCount(0)
      const outro = antes.auto_assign === "basic" ? "Desligado" : "Básico"
      await page.getByRole("radio", { name: new RegExp(`^${outro}`) }).check()
      await expect(page.getByText("Atribuição salva.").first()).toBeVisible()
      const depois = await api<{ auto_assign: string }>("/api/inbox/assignment")
      expect(depois.auto_assign).toBe(outro === "Básico" ? "basic" : "off")
      await page.getByRole("spinbutton", { name: "Limite de conversas abertas por atendente" }).fill("9")
      await page.getByRole("button", { name: "Salvar limite" }).click()
      await expect.poll(async () => (await api<{ assign_limit: number | null }>("/api/inbox/assignment")).assign_limit).toBe(9)
    } finally {
      await api("/api/inbox/assignment", { method: "PUT", body: JSON.stringify({ auto_assign: antes.auto_assign, assign_limit: antes.assign_limit }) })
    }
  })

  test("Notificações: marcar um aviso da caixa de entrada grava na hora", async ({ page }) => {
    const antes = await api<{ on_unassigned: boolean; email_enabled: boolean; alert_email: string | null; on_assigned_message: boolean; on_assigned_to_me: boolean }>("/api/me/alerts")
    try {
      await page.goto(`/${WORKSPACE}/settings/notices`)
      const caixa = page.getByRole("checkbox", { name: "Nova conversa sem responsável" })
      await caixa.click()
      await expect(page.getByText("Avisos salvos.").first()).toBeVisible()
      expect((await api<{ on_unassigned: boolean }>("/api/me/alerts")).on_unassigned).toBe(!antes.on_unassigned)
    } finally {
      await api("/api/me/alerts", { method: "PUT", body: JSON.stringify({ email_enabled: antes.email_enabled, alert_email: antes.alert_email, on_assigned_message: antes.on_assigned_message, on_unassigned: antes.on_unassigned, on_assigned_to_me: antes.on_assigned_to_me }) })
    }
  })

  test("Modelos instalados: nome, quem instalou e o ⋮ leva à automação criada", async ({ page }) => {
    test.skip(installedTemplatesMenuHidden, "Modelos instalados está oculto (src/lib/hidden-features.ts); volta junto com o menu")
    const id = `e2e-inst-${novoTag()}`
    const usuario = consulta<{ user_id: string }>(`SELECT user_id FROM workspace_members WHERE workspace_id='${WORKSPACE}' AND role='owner' LIMIT 1`)[0]!.user_id
    sql([
      // O grafo que o motor grava ao criar uma automação: só o gatilho.
      `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${id}','${WORKSPACE}','Automação ${id}','${JSON.stringify({ nodes: [{ id: "trigger", type: "trigger", position: { x: 0, y: 80 }, config: {} }], edges: [] })}')`,
      `INSERT INTO template_installs(id,workspace_id,template_id,template_version,automation_id,user_id,installed_at) VALUES ('${id}','${WORKSPACE}','boas-vindas',1,'${id}','${q(usuario)}',${Date.now()})`,
    ])
    try {
      await page.goto(`/${WORKSPACE}/settings/installed`)
      await expect(page.getByRole("columnheader", { name: "Automação criada" })).toHaveCount(0)
      const linha = page.getByRole("row").filter({ has: page.getByRole("button", { name: /^Mais ações de modelo / }) }).first()
      await expect(linha).toBeVisible()
      await linha.getByRole("button", { name: /^Mais ações de modelo / }).click()
      await page.getByRole("menuitem", { name: new RegExp(`Abrir automação criada: Automação ${id}`) }).click()
      await expect(page).toHaveURL(new RegExp(`/automations/${id}`))
    } finally {
      sql([`DELETE FROM template_installs WHERE id='${id}'`, `DELETE FROM automations WHERE id='${id}'`])
    }
  })
})
