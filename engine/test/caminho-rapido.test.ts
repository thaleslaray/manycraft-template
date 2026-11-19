import { giveCredentials } from './credentials'
import { createExecutionContext, createMessageBatch, getQueueResult, introspectWorkflow, type WorkflowIntrospector } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Graph, GraphNode } from '../src/contracts'
import type { InboundEvent } from '../src/integrations'
import { consumeInbound, processInbound, processInboundFast } from '../src/jobs'
import { recoverInlineRuns } from '../src/flow/inline'
import { acceptRaw } from '../src/channels/core/hooks'
import { connectionRuntime } from '../src/channels/core/runtime'
import type { FlowEnv } from '../src/flow/types'
import { seed } from './fixtures'
import { ChannelLimiter } from '../src/flow/limiter'

// Caminho rápido: o webhook processa o evento na hora e roda os primeiros passos em linha; a fila e o Workflow continuam de rede de segurança.
const node = (id: string, type: GraphNode['type'], config: GraphNode['config'] = {}): GraphNode => ({ id, type, position: { x: 0, y: 0 }, config })
const greeting: Graph = { nodes: [node('start', 'trigger'), node('hello', 'message', { blocks: [{ kind: 'text', text: 'Oi! Já te respondo.' }] }),
  node('lead', 'action', { actions: [{ type: 'add_tag', tag_id: 'tag-a' }] }), node('bye', 'message', { blocks: [{ kind: 'typing', seconds: 1 }, { kind: 'text', text: 'Pronto.' }] })],
  edges: [{ from: 'start', port: 'next', to: 'hello' }, { from: 'hello', port: 'next', to: 'lead' }, { from: 'lead', port: 'next', to: 'bye' }] }
const withDelay: Graph = { nodes: [node('start', 'trigger'), node('hello', 'message', { blocks: [{ kind: 'text', text: 'Primeira' }] }),
  node('delay', 'smart_delay', { duration: { value: 1, unit: 'minutes' } }), node('after', 'message', { blocks: [{ kind: 'text', text: 'Depois da espera' }] })],
  edges: [{ from: 'start', port: 'next', to: 'hello' }, { from: 'hello', port: 'next', to: 'delay' }, { from: 'delay', port: 'next', to: 'after' }] }
const withButton: Graph = { nodes: [node('start', 'trigger'), node('offer', 'message', {
  blocks: [{ kind: 'text', text: 'Quer o material?' }, { kind: 'button', id: 'link', label: 'Quero', action: { type: 'go_to_node' } }],
  click_timeout: { value: 1, unit: 'minutes' } }), node('delivery', 'message', { blocks: [{ kind: 'text', text: 'Aqui está' }] })],
  edges: [{ from: 'start', port: 'next', to: 'offer' }, { from: 'offer', port: 'link', to: 'delivery' }] }

let workflow: WorkflowIntrospector | undefined
let sent: { text: string; reply_markup?: { inline_keyboard: { callback_data: string }[][] } }[]
let update = 0

beforeEach(async () => {
  await seed()
  sent = []
  vi.spyOn(ChannelLimiter.prototype, 'acquire').mockResolvedValue({ allowed: true, retryAfter: 0 })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    expect(request.url).toMatch(/^https:\/\/api\.telegram\.org\/botTESTONLY\/(sendMessage|answerCallbackQuery|sendChatAction)$/)
    const body = await request.json() as typeof sent[number] & { chat_id: number }
    if (request.url.endsWith('/sendMessage')) {
      sent.push(body)
      return Response.json({ ok: true, result: { message_id: 10000 + sent.length, date: 1, chat: { id: body.chat_id }, text: body.text } })
    }
    return Response.json({ ok: true, result: true })
  })
  await env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('tg-a','a','telegram','test-bot')").run()
  await giveCredentials(env, 'tg-a', { botToken: 'TESTONLY', webhookSecret: 'secret-tg-a' })
  await env.DB.prepare("UPDATE triggers SET channel_id='tg-a',repeat_mode='every_time' WHERE id='trg-a'").run()
  await env.DB.prepare("UPDATE keywords SET status='live' WHERE id='key-a'").run()
  workflow = await introspectWorkflow(env.FLOW_RUN!)
  await workflow.modifyAll(async (modifier) => { await modifier.disableSleeps(); await modifier.disableRetryDelays() })
})
afterEach(async () => { await workflow?.dispose(); workflow = undefined; vi.restoreAllMocks() })

