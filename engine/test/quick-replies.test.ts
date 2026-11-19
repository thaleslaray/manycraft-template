import { giveCredentials } from './credentials'
import { createExecutionContext, createMessageBatch, getQueueResult, introspectWorkflow, type WorkflowIntrospector } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Graph, GraphNode } from '../src/contracts'
import type { InboundEvent } from '../src/integrations'
import { consumeInbound } from '../src/jobs'
import { app } from '../src/index'
import { fixtureCookie, seedAuth } from './auth-helpers'
import { seed } from './fixtures'
import { ChannelLimiter } from '../src/flow/limiter'
import { quickRepliesError, quickReplyLimits, quickReplyWaitMs } from '../src/schemas/message-quick-replies'
import { buttonLimit, buttonsError } from '../src/schemas/message-buttons'
import { capabilities } from '../src/channels/capabilities'

const node = (id: string, type: GraphNode['type'], config: GraphNode['config'] = {}): GraphNode => ({ id, type, position: { x: 0, y: 0 }, config })
const reply = (id: string, label: string, extra: object = {}) => ({ kind: 'quick_reply', id, label, ...extra })
const edges = [{ from: 'start', port: 'next', to: 'ask' }]
const withReplies = (config: Record<string, unknown> = {}, blocks: unknown[] = [{ kind: 'text', text: 'Qual caminho?' }, reply('a', 'Preços'), reply('b', 'Suporte'), reply('skip', 'Pular', { skip: true })]): Graph => ({
  nodes: [node('start', 'trigger'), node('ask', 'message', { blocks, ...config }),
    node('prices', 'message', { blocks: [{ kind: 'text', text: 'Segue a tabela.' }] }),
    node('support', 'message', { blocks: [{ kind: 'text', text: 'Chamando o suporte.' }] }),
    node('resume', 'message', { blocks: [{ kind: 'text', text: 'Seguindo sem a escolha.' }] })],
  edges: [...edges, { from: 'ask', port: 'btn:a', to: 'prices' }, { from: 'ask', port: 'btn:b', to: 'support' }, { from: 'ask', port: 'next', to: 'resume' }],
})

type Call = { method: string; at: number; body: Record<string, any> }
let calls: Call[]
let workflow: WorkflowIntrospector | undefined
let update = 0
const sent = () => calls.filter(c => c.method === 'sendMessage')

beforeEach(async () => {
  await seed()
  calls = []; update = 0
  vi.spyOn(ChannelLimiter.prototype, 'acquire').mockResolvedValue({ allowed: true, retryAfter: 0 })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    const method = request.url.split('/').at(-1)!
    expect(request.url).toMatch(/^https:\/\/api\.telegram\.org\/botTESTONLY\/(sendMessage|sendChatAction|answerCallbackQuery)$/)
    const body = await request.json() as Record<string, any>
    calls.push({ method, at: Date.now(), body })
    return Response.json({ ok: true, result: method === 'sendMessage' ? { message_id: 10000 + calls.length, date: 1, chat: { id: body.chat_id }, text: body.text } : true })
  })
  await env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('tg-a','a','telegram','test-bot')").run()
  await giveCredentials(env, 'tg-a', { botToken: 'TESTONLY', webhookSecret: 'secret-tg-a' })
  await env.DB.prepare("UPDATE triggers SET channel_id='tg-a',repeat_mode='every_time' WHERE id='trg-a'").run()
  await env.DB.prepare("UPDATE keywords SET status='live' WHERE id='key-a'").run()
})
afterEach(async () => { await workflow?.dispose(); workflow = undefined; vi.restoreAllMocks() })

