import { mkdirSync } from "node:fs"
import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { WORKSPACE, api, consulta, menuMais, novoTag, q, sql, pastaPrints } from "./helpers"

/** Cada linha tem um menu ⋮ (Mais ações de <campo|tag> <nome>) com Editar, Arquivar/Desarquivar e Excluir. */
async function acao(page: Page, singular: string, nome: string, item: "Editar" | "Arquivar" | "Desarquivar" | "Excluir") {
  await menuMais(page, `Mais ações de ${singular} ${nome}`, item)
}

/** Arquivados moram no ⋮ do cartão ("Mostrar arquivados"), não num filtro de situação. */
async function mostrarArquivados(page: Page, titulo: string, ligar: boolean) {
  await page.getByRole("button", { name: `Mais ações de ${titulo}`, exact: true }).click()
  const item = page.getByRole("menuitemcheckbox", { name: /Mostrar arquivados/ })
  if ((await item.getAttribute("aria-checked") === "true") !== ligar) await item.click(); else await page.keyboard.press("Escape")
}

for (const kind of ["fields", "tags"] as const) {
  const singular = kind === "fields" ? "campo" : "tag"
  test(`${singular}: criar, recarregar, renomear, arquivar, restaurar e excluir no motor`, { tag: "@celular" }, async ({ page }, info) => {
    const prefix = `e2e-settings-${novoTag()}`
    const name = `${prefix} ${singular}`
    const renamed = `${name} atualizado`
    const table = kind === "fields" ? "custom_fields" : "tags"
    try {
      await page.goto(`/${WORKSPACE}/settings/${kind}`)
      await page.getByRole("button", { name: kind === "fields" ? "Novo campo do usuário" : "Nova tag", exact: true }).click()
      await page.getByRole("textbox", { name: "Nome", exact: true }).fill(name)
      if (kind === "fields") await page.getByLabel("Tipo de dado").selectOption("number")
      await page.getByRole("button", { name: `Salvar ${singular}`, exact: true }).click()
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await page.reload()
      await expect(page.getByText(name, { exact: true })).toBeVisible()
      expect(consulta(`SELECT name FROM ${table} WHERE workspace_id='${WORKSPACE}' AND name='${q(name)}'`)).toHaveLength(1)
      await acao(page, singular, name, "Editar")
      await page.getByRole("textbox", { name: "Nome", exact: true }).fill(renamed)
      await page.getByRole("button", { name: `Salvar ${singular}`, exact: true }).click()
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await acao(page, singular, renamed, "Arquivar")
      await expect(page.getByText(renamed, { exact: true })).toHaveCount(0)
      await page.reload()
      await mostrarArquivados(page, kind === "fields" ? "Campos do usuário" : "Tags", true)
      await expect(page.getByText(renamed, { exact: true })).toBeVisible()
      await acao(page, singular, renamed, "Desarquivar")
      await mostrarArquivados(page, kind === "fields" ? "Campos do usuário" : "Tags", false)
      await expect(page.getByText(renamed, { exact: true })).toBeVisible()
      if (process.env.E2E_CAPTURE_SETTINGS) {
        const dir = pastaPrints("clone-screens")
        mkdirSync(dir, { recursive: true })
        await page.setViewportSize({ width: info.project.name === "desktop" ? 1440 : 390, height: info.project.name === "desktop" ? 900 : 844 })
        await page.screenshot({ path: `${dir}/02-${kind}-${info.project.name}.png`, fullPage: false })
      }
      await acao(page, singular, renamed, "Excluir")
      await page.getByRole("button", { name: "Confirmar", exact: true }).click()
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await page.reload()
      await expect(page.getByText(renamed, { exact: true })).toHaveCount(0)
      expect(consulta(`SELECT name FROM ${table} WHERE workspace_id='${WORKSPACE}' AND name LIKE '${prefix}%'`)).toHaveLength(0)
    } finally {
      sql([`DELETE FROM ${table} WHERE workspace_id='${WORKSPACE}' AND name LIKE '${prefix}%'`])
    }
  })
}

