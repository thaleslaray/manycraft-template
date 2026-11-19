import { saveBroadcast, processBroadcastBatch, getBroadcast } from '../src/db/broadcasts'
import { giveCredentials, TEST_KEK } from './credentials'
import { createExecutionContext, createMessageBatch, getQueueResult, introspectWorkflow, type WorkflowIntrospector } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Graph, GraphNode } from '../src/contracts'
import type { InboundEvent, IntegrationEnv } from '../src/integrations'
import { consumeInbound } from '../src/jobs'
import { seed } from './fixtures'
import { ChannelLimiter } from '../src/flow/limiter'
import app from '../src/index'

const node = (id: string, type: GraphNode['type'], config: GraphNode['config'] = {}): GraphNode => ({
  id, type, position: { x: 0, y: 0 }, config,
})
const demo: Graph = {
  nodes: [node('start', 'trigger'), node('offer', 'message', {
    blocks: [{ kind: 'text', text: 'Quer receber o material?' },
      { kind: 'button', id: 'link', label: 'Quero o link', action: { type: 'go_to_node' } }],
    click_timeout: { value: 1, unit: 'minutes' },
  }), node('delay', 'smart_delay', { duration: { value: 1, unit: 'minutes' } }),
  node('delivery', 'message', { blocks: [{ kind: 'text', text: 'Material da versão original' }] }),
  node('lead', 'action', { actions: [{ type: 'add_tag', tag_id: 'tag-a' }] }),
  node('timeout', 'message', { blocks: [{ kind: 'text', text: 'Você pode pedir novamente quando quiser.' }] })],
  edges: [{ from: 'start', port: 'next', to: 'offer' }, { from: 'offer', port: 'link', to: 'delay' },
    { from: 'offer', port: 'timeout', to: 'timeout' }, { from: 'delay', port: 'next', to: 'delivery' },
    { from: 'delivery', port: 'next', to: 'lead' }],
}
const short: Graph = { nodes: [node('start', 'trigger'), node('lead', 'action', {
  actions: [{ type: 'add_tag', tag_id: 'tag-a' }],
})], edges: [{ from: 'start', port: 'next', to: 'lead' }] }
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
  await publish(demo)
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
async function runRow() {
  return env.DB.prepare("SELECT id,status,contact_id,automation_version_id FROM flow_runs WHERE workspace_id='a' ORDER BY created_at DESC LIMIT 1")
    .first<{ id: string; status: string; contact_id: string; automation_version_id: string }>()
}
async function instance() {
  const instances = await workflow!.get()
  expect(instances).toHaveLength(1)
  return instances[0]
}
async function click(token: string, user = 100) {
  return inbound({ update_id: ++update, callback_query: { id: `callback-${update}`, from: { id: user }, data: token,
    message: { message_id: 1, chat: { id: user, type: 'private' } } } })
}
async function offered() {
  const current = await instance()
  await current.waitForStepResult({ name: 'waiting:1' })
  expect(sent).toHaveLength(1)
  const button = sent[0].reply_markup!.inline_keyboard[0][0]
  expect(button.text).toBe('Quero o link')
  expect(button.callback_data).toMatch(/^b:[a-f0-9]{24}$/)
  expect(new TextEncoder().encode(button.callback_data).length).toBeLessThanOrEqual(64)
  return { current, token: button.callback_data }
}

it('executa fila → contato → keyword → Workflow → botão → atraso → mensagem → etiqueta; deduplica updates e cliques', async () => {
  await inspect()
  const payload = dm()
  expect((await inbound(payload)).retryMessages).toEqual([])
  const { current, token } = await offered()
  expect((await runRow())?.status).toBe('waiting_click')
  await inbound(payload)
  await click(token)
  await click(token)
  await current.waitForStatus('complete')
  const run = (await runRow())!
  expect(run.status).toBe('done')
  expect(sent.map((message) => message.text)).toEqual(['Quer receber o material?', 'Material da versão original'])
  expect(await env.DB.prepare('SELECT count(*) FROM trigger_firings').first('count(*)')).toBe(1)
  expect(await env.DB.prepare('SELECT count(*) FROM flow_runs').first('count(*)')).toBe(1)
  // Família palavra-chave: o contato novo guarda o gatilho como origem de entrada.
  expect(await env.DB.prepare("SELECT optin_source FROM contacts WHERE id=(SELECT contact_id FROM flow_runs LIMIT 1)").first('optin_source')).toBe('trigger:trg-a')
  expect(await env.DB.prepare("SELECT count(*) FROM contact_tags WHERE contact_id=? AND tag_id='tag-a'").bind(run.contact_id).first('count(*)')).toBe(1)
  const metrics = await env.DB.prepare('SELECT type,count(*) AS count FROM node_events WHERE flow_run_id=? AND type IN (\'sent\',\'clicked\') GROUP BY type ORDER BY type')
    .bind(run.id).all()
  expect(metrics.results).toEqual([{ type: 'clicked', count: 1 }, { type: 'sent', count: 2 }])
  expect(await env.DB.prepare("SELECT count(*) FROM contact_channels WHERE channel_id='tg-a' AND external_user_id='100'").first('count(*)')).toBe(1)
  expect(await env.DB.prepare('SELECT profile_pic_url FROM contacts WHERE id=?').bind(run.contact_id).first('profile_pic_url')).toBe(`/api/contacts/${run.contact_id}/avatar`)
  const messages = await env.DB.prepare('SELECT direction,source,content FROM messages ORDER BY created_at,id').all<{ direction: string; source: string; content: string }>()
  expect(messages.results.filter(m => m.direction === 'in').map(m => JSON.parse(m.content).text).sort()).toEqual(['Quero o link', 'quero'])
  expect(messages.results.filter(m => m.source === 'automation')).toHaveLength(2)
  expect(messages.results.filter(m => m.source === 'automation').map(m => JSON.parse(m.content).text)).toEqual(sent.map(m => m.text))
})

it('clique executa ações do botão uma vez e reabre a janela conforme a ficha efetiva', async () => {
  const graph = structuredClone(demo)
  graph.nodes[1].config.blocks = [{ kind: 'text', text: 'Escolha' }, {
    kind: 'button', id: 'link', label: 'Quero o link', action: { type: 'go_to_node' },
    actions: [{ type: 'add_tag', tag_id: 'tag-a' }, { type: 'set_custom_field_value', field_id: 'button-field', value: 'clicou' }],
  }]
  await env.DB.prepare("INSERT INTO custom_fields(id,workspace_id,name,type) VALUES ('button-field','a','Interesse do botão','text')").run()
  await env.DB.prepare("UPDATE channels SET capabilities_override=? WHERE id='tg-a'")
    .bind(JSON.stringify({ window: { standardHours: 24 } })).run()
  await publish(graph, 2)
  await inspect()
  await inbound(dm())
  const { current, token } = await offered()
  const run = (await runRow())!
  await env.DB.prepare('UPDATE contact_channels SET window_expires_at=0 WHERE contact_id=?').bind(run.contact_id).run()
  const clickedAt = Date.now()
  await click(token); await click(token)
  await current.waitForStatus('complete')
  expect(await env.DB.prepare("SELECT value FROM contact_field_values WHERE contact_id=? AND field_id='button-field'").bind(run.contact_id).first('value')).toBe('"clicou"')
  expect(await env.DB.prepare("SELECT count(*) FROM contact_tags WHERE contact_id=? AND tag_id='tag-a'").bind(run.contact_id).first('count(*)')).toBe(1)
  const expires = await env.DB.prepare('SELECT window_expires_at FROM contact_channels WHERE contact_id=?').bind(run.contact_id).first<number>('window_expires_at')
  expect(expires).toBeGreaterThanOrEqual(clickedAt + 86400000)
})

it('pausa antes do bloco 31 sem espera, preservando os primeiros 30 efeitos', async () => {
  await env.DB.prepare("INSERT INTO custom_fields(id,workspace_id,name,type) VALUES ('counter','a','Contador','number')").run()
  const graph: Graph = { nodes: [node('start', 'trigger'), ...Array.from({ length: 31 }, (_, i) => node(`a${i}`, 'action', {
    actions: [{ type: 'set_custom_field_value', field_id: 'counter', value: i + 1 }],
  }))], edges: Array.from({ length: 31 }, (_, i) => ({ from: i ? `a${i - 1}` : 'start', port: 'next', to: `a${i}` })) }
  await publish(graph, 2); await inspect(); await inbound(dm())
  await (await instance()).waitForStatus('complete')
  const run = (await runRow())!
  expect(run.status).toBe('waiting_delay')
  expect(await env.DB.prepare('SELECT value FROM contact_field_values WHERE contact_id=?').bind(run.contact_id).first('value')).toBe('30')
  expect(await env.DB.prepare('SELECT error FROM flow_runs WHERE id=?').bind(run.id).first('error')).toBe('consecutive_block_limit')
  expect(await env.DB.prepare('SELECT steps_since_pause FROM flow_runs WHERE id=?').bind(run.id).first('steps_since_pause')).toBe(30)
})

it('um ciclo de notas também encontra a pausa de segurança', async () => {
  await publish({ nodes: [node('start', 'trigger'), node('note', 'note' as GraphNode['type'])], edges: [{ from: 'start', port: 'next', to: 'note' }, { from: 'note', port: 'next', to: 'note' }] }, 2)
  await inspect(); await inbound(dm())
  await (await instance()).waitForStatus('complete')
  expect((await runRow())?.status).toBe('waiting_delay')
  expect(await env.DB.prepare('SELECT steps_since_pause FROM flow_runs').first('steps_since_pause')).toBe(30)
})