async function publish(graph: Graph, version = 1) {
  await env.DB.prepare('INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES (?,\'a\',\'auto-a\',?,?)')
    .bind(`version-${version}`, version, JSON.stringify(graph)).run()
  await env.DB.prepare("UPDATE automations SET status='live',published_version_id=? WHERE id='auto-a'").bind(`version-${version}`).run()
}
async function inspect(options: { timeouts?: string[]; sleeps?: boolean } = {}) {
  workflow = await introspectWorkflow(env.FLOW_RUN!)
  await workflow.modifyAll(async modifier => {
    if (options.sleeps !== false) await modifier.disableSleeps()
    await modifier.disableRetryDelays()
    for (const name of options.timeouts ?? []) await modifier.forceEventTimeout({ name })
  })
}
const dm = (text = 'quero', user = 100) => ({ update_id: ++update, message: { message_id: update, from: { id: user, first_name: 'Pessoa de teste' }, chat: { id: user, type: 'private' }, text } })
async function inbound(payload: Record<string, unknown>) {
  const event: InboundEvent = { version: 1, provider: 'telegram', workspaceId: 'a', channelId: 'tg-a', eventId: String((payload as { update_id: number }).update_id), receivedAt: Date.now(), payload }
  const batch = createMessageBatch('inbound', [{ id: `queue-${crypto.randomUUID()}`, timestamp: new Date(), attempts: 1, body: event }])
  await consumeInbound(batch, env)
  return getQueueResult(batch, createExecutionContext())
}
const click = (data: string, user = 100) => inbound({ update_id: ++update, callback_query: { id: `cb-${update}`, from: { id: user }, data, message: { message_id: 1, chat: { id: user, type: 'private' } } } })
const instance = async () => { const list = await workflow!.get(); expect(list).toHaveLength(1); return list[0] }
const runRow = () => env.DB.prepare("SELECT id,status,contact_id FROM flow_runs WHERE workspace_id='a' ORDER BY created_at DESC LIMIT 1").first<{ id: string; status: string; contact_id: string }>()

it('limites das respostas rápidas vêm da ficha: nativa (até 11 e 20 caracteres) ou botões de toque', () => {
  expect(quickReplyLimits(capabilities('instagram'))).toEqual({ max: 11, titleMax: 20, native: true })
  expect(quickReplyLimits(capabilities('telegram'))).toEqual({ max: 10, titleMax: 20, native: false })
  expect(quickReplyLimits(capabilities('whatsapp'))).toEqual({ max: 3, titleMax: 20, native: false })
})

it.each([
  ['botão e resposta rápida não coexistem', [{ kind: 'text', text: 'Oi' }, { kind: 'button', id: 'x', label: 'Botão', action: { type: 'go_to_node' } }, reply('a', 'Sim')], {}, 'não coexistem'],
  ['exige um texto', [reply('a', 'Sim')], {}, 'texto'],
  ['título acima de 20 caracteres', [{ kind: 'text', text: 'Oi' }, reply('a', 'a'.repeat(21))], {}, 'até 20'],
  ['mais de 11 respostas', [{ kind: 'text', text: 'Oi' }, ...Array.from({ length: 12 }, (_, i) => reply(`r${i}`, `R${i}`))], {}, 'até 11'],
  ['tentativas acima de 5', [{ kind: 'text', text: 'Oi' }, reply('a', 'Sim')], { reply_attempts: 6 }, '1 a 5'],
  ['espera total acima de 24 h', [{ kind: 'text', text: 'Oi' }, reply('a', 'Sim')], { click_timeout: { value: 13, unit: 'hours' }, reply_attempts: 2 }, '24 horas'],
  ['duas respostas Pular', [{ kind: 'text', text: 'Oi' }, reply('a', 'Pular', { skip: true }), reply('b', 'Pular', { skip: true })], {}, 'só uma'],
])('regra de publicação: %s', (_name, blocks, settings, message) => {
  expect(quickRepliesError(blocks as never, [capabilities('instagram')], settings as never)).toContain(message)
})
it('aceita 11 respostas de 20 caracteres no Instagram e divide 24 h entre as tentativas', () => {
  const blocks = [{ kind: 'text', text: 'Oi' }, ...Array.from({ length: 11 }, (_, i) => reply(`r${i}`, 'x'.repeat(20)))]
  expect(quickRepliesError(blocks as never, [capabilities('instagram')], { reply_attempts: 3 })).toBeUndefined()
  expect(quickReplyWaitMs({ reply_attempts: 3 })).toBe(8 * 3600_000)
})

