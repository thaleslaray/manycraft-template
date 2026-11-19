import { giveCredentials } from './credentials'
import { TEST_KEK } from './credentials'
import { createExecutionContext, createMessageBatch, getQueueResult, introspectWorkflow, type WorkflowIntrospector } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/env'
import type { Graph, GraphNode } from '../src/contracts'
import type { InboundEvent, IntegrationEnv } from '../src/integrations'
import type { Message } from '../src/inbox/service'
import { InboxHub } from '../src/inbox/hub'
import { ChannelLimiter } from '../src/flow/limiter'
import { actions } from '../src/flow/nodes'
import type { FlowEnv, Run } from '../src/flow/types'
import { consumeInbound } from '../src/jobs'
import { origin, seedAuth } from './auth-helpers'

const node = (id: string, type: GraphNode['type'], config: GraphNode['config'] = {}): GraphNode => ({ id, type, config, position: { x: 0, y: 0 } })
const demo: Graph = {
  nodes: [node('start', 'trigger'), node('offer', 'message', { blocks: [
    { kind: 'text', text: 'Seu material está disponível.' },
    { kind: 'button', id: 'link', label: 'Receber material', action: { type: 'go_to_node' } },
  ], click_timeout: { value: 1, unit: 'minutes' } }),
  node('delay', 'smart_delay', { duration: { value: 1, unit: 'minutes' } }),
  node('delivery', 'message', { blocks: [{ kind: 'text', text: 'Aqui está o material.' }] }),
  node('lead', 'action', { actions: [{ type: 'add_tag', tag_id: 'tag-a' }] })],
  edges: [{ from: 'start', port: 'next', to: 'offer' }, { from: 'offer', port: 'link', to: 'delay' },
    { from: 'delay', port: 'next', to: 'delivery' }, { from: 'delivery', port: 'next', to: 'lead' }],
}
let workflow: WorkflowIntrospector | undefined
let update = 0
let sent: { text: string; chat_id: string | number; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }[]
const sockets: WebSocket[] = []
const bindings = () => ({ ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: 'a' } as Env)

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('x-workspace', 'a')
  headers.set('origin', origin)
  headers.set('content-type', 'application/json')
  return app.request(`${origin}/api/${path}`, { ...init, headers }, bindings())
}
const post = (path: string, body: unknown) => request(path, { method: 'POST', body: JSON.stringify(body) })
async function publish(graph: Graph, version = 1) {
  await env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES (?,'a','auto-a',?,?)")
    .bind(`timeline-version-${version}`, version, JSON.stringify(graph)).run()
  await env.DB.prepare("UPDATE automations SET status='live',published_version_id=? WHERE id='auto-a'").bind(`timeline-version-${version}`).run()
}
async function inspect() {
  workflow = await introspectWorkflow(env.FLOW_RUN!)
  await workflow.modifyAll(async modifier => { await modifier.disableSleeps(); await modifier.disableRetryDelays() })
}
async function inbound(payload: Record<string, unknown>, runtime: IntegrationEnv = env) {
  const event: InboundEvent = { version: 1, provider: 'telegram', workspaceId: 'a', channelId: 'tg-a',
    eventId: String((payload as { update_id: number }).update_id), receivedAt: Date.now(), payload }
  const batch = createMessageBatch('inbound', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: event }])
  await consumeInbound(batch, runtime)
  return getQueueResult(batch, createExecutionContext())
}
function dm(text = 'quero') {
  return { update_id: ++update, message: { message_id: update, from: { id: 100, first_name: 'Pessoa de teste' },
    chat: { id: 100, type: 'private' }, text } }
}
function click(token: string) {
  return inbound({ update_id: ++update, callback_query: { id: `timeline-callback-${update}`, from: { id: 100 }, data: token,
    message: { message_id: 1, chat: { id: 100, type: 'private' } } } })
}
async function current() {
  const instances = await workflow!.get()
  expect(instances).toHaveLength(1)
  return instances[0]
}
async function conversationId() {
  return (await env.DB.prepare("SELECT v.id FROM conversations v JOIN contact_channels cc ON cc.id=v.contact_channel_id WHERE cc.channel_id='tg-a' AND cc.external_user_id='100'").first<{ id: string }>())!.id
}
async function history(id: string) {
  const response = await request(`inbox/conversations/${id}/messages`)
  expect(response.status).toBe(200)
  return (await response.json() as { rows: Message[] }).rows
}
async function connect() {
  const response = await request('inbox/live', { headers: { Upgrade: 'websocket' } })
  expect(response.status).toBe(101)
  const socket = (response as Response & { webSocket: WebSocket }).webSocket
  socket.accept()
  sockets.push(socket)
  const frames: { type: string; message?: Message }[] = []
  socket.addEventListener('message', event => { if (event.data !== 'pong') frames.push(JSON.parse(String(event.data))) })
  return { socket, frames }
}
async function flushSocket(socket: WebSocket) {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('WebSocket sem resposta.')) }, 3000)
    function receive(event: MessageEvent) {
      if (event.data !== 'pong') return
      clearTimeout(timeout)
      socket.removeEventListener('message', receive)
      resolve()
    }
    socket.addEventListener('message', receive)
    socket.send('ping')
  })
}