it('espera por clique e Smart Delay reiniciam o limite de blocos consecutivos', async () => {
  const graph = structuredClone(demo)
  const chain = Array.from({ length: 29 }, (_, i) => node(`chain${i}`, 'action', { actions: [{ type: 'add_tag', tag_id: 'tag-a' }] }))
  graph.nodes.push(...chain)
  graph.edges = graph.edges.filter(e => e.from !== 'start')
  graph.edges.push(...chain.map((n, i) => ({ from: i ? chain[i - 1].id : 'start', port: 'next', to: n.id })), { from: chain.at(-1)!.id, port: 'next', to: 'offer' })
  await publish(graph, 2); await inspect(); await inbound(dm())
  const current = await instance()
  await current.waitForStepResult({ name: 'waiting:30' })
  const token = sent[0].reply_markup!.inline_keyboard[0][0].callback_data
  await click(token)
  await current.waitForStatus('complete')
  expect((await runRow())?.status).toBe('done')
  expect(sent.map(m => m.text)).toEqual(['Quer receber o material?', 'Material da versão original'])
})

it('Smart Delay permite uma nova série de 30 blocos sem acionar a pausa de segurança', async () => {
  const list = Array.from({ length: 29 }, (_, i) => node(`before${i}`, 'action', { actions: [{ type: 'add_tag', tag_id: 'tag-a' }] }))
  list.push(node('wait', 'smart_delay', { duration: { value: 1, unit: 'seconds' } }))
  list.push(...Array.from({ length: 29 }, (_, i) => node(`after${i}`, 'action', { actions: [{ type: 'add_tag', tag_id: 'tag-a' }] })))
  list.push(node('end', 'message', { blocks: [{ kind: 'text', text: 'Concluído após espera' }] }))
  await publish({ nodes: [node('start', 'trigger'), ...list], edges: list.map((n, i) => ({ from: i ? list[i - 1].id : 'start', port: 'next', to: n.id })) }, 2)
  await inspect(); await inbound(dm())
  await (await instance()).waitForStatus('complete')
  expect((await runRow())?.status).toBe('done')
  expect(sent.map(m => m.text)).toEqual(['Concluído após espera'])
})

it('timeout do botão percorre a porta sem clique e conclui sem etiqueta ou erro', async () => {
  await inspect(true)
  await inbound(dm())
  await (await instance()).waitForStatus('complete')
  expect((await runRow())?.status).toBe('done')
  expect(sent.map((message) => message.text)).toEqual(['Quer receber o material?', 'Você pode pedir novamente quando quiser.'])
  expect(await env.DB.prepare("SELECT count(*) FROM contact_tags WHERE contact_id=?").bind((await runRow())!.contact_id).first('count(*)')).toBe(0)
  expect(await env.DB.prepare("SELECT count(*) FROM node_events WHERE type='clicked'").first('count(*)')).toBe(0)
})

it('publicar enquanto espera o clique: o run segue a versão nova a partir da espera seguinte (ponto de retomada)', async () => {
  await inspect()
  await inbound(dm())
  const { current, token } = await offered()
  const changed = structuredClone(demo)
  changed.nodes.find((entry) => entry.id === 'delivery')!.config = { blocks: [{ kind: 'text', text: 'Versão nova' }] }
  await publish(changed, 2)
  await click(token)
  await current.waitForStatus('complete')
  expect((await runRow())?.automation_version_id).toBe('version-2')
  expect(sent.at(-1)?.text).toBe('Versão nova')
})

it.each([
  ['is', 'QuErO', 'quero', true], ['contains', 'eu quero agora', 'quero', true],
  ['starts_with', 'quero material', 'quero', true], ['word_match', 'eu quero!', 'quero', true],
  ['word_match', 'requerologia', 'quero', false], ['does_not_contain', 'material liberado', 'bloqueado', true],
  ['does_not_contain', 'está bloqueado', 'bloqueado', false],
])('keyword %s com texto %s e palavra %s corresponde: %s', async (rule, text, word, matches) => {
  await publish(short, 2)
  await env.DB.prepare("UPDATE keywords SET rule=?,words=? WHERE id='key-a'").bind(rule, JSON.stringify([word])).run()
  await inspect()
  await inbound(dm(text as string))
  const created = await workflow!.get()
  expect(created).toHaveLength(matches ? 1 : 0)
  if (created.length) await created[0].waitForStatus('complete')
  expect(await env.DB.prepare('SELECT count(*) FROM trigger_firings').first('count(*)')).toBe(matches ? 1 : 0)
})

it('prioriza o gatilho equivalente mais antigo e boas-vindas só ocorre no primeiro contato sem keyword', async () => {
  await publish(short, 2)
  await env.DB.batch([
    env.DB.prepare("INSERT INTO triggers (id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode) VALUES ('priority','a','auto-a','tg-a','Prioridade','keyword','active','every_time')"),
    env.DB.prepare("INSERT INTO keywords (id,workspace_id,trigger_id,rule,words,status,priority) VALUES ('priority','a','priority','contains','[\"quero\"]','live',0)"),
    env.DB.prepare("UPDATE triggers SET created_at=1 WHERE id='priority'"),
    env.DB.prepare("INSERT INTO triggers (id,workspace_id,automation_id,channel_id,name,kind,status) VALUES ('welcome','a','auto-a','tg-a','Boas-vindas','welcome_message','active')"),
  ])
  await inspect()
  await inbound(dm())
  await inbound(dm('olá', 200))
  await inbound(dm('olá novamente', 200))
  for (const current of await workflow!.get()) await current.waitForStatus('complete')
  const firings = await env.DB.prepare('SELECT trigger_id FROM trigger_firings ORDER BY trigger_id').all()
  expect(firings.results).toEqual([{ trigger_id: 'priority' }, { trigger_id: 'welcome' }])
})

it('Basic roteia keyword antes de boas-vindas e padrão, mantém 24h e idempotência', async () => {
  await publish(short, 2)
  await env.DB.batch([
    env.DB.prepare("INSERT INTO triggers (id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode) VALUES ('basic-welcome','a','auto-a','tg-a','Boas-vindas','welcome_message','active','once')"),
    env.DB.prepare("INSERT INTO triggers (id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode) VALUES ('basic-default','a','auto-a','tg-a','Resposta padrão','default_reply','active','once_per_24_hours')"),
  ])
  await inspect()
  await inbound(dm('quero', 100))
  await inbound(dm('olá', 200))
  const payload = dm('qualquer texto', 200)
  await inbound(payload)
  await inbound(payload)
  await inbound(dm('de novo', 200))
  for (const current of await workflow!.get()) await current.waitForStatus('complete')
  expect((await env.DB.prepare('SELECT trigger_id FROM trigger_firings ORDER BY fired_at,trigger_id').all()).results.map(r => r.trigger_id))
    .toEqual(['trg-a', 'basic-welcome', 'basic-default'])
  await env.DB.prepare("UPDATE trigger_firings SET fired_at=? WHERE trigger_id='basic-default'").bind(Date.now() - 86400001).run()
  await inbound(dm('outra dúvida', 200))
  for (const current of await workflow!.get()) await current.waitForStatus('complete')
  expect(await env.DB.prepare("SELECT count(*) n FROM trigger_firings WHERE trigger_id='basic-default'").first('n')).toBe(2)
  // Uma keyword reconhecida que atingiu sua frequência não cai na resposta padrão.
  await env.DB.prepare("UPDATE triggers SET repeat_mode='once' WHERE id='trg-a'").run()
  await inbound(dm('quero', 100))
  await inbound(dm('quero', 100))
  for (const current of await workflow!.get()) await current.waitForStatus('complete')
  expect(await env.DB.prepare("SELECT count(*) n FROM trigger_firings WHERE trigger_id='basic-default'").first('n')).toBe(2)
  // O mesmo contato tem sua própria primeira entrada na segunda conexão.
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('tg-other','a','telegram','another-bot')"),
    env.DB.prepare(`INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in)
      SELECT 'other-cc','a',contact_id,'tg-other','200',1 FROM contact_channels WHERE channel_id='tg-a' AND external_user_id='200'`),
    env.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode) VALUES ('other-welcome','a','auto-a','tg-other','Recepção','welcome_message','active','once')"),
  ])
  await giveCredentials(env, 'tg-other', { botToken: 'TESTONLY', webhookSecret: 'secret-other' })
  await inbound(dm('olá', 200), { channelId: 'tg-other' })
  await inbound(dm('mais uma', 200), { channelId: 'tg-other' })
  for (const current of await workflow!.get()) await current.waitForStatus('complete')
  expect(await env.DB.prepare("SELECT count(*) n FROM trigger_firings WHERE trigger_id='other-welcome'").first('n')).toBe(1)
})

it('rejeita callback de outro contato e envelope de outro workspace', async () => {
  await inspect()
  await inbound(dm())
  const { current, token } = await offered()
  await click(token, 999)
  expect((await runRow())?.status).toBe('waiting_click')
  expect(sent).toHaveLength(1)
  const result = await inbound(dm(), { workspaceId: 'b' })
  expect(result.retryMessages).toHaveLength(1)
  expect(await env.DB.prepare("SELECT count(*) FROM flow_runs WHERE workspace_id='b'").first('count(*)')).toBe(0)
  await click(token)
  await current.waitForStatus('complete')
})