it('toque numa resposta rápida segue pela porta da resposta, registra o clique e reabre a janela da ficha', async () => {
  await env.DB.prepare("UPDATE channels SET capabilities_override=? WHERE id='tg-a'").bind(JSON.stringify({ window: { standardHours: 24 } })).run()
  await publish(withReplies()); await inspect(); await inbound(dm())
  const current = await instance()
  await current.waitForStepResult({ name: 'waiting:1' })
  // Telegram não tem resposta rápida nativa: o motor adapta para o teclado de toque, sem nunca citar o canal.
  expect(sent()).toHaveLength(1)
  const keyboard = sent()[0].body.reply_markup.inline_keyboard.flat()
  expect(keyboard.map((b: { text: string }) => b.text)).toEqual(['Preços', 'Suporte', 'Pular'])
  expect(keyboard.every((b: { callback_data: string }) => /^b:[a-f0-9]{24}$/.test(b.callback_data))).toBe(true)
  expect((await runRow())?.status).toBe('waiting_click')
  const run = (await runRow())!
  await env.DB.prepare('UPDATE contact_channels SET window_expires_at=0 WHERE contact_id=?').bind(run.contact_id).run()
  const at = Date.now()
  await click(keyboard[1].callback_data); await click(keyboard[1].callback_data)
  await current.waitForStatus('complete')
  expect(sent().map(c => c.body.text)).toEqual(['Qual caminho?', 'Chamando o suporte.'])
  expect(await env.DB.prepare("SELECT button_id FROM node_events WHERE type='clicked' AND flow_run_id=?").bind(run.id).all()).toMatchObject({ results: [{ button_id: 'b' }] })
  expect(await env.DB.prepare('SELECT window_expires_at FROM contact_channels WHERE contact_id=?').bind(run.contact_id).first<number>('window_expires_at')).toBeGreaterThanOrEqual(at + 86400000)
  const inboundTexts = (await env.DB.prepare("SELECT content FROM messages WHERE direction='in'").all<{ content: string }>()).results.map(m => JSON.parse(m.content).text)
  expect(inboundTexts).toContain('Suporte')
})

it('Pular segue pelo próximo passo quando sua saída não está ligada', async () => {
  await publish(withReplies()); await inspect(); await inbound(dm())
  const current = await instance()
  await current.waitForStepResult({ name: 'waiting:1' })
  await click(sent()[0].body.reply_markup.inline_keyboard.flat()[2].callback_data)
  await current.waitForStatus('complete')
  expect(sent().map(c => c.body.text)).toEqual(['Qual caminho?', 'Seguindo sem a escolha.'])
})

it('sem toque, a retomada acontece pelo próximo passo e não conta clique', async () => {
  await publish(withReplies()); await inspect({ timeouts: ['click:1'] }); await inbound(dm())
  await (await instance()).waitForStatus('complete')
  expect(sent().map(c => c.body.text)).toEqual(['Qual caminho?', 'Seguindo sem a escolha.'])
  expect(await env.DB.prepare("SELECT count(*) FROM node_events WHERE type='clicked'").first('count(*)')).toBe(0)
  expect((await runRow())?.status).toBe('done')
})

it('tentativas reenviam só a mensagem com as respostas e depois retomam; um toque em qualquer tentativa vale', async () => {
  await publish(withReplies({ reply_attempts: 3, click_timeout: { value: 1, unit: 'hours' } }))
  await inspect({ timeouts: ['click:1', 'click:1:r1', 'click:1:r2'] }); await inbound(dm())
  await (await instance()).waitForStatus('complete')
  expect(sent().map(c => c.body.text)).toEqual(['Qual caminho?', 'Qual caminho?', 'Qual caminho?', 'Seguindo sem a escolha.'])
  const tokens = sent().slice(0, 3).map(c => c.body.reply_markup.inline_keyboard.flat()[0].callback_data)
  expect(new Set(tokens).size).toBe(1)
})