async function publish(graph: Graph, version = 1) {
  await env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES (?,'a','auto-a',?,?)")
    .bind(`version-${version}`, version, JSON.stringify(graph)).run()
  await env.DB.prepare("UPDATE automations SET status='live',published_version_id=? WHERE id='auto-a'").bind(`version-${version}`).run()
}
function event(payload: Record<string, unknown>): InboundEvent {
  return { version: 1, provider: 'telegram', workspaceId: 'a', channelId: 'tg-a', eventId: String((payload as { update_id: number }).update_id), receivedAt: Date.now(), payload }
}
const dm = (text = 'quero', user = 100) => event({ update_id: ++update, message: { message_id: update, from: { id: user, first_name: 'Pessoa' }, chat: { id: user, type: 'private' }, text } })
async function queue(body: InboundEvent) {
  const batch = createMessageBatch('inbound', [{ id: `queue-${crypto.randomUUID()}`, timestamp: new Date(), attempts: 1, body }])
  await consumeInbound(batch, env)
  return getQueueResult(batch, createExecutionContext())
}
const runRow = () => env.DB.prepare("SELECT id,status,workflow_created_at,executor_claimed_at FROM flow_runs WHERE workspace_id='a' ORDER BY created_at DESC LIMIT 1")
  .first<{ id: string; status: string; workflow_created_at: number | null; executor_claimed_at: number | null }>()

it('fluxo sem espera roda inteiro em linha no webhook: responde sem Workflow, e a fila depois não repete', async () => {
  await publish(greeting)
  const message = dm()
  const log = vi.spyOn(console, 'log')
  await processInboundFast([message], env)
  expect(sent.map(m => m.text)).toEqual(['Oi! Já te respondo.', 'Pronto.'])
  const run = (await runRow())!
  expect(run).toMatchObject({ status: 'done', workflow_created_at: 0 })
  expect(await workflow!.get()).toHaveLength(0)
  expect(await env.DB.prepare("SELECT count(*) FROM contact_tags WHERE tag_id='tag-a' AND contact_id=(SELECT contact_id FROM flow_runs WHERE id=?)").bind(run.id).first('count(*)')).toBe(1)
  // Métricas iguais às do Workflow: um "sent" por mensagem.
  expect(await env.DB.prepare("SELECT count(*) FROM node_events WHERE flow_run_id=? AND type='sent'").bind(run.id).first('count(*)')).toBe(2)
  const lines = log.mock.calls.map(c => String(c[0]))
  const inline = JSON.parse(lines.find(l => l.includes('"flow_inline"'))!)
  expect(inline).toMatchObject({ outcome: 'finished', reason: null })
  expect(inline.firstSendSinceReceivedMs).toBeGreaterThanOrEqual(0)
  expect(lines.some(l => l.includes('"inbound_fast"') && l.includes('"processed"'))).toBe(true)
  // A fila chega depois: vê o evento processado, confirma e não envia de novo.
  expect((await queue(message)).explicitAcks).toHaveLength(1)
  expect(lines.length).toBeGreaterThan(0)
  expect(log.mock.calls.map(c => String(c[0])).some(l => l.includes('"inbound_queue"') && l.includes('"already"'))).toBe(true)
  expect(sent).toHaveLength(2)
  // O evento repetido pela Meta no caminho rápido também não repete.
  await processInboundFast([message], env)
  expect(sent).toHaveLength(2)
  expect(await env.DB.prepare('SELECT count(*) FROM flow_runs').first('count(*)')).toBe(1)
})