it('retry após falha de criação do Workflow recupera o mesmo disparo e run', async () => {
  await publish(short, 2)
  await inspect()
  const payload = dm()
  const create = vi.fn(async () => { throw new Error('Workflow indisponível') })
  expect((await inbound(payload, { bindings: { ...env, FLOW_RUN: { create } as unknown as Workflow<{ runId: string }> } })).retryMessages).toHaveLength(1)
  expect((await inbound(payload)).retryMessages).toEqual([])
  await (await instance()).waitForStatus('complete')
  expect(await env.DB.prepare('SELECT count(*) FROM flow_runs').first('count(*)')).toBe(1)
  expect(await env.DB.prepare('SELECT count(*) FROM trigger_firings').first('count(*)')).toBe(1)
  expect((await runRow())?.status).toBe('done')
})

it('reutiliza o contato já vinculado ao usuário Telegram sem criar contato órfão', async () => {
  await publish(short, 2)
  await env.DB.prepare(`INSERT INTO contact_channels
    (id,workspace_id,contact_id,channel_id,external_user_id,opted_in)
    VALUES ('tg-known','a','c-a','tg-a','100',1)`).run()
  await inspect()
  await inbound(dm())
  await (await instance()).waitForStatus('complete')
  expect((await runRow())?.contact_id).toBe('c-a')
  expect(await env.DB.prepare("SELECT count(*) FROM contacts WHERE workspace_id='a'").first('count(*)')).toBe(1)
  expect(await env.DB.prepare("SELECT contact_id FROM contact_channels WHERE id='tg-known'").first('contact_id')).toBe('c-a')
})

it('once_per_24_hours respeita uma janela móvel desde o disparo anterior', async () => {
  await publish(short, 2)
  await env.DB.prepare("UPDATE triggers SET repeat_mode='once_per_24_hours' WHERE id='trg-a'").run()
  await inspect()
  await inbound(dm())
  await (await instance()).waitForStatus('complete')
  await inbound(dm())
  expect(await workflow!.get()).toHaveLength(1)
  expect(await env.DB.prepare('SELECT count(*) FROM trigger_firings').first('count(*)')).toBe(1)
  await env.DB.prepare("UPDATE trigger_firings SET fired_at=? WHERE trigger_id='trg-a'").bind(Date.now() - 86400001).run()
  await inbound(dm())
  const instances = await workflow!.get()
  expect(instances).toHaveLength(2)
  await instances[1].waitForStatus('complete')
  expect(await env.DB.prepare('SELECT count(*) FROM trigger_firings').first('count(*)')).toBe(2)
  expect(await env.DB.prepare("SELECT count(*) FROM flow_runs WHERE status='done'").first('count(*)')).toBe(2)
})

it.each([['all', 'true'], ['any', 'true'], ['all', 'false']])('ações e condição %s seguem porta %s com valores do contato', async (match, port) => {
  const graph: Graph = {
    nodes: [node('start', 'trigger'), node('set', 'action', { actions: [
      { type: 'add_tag', tag_id: 'tag-a' }, { type: 'set_custom_field_value', field_id: 'field-a', value: 'curso' },
    ] }), node('check', 'condition', { match, rules: [
      { type: 'tag', tag_id: 'tag-a', operator: 'has' },
      { type: 'field', field_id: 'field-a', operator: 'equals', value: port === 'false' ? 'outro' : 'curso' },
    ] }), node('true', 'message', { blocks: [{ kind: 'text', text: 'Caminho aprovado' }] }),
    node('false', 'message', { blocks: [{ kind: 'text', text: 'Caminho alternativo' }] }),
    node('clear', 'action', { actions: [{ type: 'remove_tag', tag_id: 'tag-a' },
      { type: 'unset_custom_field_value', field_id: 'field-a' }] })],
    edges: [{ from: 'start', port: 'next', to: 'set' }, { from: 'set', port: 'next', to: 'check' },
      { from: 'check', port: 'true', to: 'true' }, { from: 'check', port: 'false', to: 'false' },
      { from: 'true', port: 'next', to: 'clear' }, { from: 'false', port: 'next', to: 'clear' }],
  }
  await publish(graph, 2)
  await inspect()
  await inbound(dm())
  await (await instance()).waitForStatus('complete')
  expect(sent.map(message => message.text)).toEqual([port === 'true' ? 'Caminho aprovado' : 'Caminho alternativo'])
  const run = (await runRow())!
  expect(await env.DB.prepare('SELECT count(*) FROM contact_tags WHERE contact_id=?').bind(run.contact_id).first('count(*)')).toBe(0)
  expect(await env.DB.prepare('SELECT count(*) FROM contact_field_values WHERE contact_id=?').bind(run.contact_id).first('count(*)')).toBe(0)
})

it('randomizer mantém variante por contato e iniciar automação cria um filho publicado em cada run', async () => {
  const parent: Graph = {
    nodes: [node('start', 'trigger'), node('split', 'randomizer', {
      variations: [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }], random_every_time: false,
    }), node('a', 'message', { blocks: [{ kind: 'text', text: 'Variante A' }] }),
    node('b', 'message', { blocks: [{ kind: 'text', text: 'Variante B' }] }),
    node('child', 'start_automation', { automation_id: 'child-auto' })],
    edges: [{ from: 'start', port: 'next', to: 'split' }, { from: 'split', port: 'a', to: 'a' },
      { from: 'split', port: 'b', to: 'b' }, { from: 'a', port: 'next', to: 'child' },
      { from: 'b', port: 'next', to: 'child' }],
  }
  await publish(parent, 2)
  await env.DB.batch([
    env.DB.prepare("INSERT INTO automations (id,workspace_id,name) VALUES ('child-auto','a','Automação filha')"),
    env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('child-version','a','child-auto',1,?)").bind(JSON.stringify(short)),
    env.DB.prepare("UPDATE automations SET status='live',published_version_id='child-version' WHERE id='child-auto'"),
  ])
  await inspect()
  await inbound(dm())
  // The parent's completion guarantees its child was created, then await both instances.
  await (await workflow!.get())[0].waitForStatus('complete')
  for (const current of await workflow!.get()) await current.waitForStatus('complete')
  await inbound(dm())
  for (const current of await workflow!.get()) await current.waitForStatus('complete')
  for (const current of await workflow!.get()) await current.waitForStatus('complete')
  expect(await workflow!.get()).toHaveLength(4)
  expect(sent).toHaveLength(2)
  expect(sent[0].text).toBe(sent[1].text)
  expect(await env.DB.prepare('SELECT count(*) FROM flow_random_assignments').first('count(*)')).toBe(1)
  expect(await env.DB.prepare("SELECT count(*) FROM flow_runs WHERE automation_version_id='child-version' AND depth=1 AND status='done'").first('count(*)')).toBe(2)
})

const singleMessage: Graph = { nodes: [node('start', 'trigger'), node('message', 'message', {
  blocks: [{ kind: 'text', text: 'Mensagem com confirmação de envio' }],
})], edges: [{ from: 'start', port: 'next', to: 'message' }] }

it('Telegram 429 permite retry do envio e registra uma única mensagem enviada', async () => {
  await publish(singleMessage, 2)
  await inspect()
  vi.mocked(fetch).mockImplementationOnce(async () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 2 } }, { status: 429 }))
  await inbound(dm())
  await (await instance()).waitForStatus('complete')
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(sent).toHaveLength(1)
  expect((await runRow())?.status).toBe('done')
  expect(await env.DB.prepare("SELECT count(*) FROM node_events WHERE type='sent'").first('count(*)')).toBe(1)
})

it('falha de rede deixa envio incerto e interrompe sem repetir uma possível entrega', async () => {
  await publish(singleMessage, 2)
  await inspect()
  vi.mocked(fetch).mockRejectedValueOnce(new Error('Connection reset after send'))
  await inbound(dm())
  await (await instance()).waitForStatus('errored')
  expect(fetch).toHaveBeenCalledTimes(1)
  expect((await runRow())?.status).toBe('failed')
  expect(await env.DB.prepare('SELECT status FROM flow_outbound').first('status')).toBe('uncertain')
  expect(await env.DB.prepare("SELECT count(*) FROM node_events WHERE type='sent'").first('count(*)')).toBe(0)
  const message = await env.DB.prepare("SELECT content FROM messages WHERE source='automation'").first<string>('content')
  expect(JSON.parse(message!).status).toBe('failed')
})

it('uma DM entra na conversa e chega ao WebSocket mesmo sem gatilho correspondente', async () => {
  const response = await env.INBOX_HUB!.getByName('a').fetch(new Request('https://inbox.test/live', { headers: { Upgrade: 'websocket', 'x-inbox-user': 'user-a' } }))
  const socket = response.webSocket!
  socket.accept()
  const received = new Promise<Record<string, unknown>>(resolve => socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true }))
  const payload = dm('apenas uma conversa')
  await inbound(payload)
  const event = await received
  expect(event).toMatchObject({ type: 'message', message: { direction: 'in', sender: 'contact', text: 'apenas uma conversa' },
    conversation: { channel_type: 'telegram', unread_count: 1, contact: { name: 'Pessoa de teste' } } })
  await inbound(payload)
  expect(await env.DB.prepare("SELECT count(*) FROM messages WHERE direction='in'").first('count(*)')).toBe(1)
  expect(await env.DB.prepare('SELECT count(*) FROM flow_runs').first('count(*)')).toBe(0)
  socket.close(1000)
})

it('a pausa humana impede novo gatilho, mas preserva a mensagem recebida na inbox', async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('paused','a','c-a','tg-a','100',1)"),
    env.DB.prepare("UPDATE contacts SET automation_paused_until=? WHERE id='c-a'").bind(Date.now() + 1800000),
  ])
  await inspect()
  await inbound(dm())
  expect(await workflow!.get()).toHaveLength(0)
  expect(await env.DB.prepare("SELECT count(*) FROM messages WHERE direction='in'").first('count(*)')).toBe(1)
})

