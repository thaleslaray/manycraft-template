import { test, expect } from './fixtures'
import { WORKSPACE, api, canalE2eSql, limpezaSql, novoTag, q, sql } from './helpers'

// Ficha 11: o passo de mensagem pertence a um canal e o painel mostra só o que a ficha desse canal declara.
test('criar fluxo com dois canais: cada passo mostra opções diferentes e a publicação passa sem erro', async ({ page }) => {
  test.setTimeout(120000)
  const t = novoTag(), automation = `e2e-f11-${t}`, tg = `e2e-f11-tg-${t}`, ig = `e2e-f11-ig-${t}`
  const graph = { nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} }], edges: [] }
  const canal = (id: string, tipo: string, provedor: string) => [
    ...canalE2eSql(id, tipo),
    `UPDATE channels SET provider='${provedor}',connection_state='connected',display_name='${tipo} ${t}' WHERE id='${id}'`,
  ]
  try {
    sql([
      ...canal(tg, 'telegram', 'telegram_bot'), ...canal(ig, 'instagram', 'instagram_unified'),
      `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${automation}','${WORKSPACE}','Dois canais ${t}','${q(JSON.stringify(graph))}')`,
      ...[[tg, 'tg'], [ig, 'ig']].flatMap(([canalId, sufixo]) => [
        `INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES ('${automation}-${sufixo}','${WORKSPACE}','${automation}','${canalId}','Gatilho ${sufixo}','keyword','active','every_time','{"node_id":"trigger"}')`,
        `INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES ('${automation}-k-${sufixo}','${WORKSPACE}','${automation}-${sufixo}','is','["f11-${sufixo}-${t}"]','live',0)`,
      ]),
    ])
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${automation}`)

    // Passo 1: Telegram. O seletor lista só canais ativos com conexão ligada.
    await page.getByRole('button', { name: 'Adicionar passo', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Mensagem', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Por qual canal vai esta mensagem?' })
    await expect(dialog.getByRole('button', { name: 'Telegram', exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Instagram', exact: true })).toBeVisible()
    for (const fora of ['Messenger', 'TikTok']) await expect(dialog.getByRole('button', { name: fora, exact: true })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Telegram', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Canal do passo', exact: true })).toContainText('Telegram')
    await page.getByRole('textbox', { name: 'Texto do bloco 1', exact: true }).fill('Oi pelo Telegram')
    // O Telegram não tem resposta rápida nativa, mas o motor a adapta para botões de toque; também tem digitação.
    await expect(page.getByRole('button', { name: 'Adicionar resposta rápida', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Digitação', exact: true })).toBeVisible()
    await expect(page.getByText('/ 4.096')).toBeVisible()

    // Passo 2: Instagram. Aqui há respostas rápidas e o limite de texto está em bytes.
    await page.getByRole('button', { name: 'Adicionar passo', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Mensagem', exact: true }).click()
    await page.getByRole('dialog', { name: 'Por qual canal vai esta mensagem?' }).getByRole('button', { name: 'Instagram', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Canal do passo', exact: true })).toContainText('Instagram')
    await page.getByRole('textbox', { name: 'Texto do bloco 1', exact: true }).fill('Oi pelo Instagram')
    await expect(page.getByRole('button', { name: 'Adicionar resposta rápida', exact: true })).toBeVisible()
    await page.getByRole('textbox', { name: 'Texto do bloco 1', exact: true }).focus() // o contador só aparece com o campo em foco
    await expect(page.getByText('/ 1.000 bytes')).toBeVisible()

    // O cartão de cada passo mostra o canal.
    await expect(page.locator('.react-flow__node').filter({ hasText: 'Oi pelo Telegram' }).getByText('Telegram', { exact: true })).toBeVisible()
    await expect(page.locator('.react-flow__node').filter({ hasText: 'Oi pelo Instagram' }).getByText('Instagram', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByText('Publicada · versão 1', { exact: true })).toBeVisible()
    const salvo = await api<{ automation: { draft_graph: { nodes: { type: string; config: { channel?: string } }[] } } }>(`/api/automations/${automation}`)
    expect(salvo.automation.draft_graph.nodes.filter(n => n.type === 'message').map(n => n.config.channel).sort()).toEqual(['instagram', 'telegram'])

    // Celular: o mesmo fluxo continua legível, com o canal de cada passo.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    await expect(page.getByText('Telegram').first()).toBeVisible()
    await expect(page.getByText('Instagram').first()).toBeVisible()
  } finally {
    sql([
      `DELETE FROM keywords WHERE id LIKE '${automation}-k-%'`, `DELETE FROM triggers WHERE automation_id='${automation}'`,
      `DELETE FROM automation_versions WHERE automation_id='${automation}'`, `DELETE FROM automations WHERE id='${automation}'`, ...limpezaSql(),
    ])
  }
})
