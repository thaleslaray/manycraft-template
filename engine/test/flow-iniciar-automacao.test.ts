import { giveCredentials, TEST_KEK } from './credentials'
import { createExecutionContext, createMessageBatch, getQueueResult, introspectWorkflow, type WorkflowIntrospector } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Graph, GraphNode } from '../src/contracts'
import type { InboundEvent, IntegrationEnv } from '../src/integrations'
import { consumeInbound } from '../src/jobs'
import { seed } from './fixtures'
import { authenticatedRequest } from './auth-helpers'
import { createAuth } from '../src/auth'
import { ChannelLimiter } from '../src/flow/limiter'

const node = (id: string, type: GraphNode['type'], config: GraphNode['config'] = {}): GraphNode => ({
  id, type, position: { x: 0, y: 0 }, config,
})
const short: Graph = { nodes: [node('start', 'trigger'), node('lead', 'action', { actions: [{ type: 'add_tag', tag_id: 'tag-a' }] })], edges: [{ from: 'start', port: 'next', to: 'lead' }] }
let workflow: WorkflowIntrospector | undefined
let sent: { text: string; chat_id: string | number; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }[]
let update = 0

beforeEach(async () => {
  await seed()
  sent = []
  update = 0
  vi.spyOn(ChannelLimiter.prototype, 'acquire').mockResolvedValue({ allowed: true, retryAfter: 0 })
  // Even a broken mock can never send using the real development bot's token.
  expect(env.CONNECTIONS_KEK_V1).toBe(TEST_KEK)
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    expect(request.url).toMatch(/^https:\/\/api\.telegram\.org\/botTESTONLY\/(sendMessage|answerCallbackQuery)$/)
    const body = await request.json() as typeof sent[number]
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
  await publish(short)
})
afterEach(async () => {
  await workflow?.dispose()
  workflow = undefined
  vi.restoreAllMocks()
})

async function publish(graph: Graph, version = 1) {
  await env.DB.prepare('INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES (?,\'a\',\'auto-a\',?,?)')
    .bind(`version-${version}`, version, JSON.stringify(graph)).run()
  await env.DB.prepare("UPDATE automations SET status='live',published_version_id=? WHERE id='auto-a'").bind(`version-${version}`).run()
}
async function inspect(timeout = false, accelerateSleeps = true) {
  workflow = await introspectWorkflow(env.FLOW_RUN!)
  await workflow.modifyAll(async (modifier) => {
    if (accelerateSleeps) await modifier.disableSleeps()
    await modifier.disableRetryDelays()
    if (timeout) await modifier.forceEventTimeout({ name: 'click:1' })
  })
  return workflow
}
function dm(text = 'quero', user = 100) {
  return { update_id: ++update, message: { message_id: update, from: { id: user, first_name: 'Pessoa de teste' },
    chat: { id: user, type: 'private' }, text } }
}
async function inbound(payload: Record<string, unknown>, options: { workspaceId?: string; channelId?: string; bindings?: IntegrationEnv } = {}) {
  const event: InboundEvent = { version: 1, provider: 'telegram', workspaceId: options.workspaceId ?? 'a',
    channelId: options.channelId ?? 'tg-a', eventId: String((payload as { update_id: number }).update_id), receivedAt: Date.now(), payload }
  const batch = createMessageBatch('inbound', [{ id: `queue-${crypto.randomUUID()}`, timestamp: new Date(), attempts: 1, body: event }])
  await consumeInbound(batch, options.bindings ?? env)
  return getQueueResult(batch, createExecutionContext())
}

