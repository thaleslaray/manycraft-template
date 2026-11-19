import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { api, conexaoConectada, gatilhoDeRascunho, novoTag, q, sql, WORKSPACE } from './helpers'

async function escolha(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

type Graph = { nodes: { id: string; type: string; config: { rules?: unknown[] } }[] }

test('condição por origem do contato: escolher, salvar, reabrir e publicar', async ({ page }) => {
  test.setTimeout(120_000)
  const tag = novoTag(), id = `e2e-origem-${tag}`
  const graph = { nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'cond', type: 'condition', position: { x: 250, y: 0 }, config: { match: 'all', rules: [{ type: 'tag', tag_id: '', operator: 'has' }] } },
    { id: 'yes', type: 'message', position: { x: 500, y: -80 }, config: { blocks: [{ kind: 'text', text: 'Você veio do anúncio.' }] } },
    { id: 'no', type: 'message', position: { x: 500, y: 80 }, config: { blocks: [{ kind: 'text', text: 'Bem-vindo de volta.' }] } },
  ], edges: [{ from: 'trigger', port: 'next', to: 'cond' }, { from: 'cond', port: 'true', to: 'yes' }, { from: 'cond', port: 'false', to: 'no' }] }
  sql([`INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${id}','${WORKSPACE}','Condição por origem ${tag}','${q(JSON.stringify(graph))}')`])
  // Publicar sem gatilho é barrado: este gatilho nasce desligado só para a publicação passar.
  await gatilhoDeRascunho(id, await conexaoConectada(), `origem${tag}`)
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${id}`)
    await page.locator('.react-flow__node[data-id="cond"]').click()
    await escolha(page, 'Regra 1', 'Origem do contato')
    await escolha(page, 'Origem', 'Widget: anúncio')
    await escolha(page, 'Comparação', 'Não veio dessa origem')
    await expect(page.getByText('Contato que nunca passou por uma não tem origem.')).toBeVisible()
    await expect(page.locator('.react-flow__node[data-id="cond"]')).toContainText('Não veio de widget: anúncio')
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click()
    await expect(page.getByText('Rascunho salvo', { exact: true })).toBeVisible()
    const detail = await api<{ automation: { draft_graph: Graph } }>(`/api/automations/${id}`)
    expect(detail.automation.draft_graph.nodes.find(n => n.id === 'cond')?.config.rules).toEqual([{ type: 'origin', origin: 'ads', operator: 'is_not' }])
    await page.reload()
    await page.locator('.react-flow__node[data-id="cond"]').click()
    await expect(page.getByRole('combobox', { name: 'Origem', exact: true })).toContainText('Widget: anúncio')
    // Teclado: abre a lista, troca a origem por seta e confirma, sem mouse.
    await page.getByRole('combobox', { name: 'Origem', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('listbox')).toBeVisible()
    await page.getByRole('option', { name: 'Palavra-chave', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('combobox', { name: 'Origem', exact: true })).toContainText('Palavra-chave')
    await page.getByRole('button', { name: /Publicar/ }).first().click()
    await expect(page.getByText(/publicad/i).first()).toBeVisible()
  } finally {
    sql([`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${id}'`])
  }
})