test("tag lead lista a contagem real de três contatos", async ({ page }) => {
  const suffix = novoTag(), id = `e2e-lead-${suffix}`, name = `lead ${suffix}`
  sql([
    `INSERT INTO tags(id,workspace_id,name) VALUES ('${id}','${WORKSPACE}','${name}')`,
    ...[1, 2, 3].flatMap(n => [
      `INSERT INTO contacts(id,workspace_id,first_name) VALUES ('${id}-${n}','${WORKSPACE}','Lead ${n}')`,
      `INSERT INTO contact_tags(workspace_id,contact_id,tag_id) VALUES ('${WORKSPACE}','${id}-${n}','${id}')`,
    ]),
  ])
  try {
    await page.goto(`/${WORKSPACE}/settings/tags`)
    const row = page.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) })
    await row.getByRole("button", { name: `Mais ações de tag ${name}`, exact: true }).click()
    await expect(page.getByRole("menu").getByText(/3 contatos/)).toBeVisible()
    await page.keyboard.press("Escape")
    const tags = await api<{ id: string; contact_count: number }[]>("/api/tags")
    expect(tags.find(tag => tag.id === id)?.contact_count).toBe(3)
  } finally {
    sql([`DELETE FROM tags WHERE id='${id}' AND workspace_id='${WORKSPACE}'`, `DELETE FROM contacts WHERE id LIKE '${id}-%' AND workspace_id='${WORKSPACE}'`])
  }
})

test("excluir campo avisa quais automações publicadas usam o valor", { tag: "@celular" }, async ({ page }, info) => {
  const id = `e2e-settings-usage-${novoTag()}`, fieldName = `Interesse ${id}`, automationName = `Qualificação ${id}`
  const field = await api<{ id: string }>("/api/fields", { method: "POST", body: JSON.stringify({ name: fieldName, type: "number" }) })
  const graph = { nodes: [{ id: "a", type: "action", position: { x: 0, y: 0 }, config: { actions: [{ type: "set_custom_field_value", field_id: field.id, value: 7 }] } }], edges: [] }
  sql([
    `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${id}','${WORKSPACE}','${automationName}','{}')`,
    `INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('${id}-v','${WORKSPACE}','${id}',1,'${q(JSON.stringify(graph))}')`,
    `UPDATE automations SET status='live',published_version_id='${id}-v' WHERE id='${id}' AND workspace_id='${WORKSPACE}'`,
  ])
  try {
    await page.goto(`/${WORKSPACE}/settings/fields`)
    await acao(page, "campo", fieldName, "Excluir")
    await expect(page.getByRole("dialog")).toContainText(automationName)
    if (process.env.E2E_CAPTURE_SETTINGS) {
      const dir = pastaPrints("clone-screens")
      mkdirSync(dir, { recursive: true })
      await page.setViewportSize({ width: info.project.name === "desktop" ? 1440 : 390, height: info.project.name === "desktop" ? 900 : 844 })
      await page.waitForTimeout(700)
      await page.screenshot({ path: `${dir}/02-field-delete-warning-${info.project.name}.png`, fullPage: false })
    }
    await page.getByRole("button", { name: "Voltar", exact: true }).click()
    expect(consulta(`SELECT id FROM custom_fields WHERE id='${field.id}' AND workspace_id='${WORKSPACE}'`)).toHaveLength(1)
    await acao(page, "campo", fieldName, "Excluir")
    await page.getByRole("button", { name: "Confirmar", exact: true }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(fieldName, { exact: true })).toHaveCount(0)
  } finally {
    sql([
      `DELETE FROM automation_versions WHERE automation_id='${id}' AND workspace_id='${WORKSPACE}'`,
      `DELETE FROM automations WHERE id='${id}' AND workspace_id='${WORKSPACE}'`,
      `DELETE FROM custom_fields WHERE id='${field.id}' AND workspace_id='${WORKSPACE}'`,
    ])
  }
})