async function publishChild(id: string, graph: Graph, version = 1) {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO automations (id,workspace_id,name) VALUES (?,\'a\',?)').bind(id, `Automação ${id}`),
    env.DB.prepare('INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES (?,\'a\',?,?,?)').bind(`${id}-v${version}`, id, version, JSON.stringify(graph)),
    env.DB.prepare("UPDATE automations SET status='live',published_version_id=? WHERE id=?").bind(`${id}-v${version}`, id),
  ])
}
const say = (id: string, text: string) => node(id, 'message', { blocks: [{ kind: 'text', text }] })
const parentGraph = (config: Record<string, unknown> = {}): Graph => ({
  nodes: [node('start', 'trigger'), say('antes', 'Antes'), node('call', 'start_automation', { automation_id: 'child-auto', wait_for_finish: true, ...config }), say('depois', 'Depois')],
  edges: [{ from: 'start', port: 'next', to: 'antes' }, { from: 'antes', port: 'next', to: 'call' }, { from: 'call', port: 'next', to: 'depois' }],
})
const childSays: Graph = { nodes: [node('start', 'trigger'), say('dentro', 'Dentro')], edges: [{ from: 'start', port: 'next', to: 'dentro' }] }
async function finishAll() {
  for (let round = 0; round < 3; round++) for (const current of await workflow!.get()) await current.waitForStatus('complete')
}

it('com "esperar terminar" a automação chamada termina e só então segue para o passo seguinte', async () => {
  await publish(parentGraph(), 2)
  await publishChild('child-auto', childSays)
  await inspect()
  await inbound(dm())
  await finishAll()
  expect(sent.map(m => m.text)).toEqual(['Antes', 'Dentro', 'Depois'])
  const rows = await env.DB.prepare("SELECT automation_version_id v,parent_run_id p,status s FROM flow_runs ORDER BY depth").all<{ v: string; p: string | null; s: string }>()
  expect(rows.results.map(r => [r.v, r.s, r.p === null])).toEqual([['version-2', 'done', true], ['child-auto-v1', 'done', false]])
})

it('sem a opção no grafo (publicado antes dela existir) não espera, como \"seguir sem esperar\"', async () => {
  await publish(parentGraph({ wait_for_finish: undefined }), 2)
  await publishChild('child-auto', childSays)
  const { calledBy } = await import('../src/db/called-by')
  expect(await calledBy(env.DB, 'a', 'child-auto')).toEqual([{ id: 'auto-a', name: expect.any(String), waits: false }])
})

it('com "seguir sem esperar" o fluxo original não espera o término da chamada', async () => {
  await publish(parentGraph({ wait_for_finish: false }), 2)
  await publishChild('child-auto', childSays)
  await inspect()
  await inbound(dm())
  await finishAll()
  expect(sent.map(m => m.text)).toContain('Depois')
  expect(await env.DB.prepare('SELECT count(*) n FROM flow_runs WHERE parent_run_id IS NOT NULL').first('n')).toBe(0)
})

it('retoma o fluxo original depois que o contato responde a pergunta da automação chamada', async () => {
  const child: Graph = { nodes: [node('start', 'trigger'), node('ask', 'question' as GraphNode['type'], {
    text: 'Qual o seu nome?', answer_type: 'text', field_id: 'field-a', retry_message: 'Tente de novo.', max_attempts: 2, skip: true, timeout: { value: 1, unit: 'minutes' } }), say('ok', 'Anotado')],
    edges: [{ from: 'start', port: 'next', to: 'ask' }, { from: 'ask', port: 'success', to: 'ok' }] }
  await publish(parentGraph(), 2)
  await publishChild('child-auto', child)
  await inspect()
  await inbound(dm())
  await vi.waitFor(async () => expect(sent.map(m => m.text)).toEqual(['Antes', 'Qual o seu nome?']), { timeout: 20000 })
  // O fluxo original ainda espera: nada de "Depois" antes da resposta.
  expect(await env.DB.prepare("SELECT status FROM flow_runs WHERE depth=0").first('status')).not.toBe('done')
  await inbound(dm('Maria'))
  await finishAll()
  expect(sent.map(m => m.text)).toEqual(['Antes', 'Qual o seu nome?', 'Anotado', 'Depois'])
})

