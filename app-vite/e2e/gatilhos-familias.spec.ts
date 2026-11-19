import { test, expect } from './fixtures'
import { WORKSPACE, novoTag, sql } from './helpers'

test('tela Gatilhos agrupa por família, mostra Tipo · Canal e abre a automação do gatilho', async ({ page }) => {
  const tag = novoTag(), canal = `ig-${tag}`, nome = `Comentário ${tag}`
  const graph = JSON.stringify({ nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} }], edges: [] })
  // Gatilho só conta como Ativo com a automação ao vivo: o teste usa a sua, não a primeira que existir no banco.
  sql([
    `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('au-${tag}','${WORKSPACE}','Alvo ${tag}','${graph}')`,
    `INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('au-${tag}-v1','${WORKSPACE}','au-${tag}',1,'${graph}')`,
    `UPDATE automations SET status='live',published_version_id='au-${tag}-v1' WHERE id='au-${tag}'`,
    `INSERT INTO channels(id,workspace_id,type,external_id,status,display_name) VALUES ('${canal}','${WORKSPACE}','instagram','ext-${tag}','connected','Conta ${tag}')`,
    `INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status,config) SELECT 'tg-${tag}',workspace_id,id,'${canal}','${nome}','widget','feed_comment','active','{}' FROM automations WHERE id='au-${tag}'`,
  ])
  try {
    await page.goto(`/${WORKSPACE}/automations`)
    await page.getByRole('link', { name: 'Gatilhos', exact: true }).click()
    const familia = page.getByRole('region', { name: 'Comentários', exact: true })
    await expect(familia).toBeVisible()
    await expect(familia.getByTestId('comments-active')).toContainText('de')
    const item = familia.getByRole('link', { name: new RegExp(nome) })
    await expect(item).toContainText('Comentário · Instagram')
    await expect(item).toContainText('Ativo')
    await item.click()
    await expect(page).toHaveURL(/\/automations\/[^/]+$/)
  } finally {
    sql([`DELETE FROM triggers WHERE id='tg-${tag}'`, `DELETE FROM channels WHERE id='${canal}'`,
      `DELETE FROM automation_versions WHERE automation_id='au-${tag}'`, `DELETE FROM automations WHERE id='au-${tag}'`])
  }
})

test('erro ao carregar mostra o aviso e o botão de tentar de novo', async ({ page, erros }) => {
  await page.route('**/api/triggers/overview', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"falha"}' }))
  await page.goto(`/${WORKSPACE}/automations/triggers`)
  await expect(page.getByRole('alert')).toContainText('Não consegui carregar os gatilhos')
  await expect(page.getByRole('button', { name: 'Tentar de novo' })).toBeVisible()
  erros.length = 0 // o 500 simulado aparece no console de propósito
})