it('limite de envio da conversa entre duas partes da mensagem: espera em linha, sem passar ao Workflow', async () => {
  // Duas partes na mesma mensagem (a foto e o texto de uma vitrine): o limite de 1 envio por segundo por conversa recusa a segunda.
  // Antes, toda mensagem de duas partes passava ao Workflow só por isso; agora a espera de ~1 s acontece em linha, como a nova
  // tentativa do Workflow, e a execução termina no webhook.
  await publish({ nodes: [node('start', 'trigger'), node('pair', 'message', { blocks: [{ kind: 'text', text: 'Parte 1' }, { kind: 'text', text: 'Parte 2' }] })],
    edges: [{ from: 'start', port: 'next', to: 'pair' }] })
  const acquire = vi.mocked(ChannelLimiter.prototype.acquire)
  acquire.mockReset()
  acquire.mockResolvedValueOnce({ allowed: true, retryAfter: 0 }).mockResolvedValueOnce({ allowed: false, retryAfter: 1 }).mockResolvedValue({ allowed: true, retryAfter: 0 })
  const started = Date.now()
  await processInboundFast([dm()], env)
  expect(sent.map(m => m.text)).toEqual(['Parte 1', 'Parte 2'])
  expect(Date.now() - started).toBeGreaterThanOrEqual(1000)
  const run = (await runRow())!
  expect(run).toMatchObject({ status: 'done', workflow_created_at: 0 })
  expect(await workflow!.get()).toHaveLength(0)
  expect(await env.DB.prepare("SELECT count(*) FROM node_events WHERE flow_run_id=? AND type='sent' AND node_id='pair'").bind(run.id).first('count(*)')).toBe(1)
})

it('fila e caminho rápido ao mesmo tempo: uma resposta só', async () => {
  await publish(greeting)
  const message = dm()
  const results = await Promise.all([processInboundFast([message], env), queue(message)])
  // Se a fila perdeu a disputa, pede nova tentativa em vez de confirmar sem processar.
  const queued = results[1]
  expect(queued.explicitAcks.length + queued.retryMessages.length).toBe(1)
  await (await workflow!.get())[0]?.waitForStatus('complete')
  expect(sent.map(m => m.text)).toEqual(['Oi! Já te respondo.', 'Pronto.'])
  expect(await env.DB.prepare('SELECT count(*) FROM flow_runs').first('count(*)')).toBe(1)
})

it('evento com posse do caminho rápido: a fila volta depois; posse vencida, a fila processa', async () => {
  await publish(greeting)
  const message = dm()
  const id = JSON.stringify(['telegram', 'tg-a', message.eventId])
  await env.DB.prepare("INSERT INTO inbound_events (id,workspace_id,channel_id,payload,received_at,claimed_at) VALUES (?,'a','tg-a',?,?,?)")
    .bind(id, JSON.stringify(message.payload), message.receivedAt, Date.now()).run()
  expect(await processInbound(message, env)).toBe('busy')
  expect((await queue(message)).retryMessages).toHaveLength(1)
  expect(sent).toHaveLength(0)
  await env.DB.prepare('UPDATE inbound_events SET claimed_at=? WHERE id=?').bind(Date.now() - 61_000, id).run()
  expect((await queue(message)).explicitAcks).toHaveLength(1)
  await (await workflow!.get())[0].waitForStatus('complete')
  expect(sent).toHaveLength(2)
})

