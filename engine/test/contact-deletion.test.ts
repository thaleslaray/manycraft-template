import { giveCredentials } from './credentials'
import { TEST_KEK } from './credentials'
import { createExecutionContext, createMessageBatch, getQueueResult, introspectWorkflow, type WorkflowIntrospector } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Graph, GraphNode } from '../src/contracts'
import type { Env } from '../src/env'
import { ChannelLimiter } from '../src/flow/limiter'
import { app } from '../src/index'
import type { InboundEvent } from '../src/integrations'
import { ensureConversation, notifyTimeline, type Conversation } from '../src/inbox/service'
import { consumeInbound } from '../src/jobs'
import { authenticatedRequest, fixtureCookie, origin, seedAuth } from './auth-helpers'

const node = (id: string, type: GraphNode['type'], config: GraphNode['config'] = {}): GraphNode => ({ id, type, config, position: { x: 0, y: 0 } })
const welcome: Graph = {
  nodes: [node('start', 'trigger'), node('hello', 'message', { blocks: [{ kind: 'text', text: 'Bem-vindo ao teste!' }] })],
  edges: [{ from: 'start', port: 'next', to: 'hello' }],
}
const waiting: Graph = {
  nodes: [node('start', 'trigger'), node('offer', 'message', {
    blocks: [{ kind: 'text', text: 'Primeira mensagem' }, { kind: 'button', id: 'next', label: 'Continuar', action: { type: 'go_to_node' } }],
    click_timeout: { value: 1, unit: 'hours' },
  }), node('after', 'message', { blocks: [{ kind: 'text', text: 'Automação retomada' }] })],
  edges: [{ from: 'start', port: 'next', to: 'offer' }, { from: 'offer', port: 'btn:next', to: 'after' },
    { from: 'offer', port: 'timeout', to: 'after' }],
}
let workflow: WorkflowIntrospector | undefined
let cookie: string
let update: number
let sent: { text: string; reply_markup?: { inline_keyboard: { callback_data: string }[][] } }[]
const sockets: WebSocket[] = []

function request(path: string, init: RequestInit = {}, bindings: Env = env) {
  return authenticatedRequest(path, 'a', init, cookie, bindings)
}
function post(path: string, body?: unknown, bindings: Env = env) {
  return request(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, bindings)
}
async function connect(workspace = 'a') {
  const response = await authenticatedRequest('inbox/live', workspace, { headers: { Upgrade: 'websocket' } }, workspace === 'a' ? cookie : undefined)
  expect(response.status).toBe(101)
  const socket = (response as Response & { webSocket: WebSocket }).webSocket
  socket.accept()
  sockets.push(socket)
  return socket
}
function nextFrame(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('Evento WebSocket não recebido.')) }, 3000)
    const receive = (event: MessageEvent) => {
      clearTimeout(timeout)
      socket.removeEventListener('message', receive)
      resolve(String(event.data))
    }
    socket.addEventListener('message', receive)
  })
}
async function publish(graph: Graph) {
  await env.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('delete-version','a','auto-a',1,?)")
    .bind(JSON.stringify(graph)).run()
  await env.DB.prepare("UPDATE automations SET status='live',published_version_id='delete-version' WHERE id='auto-a'").run()
  await env.DB.prepare("UPDATE triggers SET channel_id='tg-a',repeat_mode='once' WHERE id='trg-a'").run()
  await env.DB.prepare("UPDATE keywords SET status='live' WHERE id='key-a'").run()
}
async function inspect() {
  workflow = await introspectWorkflow(env.FLOW_RUN)
  await workflow.modifyAll(async modifier => { await modifier.disableRetryDelays() })
}
function dm(text = 'quero', user = 100) {
  return { update_id: ++update, message: { message_id: update, from: { id: user, first_name: 'Pessoa de teste', username: 'pessoa_privada' },
    chat: { id: user, type: 'private' }, text } }
}
async function inbound(payload: Record<string, unknown>) {
  const event: InboundEvent = { version: 1, provider: 'telegram', workspaceId: 'a', channelId: 'tg-a',
    eventId: String(payload.update_id), receivedAt: Date.now(), payload }
  const batch = createMessageBatch('inbound', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: event }])
  await consumeInbound(batch, env)
  expect((await getQueueResult(batch, createExecutionContext())).retryMessages).toEqual([])
}
async function currentRun() {
  const row = await env.DB.prepare("SELECT id,contact_id,status FROM flow_runs WHERE workspace_id='a' ORDER BY created_at DESC,id DESC LIMIT 1")
    .first<{ id: string; contact_id: string; status: string }>()
  expect(row).toBeTruthy()
  return row!
}
async function offered() {
  await publish(waiting)
  await inspect()
  await inbound(dm())
  const instances = await workflow!.get()
  expect(instances).toHaveLength(1)
  const current = instances[0]
  await current.waitForStepResult({ name: 'waiting:1' })
  expect(sent.map(message => message.text)).toEqual(['Primeira mensagem'])
  return { current, run: await currentRun(), token: sent[0].reply_markup!.inline_keyboard[0][0].callback_data.slice(2) }
}