it('run aguardando clique respeita pausa humana antes de avançar ao próximo nó', async () => {
  await inspect(false, false)
  await inbound(dm())
  const { current, token } = await offered()
  const until = Date.now() + 1800000
  await env.DB.prepare('UPDATE contacts SET automation_paused_until=? WHERE id=?').bind(until, (await runRow())!.contact_id).run()
  await click(token)
  expect(await current.waitForStepResult({ name: 'pause-check:2:0' })).toBe(until)
  expect((await runRow())?.status).toBe('waiting_delay')
  expect(sent).toHaveLength(1)
})

it.each([
  ['whatsapp', Date.now() + 86400000, 1, 'channel_rejected'],
  ['whatsapp', 1, 1, 'channel_outside_window'],
  ['telegram', null, 0, 'channel_not_opted_in'],
])('executor resolve %s pelo registro e barra o envio (%s, opt-in %s)', async (type, window, optedIn, error) => {
  await publish(singleMessage, 2)
  await inspect()
  await env.DB.prepare("UPDATE channels SET type=? WHERE id='tg-a'").bind(type).run()
  const wa = type === 'whatsapp'
  await env.DB.prepare(`INSERT INTO contact_channels
    (id,workspace_id,contact_id,channel_id,external_user_id,identity_kind,opted_in,window_expires_at)
    VALUES ('manual-channel','a','c-a','tg-a',?,?,?,?)`).bind(wa ? 'BR.abc123' : '100', wa ? 'bsuid' : 'provider_id', optedIn, window).run()
  await env.DB.prepare(`INSERT INTO flow_runs (id,workspace_id,contact_id,automation_version_id,channel_id)
    VALUES ('manual-run','a','c-a','version-2','tg-a')`).run()
  await env.FLOW_RUN!.create({ id: 'manual-run', params: { runId: 'manual-run' } })
  await (await instance()).waitForStatus('errored')
  const result = await env.DB.prepare("SELECT status,error FROM flow_runs WHERE id='manual-run'").first()
  expect(result).toEqual({ status: 'failed', error })
  if (error === 'channel_outside_window') {
    const blocked = await env.DB.prepare("SELECT content FROM messages WHERE id='window-blocked:manual-run'").first<string>('content')
    expect(JSON.parse(blocked!)).toMatchObject({ sender: 'system', error: 'channel_outside_window', text: expect.stringMatching(/Envio barrado: a janela de 24 horas/) })
  }
  expect(fetch).not.toHaveBeenCalled()
})

it('executor respeita o teto de botões do adaptador sem perder opções', async () => {
  const graph: Graph = { nodes: [node('start', 'trigger'), node('message', 'message', {
    blocks: [{ kind: 'text', text: 'Escolha uma opção' }, ...Array.from({ length: 12 }, (_, i) => ({
      kind: 'button', id: `url-${i}`, label: `Opção ${i}`, action: { type: 'url', url: `https://example.com/${i}` },
    }))],
  })], edges: [{ from: 'start', port: 'next', to: 'message' }] }
  await publish(graph, 2)
  await inspect()
  await inbound(dm())
  await (await instance()).waitForStatus('complete')
  expect(sent).toHaveLength(2)
  expect(sent.map(m => m.reply_markup?.inline_keyboard.length)).toEqual([10, 2])
  expect(await env.DB.prepare("SELECT count(*) FROM flow_outbound WHERE status='sent'").first('count(*)')).toBe(2)
  expect((await runRow())?.status).toBe('done')
})

it('dois postbacks com título igual preservam os IDs distintos na inbox', async () => {
  const graph: Graph = { nodes: [node('start', 'trigger'), node('message', 'message', {
    blocks: [{ kind: 'text', text: 'Escolha uma opção' },
      { kind: 'button', id: 'first', label: 'Continuar', action: { type: 'go_to_node' } },
      { kind: 'button', id: 'second', label: 'Continuar', action: { type: 'go_to_node' } }],
    click_timeout: { value: 1, unit: 'minutes' },
  })], edges: [{ from: 'start', port: 'next', to: 'message' }] }
  await publish(graph, 2)
  await inspect(true)
  await inbound(dm())
  await (await instance()).waitForStatus('complete')
  const content = await env.DB.prepare("SELECT content FROM messages WHERE source='automation'").first<string>('content')
  expect(JSON.parse(content!).buttons.map((button: { id: string }) => button.id)).toEqual(['first', 'second'])
})

it('duas conexões Telegram no mesmo workspace respondem cada uma pelo seu próprio bot', async () => {
  await env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('tg-a2','a','telegram','second-bot')").run()
  await giveCredentials(env, 'tg-a2', { botToken: 'SECOND-BOT-TOKEN', webhookSecret: 'secret-tg-a2' })
  // The trigger now listens on every connection of the workspace.
  await env.DB.prepare("UPDATE triggers SET channel_id=NULL WHERE id='trg-a'").run()
  await publish({ nodes: [node('start', 'trigger'), node('hello', 'message', { blocks: [{ kind: 'text', text: 'Olá pelo bot certo' }] })],
    edges: [{ from: 'start', port: 'next', to: 'hello' }] }, 2)
  const urls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    urls.push(new Request(input, init).url)
    return Response.json({ ok: true, result: { message_id: 9000 + urls.length } })
  })
  await inspect()
  expect((await inbound(dm('quero', 100))).retryMessages).toEqual([])
  expect((await inbound(dm('quero', 200), { channelId: 'tg-a2' })).retryMessages).toEqual([])
  const runs = await workflow!.get()
  expect(runs).toHaveLength(2)
  for (const run of runs) await run.waitForStatus('complete')
  expect(urls.sort()).toEqual(['https://api.telegram.org/botSECOND-BOT-TOKEN/sendMessage', 'https://api.telegram.org/botTESTONLY/sendMessage'])
  const rows = await env.DB.prepare("SELECT connection_id AS c FROM messages WHERE source='automation' ORDER BY connection_id").all<{ c: string }>()
  expect(rows.results.map(r => r.c)).toEqual(['tg-a', 'tg-a2'])
})

it('com limite de texto próprio da conexão, dois blocos longos no mesmo nó enviam todos os caracteres', async () => {
  await env.DB.prepare(`UPDATE channels SET capabilities_override='{"text":{"maxLength":1000}}' WHERE id='tg-a'`).run()
  const first = 'a'.repeat(2000), second = 'b'.repeat(2000)
  await publish({ nodes: [node('start', 'trigger'), node('long', 'message', { blocks: [{ kind: 'text', text: first }, { kind: 'text', text: second }] })],
    edges: [{ from: 'start', port: 'next', to: 'long' }] }, 2)
  await inspect()
  await inbound(dm())
  await (await instance()).waitForStatus('complete')
  expect(sent.map(m => m.text).join('')).toBe(first + second)
  expect(sent.every(m => m.text.length <= 1000)).toBe(true)
})

it('personaliza texto e botão com nome e reserva pelo envio falso', async () => {
  const personalized: Graph = { nodes: [node('start', 'trigger'), node('hello', 'message', {
    blocks: [
      { kind: 'text', text: 'Olá {{primeiro_nome|cliente}} {{sobrenome|amigo}}! {{campo:field-a|Sem interesse}}. Legado: {{first_name|cliente}} {{last_name|amigo}}.' },
      { kind: 'button', id: 'site', label: 'Oi {{primeiro_nome|cliente}}', action: { type: 'url', url: 'https://example.com' } },
    ],
  })], edges: [{ from: 'start', port: 'next', to: 'hello' }] }
  await publish(personalized, 2)
  await inspect()
  await inbound(dm())
  await (await instance()).waitForStatus('complete')
  expect(sent[0].text).toBe('Olá Pessoa de teste amigo! Sem interesse. Legado: Pessoa de teste amigo.')
  expect(sent[0].reply_markup?.inline_keyboard[0][0].text).toBe('Oi Pessoa de teste')
})

