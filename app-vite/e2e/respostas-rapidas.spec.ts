import { mkdirSync } from 'node:fs'
import { test, expect } from './fixtures'
import { api, consulta, ENGINE, novoTag, q, sql, WORKSPACE, pastaPrints } from './helpers'
import { subirTelegramFalso } from './telegram-falso'

const directory = pastaPrints("clone-screens")
const message = (id: string, y: number, text: string, extra: Record<string, unknown> = {}) => ({ id, type: 'message', position: { x: 380, y }, config: { blocks: [{ kind: 'text', text }], ...extra } })

test('resposta rápida e digitação: montar no editor, publicar e conferir ordem, teclado e atraso pelo Telegram falso', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'A edição é do desktop; a leitura no celular tem a jornada seguinte.')
  test.setTimeout(150000)
  const suffix = novoTag(), automation = `e2e-quick-${suffix}`
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development).toBeTruthy()
  const base = new URL(catalog.development!.providerApiBase)
  expect(['localhost', '127.0.0.1']).toContain(base.hostname)
  const bot = 9600000 + Math.floor(Math.random() * 100000), user = bot + 1, other = bot + 2
  const fake = await subirTelegramFalso(Number(base.port), { [`${bot}:e2e-quick`]: { id: bot, username: 'quick_test_bot' } })
  let connection: string | undefined
  const screen = (name: string) => process.env.E2E_CAPTURE_SCREENS === '1' ? (mkdirSync(directory, { recursive: true }), `${directory}/${name}`) : info.outputPath(name)
  try {
    connection = (await api<{ connection: { id: string } }>('/api/connections', { method: 'POST', body: JSON.stringify({ kind: 'telegram', credentials: { botToken: `${bot}:e2e-quick` } }) })).connection.id
    const graph = { nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
      message('ask', 0, 'Qual caminho você prefere?'), message('prices', -200, 'Segue a tabela de preços.'),
      message('support', 200, 'Chamando o suporte agora.'), message('resume', 400, 'Seguindo sem a sua escolha.'),
    ], edges: [{ from: 'trigger', port: 'next', to: 'ask' }] }
    sql([
      `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${automation}','${WORKSPACE}','Escolha de caminho','${q(JSON.stringify(graph))}')`,
      `INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES ('${automation}-trigger','${WORKSPACE}','${automation}','${connection}','Caminho','keyword','active','every_time','{"node_id":"trigger"}')`,
      `INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES ('${automation}-keyword','${WORKSPACE}','${automation}-trigger','is','["quick-${suffix}"]','live',0)`,
    ])
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${automation}`)
    const ask = page.locator('.react-flow__node[data-id="ask"]')
    await ask.click()

    // Digitação antes do texto: o bloco entra no fim e sobe uma posição.
    await page.getByRole('button', { name: 'Digitação', exact: true }).click()
    await page.getByRole('button', { name: 'Subir bloco 2', exact: true }).click()
    await page.getByRole('spinbutton', { name: /^Segundos digitando \(1 a \d+\) · bloco 1$/ }).fill('3')
    await expect(page.getByText('A pessoa vê “digitando…” durante a espera.')).toBeVisible()

    await page.getByRole('button', { name: 'Adicionar resposta rápida', exact: true }).click()
    await page.getByRole('textbox', { name: 'Título da resposta rápida 1', exact: true }).fill('Quero preços')
    await page.getByRole('button', { name: 'Adicionar resposta rápida', exact: true }).click()
    const second = page.getByRole('textbox', { name: 'Título da resposta rápida 2', exact: true })
    await second.fill('Falar com suporte')
    await page.getByRole('button', { name: 'Pular', exact: true }).click()
    // Botão e resposta rápida não coexistem no mesmo texto.
    await expect(page.getByRole('button', { name: 'Adicionar botão', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Pular', exact: true })).toBeDisabled()
    await expect(page.getByText('Botão e resposta rápida não coexistem no mesmo texto.')).toBeVisible()

    const link = async (name: string, target: RegExp) => { await page.getByRole('combobox', { name, exact: true }).click(); await page.getByRole('option', { name: target }).click() }
    await link('Ao tocar em “Quero preços” vai para', /Segue a tabela/)
    await link('Ao tocar em “Falar com suporte” vai para', /Chamando o suporte/)
    await link('Se não tocar, vai para', /Seguindo sem a sua/)
    await expect(page.getByText('Se a pessoa não tocar')).toBeVisible()
    // Limite de 20 caracteres vem da ficha: o painel avisa e a publicação é recusada.
    await second.fill('Falar com o suporte hoje')
    await expect(page.getByText('24 / 20')).toBeVisible()
    await second.scrollIntoViewIfNeeded()
    await page.screenshot({ path: screen('08-resposta-rapida-limite-desktop.png'), scale: 'css' })
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'até 20 caracteres' })).toBeVisible()
    await second.fill('Falar com suporte')

    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click()
    await expect(page.getByText('Rascunho salvo', { exact: true })).toBeVisible()
    await page.reload(); await ask.click()
    await expect(page.getByRole('textbox', { name: 'Título da resposta rápida 2', exact: true })).toHaveValue('Falar com suporte')
    await expect(page.getByRole('spinbutton', { name: /^Segundos digitando \(1 a \d+\) · bloco 1$/ })).toHaveValue('3')
    const saved = await api<{ automation: { draft_graph: typeof graph } }>(`/api/automations/${automation}`)
    const node = saved.automation.draft_graph.nodes.find(n => n.id === 'ask')!
    expect(node.config.blocks).toEqual([{ kind: 'typing', seconds: 3 }, { kind: 'text', text: 'Qual caminho você prefere?' },
      { kind: 'quick_reply', id: 'q1', label: 'Quero preços' }, { kind: 'quick_reply', id: 'q2', label: 'Falar com suporte' }, { kind: 'quick_reply', id: 'q3', label: 'Pular', skip: true }])
    expect(saved.automation.draft_graph.edges).toEqual(expect.arrayContaining([{ from: 'ask', port: 'btn:q1', to: 'prices' }, { from: 'ask', port: 'btn:q2', to: 'support' }, { from: 'ask', port: 'next', to: 'resume' }]))
    await page.getByRole('region', { name: 'Retomada sem toque' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: screen('08-resposta-rapida-desktop.png'), scale: 'css' })

    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByText('Publicada · versão 1', { exact: true })).toBeVisible()
    const hook = fake.webhook()!
    const deliver = async (payload: unknown) => {
      const res = await fetch(hook.url.replace(/^https?:\/\/[^/]+/, ENGINE), { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': hook.secret_token }, body: JSON.stringify(payload) })
      expect(res.status).toBe(200)
    }
    const say = (from: number, id: number) => deliver({ update_id: Date.now() + id, message: { message_id: id, from: { id: from, first_name: 'Ana' }, chat: { id: from, type: 'private' }, text: `quick-${suffix}` } })

    // 1) Quem toca numa resposta segue pela porta dela; o indicador sai antes e a pausa dura o que foi configurado.
    await say(user, 1)
    await expect.poll(() => fake.chamadas.filter(c => c.metodo === 'sendMessage').length, { timeout: 30000 }).toBe(1)
    const calls = fake.chamadas.filter(c => c.token === `${bot}:e2e-quick`)
    expect(calls.map(c => c.metodo)).toEqual(expect.arrayContaining(['sendChatAction', 'sendMessage']))
    const typing = calls.findIndex(c => c.metodo === 'sendChatAction'), message1 = calls.findIndex(c => c.metodo === 'sendMessage')
    expect(typing).toBeGreaterThanOrEqual(0)
    expect(typing).toBeLessThan(message1)
    expect(calls[typing].corpo).toMatchObject({ action: 'typing', chat_id: String(user) })
    expect(fake.instantes[fake.chamadas.indexOf(calls[message1])] - fake.instantes[fake.chamadas.indexOf(calls[typing])]).toBeGreaterThanOrEqual(2500)
    const keyboard = (calls[message1].corpo as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }).reply_markup.inline_keyboard.flat()
    expect(keyboard.map(b => b.text)).toEqual(['Quero preços', 'Falar com suporte', 'Pular'])
    expect(keyboard.every(b => /^b:[a-f0-9]{24}$/.test(b.callback_data))).toBe(true)
    await deliver({ update_id: Date.now() + 10, callback_query: { id: `tap-${suffix}`, from: { id: user }, data: keyboard[1].callback_data, message: { message_id: 1, chat: { id: user, type: 'private' } } } })
    await expect.poll(() => fake.enviadas().filter(m => m.chat_id === String(user)).map(m => m.text), { timeout: 30000 }).toEqual(['Qual caminho você prefere?', 'Chamando o suporte agora.'])
    expect(consulta(`SELECT 1 FROM node_events WHERE automation_id='${automation}' AND type='clicked' AND button_id='q2'`)).toHaveLength(1)

    // 2) Quem não toca fica esperando: a retomada pelo próximo passo está agendada para 24 h.
    await say(other, 2)
    await expect.poll(() => consulta<{ status: string }>(`SELECT r.status FROM flow_runs r JOIN contact_channels cc ON cc.contact_id=r.contact_id AND cc.channel_id=r.channel_id WHERE cc.external_user_id='${other}' AND cc.channel_id='${connection}'`).map(r => r.status), { timeout: 30000 }).toEqual(['waiting_click'])
    const [{ wait }] = consulta<{ wait: number }>(`SELECT r.wait_until - CAST(strftime('%s','now') AS INTEGER)*1000 AS wait FROM flow_runs r JOIN contact_channels cc ON cc.contact_id=r.contact_id AND cc.channel_id=r.channel_id WHERE cc.external_user_id='${other}' AND cc.channel_id='${connection}'`)
    expect(wait).toBeGreaterThan(23.5 * 3600_000)
    expect(wait).toBeLessThanOrEqual(24 * 3600_000 + 60_000)
  } finally {
    await fake.fechar()
    sql([...(connection ? [`DELETE FROM contacts WHERE workspace_id='${WORKSPACE}' AND id IN (SELECT contact_id FROM contact_channels WHERE channel_id='${connection}')`] : []), `DELETE FROM automations WHERE id='${automation}'`, ...(connection ? [`DELETE FROM channels WHERE id='${connection}'`] : [])])
  }
})

test('celular: passos mostram as respostas rápidas e o Pular em modo de leitura', { tag: "@celular" }, async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'Leitura no celular.')
  const suffix = novoTag(), automation = `e2e-quick-m-${suffix}`, connection = `e2e-quick-m-ch-${suffix}`
  const graph = { nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    message('ask', 0, 'Qual caminho você prefere?', { blocks: [{ kind: 'typing', seconds: 2 }, { kind: 'text', text: 'Qual caminho você prefere?' }, { kind: 'quick_reply', id: 'q1', label: 'Quero preços' }, { kind: 'quick_reply', id: 'q2', label: 'Pular', skip: true }] })],
  edges: [{ from: 'trigger', port: 'next', to: 'ask' }] }
  try {
    sql([`INSERT INTO channels(id,workspace_id,type,external_id,status,display_name) VALUES ('${connection}','${WORKSPACE}','telegram','${connection}','connected','Atendimento')`,
      `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${automation}','${WORKSPACE}','Escolha de caminho','${q(JSON.stringify(graph))}')`,
      `INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES ('${automation}-trigger','${WORKSPACE}','${automation}','${connection}','Caminho','keyword','active','every_time','{"node_id":"trigger"}')`])
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/${WORKSPACE}/automations/${automation}`)
    const steps = page.getByRole('list', { name: 'Passos da automação' })
    await expect(steps).toContainText('Resposta rápida “Quero preços”')
    await expect(steps).toContainText('Pular')
    await steps.scrollIntoViewIfNeeded()
    await page.screenshot({ path: screen('08-resposta-rapida-mobile.png'), scale: 'css' })
  } finally { sql([`DELETE FROM automations WHERE id='${automation}'`, `DELETE FROM channels WHERE id='${connection}'`]) }

  function screen(name: string) { return process.env.E2E_CAPTURE_SCREENS === '1' ? (mkdirSync(directory, { recursive: true }), `${directory}/${name}`) : info.outputPath(name) }
})
