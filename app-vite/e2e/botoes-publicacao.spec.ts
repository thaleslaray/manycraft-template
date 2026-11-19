import { mkdirSync } from 'node:fs'
import { test, expect } from './fixtures'
import { abrirBotoes, api, consulta, ENGINE, novoTag, q, sql, WORKSPACE, escolherCanalDoPasso, pastaPrints, caminhoPrint } from './helpers'
import { subirTelegramFalso } from './telegram-falso'

test('botão aplica tag e campo pelo Telegram falso; criar passo liga a porta do botão e persiste', { tag: "@celular" }, async ({ page }, info) => {
  test.setTimeout(120000)
  const suffix = novoTag(), automation = `e2e-button-${suffix}`, tag = `${automation}-tag`, field = `${automation}-field`
  const catalog = await api<{ development?: { providerApiBase: string } }>('/api/connections/catalog')
  expect(catalog.development).toBeTruthy()
  const base = new URL(catalog.development!.providerApiBase)
  expect(['localhost', '127.0.0.1']).toContain(base.hostname)
  const bot = 9400000 + Math.floor(Math.random() * 100000), user = bot + 1
  const fake = await subirTelegramFalso(Number(base.port), { [`${bot}:e2e-button`]: { id: bot, username: 'button_test_bot' } })
  let connection: string | undefined
  try {
    connection = (await api<{ connection: { id: string } }>('/api/connections', { method: 'POST', body: JSON.stringify({ kind: 'telegram', credentials: { botToken: `${bot}:e2e-button` } }) })).connection.id
    const graph = { nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
      { id: 'offer', type: 'message', position: { x: 360, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Quer conhecer a oficina?' }, { kind: 'button', id: 'interesse', label: 'Quero conhecer', action: { type: 'go_to_node' } }] } },
      { id: 'fallback', type: 'message', position: { x: 720, y: 220 }, config: { blocks: [{ kind: 'text', text: 'Resposta alternativa' }] } },
    ], edges: [{ from: 'trigger', port: 'next', to: 'offer' }, { from: 'offer', port: 'next', to: 'fallback' }] }
    sql([
      `INSERT INTO tags(id,workspace_id,name) VALUES ('${tag}','${WORKSPACE}','Interesse do botão ${suffix}')`,
      `INSERT INTO custom_fields(id,workspace_id,name,type) VALUES ('${field}','${WORKSPACE}','Origem do botão ${suffix}','number')`,
      `INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${automation}','${WORKSPACE}','Interesse na oficina','${q(JSON.stringify(graph))}')`,
      `INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES ('${automation}-trigger','${WORKSPACE}','${automation}','${connection}','Interesse','keyword','active','every_time','{"node_id":"trigger"}')`,
      `INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES ('${automation}-keyword','${WORKSPACE}','${automation}-trigger','is','["button-${suffix}"]','live',0)`,
    ])
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${automation}`)
    const offer = page.locator('.react-flow__node[data-id="offer"]')
    await offer.click()
    await abrirBotoes(page)
    // A ação do toque é escolhida num menu com ícones, não no seletor nativo.
    await page.getByRole('combobox', { name: 'O que acontece ao tocar', exact: true }).click()
    await expect(page.getByRole('option', { name: 'Abrir um link', exact: true })).toBeVisible()
    await page.getByRole('option', { name: 'Ir para um passo', exact: true }).click()
    await page.getByRole('button', { name: 'Adicionar ação ao botão', exact: true }).click()
    await page.getByRole('combobox', { name: 'Tag do botão', exact: true }).click()
    await page.getByRole('option', { name: `Interesse do botão ${suffix}`, exact: true }).click()
    await page.getByRole('button', { name: 'Adicionar ação ao botão', exact: true }).click()
    await page.getByRole('combobox', { name: 'Ação do botão 2', exact: true }).click()
    await page.getByRole('option', { name: 'Definir valor de campo', exact: true }).click()
    await page.getByRole('combobox', { name: 'Campo do botão', exact: true }).click()
    await page.getByRole('option', { name: `Origem do botão ${suffix}`, exact: true }).click()
    await page.getByRole('spinbutton', { name: 'Valor', exact: true }).fill('23')
    await expect(offer.getByRole('listitem', { name: 'Adiciona tag', exact: true })).toBeVisible()
    await expect(offer.getByRole('listitem', { name: 'Define campo', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Criar passo pelo botão', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Mensagem', exact: true }).click()
    await escolherCanalDoPasso(page, 'Telegram')
    await page.getByRole('textbox', { name: 'Texto do bloco 1', exact: true }).fill('Inscrição registrada pelo botão.')
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click()
    await expect(page.getByText('Rascunho salvo', { exact: true })).toBeVisible()
    await page.reload(); await offer.click(); await abrirBotoes(page)
    await expect(page.getByRole('combobox', { name: 'Tag do botão', exact: true })).toContainText(`Interesse do botão ${suffix}`)
    await expect(page.getByRole('spinbutton', { name: 'Valor', exact: true })).toHaveValue('23')
    const saved = await api<{ automation: { draft_graph: typeof graph } }>(`/api/automations/${automation}`)
    expect(saved.automation.draft_graph.edges).toContainEqual({ from: 'offer', port: 'next', to: 'fallback' })
    expect(saved.automation.draft_graph.edges.find(e => e.from === 'offer' && e.port === 'btn:interesse')?.to).toBeTruthy()
    const dir = pastaPrints("clone-screens")
    mkdirSync(dir, { recursive: true })
    const screen = (name: string) => process.env.E2E_CAPTURE_SCREENS === '1' ? `${dir}/${name}` : info.outputPath(name)
    if (info.project.name === 'desktop') await page.screenshot({ path: screen('23-botoes-desktop.png'), scale: 'css' })
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByText('Publicada · versão 1', { exact: true })).toBeVisible()
    const hook = fake.webhook()!
    const send = async (payload: unknown) => {
      const res = await fetch(hook.url.replace(/^https?:\/\/[^/]+/, ENGINE), { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': hook.secret_token }, body: JSON.stringify(payload) })
      expect(res.status).toBe(200)
    }
    await send({ update_id: Date.now(), message: { message_id: 1, from: { id: user, first_name: 'Ana' }, chat: { id: user, type: 'private' }, text: `button-${suffix}` } })
    await expect.poll(() => fake.chamadas.find(c => c.metodo === 'sendMessage')?.corpo, { timeout: 30000 }).toMatchObject({ text: 'Quer conhecer a oficina?' })
    const body = fake.chamadas.find(c => c.metodo === 'sendMessage')!.corpo as { reply_markup: { inline_keyboard: { callback_data: string }[][] } }
    const token = body.reply_markup.inline_keyboard[0][0].callback_data
    const lookup = `SELECT ct.contact_id FROM contact_tags ct JOIN contact_channels cc ON cc.workspace_id=ct.workspace_id AND cc.contact_id=ct.contact_id WHERE ct.tag_id='${tag}' AND cc.channel_id='${connection}'`
    expect(consulta(lookup)).toHaveLength(0)
    await send({ update_id: Date.now(), callback_query: { id: 'click-23', from: { id: user }, data: token, message: { message_id: 1, chat: { id: user, type: 'private' } } } })
    await expect.poll(() => fake.enviadas().map(m => m.text), { timeout: 30000 }).toEqual(['Quer conhecer a oficina?', 'Inscrição registrada pelo botão.'])
    expect(consulta(lookup)).toHaveLength(1)
    expect(consulta<{ value: string }>(`SELECT value FROM contact_field_values WHERE field_id='${field}'`)).toEqual([{ value: '23' }])
    if (info.project.name === 'desktop') {
      await page.reload()
      await expect(page.locator('.react-flow__node[data-id="offer"]')).toContainText(/CTR\s*100/)
    }
    if (info.project.name === 'mobile') {
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(page.getByRole('list', { name: 'Passos da automação' })).toContainText('Quero conhecer')
      await page.screenshot({ path: screen('23-botoes-mobile.png'), scale: 'css' })
    }
  } finally {
    await fake.fechar()
    sql([...(connection ? [`DELETE FROM contacts WHERE workspace_id='${WORKSPACE}' AND id IN (SELECT contact_id FROM contact_channels WHERE channel_id='${connection}')`] : []), `DELETE FROM automations WHERE id='${automation}'`, ...(connection ? [`DELETE FROM channels WHERE id='${connection}'`] : []), `DELETE FROM tags WHERE id='${tag}'`, `DELETE FROM custom_fields WHERE id='${field}'`])
  }
})

test('publicação destaca passo solto e anexo faltando; rascunho continua editável', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'Edição disponível no desktop; leitura móvel coberta na jornada do botão.')
  const id = `e2e-publish-${novoTag()}`
  const graph = { nodes: [
    { id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'm', type: 'message', position: { x: 360, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Mensagem pronta' }] } },
    { id: 'loose', type: 'message', position: { x: 360, y: 260 }, config: { blocks: [{ kind: 'media', media: 'image', url: '' }] } },
  ], edges: [{ from: 't', port: 'next', to: 'm' }] }
  try {
    sql([`INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('${id}','${WORKSPACE}','Revisar antes de publicar','${q(JSON.stringify(graph))}')`])
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${WORKSPACE}/automations/${id}`)
    await page.locator('.react-flow__node[data-id="loose"]').click()
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    const pending = page.getByRole('region', { name: 'Pendências para publicar' })
    await expect(pending).toContainText('Passo solto')
    await expect(page.locator('.react-flow__node[data-id="loose"]').getByRole('img', { name: /Erro:/ })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: 'Passo solto' })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: 'Anexe um arquivo' })).toBeVisible()
    await page.screenshot({ path: process.env.E2E_CAPTURE_SCREENS === '1' ? caminhoPrint('clone-screens/23-publicacao-desktop.png') : info.outputPath('23-publicacao-desktop.png'), scale: 'css' })
    const refusal = await fetch(`${ENGINE}/api/automations/${id}/publish`, { method: 'POST', headers: { 'x-workspace': WORKSPACE } })
    expect(refusal.status).toBeGreaterThanOrEqual(400)
    await page.locator('.react-flow__node[data-id="m"]').click()
    await page.getByRole('textbox', { name: 'Texto do bloco 1', exact: true }).fill('Mensagem revisada no rascunho')
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click()
    await expect(page.getByText('Rascunho salvo', { exact: true })).toBeVisible()
  } finally { sql([`DELETE FROM automations WHERE id='${id}'`]) }
})