const questionGraph = (answer_type = 'email', extra: Record<string, unknown> = {}): Graph => ({
  nodes: [node('start', 'trigger'), node('capture', 'question' as GraphNode['type'], {
    text: 'Qual é a resposta?', answer_type, field_id: 'field-a', retry_message: 'Resposta inválida. Tente de novo.',
    max_attempts: 2, skip: true, timeout: { value: 1, unit: 'minutes' }, choices: ['Sim', 'Não'], ...extra,
  }), node('success', 'message', { blocks: [{ kind: 'text', text: 'Resposta salva.' }] }),
  node('missed', 'message', { blocks: [{ kind: 'text', text: 'Sem resposta.' }] })],
  edges: [{ from: 'start', port: 'next', to: 'capture' }, { from: 'capture', port: 'success', to: 'success' },
    { from: 'capture', port: 'no_response', to: 'missed' }],
})
async function asked() {
  const current = await instance()
  await current.waitForStepResult({ name: 'question-send:1:0' })
  await current.waitForStepResult({ name: 'question-open:1' })
  return current
}
it.each([
  ['text', 'quero', 'quero', 'text'], ['email', 'pessoa@example.com', 'pessoa@example.com', 'text'],
  ['phone', '+55 (11) 99999-1234', '+5511999991234', 'text'], ['number', '12,5', 12.5, 'number'],
  ['multiple_choice', 'Sim', 'Sim', 'text'], ['date', '2026-10-24', '2026-10-24', 'date'],
  ['datetime', '24/10/2026 14h30', '2026-10-24T17:30:00.000Z', 'datetime'],
  ['url', 'https://example.com/teste', 'https://example.com/teste', 'text'],
])('captura %s no campo, antes de qualquer palavra-chave e sem repetir entrada', async (type, answer, value, fieldType) => {
  await env.DB.prepare("UPDATE custom_fields SET type=? WHERE id='field-a'").bind(fieldType).run()
  await publish(questionGraph(type), 2)
  await inspect()
  await inbound(dm())
  const current = await asked()
  const payload = dm(answer)
  expect((await inbound(payload)).retryMessages).toEqual([])
  await inbound(payload)
  await current.waitForStatus('complete')
  const run = (await runRow())!
  expect(JSON.parse((await env.DB.prepare("SELECT value FROM contact_field_values WHERE contact_id=? AND field_id='field-a'").bind(run.contact_id).first<string>('value'))!)).toEqual(value)
  expect(await env.DB.prepare('SELECT count(*) FROM flow_runs').first('count(*)')).toBe(1)
  expect(sent.map(m => m.text)).toEqual(['Qual é a resposta?', 'Resposta salva.'])
})
it.each([['Asia/Tokyo', '2026-10-24T05:30:00.000Z'], [null, '2026-10-24T17:30:00.000Z']])('pergunta de data e hora usa o fuso do contato (%s) ou, sem ele, o da conta', async (zone, value) => {
  await env.DB.prepare("UPDATE custom_fields SET type='datetime' WHERE id='field-a'").run()
  await publish(questionGraph('datetime'), 2)
  await inspect()
  await inbound(dm())
  const current = await asked()
  const run = (await runRow())!
  await env.DB.prepare('UPDATE contacts SET timezone=? WHERE id=?').bind(zone, run.contact_id).run()
  await inbound(dm('24/10/2026 14:30'))
  await current.waitForStatus('complete')
  expect(JSON.parse((await env.DB.prepare("SELECT value FROM contact_field_values WHERE contact_id=? AND field_id='field-a'").bind(run.contact_id).first<string>('value'))!)).toBe(value)
})
it('pergunta repete e-mail inválido, aceita válido e preserva limite original', async () => {
  await publish(questionGraph(), 2)
  await inspect()
  await inbound(dm())
  const current = await asked()
  await inbound(dm('inválido'))
  await current.waitForStepResult({ name: 'question-send:1:1' })
  await inbound(dm('lead@example.com'))
  await current.waitForStatus('complete')
  expect(sent.map(m => m.text)).toEqual(['Qual é a resposta?', 'Resposta inválida. Tente de novo.', 'Resposta salva.'])
})
it.each(['tentativas', 'pular', 'timeout', 'parar'])('pergunta encerra coleta por %s', async (reason) => {
  await publish(questionGraph(), 2)
  await inspect()
  if (reason === 'timeout') await workflow!.modifyAll(async modifier => { await modifier.forceEventTimeout({ name: 'question-answer:1:0' }) })
  await inbound(dm())
  const current = reason === 'timeout' ? await instance() : await asked()
  if (reason === 'tentativas') {
    await inbound(dm('errado'))
    await current.waitForStepResult({ name: 'question-send:1:1' })
    await inbound(dm('outro inválido'))
  } else if (reason !== 'timeout') await inbound(dm(reason))
  await current.waitForStatus('complete')
  expect(sent.at(-1)?.text).toBe(reason === 'parar' ? 'Qual é a resposta?' : 'Sem resposta.')
  expect(await env.DB.prepare("SELECT count(*) FROM flow_questions WHERE status='open'").first('count(*)')).toBe(0)
  if (reason === 'parar') {
    expect(await env.DB.prepare('SELECT opted_in FROM contact_channels WHERE contact_id=? AND channel_id=\'tg-a\'').bind((await runRow())!.contact_id).first('opted_in')).toBe(0)
    await inbound(dm('quero'))
    expect(await env.DB.prepare('SELECT count(*) FROM flow_runs').first('count(*)')).toBe(1)
  }
})

it.each([
  ['text', '   ', 'text'], ['email', 'sem-arroba', 'text'], ['phone', '123', 'text'], ['number', 'Infinity', 'number'],
  ['multiple_choice', 'Talvez', 'text'], ['date', '2026-02-30', 'date'], ['datetime', '24/10/2026 25:00', 'datetime'], ['url', 'javascript:alert(1)', 'text'],
])('recusa %s inválido sem escrever no campo', async (type, answer, fieldType) => {
  await env.DB.prepare("UPDATE custom_fields SET type=? WHERE id='field-a'").bind(fieldType).run()
  await publish(questionGraph(type, { max_attempts: 1 }), 2)
  await inspect()
  await inbound(dm())
  const current = await asked()
  await inbound(dm(answer))
  await current.waitForStatus('complete')
  expect(await env.DB.prepare("SELECT count(*) FROM contact_field_values WHERE contact_id=? AND field_id='field-a'").bind((await runRow())!.contact_id).first('count(*)')).toBe(0)
  expect(sent.at(-1)?.text).toBe('Sem resposta.')
})

it.each([
  ['system:email', 'email', 'Pessoa@Example.com', 'email', 'pessoa@example.com'],
  ['system:phone', 'phone', '+55 (11) 99999-1234', 'phone', '5511999991234'],
  ['system:first_name', 'text', 'Maria', 'first_name', 'Maria'],
  ['system:last_name', 'text', 'Silva', 'last_name', 'Silva'],
])('pergunta com %s grava na coluna do contato, validada pelo tipo', async (fieldId, type, answer, column, stored) => {
  await publish(questionGraph(type, { field_id: fieldId }), 2)
  await inspect()
  await inbound(dm())
  const current = await asked()
  await inbound(dm(answer))
  await current.waitForStatus('complete')
  const run = (await runRow())!
  expect(await env.DB.prepare(`SELECT ${column} AS v FROM contacts WHERE id=?`).bind(run.contact_id).first('v')).toBe(stored)
  expect(await env.DB.prepare('SELECT count(*) FROM contact_field_values WHERE contact_id=?').bind(run.contact_id).first('count(*)')).toBe(0)
  expect(sent.at(-1)?.text).toBe('Resposta salva.')
})
it('pergunta de telefone com opt-in registra o consentimento com a frase', async () => {
  await publish(questionGraph('phone', { field_id: 'system:phone', opt_in: ['whatsapp'], consent_phrase: 'Aceito receber mensagens por WhatsApp.' }), 2)
  await inspect()
  await inbound(dm())
  const current = await asked()
  await inbound(dm('+55 (11) 99999-1234'))
  await current.waitForStatus('complete')
  const run = (await runRow())!
  const consents = await env.DB.prepare('SELECT channel_type,value,phrase FROM contact_consents WHERE contact_id=? ORDER BY channel_type').bind(run.contact_id).all()
  expect(consents.results).toEqual([
    { channel_type: 'whatsapp', value: '5511999991234', phrase: 'Aceito receber mensagens por WhatsApp.' },
  ])
})
it('opt-in só vale com o campo do sistema certo e exige a frase', async () => {
  const { publishAutomation, saveDraft } = await import('../src/db/automations')
  await saveDraft(env.DB, 'a', 'auto-a', questionGraph('email', { field_id: 'system:email', opt_in: ['whatsapp'], consent_phrase: 'x' }))
  await expect(publishAutomation(env.DB, 'a', 'auto-a')).rejects.toThrow(/opt-in/i)
  await saveDraft(env.DB, 'a', 'auto-a', questionGraph('email', { field_id: 'system:email', opt_in: ['email'] }))
  await expect(publishAutomation(env.DB, 'a', 'auto-a')).rejects.toThrow(/consentimento/i)
})
it('e-mail inválido não grava no campo do sistema e vai para "sem resposta"', async () => {
  await publish(questionGraph('email', { field_id: 'system:email', max_attempts: 1 }), 2)
  await inspect()
  await inbound(dm())
  const current = await asked()
  await inbound(dm('sem-arroba'))
  await current.waitForStatus('complete')
  expect(await env.DB.prepare('SELECT email FROM contacts WHERE id=?').bind((await runRow())!.contact_id).first('email')).toBeNull()
  expect(sent.at(-1)?.text).toBe('Sem resposta.')
})
it('publicação aceita campo do sistema só com o tipo de resposta que combina', async () => {
  const { publishAutomation, saveDraft } = await import('../src/db/automations')
  await saveDraft(env.DB, 'a', 'auto-a', questionGraph('email', { field_id: 'system:email' }))
  await expect(publishAutomation(env.DB, 'a', 'auto-a')).resolves.toMatchObject({ automation_id: 'auto-a' })
  for (const [type, field] of [['phone', 'system:email'], ['email', 'system:phone'], ['number', 'system:first_name'], ['text', 'system:nada']]) {
    await saveDraft(env.DB, 'a', 'auto-a', questionGraph(type, { field_id: field }))
    await expect(publishAutomation(env.DB, 'a', 'auto-a')).rejects.toThrow(/campo/i)
  }
})