it('fluxo com Esperar: primeira mensagem em linha, Workflow assume na espera sem reenviar', async () => {
  await publish(withDelay)
  await processInboundFast([dm()], env)
  expect(sent.map(m => m.text)).toEqual(['Primeira'])
  const run = (await runRow())!
  expect(run.workflow_created_at).toBeGreaterThan(0)
  const [instance] = await workflow!.get()
  await instance.waitForStatus('complete')
  expect(sent.map(m => m.text)).toEqual(['Primeira', 'Depois da espera'])
  expect((await runRow())!.status).toBe('done')
  expect(await env.DB.prepare("SELECT count(*) FROM node_events WHERE flow_run_id=? AND type='sent'").bind(run.id).first('count(*)')).toBe(2)
  expect(await env.DB.prepare('SELECT count(*) FROM flow_inline_steps WHERE run_id=?').bind(run.id).first('count(*)')).toBeGreaterThan(0)
})

it('fluxo com botão: mensagem em linha, Workflow espera o clique e segue', async () => {
  await publish(withButton)
  await processInboundFast([dm()], env)
  expect(sent.map(m => m.text)).toEqual(['Quer o material?'])
  const [instance] = await workflow!.get()
  // waiting:1 já rodou em linha (o Workflow devolve o resultado gravado); o clique pode chegar logo.
  expect(sent).toHaveLength(1)
  expect((await runRow())!.status).toBe('waiting_click')
  const token = sent[0].reply_markup!.inline_keyboard[0][0].callback_data
  await queue(event({ update_id: ++update, callback_query: { id: `cb-${update}`, from: { id: 100 }, data: token, message: { message_id: 1, chat: { id: 100, type: 'private' } } } }))
  await instance.waitForStatus('complete')
  expect(sent.map(m => m.text)).toEqual(['Quer o material?', 'Aqui está'])
})

it('webhook do Telegram dispara o caminho rápido no waitUntil; FAST_INBOUND=off deixa só a fila', async () => {
  await publish(greeting)
  const queued: unknown[] = []
  const bindings = { ...env, INBOUND: { send: async (body: unknown) => { queued.push(body) } } } as unknown as FlowEnv
  const rt = await connectionRuntime(bindings, 'a', 'tg-a')
  const request = (n: number) => ({ method: 'POST' as const, headers: new Headers({ 'X-Telegram-Bot-Api-Secret-Token': 'secret-tg-a' }), query: new URLSearchParams(),
    body: new TextEncoder().encode(JSON.stringify({ update_id: n, message: { message_id: n, from: { id: 100, first_name: 'Pessoa' }, chat: { id: 100, type: 'private' }, text: 'quero' } })) })
  const pending: Promise<void>[] = []
  await acceptRaw(bindings, rt, request(++update), p => { pending.push(p) })
  await Promise.all(pending)
  expect(queued).toHaveLength(1)
  expect(sent).toHaveLength(2)
  pending.length = 0
  const off = { ...bindings, FAST_INBOUND: 'off' } as FlowEnv
  await acceptRaw(off, await connectionRuntime(off, 'a', 'tg-a'), request(++update), p => { pending.push(p) })
  await Promise.all(pending)
  expect(queued).toHaveLength(2)
  expect(sent).toHaveLength(2)
})

it('caminho rápido que caiu no meio: o cron entrega ao Workflow, que não repete o passo gravado', async () => {
  await publish(withDelay)
  // Simula a queda: posse antiga sem Workflow, com a primeira mensagem já enviada e gravada pelo caminho rápido.
  await queue(dm())
  const [instance] = await workflow!.get()
  await instance.waitForStatus('complete')
  const run = (await runRow())!
  expect(sent).toHaveLength(2)
  expect(await recoverInlineRuns(env as FlowEnv)).toBe(0)
  await env.DB.prepare('UPDATE flow_runs SET workflow_created_at=NULL,executor_claimed_at=?,status=? WHERE id=?').bind(Date.now() - 91_000, 'running', run.id).run()
  expect(await recoverInlineRuns(env as FlowEnv)).toBe(1)
  expect((await runRow())!.workflow_created_at).toBeGreaterThan(0)
})