beforeEach(async () => {
  await seedAuth()
  update = 0
  sent = []
  vi.spyOn(ChannelLimiter.prototype, 'acquire').mockResolvedValue({ allowed: true, retryAfter: 0 })
  // This fixture never sends using the real development credentials.
  expect(env.CONNECTIONS_KEK_V1).toBe(TEST_KEK)
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    expect(request.url).toMatch(/^https:\/\/api\.telegram\.org\/botTESTONLY\/(sendMessage|answerCallbackQuery)$/)
    const body = await request.json() as typeof sent[number]
    if (request.url.endsWith('/sendMessage')) {
      sent.push(body)
      return Response.json({ ok: true, result: { message_id: 12000 + sent.length, date: 1, chat: { id: body.chat_id }, text: body.text } })
    }
    return Response.json({ ok: true, result: true })
  })
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('tg-a','a','telegram','timeline-bot')"),
    env.DB.prepare("UPDATE triggers SET channel_id='tg-a',repeat_mode='every_time' WHERE id='trg-a'"),
    env.DB.prepare("UPDATE keywords SET status='live' WHERE id='key-a'"),
  ])
  await giveCredentials(env, 'tg-a', { botToken: 'TESTONLY', webhookSecret: 'secret-tg-a' })
  await publish(demo)
})
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close(1000)
  await workflow?.dispose()
  workflow = undefined
  vi.restoreAllMocks()
})

