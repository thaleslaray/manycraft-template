import { mkdirSync } from 'node:fs'
import { test, expect } from './fixtures'
import { WORKSPACE, acaoDoTopo, adicionarCondicao, api, canalE2eSql, consulta, escolher, novoTag, q, sql, pastaPrints, textoDoPasso } from './helpers'

test('segmento salvo pode ser reutilizado em transmissão e condição e reaberto', { tag: "@celular" }, async ({ page }, info) => {
  const viewport = info.project.name === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 }
  await page.setViewportSize(viewport)
  const t = novoTag(), name = `Público ativo ${t}`, broadcastName = `Aviso ao público ${t}`
  const channel = `e2e-segment-use-ch-${t}`, tag = `e2e-segment-use-tag-${t}`, automation = `e2e-segment-use-auto-${t}`
  let segment = ''
  sql([...canalE2eSql(channel), `INSERT INTO tags(id,workspace_id,name) VALUES ('${tag}','${WORKSPACE}','Interesse ${t}')`])
  try {
    const saved = await api<{ id: string }>('/api/segments', { method: 'POST', body: JSON.stringify({ name, filter: { match: 'all', rules: [{ type: 'tag', tag_id: tag, operator: 'has' }] } }) })
    segment = saved.id
    await page.goto(`/${WORKSPACE}/broadcasts`)
    await acaoDoTopo(page, 'Nova transmissão')
    await page.getByLabel('Nome da transmissão').fill(broadcastName)
    await escolher(page, 'Canal conectado', 'Canal de teste e2e')
    await adicionarCondicao(page, 'Segmento salvo')
    await escolher(page, 'Segmento salvo', name)
    await (await textoDoPasso(page)).fill('Aviso de teste guardado somente como rascunho.')
    await expect(page.getByRole('status').filter({ hasText: 'receberão esta transmissão' })).toContainText('0 contatos receberão esta transmissão')
    await acaoDoTopo(page, 'Salvar rascunho')
    await page.getByRole('button', { name: `Editar ${broadcastName}`, exact: true }).click()
    await expect(page.getByLabel('Segmento salvo', { exact: true })).toContainText(name)
    expect(consulta<{ audience: string; status: string }>(`SELECT audience_filter AS audience,status FROM broadcasts WHERE workspace_id='${WORKSPACE}' AND name='${q(broadcastName)}'`)).toEqual([expect.objectContaining({ status: 'draft', audience: expect.stringContaining(segment) })])
    await capture('transmissao-segmento')

    const graph = { nodes: [{ id: 'condition', type: 'condition', position: { x: 50, y: 100 }, config: { match: 'all', rules: [{ type: 'tag', tag_id: tag, operator: 'has' }] } }], edges: [] }
    sql([`INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${automation}','${WORKSPACE}','Condição de público ${t}','${q(JSON.stringify(graph))}')`])
    // O editor oferece edição somente em tela ampla; a visualização móvel permanece em leitura.
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${automation}`)
    await page.locator('.react-flow__node[data-id="condition"]').click()
    await page.getByLabel('Regra 1', { exact: true }).click()
    await page.getByRole('option', { name: 'Pertence a segmento', exact: true }).click()
    await page.getByLabel('Segmento salvo', { exact: true }).click()
    await page.getByRole('option', { name, exact: true }).click()
    await page.getByLabel('Comparação', { exact: true }).click()
    await page.getByRole('option', { name: 'Não pertence ao segmento', exact: true }).click()
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Salvar rascunho', exact: true })).toBeDisabled()
    await page.reload()
    await expect(page.locator('.react-flow__node[data-id="condition"]')).toContainText(`Não pertence ao segmento ${name}`)
    await page.locator('.react-flow__node[data-id="condition"]').click()
    await expect(page.getByLabel('Segmento salvo', { exact: true })).toContainText(name)
    await expect(page.getByLabel('Comparação', { exact: true })).toContainText('Não pertence ao segmento')
    const persisted = JSON.parse(consulta<{ draft_graph: string }>(`SELECT draft_graph FROM automations WHERE id='${automation}'`)[0].draft_graph)
    expect(persisted.nodes[0].config.rules).toEqual([{ type: 'segment', segment_id: segment, operator: 'not_in' }])
    await page.setViewportSize(viewport)
    if (info.project.name === 'mobile') await expect(page.getByText('Use uma tela maior para editar', { exact: true })).toBeVisible()
    await capture('condicao-segmento')
  } finally {
    sql([`DELETE FROM broadcasts WHERE workspace_id='${WORKSPACE}' AND name='${q(broadcastName)}'`, `DELETE FROM automations WHERE id='${automation}'`, `DELETE FROM segments WHERE id='${q(segment)}'`, `DELETE FROM tags WHERE id='${tag}'`, `DELETE FROM channels WHERE id='${channel}'`])
  }
  async function capture(screen: string) {
    if (!process.env.CAPTURE_TICKET_27) return
    const dir = pastaPrints("clone-screens")
    mkdirSync(dir, { recursive: true })
    await page.screenshot({ animations: 'disabled', scale: 'css', path: `${dir}/27-${screen}-${info.project.name}.png` })
  }
})