it('publicação exige campo do contato compatível, não arquivado e no workspace', async () => {
  const { publishAutomation, saveDraft } = await import('../src/db/automations')
  await saveDraft(env.DB, 'a', 'auto-a', questionGraph())
  await expect(publishAutomation(env.DB, 'a', 'auto-a')).resolves.toMatchObject({ automation_id: 'auto-a' })
  for (const field of ['field-b', 'missing']) {
    await saveDraft(env.DB, 'a', 'auto-a', questionGraph('email', { field_id: field }))
    await expect(publishAutomation(env.DB, 'a', 'auto-a')).rejects.toThrow(/campo/i)
  }
  await saveDraft(env.DB, 'a', 'auto-a', questionGraph('number'))
  await expect(publishAutomation(env.DB, 'a', 'auto-a')).rejects.toThrow(/campo/i)
  await env.DB.prepare("UPDATE custom_fields SET archived=1 WHERE id='field-a'").run()
  await saveDraft(env.DB, 'a', 'auto-a', questionGraph())
  await expect(publishAutomation(env.DB, 'a', 'auto-a')).rejects.toThrow(/campo/i)
})
it('publicação consulta ajuste efetivo da conexão para pergunta de escolha', async () => {
  const { assertPublishable } = await import('../src/channels/core/publish-check')
  await env.DB.prepare("UPDATE automations SET draft_graph=? WHERE id='auto-a'").bind(JSON.stringify(questionGraph('multiple_choice'))).run()
  await expect(assertPublishable(env, 'a', 'auto-a')).resolves.toBeUndefined()
  await env.DB.prepare(`UPDATE channels SET capabilities_override='{"buttons":{"types":[],"maxPerMessage":0},"remove":["quickReplies"]}' WHERE id='tg-a'`).run()
  await expect(assertPublishable(env, 'a', 'auto-a')).rejects.toThrow(/publicar/i)
})

it.each(['choice', 'skip'])('botão da pergunta entrega %s por callback, sem aceitar outro contato ou duplicar', async (action) => {
  await publish(questionGraph('multiple_choice'), 2)
  await inspect()
  await inbound(dm())
  const current = await asked()
  const buttons = sent[0].reply_markup!.inline_keyboard.flat()
  const selected = buttons.find(b => b.text === (action === 'skip' ? 'Pular' : 'Sim'))!
  expect(selected.callback_data).toMatch(/^q:[a-f0-9]{24}:(\d+|s)$/)
  await click(selected.callback_data, 999)
  expect((await runRow())?.status).toBe('waiting_input')
  await click(selected.callback_data)
  await click(selected.callback_data)
  await current.waitForStatus('complete')
  expect(sent.at(-1)?.text).toBe(action === 'skip' ? 'Sem resposta.' : 'Resposta salva.')
  expect(await env.DB.prepare('SELECT count(*) FROM flow_runs').first('count(*)')).toBe(1)
})

it('retry de entrega ao Workflow retoma recibo e campo sem contar a resposta novamente', async () => {
  await publish(questionGraph(), 2)
  await inspect()
  await inbound(dm())
  const current = await asked()
  const payload = dm('lead@example.com')
  const bindings = { ...env, FLOW_RUN: { get: async () => ({ sendEvent: async () => { throw new Error('Workflow temporariamente indisponível') } }) } } as unknown as IntegrationEnv
  expect((await inbound(payload, { bindings })).retryMessages).toHaveLength(1)
  expect((await inbound(payload)).retryMessages).toEqual([])
  await current.waitForStatus('complete')
  expect(await env.DB.prepare('SELECT attempts FROM flow_questions').first('attempts')).toBe(1)
  expect(await env.DB.prepare('SELECT count(*) FROM flow_question_answers').first('count(*)')).toBe(1)
  expect(sent.map(m => m.text)).toEqual(['Qual é a resposta?', 'Resposta salva.'])
})

it('prazo persistido rejeita resposta tardia e novas tentativas não prorrogam a coleta', async () => {
  await publish(questionGraph(), 2)
  await inspect()
  await inbound(dm())
  const current = await asked()
  const expiry = await env.DB.prepare('SELECT expires_at FROM flow_questions').first('expires_at')
  await inbound(dm('inválido'))
  await current.waitForStepResult({ name: 'question-send:1:1' })
  expect(await env.DB.prepare('SELECT expires_at FROM flow_questions').first('expires_at')).toBe(expiry)
  await env.DB.prepare('UPDATE flow_questions SET expires_at=1').run()
  await inbound(dm('lead@example.com'))
  await current.waitForStatus('complete')
  expect(sent.at(-1)?.text).toBe('Sem resposta.')
  expect(await env.DB.prepare("SELECT count(*) FROM contact_field_values WHERE contact_id=? AND field_id='field-a'").bind((await runRow())!.contact_id).first('count(*)')).toBe(0)
})

it.each(['parar', ' SAIR ', 'STOP', 'unsubscribe'])('palavra de sistema %s descadastra na conexão antes de keywords e não reinscreve com mensagem comum', async word => {
  await env.DB.prepare("UPDATE keywords SET words=?,rule='is' WHERE id='key-a'").bind(JSON.stringify([word.trim().toLowerCase()])).run()
  await inspect()
  await inbound(dm(word))
  expect(await env.DB.prepare("SELECT opted_in FROM contact_channels WHERE channel_id='tg-a' AND external_user_id='100'").first('opted_in')).toBe(0)
  expect(await workflow!.get()).toHaveLength(0)
  await inbound(dm('quero'))
  expect(await env.DB.prepare("SELECT opted_in FROM contact_channels WHERE channel_id='tg-a' AND external_user_id='100'").first('opted_in')).toBe(0)
  expect(await workflow!.get()).toHaveLength(0)
  expect(await env.DB.prepare("SELECT content FROM messages WHERE id LIKE 'system-consent-%'").first<string>('content')).toContain('Inscrição cancelada')
})

it.each(['voltar', 'COMEÇAR', 'start', '/start', 'subscribe'])('palavra de sistema %s reinscreve apenas a conexão da entrada', async word => {
  await inspect()
  await inbound(dm('parar'))
  const contact = await env.DB.prepare("SELECT contact_id FROM contact_channels WHERE channel_id='tg-a'").first<string>('contact_id')
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('tg-other','a','telegram','outro-bot')"),
    env.DB.prepare("INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('cc-other','a',?,'tg-other','100',0)").bind(contact),
  ])
  await inbound(dm(word))
  expect((await env.DB.prepare("SELECT channel_id,opted_in FROM contact_channels WHERE contact_id=? ORDER BY channel_id").bind(contact).all()).results)
    .toEqual([{ channel_id: 'tg-a', opted_in: 1 }, { channel_id: 'tg-other', opted_in: 0 }])
  expect(await workflow!.get()).toHaveLength(0)
})

it('parar cancela a execução em espera e só executa a confirmação vinculada, mesmo com automações pausadas', async () => {
  await inspect(false, false)
  await inbound(dm())
  const { token } = await offered()
  const waiting = (await runRow())!
  await publish({ nodes: [node('start', 'trigger'), node('confirm', 'message', { blocks: [{ kind: 'text', text: 'Sua inscrição foi encerrada.' }] })], edges: [{ from: 'start', port: 'next', to: 'confirm' }] }, 2)
  await env.DB.batch([
    env.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES ('system-out','a','auto-a','tg-a','Saída','external_trigger','active','every_time','{\"system_kind\":\"system_opt_out\"}')"),
    env.DB.prepare('UPDATE contacts SET automation_paused_until=? WHERE id=?').bind(Date.now() + 86400000, waiting.contact_id),
  ])
  await inbound(dm('parar'))
  expect(await env.DB.prepare('SELECT status FROM flow_runs WHERE id=?').bind(waiting.id).first('status')).toBe('cancelled')
  const instances = await workflow!.get()
  expect(instances).toHaveLength(2)
  await expect.poll(async () => env.DB.prepare("SELECT status FROM flow_runs WHERE trigger_id='system-out'").first('status')).toBe('done')
  await click(token)
  expect(sent.map(m => m.text)).toEqual(['Quer receber o material?', 'Sua inscrição foi encerrada.'])
})


it('parar impede o envio de transmissão e voltar devolve a elegibilidade sem afetar o limite de palavras', async () => {
  await inspect()
  await inbound(dm('parar'))
  const local = { ...env, INBOUND: { send: vi.fn(async () => {}) } as unknown as Queue }
  const principal = { userId: 'test-owner', workspaceId: 'a', role: 'owner' as const }
  const input = { name: 'Aviso local', content: 'Aviso da transmissão', status: 'sending', audience: { tag: 'all', channel: 'telegram', channel_id: 'tg-a' } }
  const before = await env.DB.prepare('SELECT count(*) FROM keywords').first('count(*)')
  const blocked = await saveBroadcast(local, principal, input)
  await processBroadcastBatch(local, 'a', blocked.id)
  expect((await getBroadcast(local, principal, blocked.id)).metrics).toMatchObject({ skipped: 1, sent: 0 })
  expect(sent).toEqual([])
  await inbound(dm('voltar'))
  const allowed = await saveBroadcast(local, principal, input)
  await processBroadcastBatch(local, 'a', allowed.id)
  expect((await getBroadcast(local, principal, allowed.id)).metrics).toMatchObject({ sent: 1 })
  expect(sent.map(m => m.text)).toEqual(['Aviso da transmissão'])
  expect(await env.DB.prepare('SELECT count(*) FROM keywords').first('count(*)')).toBe(before)
})

it('notifica o evento de descadastro ao vivo mesmo sem automação de confirmação e deduplica replay', async () => {
  const notify = vi.fn(async (_event: unknown) => {})
  const local = { ...env, INBOX_HUB: { idFromName: () => 'local-hub', get: () => ({ notify }) } as unknown as typeof env.INBOX_HUB }
  const payload = dm('parar')
  await inbound(payload, { bindings: local })
  await inbound(payload, { bindings: local })
  const events = notify.mock.calls.map(([event]) => event as { message?: { sender: string; text: string } })
  expect(events.filter(event => event.message?.sender === 'system' && event.message.text === 'Inscrição cancelada nesta conexão.')).toHaveLength(1)
  expect(await env.DB.prepare("SELECT count(*) n FROM messages WHERE id LIKE 'system-consent-%'").first('n')).toBe(1)
  expect(sent).toEqual([])
})

