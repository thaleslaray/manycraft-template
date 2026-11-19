import type { Page, TestInfo } from '@playwright/test'
import { test, expect } from './fixtures'
import { api, novoTag, q, sql, WORKSPACE, caminhoPrint, abrirMaisOpcoes } from './helpers'

type Graph = { nodes: { id: string; type: string; config: Record<string, unknown> }[] }
async function config(id: string, node: string) {
  const detail = await api<{ automation: { draft_graph: Graph } }>(`/api/automations/${id}`)
  return detail.automation.draft_graph.nodes.find(item => item.id === node)?.config
}

function grafo(tipo: 'smart_delay' | 'condition', cfg: Record<string, unknown>) {
  return { nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'passo', type: tipo, position: { x: 250, y: 0 }, config: cfg },
    { id: 'message', type: 'message', position: { x: 500, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Pronto.' }] } },
  ], edges: tipo === 'condition'
    ? [{ from: 'trigger', port: 'next', to: 'passo' }, { from: 'passo', port: 'true', to: 'message' }, { from: 'passo', port: 'false', to: 'message' }]
    : [{ from: 'trigger', port: 'next', to: 'passo' }, { from: 'passo', port: 'next', to: 'message' }] }
}

async function abrir(page: Page, id: string) {
  await page.goto(`/${WORKSPACE}/automations/${id}`)
  await page.locator('.react-flow__node[data-id="passo"]').click()
}

async function print(page: Page, info: TestInfo, nome: string) {
  if (process.env.E2E_PRINTS !== '1') return
  const mobile = info.project.name === 'mobile'
  const selecionado = await page.locator('.react-flow__node.selected').first().getAttribute('data-id')
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 })
  if (mobile && selecionado) await page.locator(`.react-flow__node[data-id="${selecionado}"]`).click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(500)
  await page.screenshot({ path: caminhoPrint(`clone-screens/repintura/09-${nome}-${mobile ? 'mobile' : 'desktop'}.png`), scale: 'css', animations: 'disabled' })
  await page.setViewportSize({ width: 1440, height: 900 })
  if (mobile && selecionado) await page.locator(`.react-flow__node[data-id="${selecionado}"]`).click()
}

test('painel de Espera: seções numeradas, dias numa linha, fuso com busca, barra inferior e nó com frase e contadores', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(120_000)
  const tag = novoTag(), id = `e2e-rep09-wait-${tag}`
  const cfg = { duration: { value: 2, unit: 'minutes' } }   // sem período: o teste liga o interruptor
  sql([`INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${id}','${WORKSPACE}','Repintura espera ${tag}','${q(JSON.stringify(grafo('smart_delay', cfg)))}')`])
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${id}`)
    {
      const no = page.locator('.react-flow__node[data-id="passo"]')
      await expect(no.getByText('Aguarde 2 minutos depois continue', { exact: true })).toBeVisible()
      // Os contadores do nó só aparecem na vista publicada (em edição o nó mostra só a frase, como no original).
      for (const rotulo of ['Total', 'Esperando', 'Aprovado']) await expect(no.getByText(rotulo, { exact: true })).toHaveCount(0)
    }
    await abrir(page, id)
    const painel = page.getByRole('region', { name: 'Esperar', exact: true })
    // Abas Duração/Data, "Aguardar por" e o interruptor do período, sem seções numeradas.
    await expect(painel.getByRole('tab', { name: 'Duração', exact: true })).toBeVisible()
    await expect(painel.getByRole('heading', { name: /^Passo \d:/ })).toHaveCount(0)
    // Sem moldura de fieldset: nada de grupo "Horário de continuação" nem legenda.
    await expect(painel.getByRole('group', { name: 'Horário de continuação' })).toHaveCount(0)

    // Sem período no nó: o interruptor chega desligado e, ao ligar, mostra os dias.
    const periodo = painel.getByRole('switch', { name: 'Enviar durante um período determinado', exact: true })
    await expect(periodo).not.toBeChecked()
    await expect(painel.getByRole('group', { name: 'Dias permitidos', exact: true })).toHaveCount(0)
    await periodo.click()
    await expect(periodo).toBeChecked()
    const dias = painel.getByRole('group', { name: 'Dias permitidos', exact: true }).getByRole('button')
    await expect(dias).toHaveCount(7)
    const topos = await dias.evaluateAll(botoes => botoes.map(b => Math.round(b.getBoundingClientRect().top)))
    expect(new Set(topos).size).toBe(1)

    await abrirMaisOpcoes(page)
    await painel.getByRole('combobox', { name: 'Fuso horário', exact: true }).click()
    await page.getByRole('searchbox', { name: 'Buscar fuso horário', exact: true }).fill('sao paulo')
    await expect(page.getByRole('option')).toHaveCount(1)
    await page.getByRole('option', { name: 'America/Sao Paulo', exact: true }).click()
    await expect(painel.getByRole('combobox', { name: 'Fuso horário', exact: true })).toContainText('America/Sao Paulo')

    // Sem rodapé: apagar o passo fica na barra flutuante do nó selecionado.
    await expect(painel.getByRole('group', { name: 'Ações do painel', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Apagar passo', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click()
    await expect(page.getByText('Rascunho salvo', { exact: true })).toBeVisible()
    await expect.poll(() => config(id, 'passo')).toMatchObject({ timezone: 'America/Sao_Paulo' })
    await print(page, info, 'espera')

    await page.getByRole('button', { name: 'Apagar passo', exact: true }).click()
    await expect(page.locator('.react-flow__node[data-id="passo"]')).toHaveCount(0)
  } finally {
    sql([`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${id}'`])
  }
})

test('painel de Condição: seções numeradas sem moldura e barra inferior no lugar do "Apagar passo" solto', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(120_000)
  const tag = novoTag(), id = `e2e-rep09-cond-${tag}`
  const cfg = { match: 'all', rules: [{ type: 'current_time', window: { from: '08:00', to: '18:00', days: [1, 2, 3, 4, 5] } }] }
  sql([`INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${id}','${WORKSPACE}','Repintura condição ${tag}','${q(JSON.stringify(grafo('condition', cfg)))}')`])
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await abrir(page, id)
    const painel = page.getByRole('region', { name: 'Verificar condição', exact: true })
    await expect(painel.getByRole('heading', { name: /^Passo 1:/ })).toBeVisible()
    await expect(painel.getByRole('heading', { name: /^Passo 2:/ })).toBeVisible()
    await expect(painel.getByRole('group', { name: 'Horário de continuação' })).toHaveCount(0)
    const dias = painel.getByRole('group', { name: 'Dias permitidos', exact: true }).getByRole('button')
    const topos = await dias.evaluateAll(botoes => botoes.map(b => Math.round(b.getBoundingClientRect().top)))
    expect(new Set(topos).size).toBe(1)
    await expect(painel.getByRole('combobox', { name: 'Fuso horário', exact: true })).toBeVisible()
    await expect(painel.getByRole('group', { name: 'Ações do painel', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Apagar passo', exact: true })).toBeVisible()
    await print(page, info, 'condicao')
    await page.getByRole('button', { name: 'Apagar passo', exact: true }).click()
    await expect(page.locator('.react-flow__node[data-id="passo"]')).toHaveCount(0)
  } finally {
    sql([`DELETE FROM automations WHERE workspace_id='${WORKSPACE}' AND id='${id}'`])
  }
})