beforeEach(async () => {
  await seedAuth()
  cookie = await fixtureCookie()
  sent = []
  update = 0
  await env.DB.prepare("UPDATE channels SET type='telegram' WHERE id IN ('ch-a','ch-b')").run()
  await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('tg-a','a','telegram','delete-test-bot')").run()
  await giveCredentials(env, 'tg-a', { botToken: 'TESTONLY', webhookSecret: 'secret-tg-a' })
  await ensureConversation(env, 'a', 'c-a', 'ch-a')
  await ensureConversation(env, 'b', 'c-b', 'ch-b')
  vi.spyOn(ChannelLimiter.prototype, 'acquire').mockResolvedValue({ allowed: true, retryAfter: 0 })
  expect(env.CONNECTIONS_KEK_V1).toBe(TEST_KEK)
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init)
    expect(req.url).toMatch(/^https:\/\/api\.telegram\.org\/botTESTONLY\/(sendMessage|answerCallbackQuery)$/)
    if (req.url.endsWith('/answerCallbackQuery')) return Response.json({ ok: true, result: true })
    sent.push(await req.json())
    return Response.json({ ok: true, result: { message_id: 900000 + sent.length } })
  })
})
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close(1000)
  await workflow?.dispose()
  workflow = undefined
  vi.restoreAllMocks()
})