it('entrega entrada → automação → clique com rótulo → espera → mensagem → etiqueta em HTTP e WebSocket, sem duplicar replay', async () => {
  const live = await connect()
  await inspect()
  const payload = dm()
  await inbound(payload)
  const run = await current()
  await run.waitForStepResult({ name: 'waiting:1' })
  const token = sent[0].reply_markup!.inline_keyboard[0][0].callback_data
  await inbound(payload)
  await click(token)
  await click(token)
  await run.waitForStatus('complete')
  const id = await conversationId()
  const rows = await history(id)
  expect(rows.map(message => message.event?.kind ?? `${message.sender}:${message.text}`)).toEqual([
    'contact:quero', 'trigger', 'automation:Seu material está disponível.', 'contact:Receber material',
    'delay_started', 'automation:Aqui está o material.', 'tag_added',
  ])
  expect(rows[1]).toMatchObject({ sender: 'system', event: { kind: 'trigger', automation_id: 'auto-a', automation_name: 'Automação a', trigger_kind: 'keyword' } })
  expect(rows[4]).toMatchObject({ sender: 'system', event: { kind: 'delay_started', automation_id: 'auto-a', automation_name: 'Automação a' } })
  const delay = rows[4].event!
  expect(delay.kind).toBe('delay_started')
  if (delay.kind === 'delay_started') expect(Date.parse(delay.ends_at) - Date.parse(rows[4].created_at)).toBeGreaterThanOrEqual(59_000)
  expect(rows[6]).toMatchObject({ sender: 'system', event: { kind: 'tag_added', tag_id: 'tag-a', tag_name: 'Etiqueta a' } })
  expect(rows.map(message => Date.parse(message.created_at))).toEqual(rows.map(message => Date.parse(message.created_at)).sort((a, b) => a - b))
  expect(new Set(rows.map(message => message.id)).size).toBe(rows.length)
  await flushSocket(live.socket)
  const liveSystems = live.frames.filter(frame => frame.type === 'message' && frame.message?.sender === 'system').map(frame => frame.message!)
  expect(liveSystems.map(message => message.id)).toEqual(rows.filter(message => message.sender === 'system').map(message => message.id))
  expect(liveSystems.map(message => message.event)).toEqual(rows.filter(message => message.sender === 'system').map(message => message.event))
})

it('preserva valor anterior/novo e remoção de etiqueta; repetir a mesma gravação não inventa alterações', async () => {
  await env.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('timeline-known','a','c-a','tg-a','100',1)").run()
  await publish({ nodes: [node('start', 'trigger'), node('changes', 'action', { actions: [
    { type: 'set_custom_field_value', field_id: 'field-a', value: 'Mentoria' },
    { type: 'remove_tag', tag_id: 'tag-a' },
  ] })], edges: [{ from: 'start', port: 'next', to: 'changes' }] }, 2)
  await inspect()
  await inbound(dm())
  await (await current()).waitForStatus('complete')
  const id = await conversationId()
  const changes = (await history(id)).filter(message => ['field_changed', 'tag_removed'].includes(message.event?.kind ?? ''))
  expect(changes.map(message => message.event)).toEqual([
    { kind: 'field_changed', field_id: 'field-a', field_name: 'Interesse', previous_value: 'Curso', value: 'Mentoria' },
    { kind: 'tag_removed', tag_id: 'tag-a', tag_name: 'Etiqueta a' },
  ])
  await env.DB.batch([
    env.DB.prepare("UPDATE contact_field_values SET value='\"Mentoria\"' WHERE contact_id='c-a' AND field_id='field-a'"),
    env.DB.prepare("DELETE FROM contact_tags WHERE contact_id='c-a' AND tag_id='tag-a'"),
  ])
  expect((await history(id)).filter(message => ['field_changed', 'tag_removed'].includes(message.event?.kind ?? '')).map(message => message.id)).toEqual(changes.map(message => message.id))
})

it('registra mudanças reais de situação e pausa de atendimento com prazo, sem evento para status repetido', async () => {
  await inbound(dm('Olá'))
  const id = await conversationId()
  expect((await post(`inbox/conversations/${id}/status`, { status: 'closed' })).status).toBe(200)
  expect((await post(`inbox/conversations/${id}/status`, { status: 'closed' })).status).toBe(200)
  expect((await post(`inbox/conversations/${id}/status`, { status: 'open' })).status).toBe(200)
  const started = Date.now()
  expect((await post(`inbox/conversations/${id}/messages`, { kind: 'reply', text: 'Vou acompanhar por aqui.' })).status).toBe(201)
  const rows = await history(id)
  expect(rows.filter(message => message.event?.kind === 'status_changed').map(message => message.event)).toEqual([
    { kind: 'status_changed', previous_status: 'open', status: 'closed' },
    { kind: 'status_changed', previous_status: 'closed', status: 'open' },
  ])
  const paused = rows.filter(message => message.event?.kind === 'automation_paused')
  expect(paused).toHaveLength(1)
  const event = paused[0].event!
  if (event.kind === 'automation_paused') {
    expect(Date.parse(event.until)).toBeGreaterThanOrEqual(started + 30 * 60_000)
    expect(Date.parse(event.until)).toBeLessThanOrEqual(Date.now() + 30 * 60_000)
  }
})

