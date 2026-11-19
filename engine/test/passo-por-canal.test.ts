import { giveCredentials } from './credentials'
import { createExecutionContext, createMessageBatch, getQueueResult, introspectWorkflow, type WorkflowIntrospector } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Graph, GraphNode } from '../src/contracts'
import type { InboundEvent } from '../src/integrations'
import { consumeInbound } from '../src/jobs'
import { seed } from './fixtures'
import { ChannelLimiter } from '../src/flow/limiter'
import { channelMismatch } from '../src/flow/step-channel'

const node = (id: string, type: GraphNode['type'], config: GraphNode['config'] = {}): GraphNode => ({ id, type, position: { x: 0, y: 0 }, config })
const text = (t: string, channel?: string) => ({ blocks: [{ kind: 'text', text: t }], ...(channel ? { channel } : {}) })
let workflow: WorkflowIntrospector | undefined
let sent: string[]
let update = 0

beforeEach(async () => {
  await seed()
  sent = []
  vi.spyOn(ChannelLimiter.prototype, 'acquire').mockResolvedValue({ allowed: true, retryAfter: 0 })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    const body = await request.json() as { text: string; chat_id: string | number }
    sent.push(body.text)
    return Response.json({ ok: true, result: { message_id: 10000 + sent.length, date: 1, chat: { id: body.chat_id }, text: body.text } })
  })
  await env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('tg-a','a','telegram','test-bot')").run()
  await giveCredentials(env, 'tg-a', { botToken: 'TESTONLY', webhookSecret: 'secret-tg-a' })
  await env.DB.prepare("UPDATE triggers SET channel_id='tg-a',repeat_mode='every_time' WHERE id='trg-a'").run()
  await env.DB.prepare("UPDATE keywords SET status='live' WHERE id='key-a'").run()
})
afterEach(async () => { await workflow?.dispose(); workflow = undefined; vi.restoreAllMocks() })

async function publish(graph: Graph) {
  await env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('version-1','a','auto-a',1,?)").bind(JSON.stringify(graph)).run()
  await env.DB.prepare("UPDATE automations SET status='live',published_version_id='version-1' WHERE id='auto-a'").run()
}
async function dm() {
  workflow = await introspectWorkflow(env.FLOW_RUN!)
  await workflow.modifyAll(async m => { await m.disableSleeps(); await m.disableRetryDelays() })
  const id = ++update
  const event: InboundEvent = { version: 1, provider: 'telegram', workspaceId: 'a', channelId: 'tg-a', eventId: String(id), receivedAt: Date.now(),
    payload: { update_id: id, message: { message_id: id, from: { id: 100, first_name: 'Pessoa' }, chat: { id: 100, type: 'private' }, text: 'quero' } } }
  const batch = createMessageBatch('inbound', [{ id: `q-${id}`, timestamp: new Date(), attempts: 1, body: event }])
  await consumeInbound(batch, env)
  await getQueueResult(batch, createExecutionContext())
  const [instance] = await workflow.get()
  await instance.waitForStatus('complete')
}

it('o contato só recebe o passo do seu canal; o passo de outro canal é pulado e o motivo fica registrado', async () => {
  await publish({ nodes: [node('start', 'trigger'), node('wa', 'message', text('Oi pelo WhatsApp', 'whatsapp')), node('tg', 'message', text('Oi pelo Telegram', 'telegram'))],
    edges: [{ from: 'start', port: 'next', to: 'wa' }, { from: 'wa', port: 'next', to: 'tg' }] })
  await dm()
  expect(sent).toEqual(['Oi pelo Telegram'])
  const skips = await env.DB.prepare('SELECT node_id,reason,step_channel,run_channel FROM flow_step_skips').all()
  expect(skips.results).toEqual([{ node_id: 'wa', reason: 'channel_mismatch', step_channel: 'whatsapp', run_channel: 'telegram' }])
  expect(await env.DB.prepare('SELECT status FROM flow_runs').first('status')).toBe('done')
})

it('vários passos de canais diferentes em fila: só os do canal do contato saem, em qualquer ordem', async () => {
  await publish({ nodes: [node('start', 'trigger'), node('a', 'message', text('TG 1', 'telegram')), node('b', 'message', text('IG', 'instagram')),
    node('c', 'message', text('WA', 'whatsapp')), node('d', 'message', text('TG 2', 'telegram')), node('e', 'message', text('E-mail', 'email'))],
  edges: [['start', 'a'], ['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e']].map(([from, to]) => ({ from, port: 'next', to })) })
  await dm()
  expect(sent).toEqual(['TG 1', 'TG 2'])
  const skipped = await env.DB.prepare('SELECT node_id FROM flow_step_skips ORDER BY step_index').all<{ node_id: string }>()
  expect(skipped.results.map(r => r.node_id)).toEqual(['b', 'c', 'e'])
})

it('passo sem canal (fluxo antigo) continua enviando e nada é registrado', async () => {
  await publish({ nodes: [node('start', 'trigger'), node('old', 'message', text('Fluxo antigo'))], edges: [{ from: 'start', port: 'next', to: 'old' }] })
  await dm()
  expect(sent).toEqual(['Fluxo antigo'])
  expect(await env.DB.prepare('SELECT count(*) FROM flow_step_skips').first('count(*)')).toBe(0)
})

it('channelMismatch compara só quando o passo declara canal', () => {
  expect(channelMismatch(undefined, 'telegram')).toBe(false)
  expect(channelMismatch('telegram', 'telegram')).toBe(false)
  expect(channelMismatch('whatsapp', 'telegram')).toBe(true)
  expect(channelMismatch('pending', 'telegram')).toBe(false)
})

it('passo de modelo num contato de canal sem modelos (Telegram) falha com motivo claro, sem enviar', async () => {
  await publish({ nodes: [node('start', 'trigger'), node('tpl', 'template_message', { template_id: 'qualquer' }), node('depois', 'message', text('Depois'))],
    edges: [{ from: 'start', port: 'next', to: 'tpl' }, { from: 'tpl', port: 'next', to: 'depois' }] })
  workflow = await introspectWorkflow(env.FLOW_RUN!)
  await workflow.modifyAll(async m => { await m.disableSleeps(); await m.disableRetryDelays() })
  const event: InboundEvent = { version: 1, provider: 'telegram', workspaceId: 'a', channelId: 'tg-a', eventId: '900', receivedAt: Date.now(),
    payload: { update_id: 900, message: { message_id: 900, from: { id: 100, first_name: 'Pessoa' }, chat: { id: 100, type: 'private' }, text: 'quero' } } }
  const batch = createMessageBatch('inbound', [{ id: 'q-tpl', timestamp: new Date(), attempts: 1, body: event }])
  await consumeInbound(batch, env)
  await getQueueResult(batch, createExecutionContext())
  const [instance] = await workflow.get()
  await vi.waitFor(async () => expect(await env.DB.prepare('SELECT status FROM flow_runs').first('status')).toBe('failed'), { timeout: 20000 })
  void instance
  expect(sent).toEqual([])
  expect(await env.DB.prepare('SELECT error FROM flow_runs').first('error')).toMatch(/template_channel_unsupported/)
}, 30000)
