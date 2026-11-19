import { test, expect } from './fixtures'
import { abrirBotoes, novoTag, q, sql, WORKSPACE } from './helpers'

test('botão que abre um site explica que não inscreve nem abre a janela de conversa', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'O editor de passos só existe na tela larga.')
  const automation = `e2e-site-${novoTag()}`
  const graph = { nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'offer', type: 'message', position: { x: 360, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Conheça a oficina' }, { kind: 'button', id: 'site', label: 'Abrir site', action: { type: 'url', url: 'https://example.test/oficina' } }] } },
  ], edges: [{ from: 'trigger', port: 'next', to: 'offer' }] }
  sql([`INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${automation}','${WORKSPACE}','Botão de site','${q(JSON.stringify(graph))}')`])
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${automation}`)
    await page.locator('.react-flow__node[data-id="offer"]').click()
    await abrirBotoes(page)
    await expect(page.getByTestId('nota-botao-de-site')).toContainText('não inscreve o contato nem abre a janela de conversa')
  } finally {
    sql([`DELETE FROM automations WHERE id='${automation}'`])
  }
})