it('filha cancelada (automação foi para a lixeira) avisa o pai, que termina cancelado e não segue para o passo seguinte', async () => {
  const child: Graph = { nodes: [node('start', 'trigger'), node('ask', 'question' as GraphNode['type'], {
    text: 'Qual o seu nome?', answer_type: 'text', field_id: 'field-a', retry_message: 'Tente de novo.', max_attempts: 2, skip: true, timeout: { value: 1, unit: 'minutes' } }), say('ok', 'Anotado')],
    edges: [{ from: 'start', port: 'next', to: 'ask' }, { from: 'ask', port: 'success', to: 'ok' }] }
  await publish(parentGraph(), 2)
  await publishChild('child-auto', child)
  // Só a pessoa e o vínculo com o espaço: seedAuth() apagaria os espaços que o teste já montou.
  await (await createAuth(env).$context).internalAdapter.createUser({ id: 'user-a', name: 'Pessoa a', email: 'a@example.test', emailVerified: true }, { method: 'test-fixture' })
  await env.DB.prepare("INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES ('member-a','a','user-a','owner')").run()
  await inspect()
  await inbound(dm())
  await vi.waitFor(async () => expect(sent.map(m => m.text)).toEqual(['Antes', 'Qual o seu nome?']), { timeout: 20000 })
  expect((await authenticatedRequest('automations/child-auto/trash', 'a', { method: 'POST' })).status).toBe(200)
  await vi.waitFor(async () => expect(await env.DB.prepare('SELECT status FROM flow_runs WHERE depth=0').first('status')).toBe('cancelled'), { timeout: 20000 })
  expect(sent.map(m => m.text)).not.toContain('Depois')
})

it('filha pausada pela segurança (30 passos seguidos) pausa o pai no passo da chamada, sem concluí-lo', async () => {
  const loop: Graph = { nodes: [node('start', 'trigger'), node('note', 'note' as GraphNode['type'])], edges: [{ from: 'start', port: 'next', to: 'note' }, { from: 'note', port: 'next', to: 'note' }] }
  await publish(parentGraph(), 2)
  await publishChild('child-auto', loop)
  await inspect()
  await inbound(dm())
  await vi.waitFor(async () => expect(await env.DB.prepare('SELECT error FROM flow_runs WHERE depth=0').first('error')).toBe('consecutive_block_limit'), { timeout: 20000 })
  expect(await env.DB.prepare('SELECT status,current_node_id FROM flow_runs WHERE depth=0').first()).toEqual({ status: 'waiting_delay', current_node_id: 'call' })
  expect(sent.map(m => m.text)).toEqual(['Antes'])
})

it('proteção contra laço: A espera B e B espera A, a segunda chamada é recusada e nada se repete sem fim', async () => {
  const a: Graph = { nodes: [node('start', 'trigger'), node('call', 'start_automation', { automation_id: 'loop-b', wait_for_finish: true }), say('fim', 'Fim de A')],
    edges: [{ from: 'start', port: 'next', to: 'call' }, { from: 'call', port: 'next', to: 'fim' }] }
  const b: Graph = { nodes: [node('start', 'trigger'), node('call', 'start_automation', { automation_id: 'auto-a', wait_for_finish: true }), say('fim', 'Fim de B')],
    edges: [{ from: 'start', port: 'next', to: 'call' }, { from: 'call', port: 'next', to: 'fim' }] }
  await publish(a, 2)
  await publishChild('loop-b', b)
  await inspect()
  await inbound(dm())
  await vi.waitFor(async () => expect((await env.DB.prepare('SELECT count(*) n FROM flow_runs').first<number>('n'))).toBe(2), { timeout: 20000 })
  await vi.waitFor(async () => expect(await env.DB.prepare("SELECT count(*) n FROM flow_runs WHERE status='failed'").first('n')).toBeGreaterThan(0), { timeout: 20000 })
  await vi.waitFor(() => expect(sent.map(m => m.text)).toEqual(['Fim de A']), { timeout: 20000 })
  expect(await env.DB.prepare('SELECT count(*) n FROM flow_runs').first('n')).toBe(2)
  expect(sent.map(m => m.text)).toEqual(['Fim de A'])
})

it('"Chamada por" lista as automações publicadas que iniciam a automação', async () => {
  await publish(parentGraph(), 2)
  await publishChild('child-auto', childSays)
  const { calledBy } = await import('../src/db/called-by')
  expect(await calledBy(env.DB, 'a', 'child-auto')).toEqual([{ id: 'auto-a', name: expect.any(String), waits: true }])
  expect(await calledBy(env.DB, 'a', 'auto-a')).toEqual([])
})