it('retry após falha na criação do Workflow mantém o evento de entrada único', async () => {
  await publish({ nodes: [node('start', 'trigger')], edges: [] }, 2)
  await inspect()
  const payload = dm()
  const create = vi.fn(async () => { throw new Error('Workflow indisponível no teste.') })
  expect((await inbound(payload, { ...env, FLOW_RUN: { create } as unknown as Workflow<{ runId: string }> })).retryMessages).toHaveLength(1)
  expect((await inbound(payload)).retryMessages).toEqual([])
  await (await current()).waitForStatus('complete')
  const rows = await history(await conversationId())
  expect(rows.filter(message => message.event?.kind === 'trigger')).toHaveLength(1)
  expect(rows.filter(message => message.sender === 'contact')).toHaveLength(1)
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM flow_runs').first('n')).toBe(1)
})

it('retry real do passo de ação recupera o aviso pendente após falha no Hub sem repetir etiqueta, campo ou evento', async () => {
  const live = await connect()
  const deliver = InboxHub.prototype.notify
  let failures = 0
  // One transient Hub failure on the tag notice: the action step already committed and must only resend the pending notice.
  vi.spyOn(InboxHub.prototype, 'notify').mockImplementation(async function (this: InboxHub, event: unknown) {
    if (!failures && (event as { message?: Message }).message?.event?.kind === 'tag_added') { failures++; throw new Error('Hub indisponível no teste.') }
    return deliver.call(this, event)
  } as InboxHub['notify'])
  await inspect()
  await inbound(dm())
  const run = await current()
  await run.waitForStepResult({ name: 'waiting:1' })
  await click(sent[0].reply_markup!.inline_keyboard[0][0].callback_data)
  await run.waitForStatus('complete')
  expect(failures).toBe(1)
  const id = await conversationId()
  const tags = (await history(id)).filter(message => message.event?.kind === 'tag_added')
  expect(tags).toHaveLength(1)
  expect(await env.DB.prepare('SELECT timeline_notified FROM messages WHERE id=?').bind(tags[0].id).first('timeline_notified')).toBe(1)
  await flushSocket(live.socket)
  expect(live.frames.filter(frame => frame.message?.event?.kind === 'tag_added').map(frame => frame.message!.id)).toEqual([tags[0].id])
  // Replaying the same action step changes nothing: no second tag, field value or timeline event.
  const row = (await env.DB.prepare('SELECT * FROM flow_runs LIMIT 1').first<Run>())!
  const replay = { ...row, automation_id: 'auto-a' }
  const config = { actions: [
    { type: 'set_custom_field_value', field_id: 'field-a', value: 'Mentoria' },
    { type: 'remove_tag', tag_id: 'tag-a' },
    { type: 'add_tag', tag_id: 'tag-a' },
    { type: 'unset_custom_field_value', field_id: 'field-a' },
  ] }
  await env.DB.prepare("INSERT INTO contact_field_values (workspace_id,contact_id,field_id,value) VALUES ('a',?,'field-a','\"Curso\"')").bind(row.contact_id).run()
  await actions(env as unknown as FlowEnv, replay, config, 99)
  const first = await history(id)
  await actions(env as unknown as FlowEnv, replay, config, 99)
  const second = await history(id)
  expect(second).toEqual(first)
  expect(second.filter(message => message.event?.kind === 'field_changed').map(message => message.event)).toContainEqual({
    kind: 'field_changed', field_id: 'field-a', field_name: 'Interesse', previous_value: 'Curso', value: 'Mentoria',
  })
  expect(second.filter(message => message.event?.kind === 'tag_removed')).toHaveLength(1)
})