it.each(['parar', ' SAIR '])('descadastro durante pergunta por %s encerra a coleta e envia só a confirmação vinculada', async word => {
  await publish(questionGraph(), 2)
  await inspect()
  await inbound(dm())
  const question = await asked()
  const waiting = (await runRow())!
  await publish({ nodes: [node('start', 'trigger'), node('confirm', 'message', { blocks: [{ kind: 'text', text: 'Inscrição encerrada com segurança.' }] })], edges: [{ from: 'start', port: 'next', to: 'confirm' }] }, 3)
  await env.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES ('system-question-out','a','auto-a','tg-a','Saída','external_trigger','active','every_time','{\"system_kind\":\"system_opt_out\"}')").run()
  const payload = dm(word)
  await inbound(payload)
  expect(await workflow!.get()).toHaveLength(2)
  await expect.poll(async () => env.DB.prepare("SELECT status FROM flow_runs WHERE trigger_id='system-question-out'").first('status')).toBe('done')
  await question.waitForStatus('complete')
  expect(await env.DB.prepare('SELECT status FROM flow_runs WHERE id=?').bind(waiting.id).first('status')).toBe('cancelled')
  expect(await env.DB.prepare('SELECT status FROM flow_questions WHERE run_id=?').bind(waiting.id).first('status')).toBe('stopped')
  expect(await env.DB.prepare('SELECT opted_in FROM contact_channels WHERE contact_id=?').bind(waiting.contact_id).first('opted_in')).toBe(0)
  await inbound(payload)
  expect(sent.map(message => message.text)).toEqual(['Qual é a resposta?', 'Inscrição encerrada com segurança.'])
  expect(await env.DB.prepare('SELECT count(*) n FROM contact_field_values WHERE contact_id=?').bind(waiting.contact_id).first('n')).toBe(0)
})

it('botão de link com ações, sem saída, roda as ações ao abrir o link', async () => {
  ;(env as { PUBLIC_BASE_URL?: string }).PUBLIC_BASE_URL = 'https://engine.test'
  const graph = structuredClone(demo)
  graph.nodes[1].config.blocks = [{ kind: 'text', text: 'Veja a loja' },
    { kind: 'button', id: 'site', label: 'Abrir loja', action: { type: 'url', url: 'https://example.com/loja' }, actions: [{ type: 'add_tag', tag_id: 'tag-a' }] }]
  graph.edges = [{ from: 'start', port: 'next', to: 'offer' }]
  await publish(graph, 2); await inspect(); await inbound(dm())
  const current = await instance()
  await current.waitForStepResult({ name: 'waiting:1' })
  const link = (sent[0] as unknown as { reply_markup: { inline_keyboard: { url: string }[][] } }).reply_markup.inline_keyboard[0][0].url
  expect(link).toMatch(/flow-public\/click\//)
  const contact = (await runRow())!.contact_id
  await env.DB.prepare('DELETE FROM contact_tags WHERE contact_id=?').bind(contact).run()
  expect((await app.fetch(new Request(link, { redirect: 'manual' }), env)).headers.get('location')).toBe('https://example.com/loja')
  await current.waitForStatus('complete')
  expect(await env.DB.prepare("SELECT count(*) FROM contact_tags WHERE contact_id=? AND tag_id='tag-a'").bind(contact).first('count(*)')).toBe(1)
})

it('botão de link com saída abre o endereço e segue para o passo ligado, uma vez', async () => {
  ;(env as { PUBLIC_BASE_URL?: string }).PUBLIC_BASE_URL = 'https://engine.test'
  const graph = structuredClone(demo)
  graph.nodes[1].config.blocks = [{ kind: 'text', text: 'Veja a loja' },
    { kind: 'button', id: 'site', label: 'Abrir loja', action: { type: 'url', url: 'https://example.com/loja' } }]
  graph.edges = [{ from: 'start', port: 'next', to: 'offer' }, { from: 'offer', port: 'btn:site', to: 'delivery' },
    { from: 'offer', port: 'timeout', to: 'timeout' }, { from: 'delivery', port: 'next', to: 'lead' }]
  await publish(graph, 2); await inspect(); await inbound(dm())
  const current = await instance()
  await current.waitForStepResult({ name: 'waiting:1' })
  const link = (sent[0] as unknown as { reply_markup: { inline_keyboard: { url: string }[][] } }).reply_markup.inline_keyboard[0][0].url
  expect(link).toMatch(/^https:\/\/engine\.test\/api\/flow-public\/click\/[a-f0-9]{24}$/)
  const first = await app.fetch(new Request(link, { redirect: 'manual' }), env)
  expect(first.status).toBe(302)
  expect(first.headers.get('location')).toBe('https://example.com/loja')
  expect((await app.fetch(new Request(link, { redirect: 'manual' }), env)).headers.get('location')).toBe('https://example.com/loja')
  await current.waitForStatus('complete')
  expect(sent.map(m => m.text)).toEqual(['Veja a loja', 'Material da versão original'])
  expect(await env.DB.prepare("SELECT count(*) FROM node_events WHERE type='clicked'").first('count(*)')).toBe(1)
  expect((await app.fetch(new Request('https://engine.test/api/flow-public/click/' + '0'.repeat(24)), env)).status).toBe(404)
})

it('bloco dinâmico: envia o conteúdo v2 do servidor, roda ações por nome e o botão de retorno chama o servidor de novo', async () => {
  const calls: { url: string; body: { contact: { id: string; tags: string[] } } }[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    if (request.url.startsWith('https://dyn.example.com/')) {
      calls.push({ url: request.url, body: await request.json() as never })
      return Response.json(request.url.endsWith('/inicio')
        ? { version: 'v2', content: { messages: [{ type: 'text', text: 'Olá do servidor', buttons: [{ type: 'dynamic_block_callback', caption: 'Mais', url: 'https://dyn.example.com/mais' }] }],
          actions: [{ action: 'add_tag', tag_name: 'Etiqueta a' }] } }
        : { version: 'v2', content: { messages: [{ type: 'text', text: 'Segunda parte' }] } })
    }
    const body = await request.json() as typeof sent[number]
    if (request.url.endsWith('/sendMessage')) { sent.push(body); return Response.json({ ok: true, result: { message_id: 10000 + sent.length, date: 1, chat: { id: body.chat_id }, text: body.text } }) }
    return Response.json({ ok: true, result: true })
  })
  await publish({ nodes: [node('start', 'trigger'), node('dyn', 'dynamic', { url: 'https://dyn.example.com/inicio' })], edges: [{ from: 'start', port: 'next', to: 'dyn' }] }, 2)
  await inspect(); await inbound(dm())
  const current = await instance()
  for (let i = 0; i < 100 && (await runRow())?.status !== 'waiting_click'; i++) await new Promise(r => setTimeout(r, 50))
  expect(sent.map(m => m.text)).toEqual(['Olá do servidor'])
  expect(calls[0].body.contact.id).toBeTruthy()
  const contact = (await runRow())!.contact_id
  expect(await env.DB.prepare("SELECT count(*) FROM contact_tags WHERE contact_id=? AND tag_id='tag-a'").bind(contact).first('count(*)')).toBe(1)
  const keyboard = (sent[0] as unknown as { reply_markup: { inline_keyboard: { callback_data: string }[][] } }).reply_markup.inline_keyboard
  await click(keyboard[0][0].callback_data)
  await current.waitForStatus('complete')
  expect(sent.map(m => m.text)).toEqual(['Olá do servidor', 'Segunda parte'])
  expect(calls.map(c => c.url)).toEqual(['https://dyn.example.com/inicio', 'https://dyn.example.com/mais'])
}, 30_000)

it('bloco dinâmico com servidor fora do ar usa o texto reserva', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    if (request.url.startsWith('https://dyn.example.com/')) return new Response('erro', { status: 500 })
    const body = await request.json() as typeof sent[number]
    if (request.url.endsWith('/sendMessage')) { sent.push(body); return Response.json({ ok: true, result: { message_id: 10000 + sent.length, date: 1, chat: { id: body.chat_id }, text: body.text } }) }
    return Response.json({ ok: true, result: true })
  })
  await publish({ nodes: [node('start', 'trigger'), node('dyn', 'dynamic', { url: 'https://dyn.example.com/inicio', fallback_text: 'Volto já.' })], edges: [{ from: 'start', port: 'next', to: 'dyn' }] }, 2)
  await inspect(); await inbound(dm())
  await (await instance()).waitForStatus('complete')
  expect(sent.map(m => m.text)).toEqual(['Volto já.'])
  expect(await env.DB.prepare("SELECT error_code FROM external_request_logs WHERE node_id='dyn'").first('error_code')).toBe('dynamic')
})

it('external message callback: a próxima mensagem de texto vai ao servidor (com {{last_input_text}}) e não dispara automação', async () => {
  const calls: { url: string; body: unknown }[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    if (request.url.startsWith('https://dyn.example.com/')) {
      calls.push({ url: request.url, body: await request.json() })
      return Response.json(request.url.endsWith('/inicio')
        ? { version: 'v2', content: { messages: [{ type: 'text', text: 'Qual seu pedido?' }], external_message_callback: { url: 'https://dyn.example.com/cb', payload: { pedido: '{{last_input_text}}', id: '{{user_id}}' }, timeout: 600 } } }
        : { version: 'v2', content: { messages: [{ type: 'text', text: 'Pedido recebido' }] } })
    }
    const body = await request.json() as typeof sent[number]
    if (request.url.endsWith('/sendMessage')) { sent.push(body); return Response.json({ ok: true, result: { message_id: 10000 + sent.length, date: 1, chat: { id: body.chat_id }, text: body.text } }) }
    return Response.json({ ok: true, result: true })
  })
  await publish({ nodes: [node('start', 'trigger'), node('dyn', 'dynamic', { url: 'https://dyn.example.com/inicio' })], edges: [{ from: 'start', port: 'next', to: 'dyn' }] }, 2)
  await inspect(); await inbound(dm())
  await (await instance()).waitForStatus('complete')
  const contact = (await runRow())!.contact_id
  await inbound(dm('quero'))
  for (let i = 0; i < 100 && sent.length < 2; i++) await new Promise(r => setTimeout(r, 50))
  expect(sent.map(m => m.text)).toEqual(['Qual seu pedido?', 'Pedido recebido'])
  expect(calls[1]).toEqual({ url: 'https://dyn.example.com/cb', body: { pedido: 'quero', id: contact } })
  expect(await env.DB.prepare('SELECT count(*) FROM message_callbacks').first('count(*)')).toBe(0)
}, 30_000)

