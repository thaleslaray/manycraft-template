import { mkdirSync } from 'node:fs'
import { test, expect } from './fixtures'
import { api, novoTag, q, sql, WORKSPACE, pastaPrints } from './helpers'
import { subirTelegramFalso } from './telegram-falso'

const directory = pastaPrints("clone-screens")
const botao = (i: number) => ({ kind: 'button', id: `b${i}`, label: `Opção ${i}`, action: { type: 'url', url: 'https://exemplo.test' } })
const grafo = (botoes: number) => ({ nodes: [
  { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
  { id: 'menu', type: 'message', position: { x: 380, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Escolha uma opção' }, ...Array.from({ length: botoes }, (_, i) => botao(i + 1))] } },
], edges: [{ from: 'trigger', port: 'next', to: 'menu' }] })

test('limite de botões vem da ficha do canal (Telegram 10) e botão não convive com resposta rápida; publicar recusa o excesso', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'A edição é do desktop.')
  test.setTimeout(150000)
  const suffix = novoTag(), cheia = `e2e-botoes-cheia-${suffix}`, excesso = `e2e-botoes-excesso-${suffix}`
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development).toBeTruthy()
  const base = new URL(catalog.development!.providerApiBase)
  expect(['localhost', '127.0.0.1']).toContain(base.hostname)
  const bot = 9700000 + Math.floor(Math.random() * 100000)
  const fake = await subirTelegramFalso(Number(base.port), { [`${bot}:e2e-limite`]: { id: bot, username: 'limite_test_bot' } })
  let connection: string | undefined
  const screen = (name: string) => process.env.E2E_CAPTURE_SCREENS === '1' ? (mkdirSync(directory, { recursive: true }), `${directory}/${name}`) : info.outputPath(name)
  const seed = (id: string, name: string, n: number) => [
    `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${id}','${WORKSPACE}','${name}','${q(JSON.stringify(grafo(n)))}')`,
    `INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES ('${id}-trigger','${WORKSPACE}','${id}','${connection}','Menu','keyword','active','every_time','{"node_id":"trigger"}')`,
    `INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES ('${id}-keyword','${WORKSPACE}','${id}-trigger','is','["limite-${suffix}-${n}"]','live',0)`,
  ]
  try {
    connection = (await api<{ connection: { id: string } }>('/api/connections', { method: 'POST', body: JSON.stringify({ kind: 'telegram', credentials: { botToken: `${bot}:e2e-limite` } }) })).connection.id
    sql([...seed(cheia, 'Menu com dez botões', 10), ...seed(excesso, 'Menu com onze botões', 11)])
    await page.setViewportSize({ width: 1440, height: 900 })

    await page.goto(`/${WORKSPACE}/automations/${cheia}`)
    await page.locator('.react-flow__node[data-id="menu"]').click()
    await expect(page.getByRole('button', { name: 'Adicionar botão', exact: true })).toBeDisabled()
    await expect(page.getByText('Limite de 10 botões por mensagem nesta conexão.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Adicionar resposta rápida', exact: true })).toBeDisabled()
    await expect(page.getByText('Botão e resposta rápida não coexistem no mesmo texto: tire os botões para usar respostas rápidas.')).toBeVisible()
    await page.screenshot({ path: screen('09-botoes-limite-desktop.png'), scale: 'css' })

    await page.goto(`/${WORKSPACE}/automations/${excesso}`)
    await page.locator('.react-flow__node[data-id="menu"]').click()
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByText('Use até 10 botões por mensagem nesta conexão.').first()).toBeVisible()
    const salvo = await api<{ automation: { status: string } }>(`/api/automations/${excesso}`)
    expect(salvo.automation.status).not.toBe('live')
  } finally {
    await fake.fechar()
    sql([`DELETE FROM automations WHERE id IN ('${cheia}','${excesso}')`, ...(connection ? [`DELETE FROM channels WHERE id='${connection}'`] : [])])
  }
})