describe('exclusão dos dados do contato', () => {
  it('anonimiza PII, apaga vínculos e histórico, cancela runs e mantém estatísticas com evento isolado por workspace', async () => {
    await publish(welcome)
    await env.DB.batch([
      env.DB.prepare(`UPDATE contacts SET gender='female',locale='pt-BR',timezone='America/Sao_Paulo',profile_pic_url='https://example.test/pessoa',
        optin_source='telegram',last_input_text='Dado privado',automation_paused_until=?,last_interaction_at=1001 WHERE id='c-a'`).bind(Date.now() + 1800000),
      env.DB.prepare("INSERT INTO messages(id,workspace_id,conversation_id,direction,source,content) VALUES ('private-message','a','inbox-cc-a','in','contact','{\"text\":\"Dado privado\"}')"),
      env.DB.prepare("INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,status,error,wait_until) VALUES ('private-run','a','c-a','delete-version','waiting_click','Dado privado',9999999999999)"),
      env.DB.prepare("INSERT INTO button_tokens(token,workspace_id,run_id,node_id,step_index,button_id,expires_at) VALUES ('private-token','a','private-run','hello',1,'next',9999999999999)"),
      env.DB.prepare("INSERT INTO node_events(workspace_id,automation_id,node_id,contact_id,flow_run_id,type) VALUES ('a','auto-a','hello','c-a','private-run','sent')"),
    ])
    const metrics = await env.DB.prepare("SELECT * FROM node_events WHERE contact_id='c-a'").all()
    const a = await connect(), b = await connect('b')
    const otherFrames: string[] = []
    b.addEventListener('message', event => { otherFrames.push(String(event.data)) })
    const deleted = nextFrame(a)
    const response = await request('contacts/c-a', { method: 'DELETE' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ deleted_ids: ['c-a'], conversation_ids: ['inbox-cc-a'] })
    expect(JSON.parse(await deleted)).toEqual({ type: 'contact_deleted', contact_id: 'c-a', conversation_ids: ['inbox-cc-a'] })
    const contact = await env.DB.prepare("SELECT * FROM contacts WHERE id='c-a'").first()
    expect(contact).toMatchObject({ status: 'deleted', first_name: null, last_name: null, gender: null, locale: null, timezone: null,
      profile_pic_url: null, optin_source: null, last_input_text: null, automation_paused_until: null, last_interaction_at: null })
    for (const table of ['contact_channels', 'contact_tags', 'contact_field_values']) {
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE contact_id='c-a'`).first('n')).toBe(0)
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM conversations WHERE id='inbox-cc-a'").first('n')).toBe(0)
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE id='private-message'").first('n')).toBe(0)
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM button_tokens WHERE run_id='private-run'").first('n')).toBe(0)
    expect(await env.DB.prepare("SELECT status,wait_until,error FROM flow_runs WHERE id='private-run'").first())
      .toEqual({ status: 'cancelled', wait_until: null, error: null })
    expect((await env.DB.prepare("SELECT * FROM node_events WHERE contact_id='c-a'").all()).results).toEqual(metrics.results)
    expect(await env.DB.prepare("SELECT status FROM contacts WHERE id='c-b'").first('status')).toBe('subscribed')
    const pong = nextFrame(b)
    b.send('ping')
    expect(await pong).toBe('pong')
    expect(otherFrames).toEqual(['pong'])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('um Workflow já esperando não envia nem altera estatística ao acordar após exclusão, mesmo se terminate falhar', async () => {
    const { current, run, token } = await offered()
    const before = (await env.DB.prepare('SELECT * FROM node_events WHERE flow_run_id=?').bind(run.id).all()).results
    const terminate = vi.fn().mockRejectedValue(new Error('Instância temporariamente indisponível'))
    const unavailable = { ...env, FLOW_RUN: { get: vi.fn(async () => ({ terminate })) } as unknown as Env['FLOW_RUN'] }
    expect((await request(`contacts/${run.contact_id}`, { method: 'DELETE' }, unavailable)).status).toBe(200)
    expect(terminate).toHaveBeenCalledOnce()
    // Simulate a previously delivered click waking the persisted wait after the token was erased.
    await (await env.FLOW_RUN.get(run.id)).sendEvent({ type: 'click_1', payload: { token } })
    await current.waitForStatus('complete')
    expect(await env.DB.prepare('SELECT status FROM flow_runs WHERE id=?').bind(run.id).first('status')).toBe('cancelled')
    expect(sent.map(message => message.text)).toEqual(['Primeira mensagem'])
    expect((await env.DB.prepare('SELECT * FROM node_events WHERE flow_run_id=?').bind(run.id).all()).results).toEqual(before)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first('n')).toBe(0)
  })

  it('a ação de excluir contato encerra o Workflow cancelado antes de enviar a mensagem do nó seguinte', async () => {
    await publish({ nodes: [node('start', 'trigger'), node('delete', 'action', { actions: [{ type: 'delete_subscriber' }] }),
      node('after', 'message', { blocks: [{ kind: 'text', text: 'Não enviar' }] })],
    edges: [{ from: 'start', port: 'next', to: 'delete' }, { from: 'delete', port: 'next', to: 'after' }] })
    await inspect()
    await inbound(dm())
    const instances = await workflow!.get()
    expect(instances).toHaveLength(1)
    await instances[0].waitForStatus('complete')
    const run = await currentRun()
    expect(run.status).toBe('cancelled')
    expect(await env.DB.prepare('SELECT status FROM contacts WHERE id=?').bind(run.contact_id).first('status')).toBe('deleted')
    expect(sent).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM flow_outbound').first('n')).toBe(0)
  })

  it('reverte toda a exclusão quando a anonimização falha dentro da transação', async () => {
    await publish(welcome)
    await env.DB.batch([
      env.DB.prepare("INSERT INTO messages(id,workspace_id,conversation_id,direction,source,content) VALUES ('rollback-message','a','inbox-cc-a','in','contact','{\"text\":\"Histórico preservado\"}')"),
      env.DB.prepare("INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,status,wait_until) VALUES ('rollback-run','a','c-a','delete-version','waiting_click',9999999999999)"),
      env.DB.prepare("INSERT INTO button_tokens(token,workspace_id,run_id,node_id,step_index,button_id,expires_at) VALUES ('rollback-token','a','rollback-run','hello',1,'next',9999999999999)"),
      env.DB.prepare("INSERT INTO node_events(workspace_id,automation_id,node_id,contact_id,flow_run_id,type) VALUES ('a','auto-a','hello','c-a','rollback-run','sent')"),
    ])
    const tables = ['contacts', 'contact_tags', 'contact_field_values', 'contact_channels', 'conversations', 'messages', 'flow_runs', 'button_tokens', 'node_events']
    const snapshot = () => Promise.all(tables.map(async table =>
      (await env.DB.prepare(`SELECT * FROM ${table} WHERE workspace_id='a' ORDER BY rowid`).all()).results))
    const before = await snapshot()
    await env.DB.prepare(`CREATE TRIGGER forced_erasure_failure BEFORE UPDATE OF status ON contacts
      WHEN NEW.status='deleted' BEGIN SELECT RAISE(ABORT,'forced_erasure_failure'); END`).run()
    try {
      expect((await request('contacts/c-a', { method: 'DELETE' })).status).toBe(500)
      expect(await snapshot()).toEqual(before)
      expect(await env.DB.prepare("SELECT status FROM flow_runs WHERE id='rollback-run'").first('status')).toBe('waiting_click')
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      await env.DB.prepare('DROP TRIGGER forced_erasure_failure').run()
    }
  })

  it.each(['quero', 'olá'])('a identidade Telegram excluída cria outro contato e dispara novamente com %s', async text => {
    await publish(welcome)
    await env.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode) VALUES ('welcome','a','auto-a','tg-a','Recepção','welcome_message','active','once')").run()
    await inspect()
    const original = dm(text)
    await inbound(original)
    await (await workflow!.get())[0].waitForStatus('complete')
    const old = await currentRun()
    expect((await request(`contacts/${old.contact_id}`, { method: 'DELETE' })).status).toBe(200)
    const preservedMetrics = await env.DB.prepare('SELECT COUNT(*) AS n FROM node_events WHERE contact_id=?').bind(old.contact_id).first('n')
    // Delivery retries of the already processed update must not recreate the deleted profile.
    await inbound(original)
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM contact_channels WHERE channel_id='tg-a'").first('n')).toBe(0)
    await inbound(dm(text))
    const instances = await workflow!.get()
    expect(instances).toHaveLength(2)
    await instances[1].waitForStatus('complete')
    const fresh = await env.DB.prepare("SELECT contact_id FROM contact_channels WHERE channel_id='tg-a' AND external_user_id='100'").first<string>('contact_id')
    expect(fresh).toBeTruthy()
    expect(fresh).not.toBe(old.contact_id)
    expect(await env.DB.prepare('SELECT status,first_name FROM contacts WHERE id=?').bind(old.contact_id).first()).toEqual({ status: 'deleted', first_name: null })
    expect(await env.DB.prepare('SELECT status FROM contacts WHERE id=?').bind(fresh!).first('status')).toBe('subscribed')
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM node_events WHERE contact_id=?').bind(old.contact_id).first('n')).toBe(preservedMetrics)
    const firings = await env.DB.prepare('SELECT trigger_id,contact_id FROM trigger_firings ORDER BY id').all()
    expect(firings.results).toEqual([{ trigger_id: text === 'quero' ? 'trg-a' : 'welcome', contact_id: old.contact_id },
      { trigger_id: text === 'quero' ? 'trg-a' : 'welcome', contact_id: fresh }])
    expect(sent.map(message => message.text)).toEqual(['Bem-vindo ao teste!', 'Bem-vindo ao teste!'])
    const receipts = await env.DB.prepare('SELECT payload FROM inbound_events WHERE id=?').bind(JSON.stringify(['telegram', 'tg-a', '1'])).first<string>('payload')
    expect(receipts).not.toContain('pessoa_privada')
    expect(receipts).not.toContain('Pessoa de teste')
  })

  it('rejeita contato de outro workspace, inexistente e lote misto sem apagar parcialmente', async () => {
    expect((await request('contacts/c-b', { method: 'DELETE' })).status).toBe(404)
    expect((await request('contacts/inexistente', { method: 'DELETE' })).status).toBe(404)
    expect((await post('contacts/bulk-delete', { ids: ['c-a', 'c-b'] })).status).toBe(404)
    expect((await post('contacts/bulk-delete', { ids: ['c-a', 'inexistente'] })).status).toBe(404)
    expect((await env.DB.prepare('SELECT id,status FROM contacts ORDER BY id').all()).results)
      .toEqual([{ id: 'c-a', status: 'subscribed' }, { id: 'c-b', status: 'subscribed' }])
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM conversations').first('n')).toBe(2)
  })

  // The maximum batch persists 100 deletions and their notifications in the real local D1.
  it('valida JSON e limite de 1 a 100 contatos e exclui o lote máximo atomicamente', async () => {
    for (const body of [{ ids: [] }, { ids: Array.from({ length: 101 }, (_, i) => `bulk-${i}`) }, { ids: [''] }, { ids: [123] }, { ids: ['c-a'], extra: true }]) {
      expect((await post('contacts/bulk-delete', body)).status).toBe(400)
    }
    expect((await request('contacts/bulk-delete', { method: 'POST', body: '{' })).status).toBe(400)
    const ids = Array.from({ length: 100 }, (_, i) => `bulk-${i}`)
    await env.DB.batch(ids.map(id => env.DB.prepare("INSERT INTO contacts(id,workspace_id,first_name) VALUES (?,'a','Nome privado')").bind(id)))
    const response = await post('contacts/bulk-delete', { ids })
    expect(response.status).toBe(200)
    const result = await response.json() as { deleted_ids: string[]; conversation_ids: string[] }
    expect([...result.deleted_ids].sort()).toEqual([...ids].sort())
    expect(result.conversation_ids).toEqual([])
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM contacts WHERE workspace_id='a' AND status='deleted' AND first_name IS NULL").first('n')).toBe(100)
    expect(await env.DB.prepare("SELECT status FROM contacts WHERE id='c-a'").first('status')).toBe('subscribed')
  }, 30_000)
})

describe('retomar automações e autorização de edição', () => {
  it('limpa a pausa, publica Conversation e respeita o workspace', async () => {
    await env.DB.prepare("UPDATE contacts SET automation_paused_until=? WHERE id IN ('c-a','c-b')").bind(Date.now() + 1800000).run()
    await notifyTimeline(env, 'a') // drain the pause events the timeline trigger just queued; the first live frame must come from resume
    const socket = await connect()
    const received = nextFrame(socket)
    const response = await post('inbox/conversations/inbox-cc-a/resume-automations')
    expect(response.status).toBe(200)
    const conversation = await response.json() as Conversation
    expect(conversation).toMatchObject({ id: 'inbox-cc-a', automation_paused_until: null })
    expect(JSON.parse(await received)).toEqual({ type: 'conversation', conversation })
    expect(await env.DB.prepare("SELECT automation_paused_until FROM contacts WHERE id='c-a'").first('automation_paused_until')).toBeNull()
    expect((await post('inbox/conversations/inbox-cc-b/resume-automations')).status).toBe(404)
    expect(await env.DB.prepare("SELECT automation_paused_until FROM contacts WHERE id='c-b'").first('automation_paused_until')).toBeGreaterThan(Date.now())
  })

  it('desperta imediatamente o Workflow da pausa humana sem acelerar sleeps nem esperar 30 minutos', async () => {
    const { current, run, token } = await offered()
    const until = Date.now() + 1800000
    await env.DB.prepare('UPDATE contacts SET automation_paused_until=? WHERE id=?').bind(until, run.contact_id).run()
    await inbound({ update_id: ++update, callback_query: { id: `callback-${update}`, from: { id: 100 }, data: `b:${token}`,
      message: { chat: { id: 100, type: 'private' } } } })
    expect(await current.waitForStepResult({ name: 'pause-check:2:0' })).toBe(until)
    expect(sent).toHaveLength(1)
    const id = await env.DB.prepare('SELECT v.id FROM conversations v JOIN contact_channels cc ON cc.id=v.contact_channel_id WHERE cc.contact_id=?')
      .bind(run.contact_id).first<string>('id')
    expect((await post(`inbox/conversations/${id}/resume-automations`)).status).toBe(200)
    await current.waitForStatus('complete')
    expect(Date.now()).toBeLessThan(until)
    expect(sent.map(message => message.text)).toEqual(['Primeira mensagem', 'Automação retomada'])
    expect(await env.DB.prepare('SELECT status FROM flow_runs WHERE id=?').bind(run.id).first('status')).toBe('done')
  })

  it.each(['owner', 'administrator', 'editor', 'livechat_agent', 'viewer'])('exige permissão de edição para excluir e retomar: %s', async role => {
    await env.DB.prepare("UPDATE workspace_members SET role=? WHERE id='member-a'").bind(role).run()
    await env.DB.prepare("INSERT INTO contacts(id,workspace_id,first_name) VALUES ('extra','a','Outro contato')").run()
    await env.DB.prepare("UPDATE contacts SET automation_paused_until=? WHERE id='c-a'").bind(Date.now() + 1800000).run()
    const allowed = ['owner', 'administrator', 'editor'].includes(role)
    expect((await post('inbox/conversations/inbox-cc-a/resume-automations')).status).toBe(allowed ? 200 : 403)
    expect((await request('contacts/extra', { method: 'DELETE' })).status).toBe(allowed ? 200 : 403)
    expect((await post('contacts/bulk-delete', { ids: ['c-a'] })).status).toBe(allowed ? 200 : 403)
    if (!allowed) {
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM contacts WHERE status='deleted'").first('n')).toBe(0)
      expect(await env.DB.prepare("SELECT automation_paused_until FROM contacts WHERE id='c-a'").first('automation_paused_until')).toBeGreaterThan(Date.now())
    }
  })

  it('rejeita exclusão e retomada sem sessão autenticada', async () => {
    for (const [path, method, body] of [['contacts/c-a', 'DELETE', undefined], ['contacts/bulk-delete', 'POST', { ids: ['c-a'] }],
      ['inbox/conversations/inbox-cc-a/resume-automations', 'POST', undefined]] as const) {
      expect((await app.request(`${origin}/api/${path}`, { method, headers: { origin, 'x-workspace': 'a', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env)).status).toBe(401)
    }
  })
})

it('exclui aliases WhatsApp W7 e eventos W4 de todos os canais sem recriar a linha do tempo', async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('wa-a','a','whatsapp','wa-delete-test')"),
    env.DB.prepare(`INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,identity_kind,phone_e164)
      VALUES ('wa-identity','a','c-a','wa-a','BR.ENT.delete123','bsuid','+5511999991234')`),
    env.DB.prepare("UPDATE contact_channels SET phone_e164='+5511888881234' WHERE id='wa-identity'"),
  ])
  const waConversation = await ensureConversation(env, 'a', 'c-a', 'wa-a')
  await env.DB.batch([
    env.DB.prepare("UPDATE contact_field_values SET value='\"Dado privado na linha do tempo\"' WHERE workspace_id='a' AND contact_id='c-a'"),
    env.DB.prepare("DELETE FROM contact_tags WHERE workspace_id='a' AND contact_id='c-a'"),
    env.DB.prepare("INSERT INTO contact_tags(workspace_id,contact_id,tag_id) VALUES ('a','c-a','tag-a')"),
  ])
  expect(await env.DB.prepare("SELECT COUNT(*) FROM contact_identity_aliases WHERE contact_channel_id='wa-identity'").first('COUNT(*)')).toBe(2)
  expect(await env.DB.prepare("SELECT COUNT(*) FROM messages WHERE json_extract(content,'$.sender')='system'").first<number>('COUNT(*)')).toBeGreaterThan(0)
  const response = await request('contacts/c-a', { method: 'DELETE' })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ deleted_ids: ['c-a'], conversation_ids: expect.arrayContaining(['inbox-cc-a', waConversation]) })
  expect(await env.DB.prepare("SELECT COUNT(*) FROM contact_identity_aliases").first('COUNT(*)')).toBe(0)
  expect(await env.DB.prepare("SELECT COUNT(*) FROM messages").first('COUNT(*)')).toBe(0)
  expect(await env.DB.prepare("SELECT COUNT(*) FROM conversations WHERE workspace_id='a'").first('COUNT(*)')).toBe(0)
  expect(await env.DB.prepare("SELECT contact_count FROM tags WHERE id='tag-a'").first('contact_count')).toBe(0)
  expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
})