it('botão Ir para automação inicia a outra automação publicada e encerra esta', async () => {
  await env.DB.prepare("INSERT INTO automations (id,workspace_id,name,status,draft_graph) VALUES ('auto-2','a','Outra','live',?)").bind(JSON.stringify(demo)).run()
  await env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('v-2','a','auto-2',1,?)")
    .bind(JSON.stringify({ nodes: [node('s2', 'trigger'), node('m2', 'message', { blocks: [{ kind: 'text', text: 'Bem-vindo à outra' }] })], edges: [{ from: 's2', port: 'next', to: 'm2' }] })).run()
  await env.DB.prepare("UPDATE automations SET published_version_id='v-2' WHERE id='auto-2'").run()
  await publish({ nodes: [node('start', 'trigger'), node('m', 'message', { blocks: [{ kind: 'text', text: 'Escolha' },
    { kind: 'button', id: 'go', label: 'Ver a outra', action: { type: 'start_automation', automation_id: 'auto-2' } }] })], edges: [{ from: 'start', port: 'next', to: 'm' }] }, 2)
  await inspect(); await inbound(dm())
  for (let i = 0; i < 100 && (await runRow())?.status !== 'waiting_click'; i++) await new Promise(r => setTimeout(r, 50))
  const keyboard = (sent[0] as unknown as { reply_markup: { inline_keyboard: { callback_data: string }[][] } }).reply_markup.inline_keyboard
  await click(keyboard[0][0].callback_data)
  await expect.poll(async () => (await env.DB.prepare("SELECT status FROM flow_runs WHERE automation_version_id='v-2'").first('status')), { timeout: 15_000 }).toBe('done')
  expect(sent.map(m => m.text)).toEqual(['Escolha', 'Bem-vindo à outra'])
  await expect.poll(async () => (await env.DB.prepare("SELECT status FROM flow_runs WHERE automation_version_id='version-2'").first('status'))).toBe('done')
}, 30_000)

it('pausar uma automação só para o contato impede novos runs dela até o prazo', async () => {
  await publish({ nodes: [node('start', 'trigger'), node('act', 'action', { actions: [{ type: 'pause_automations', duration: { value: 1, unit: 'hours' }, automation_id: 'auto-a' }] }),
    node('m', 'message', { blocks: [{ kind: 'text', text: 'Pausando' }] })], edges: [{ from: 'start', port: 'next', to: 'act' }, { from: 'act', port: 'next', to: 'm' }] }, 2)
  await inspect(); await inbound(dm())
  await (await instance()).waitForStatus('complete')
  expect(await env.DB.prepare('SELECT automation_id FROM contact_automation_pauses').first('automation_id')).toBe('auto-a')
  await workflow!.dispose()
  await inspect(); await inbound(dm())
  await expect.poll(async () => (await env.DB.prepare("SELECT count(*) FROM flow_runs WHERE error='automation_paused'").first('count(*)')), { timeout: 15_000 }).toBe(1)
  expect(sent.map(m => m.text)).toEqual(['Pausando'])
}, 30_000)

it('pausa com escopo de regras: runs iniciados por regra não começam, os demais seguem', async () => {
  await publish({ nodes: [node('start', 'trigger'), node('act', 'action', { actions: [{ type: 'pause_automations', duration: { value: 1, unit: 'hours' }, scope: 'rules' }] }),
    node('m', 'message', { blocks: [{ kind: 'text', text: 'Oi' }] })], edges: [{ from: 'start', port: 'next', to: 'act' }, { from: 'act', port: 'next', to: 'm' }] }, 2)
  await inspect(); await inbound(dm())
  await (await instance()).waitForStatus('complete')
  expect(await env.DB.prepare('SELECT automation_id FROM contact_automation_pauses').first('automation_id')).toBe('scope:rules')
  const contact = (await runRow())!.contact_id
  await workflow!.dispose()
  await inspect()
  const { ensureWorkflow } = await import('../src/flow/dispatch')
  await env.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,automation_version_id,channel_id) VALUES ('rule-escopo','a',?,'version-2','tg-a')").bind(contact).run()
  await ensureWorkflow(env as never, 'rule-escopo')
  await expect.poll(async () => (await env.DB.prepare("SELECT error FROM flow_runs WHERE id='rule-escopo'").first('error')), { timeout: 15_000 }).toBe('automation_paused')
  expect(sent.map(m => m.text)).toEqual(['Oi'])
}, 30_000)

it('gatilho com opt_in_status do_not_send: conversa segue, mas a inscrição nova fica fora das transmissões', async () => {
  await publish({ nodes: [node('start', 'trigger'), node('m', 'message', { blocks: [{ kind: 'text', text: 'Oi' }] })], edges: [{ from: 'start', port: 'next', to: 'm' }] }, 2)
  await env.DB.prepare("UPDATE triggers SET config=json_set(config,'$.opt_in_status','do_not_send') WHERE workspace_id='a'").run()
  await inspect(); await inbound(dm('quero', 777))
  await (await instance()).waitForStatus('complete')
  expect(sent.map(m => m.text)).toEqual(['Oi'])
  expect(await env.DB.prepare("SELECT broadcast_opt_in FROM contact_channels WHERE external_user_id='777'").first('broadcast_opt_in')).toBe(0)
}, 30_000)

it('encurtador ligado na conexão: link do texto vira link curto e o clique conta no passo', async () => {
  await env.DB.prepare("UPDATE channels SET settings=json_set(settings,'$.shortenLinks',json('true')) WHERE id='tg-a'").run()
  await publish({ nodes: [node('start', 'trigger'), node('m', 'message', { blocks: [{ kind: 'text', text: 'Veja https://loja.example/oferta agora' }] })], edges: [{ from: 'start', port: 'next', to: 'm' }] }, 2)
  await inspect(); await inbound(dm())
  await (await instance()).waitForStatus('complete')
  const text = sent[0].text as string
  const short = /https?:\/\/\S+\/api\/flow-public\/l\/([a-z0-9]{10})/.exec(text)
  expect(short).toBeTruthy()
  const r = await app.fetch(new Request(`https://engine.test/api/flow-public/l/${short![1]}`), env)
  expect(r.status).toBe(302)
  expect(r.headers.get('location')).toBe('https://loja.example/oferta')
  expect(await env.DB.prepare("SELECT count(*) FROM node_events WHERE type='clicked' AND node_id='m'").first('count(*)')).toBe(1)
}, 30_000)

it('follow-up do gatilho: sem resposta no prazo, a automação escolhida começa; com resposta, não', async () => {
  await publish({ nodes: [node('start', 'trigger'), node('m', 'message', { blocks: [{ kind: 'text', text: 'Oi' }] })], edges: [{ from: 'start', port: 'next', to: 'm' }] }, 2)
  await env.DB.prepare("UPDATE triggers SET config=json_set(config,'$.follow_up',json('{\"after_minutes\":5,\"automation_id\":\"auto-a\"}')) WHERE workspace_id='a'").run()
  await inspect(); await inbound(dm())
  await (await instance()).waitForStatus('complete')
  const row = await env.DB.prepare('SELECT due_at,done_at FROM trigger_follow_ups').first<{ due_at: number; done_at: number | null }>()
  expect(row?.done_at).toBeNull()
  const { runDueFollowUps } = await import('../src/flow/follow-ups')
  await runDueFollowUps(env as never, row!.due_at - 1000)
  expect(await env.DB.prepare('SELECT done_at FROM trigger_follow_ups').first('done_at')).toBeNull()
  await workflow!.dispose(); await inspect()
  await runDueFollowUps(env as never, row!.due_at + 1000)
  expect(await env.DB.prepare('SELECT outcome FROM trigger_follow_ups').first('outcome')).toBe('started')
  expect(await env.DB.prepare("SELECT count(*) FROM flow_runs WHERE id LIKE 'followup-%'").first('count(*)')).toBe(1)
}, 30_000)

it('depois da espera, a execução segue a versão publicada agora quando ela mantém a espera', async () => {
  const flow = (text: string) => ({ nodes: [node('start', 'trigger'), node('wait', 'smart_delay', { duration: { value: 2, unit: 'seconds' } }), node('m', 'message', { blocks: [{ kind: 'text', text }] })],
    edges: [{ from: 'start', port: 'next', to: 'wait' }, { from: 'wait', port: 'next', to: 'm' }] })
  await publish(flow('Versão antiga'), 2)
  await inspect(false, false); await inbound(dm())
  for (let i = 0; i < 100 && (await runRow())?.status !== 'waiting_delay'; i++) await new Promise(r => setTimeout(r, 50))
  await publish(flow('Versão nova'), 3)
  await (await instance()).waitForStatus('complete')
  expect(sent.map(m => m.text)).toEqual(['Versão nova'])
  expect((await runRow())!.automation_version_id).toBe('version-3')
}, 30_000)
