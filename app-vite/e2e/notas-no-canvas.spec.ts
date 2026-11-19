import { test, expect } from "./fixtures"
import { WORKSPACE, api, sql, q } from "./helpers"

type Detalhe = { automation: { draft_graph: { annotations?: { kind: string; text?: string; title?: string; color: string; size: { w: number; h: number } }[] } } }

test("nota e grupo do mapa: criar, editar, salvar, recarregar e apagar; no celular só leitura", { tag: "@celular" }, async ({ page }, info) => {
  let id: string | undefined
  try {
    await page.goto(`/${WORKSPACE}/automations`)
    await page.getByRole("button", { name: "Nova automação", exact: true }).first().click()
    await page.getByRole("button", { name: "Começar do zero", exact: true }).click()
    await expect(page).toHaveURL(/\/automations\/[^/]+$/)
    id = page.url().split("/").pop()!
    if (info.project.name === "mobile") {
      // Em tela estreita o painel é só leitura: a nota salva por outra via aparece na lista.
      const detalhe = await api<Detalhe & { automation: { draft_graph: object } }>(`/api/automations/${id}`)
      await api(`/api/automations/${id}/draft`, { method: "PUT", body: JSON.stringify({ graph: { ...detalhe.automation.draft_graph, annotations: [{ id: "nota-1", kind: "note", position: { x: 0, y: 0 }, size: { w: 220, h: 140 }, color: "yellow", text: "Combinar o horário com a equipe" }] } }) })
      await page.reload()
      await expect(page.getByRole("heading", { name: "Notas e grupos do mapa" })).toBeVisible()
      await expect(page.getByText("Combinar o horário com a equipe")).toBeVisible()
      return
    }
    await page.getByRole("button", { name: "Notas e grupos" }).click()
    await page.getByRole("menuitem", { name: "Grupo de passos" }).click()
    await page.getByRole("textbox", { name: "Título do grupo" }).fill("Boas-vindas")
    await page.getByRole("button", { name: "Notas e grupos" }).click()
    await page.getByRole("menuitem", { name: "Nota adesiva" }).click()
    await page.getByRole("textbox", { name: "Texto da nota" }).fill("Revisar o texto")
    await page.getByText("Verde", { exact: true }).click()
    const largura = page.getByRole("textbox", { name: "Largura" })
    await largura.fill("300")
    await largura.press("Enter")
    await page.getByRole("button", { name: "Salvar rascunho" }).click()
    await expect(page.getByText("Rascunho salvo")).toBeVisible()
    await page.reload()
    await expect(page.locator(".react-flow__node-frame")).toContainText("Boas-vindas")
    await expect(page.locator(".react-flow__node-sticky")).toContainText("Revisar o texto")
    const salvo = await api<Detalhe>(`/api/automations/${id}`)
    expect(salvo.automation.draft_graph.annotations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "note", text: "Revisar o texto", color: "green", size: expect.objectContaining({ w: 300 }) }),
      expect.objectContaining({ kind: "group", title: "Boas-vindas" }),
    ]))
    await page.locator(".react-flow__node-sticky").focus()
    await page.keyboard.press("Enter")
    await page.getByRole("button", { name: "Apagar nota" }).click()
    await expect(page.locator(".react-flow__node-sticky")).toHaveCount(0)
  } finally {
    if (id) sql([`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${q(id)}'`])
  }
})