it('um toque na segunda tentativa percorre a porta da resposta', async () => {
  await publish(withReplies({ reply_attempts: 2, click_timeout: { value: 1, unit: 'hours' } }))
  await inspect({ timeouts: ['click:1'] }); await inbound(dm())
  const current = await instance()
  await current.waitForStepResult({ name: 'waiting:1:r1' })
  await click(sent()[1].body.reply_markup.inline_keyboard.flat()[0].callback_data)
  await current.waitForStatus('complete')
  expect(sent().map(c => c.body.text)).toEqual(['Qual caminho?', 'Qual caminho?', 'Segue a tabela.'])
})

it('mensagem com resposta rápida inválida para a ficha falha sem enviar nada', async () => {
  await env.DB.prepare("UPDATE channels SET capabilities_override=? WHERE id='tg-a'").bind(JSON.stringify({ buttons: { maxPerMessage: 2 } })).run()
  await publish(withReplies()); await inspect(); await inbound(dm())
  await (await instance()).waitForStatus('errored').catch(() => undefined)
  expect(sent()).toHaveLength(0)
  expect((await runRow())?.status).toBe('failed')
})

it('digitação espera o tempo configurado e mostra o indicador antes do envio quando a ficha declara', async () => {
  await publish({ nodes: [node('start', 'trigger'), node('ask', 'message', { blocks: [{ kind: 'text', text: 'Primeiro' }, { kind: 'typing', seconds: 2 }, { kind: 'text', text: 'Depois da pausa' }] })], edges })
  await inspect({ sleeps: false }); await inbound(dm())
  await (await instance()).waitForStatus('complete')
  expect(calls.map(c => c.method)).toEqual(['sendMessage', 'sendChatAction', 'sendMessage'])
  expect(calls[1].body).toMatchObject({ action: 'typing', chat_id: '100' })
  expect(calls[2].at - calls[1].at).toBeGreaterThanOrEqual(1900)
  expect(sent().map(c => c.body.text)).toEqual(['Primeiro', 'Depois da pausa'])
})

it('sem o indicador na ficha a pausa acontece do mesmo jeito, sem avisar o canal', async () => {
  await env.DB.prepare("UPDATE channels SET capabilities_override=? WHERE id='tg-a'").bind(JSON.stringify({ remove: ['typing'] })).run()
  await publish({ nodes: [node('start', 'trigger'), node('ask', 'message', { blocks: [{ kind: 'typing', seconds: 2 }, { kind: 'text', text: 'Depois da pausa' }] })], edges })
  await inspect({ sleeps: false }); await inbound(dm())
  const begin = Date.now()
  await (await instance()).waitForStatus('complete')
  expect(calls.map(c => c.method)).toEqual(['sendMessage'])
  expect(calls[0].at - begin).toBeGreaterThanOrEqual(1500)
})

it('pausa longa renova o indicador na cadência que a ficha permite (5 s)', async () => {
  await publish({ nodes: [node('start', 'trigger'), node('ask', 'message', { blocks: [{ kind: 'typing', seconds: 8 }, { kind: 'text', text: 'Pronto' }] })], edges })
  await inspect(); await inbound(dm())
  await (await instance()).waitForStatus('complete')
  expect(calls.map(c => c.method)).toEqual(['sendChatAction', 'sendChatAction', 'sendMessage'])
})

let cookie = ''
const request = (path: string, init: RequestInit) => app.request(`/api/${path}`, { ...init, headers: { cookie, 'x-workspace': 'a', 'content-type': 'application/json', origin: 'https://engine.test' } }, env)
const draft = (graph: Graph) => request('automations/auto-a/draft', { method: 'PUT', body: JSON.stringify({ graph }) })
it('publicar valida as respostas rápidas pela ficha da conexão do gatilho', async () => {
  await seedAuth(); cookie = await fixtureCookie()
  await env.DB.prepare("UPDATE channels SET display_name='Vitrine',type='instagram',provider='instagram_unified',status='connected' WHERE id='ch-a'").run()
  await env.DB.prepare("UPDATE triggers SET channel_id='ch-a' WHERE id='trg-a'").run()
  const eleven = [{ kind: 'text', text: 'Escolha' }, ...Array.from({ length: 11 }, (_, i) => reply(`r${i}`, `Opção ${i}`))]
  expect((await draft(withReplies({}, eleven))).status).toBe(200)
  expect((await request('automations/auto-a/publish', { method: 'POST' })).status).toBe(201)
  expect((await draft(withReplies({}, [...eleven, reply('r11', 'Opção 11')]))).status).toBe(200)
  const refused = await request('automations/auto-a/publish', { method: 'POST' })
  expect(refused.status).toBe(409)
  expect(await refused.text()).toContain('até 11')
  // O mesmo conteúdo no Telegram usa os botões de toque da ficha: 10 por mensagem.
  await env.DB.prepare("UPDATE channels SET type='telegram',provider='telegram_bot' WHERE id='ch-a'").run()
  expect((await draft(withReplies({}, eleven))).status).toBe(200)
  const telegram = await request('automations/auto-a/publish', { method: 'POST' })
  expect(telegram.status).toBe(409)
  expect(await telegram.text()).toContain('até 10')
})

const btn = (i: number) => ({ kind: 'button', id: `b${i}`, label: `Botão ${i}`, action: { type: 'url', url: 'https://exemplo.test' } })
const manyButtons = (n: number) => [{ kind: 'text', text: 'Escolha' }, ...Array.from({ length: n }, (_, i) => btn(i))]

it('limite de botões vem da ficha do canal: 3 nos canais da Meta, 10 no Telegram', () => {
  expect(buttonLimit([capabilities('instagram')])).toBe(3)
  expect(buttonLimit([capabilities('telegram')])).toBe(10)
  expect(buttonLimit([capabilities('telegram'), capabilities('whatsapp')])).toBe(3)
  expect(buttonsError(manyButtons(3) as never, [capabilities('whatsapp')])).toBeUndefined()
  expect(buttonsError(manyButtons(4) as never, [capabilities('whatsapp')])).toContain('até 3 botões')
  expect(buttonsError(manyButtons(10) as never, [capabilities('telegram')])).toBeUndefined()
  expect(buttonsError(manyButtons(11) as never, [capabilities('telegram')])).toContain('até 10 botões')
})

it('publicar recusa botões acima do limite da conexão e botão com resposta rápida no mesmo texto', async () => {
  await seedAuth(); cookie = await fixtureCookie()
  await env.DB.prepare("UPDATE channels SET display_name='Vitrine',type='instagram',provider='instagram_unified',status='connected' WHERE id='ch-a'").run()
  await env.DB.prepare("UPDATE triggers SET channel_id='ch-a' WHERE id='trg-a'").run()
  const graphWith = (blocks: unknown[]) => withReplies({}, blocks)
  expect((await draft(graphWith(manyButtons(3)))).status).toBe(200)
  expect((await request('automations/auto-a/publish', { method: 'POST' })).status).toBe(201)
  expect((await draft(graphWith(manyButtons(4)))).status).toBe(200)
  const refused = await request('automations/auto-a/publish', { method: 'POST' })
  expect(refused.status).toBe(409)
  expect(await refused.text()).toContain('até 3 botões')
  expect((await draft(graphWith([...manyButtons(1), reply('r1', 'Sim')]))).status).toBe(200)
  const mixed = await request('automations/auto-a/publish', { method: 'POST' })
  expect(mixed.status).toBe(409)
  expect(await mixed.text()).toContain('não coexistem')
  await env.DB.prepare("UPDATE channels SET type='telegram',provider='telegram_bot' WHERE id='ch-a'").run()
  expect((await draft(graphWith(manyButtons(10)))).status).toBe(200)
  expect((await request('automations/auto-a/publish', { method: 'POST' })).status).toBe(201)
  expect((await draft(graphWith(manyButtons(11)))).status).toBe(200)
  const telegram = await request('automations/auto-a/publish', { method: 'POST' })
  expect(telegram.status).toBe(409)
  expect(await telegram.text()).toContain('até 10 botões')
})
