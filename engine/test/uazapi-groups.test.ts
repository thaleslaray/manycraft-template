import { env as runtime } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hooks } from '../src/channels/core/hooks'
import { UazapiAdapter } from '../src/channels/uazapi-adapter'
import type { SendContext } from '../src/channels'
import { deleteContacts } from '../src/contacts'
import { consumeInbound } from '../src/jobs'
import type { InboundEvent, IntegrationEnv } from '../src/integrations'
import { giveCredentials, testKeyring } from './credentials'
import { seed } from './fixtures'
import mentionFixture from './fixtures/uazapi-group-mention.json'

const SERVER = 'https://loja.uazapi.com', TOKEN = 'UZ-INSTANCE-TOKEN', OWNER = '5511999999999'
const GROUP = '120363153742561022@g.us', AUTHOR = '5511888888888@s.whatsapp.net'
const graph = { nodes: [
  { id: 'start', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
  { id: 'hello', type: 'message', position: { x: 1, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Oi, grupo' }] } },
], edges: [{ from: 'start', port: 'next', to: 'hello' }] }

type Call = { path: string; body: Record<string, unknown> }
let calls: Call[]
let accepted: InboundEvent[]
let env: IntegrationEnv
let create: ReturnType<typeof vi.fn>

function fakeServer() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.origin !== SERVER) throw new Error(`Unexpected request: ${url.href}`)
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ path: url.pathname, body })
    if (url.pathname === '/send/text') return Response.json({ id: `${OWNER}:OUT-G1`, messageid: 'OUT-G1' })
    if (url.pathname === '/group/list') return Response.json({
      groups: [{ JID: GROUP, Name: 'Clube da Loja' }, { JID: '120363000000000001@g.us', Name: 'Suporte' }],
      pagination: { totalRecords: 2, limit: 50, offset: 0, hasMore: false, nextOffset: 50 } })
    return Response.json({ error: 'not found' }, { status: 404 })
  })
}
const groupMessage = (over: Record<string, unknown> = {}, root: Record<string, unknown> = {}) => ({ ...mentionFixture, ...root,
  message: { ...mentionFixture.message, id: `${OWNER}:G-1`, messageid: 'G-1', text: 'quero o guia', content: { text: 'quero o guia' }, ...over } })
const dm = (over: Record<string, unknown> = {}) => ({ ...mentionFixture, message: { id: `${OWNER}:D-1`, messageid: 'D-1', chatid: AUTHOR, sender: AUTHOR,
  senderName: 'Ana', fromMe: false, isGroup: false, messageType: 'Conversation', text: 'quero o guia', messageTimestamp: Date.now() - 2000, ...over } })
const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
async function deliver(body: unknown) {
  accepted = []
  expect((await hooks.request('/uz-a', post(body), env)).status).toBe(200)
  const messages = accepted.map(b => ({ body: b, attempts: 1, ack: vi.fn(), retry: vi.fn(), id: crypto.randomUUID(), timestamp: new Date() }))
  await consumeInbound({ messages } as unknown as MessageBatch<unknown>, env)
}
const count = (sql: string) => runtime.DB.prepare(sql).first<number>('n')

async function addTrigger(id: string, audience: 'direct' | 'group', match: 'keyword' | 'mention' | null, rule = 'contains', words = '["guia"]', thread: string | null = null) {
  await runtime.DB.batch([
    runtime.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,config,audience,group_match,group_thread_id) VALUES (?,'a','auto-a','uz-a',?,'keyword','active',?,?,?,?)")
      .bind(id, id, JSON.stringify({ node_id: 'start' }), audience, match, thread),
    runtime.DB.prepare("INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES (?,'a',?,?,?,'live',1)").bind(`k-${id}`, id, rule, words),
  ])
}

beforeEach(async () => {
  await seed()
  calls = []; accepted = []
  create = vi.fn(async () => ({}))
  env = { DB: runtime.DB, ...testKeyring,
    INBOUND: { send: async (event: InboundEvent) => { accepted.push(event) } } as unknown as Queue<InboundEvent>,
    FLOW_RUN: { create, get: async () => ({ sendEvent: async () => {}, status: async () => ({ status: 'running' }) }) } as unknown as NonNullable<IntegrationEnv['FLOW_RUN']> }
  await runtime.DB.batch([
    runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,connection_state) VALUES ('uz-a','a','whatsapp','uazapi','uazapi:r183e2ef','connected')"),
    runtime.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('uz-v','a','auto-a',1,?)").bind(JSON.stringify(graph)),
    runtime.DB.prepare("UPDATE automations SET published_version_id='uz-v',status='live' WHERE id='auto-a'"),
    runtime.DB.prepare("DELETE FROM triggers WHERE id='trg-a'"),
  ])
  await giveCredentials(runtime, 'uz-a', { serverUrl: SERVER, token: TOKEN, webhookSecret: 'hook-secret' })
  fakeServer()
})
afterEach(() => { vi.restoreAllMocks() })

describe('gatilho de grupo no modo palavra', () => {
  it('dispara pela palavra, guarda no grupo, faz do autor um contato sem abrir conversa privada nem consentimento', async () => {
    await addTrigger('g-word', 'group', 'keyword')
    await deliver(groupMessage())
    expect(await count("SELECT count(*) n FROM flow_runs WHERE trigger_id='g-word'")).toBe(1)
    expect(await runtime.DB.prepare("SELECT reply_group_thread_id IS NOT NULL AS g FROM flow_runs").first('g')).toBe(1)
    expect(create).toHaveBeenCalledTimes(1)
    expect(await runtime.DB.prepare("SELECT external_group_id,subject FROM group_threads").first()).toEqual({ external_group_id: GROUP, subject: 'Clube da Loja' })
    expect(await runtime.DB.prepare("SELECT direction,mentions_me FROM group_messages").first()).toEqual({ direction: 'in', mentions_me: 0 })
    const author = await runtime.DB.prepare("SELECT cc.external_user_id,cc.opted_in,cc.first_inbound_id,c.first_name FROM contact_channels cc JOIN contacts c ON c.id=cc.contact_id WHERE cc.channel_id='uz-a'").first()
    expect(author).toEqual({ external_user_id: AUTHOR, opted_in: 0, first_inbound_id: null, first_name: 'Ana' })
    expect(await count("SELECT count(*) n FROM conversations")).toBe(0)
    expect(await count("SELECT count(*) n FROM messages WHERE connection_id='uz-a'")).toBe(0)
  })
  it('mensagem sem a palavra não dispara, e o repique do mesmo evento não dispara de novo', async () => {
    await addTrigger('g-word', 'group', 'keyword')
    await deliver(groupMessage({ text: 'bom dia', content: { text: 'bom dia' } }))
    expect(await count('SELECT count(*) n FROM flow_runs')).toBe(0)
    await deliver(groupMessage({ messageid: 'G-2', id: `${OWNER}:G-2` }))
    await deliver(groupMessage({ messageid: 'G-2', id: `${OWNER}:G-2` }))
    expect(await count('SELECT count(*) n FROM flow_runs')).toBe(1)
  })
  it('gatilho de conversa privada não dispara em grupo, e o de grupo não dispara em conversa privada', async () => {
    await addTrigger('dm-word', 'direct', null)
    await deliver(groupMessage())
    expect(await count('SELECT count(*) n FROM flow_runs')).toBe(0)
    await runtime.DB.prepare("DELETE FROM triggers WHERE id='dm-word'").run()
    await addTrigger('g-word', 'group', 'keyword')
    await deliver(dm())
    expect(await count('SELECT count(*) n FROM flow_runs')).toBe(0)
    // The DM still becomes a contact with consent, as before.
    expect(await runtime.DB.prepare("SELECT opted_in FROM contact_channels WHERE channel_id='uz-a'").first('opted_in')).toBe(1)
  })
  it('gatilho restrito a um grupo ignora os outros', async () => {
    await deliver(groupMessage({ text: 'oi', content: { text: 'oi' } }))   // registers the group
    const thread = await runtime.DB.prepare('SELECT id FROM group_threads').first<string>('id')
    await addTrigger('g-one', 'group', 'keyword', 'contains', '["guia"]', thread)
    await deliver(groupMessage({ messageid: 'G-3', id: `${OWNER}:G-3`, chatid: '120363999999999999@g.us' }))
    expect(await count('SELECT count(*) n FROM flow_runs')).toBe(0)
    await deliver(groupMessage({ messageid: 'G-4', id: `${OWNER}:G-4` }))
    expect(await count('SELECT count(*) n FROM flow_runs')).toBe(1)
  })
})

describe('apagar contato', () => {
  it('apaga o que a pessoa escreveu nos grupos e mantém as respostas da automação', async () => {
    await addTrigger('g-word', 'group', 'keyword')
    await deliver(groupMessage())
    const thread = await runtime.DB.prepare('SELECT id FROM group_threads').first<string>('id')
    await runtime.DB.prepare("INSERT INTO group_messages(workspace_id,id,group_thread_id,direction,external_message_id,content) VALUES ('a','gm-out',?,'out','OUT-1','{\"text\":\"Oi\"}')").bind(thread).run()
    const contactId = await runtime.DB.prepare("SELECT contact_id FROM contact_channels WHERE channel_id='uz-a'").first<string>('contact_id')
    await deleteContacts(runtime as never, 'a', [contactId!])
    expect(await count("SELECT count(*) n FROM group_messages WHERE direction='in'")).toBe(0)
    expect(await count("SELECT count(*) n FROM group_messages WHERE direction='out'")).toBe(1)
  })
})

describe('gatilho de grupo no modo "só quando mencionado"', () => {
  it('não dispara sem menção, mesmo com a palavra, e dispara com a menção do payload', async () => {
    await addTrigger('g-mention', 'group', 'mention', 'any', '[]')
    await deliver(groupMessage())
    expect(await count('SELECT count(*) n FROM flow_runs')).toBe(0)
    await deliver(mentionFixture)
    expect(await count('SELECT count(*) n FROM flow_runs')).toBe(1)
    expect(await runtime.DB.prepare("SELECT mentions_me FROM group_messages WHERE external_message_id='GRP-MENTION-1'").first('mentions_me')).toBe(1)
  })
  it('com palavras, exige a menção e a palavra', async () => {
    await addTrigger('g-mention', 'group', 'mention', 'contains', '["preço"]')
    await deliver(mentionFixture)                                        // mentioned, but no word
    expect(await count('SELECT count(*) n FROM flow_runs')).toBe(0)
    await deliver({ ...mentionFixture, message: { ...mentionFixture.message, id: `${OWNER}:G-9`, messageid: 'G-9', text: '@5511999999999 qual o preço?' } })
    expect(await count('SELECT count(*) n FROM flow_runs')).toBe(1)
  })
  it('reconhece a menção também só pelo texto "@número" e não confunde menção de outra pessoa', async () => {
    await addTrigger('g-mention', 'group', 'mention', 'any', '[]')
    await deliver(groupMessage({ text: 'oi @5511777777777', content: { text: 'oi', contextInfo: { mentionedJID: ['5511777777777@s.whatsapp.net'] } } }))
    expect(await count('SELECT count(*) n FROM flow_runs')).toBe(0)
    await deliver(groupMessage({ messageid: 'G-5', id: `${OWNER}:G-5`, text: 'oi @5511999999999', content: 'oi @5511999999999' }))
    expect(await count('SELECT count(*) n FROM flow_runs')).toBe(1)
  })
})

describe('resposta no grupo', () => {
  async function runContext(): Promise<SendContext> {
    await addTrigger('g-word', 'group', 'keyword')
    await deliver(groupMessage())
    const run = (await runtime.DB.prepare("SELECT id,contact_id,reply_group_thread_id FROM flow_runs").first<{ id: string; contact_id: string; reply_group_thread_id: string }>())!
    await runtime.DB.prepare("UPDATE flow_runs SET current_node_id='hello' WHERE id=?").bind(run.id).run()
    return { runId: run.id, step: 1, part: 0, channelId: 'uz-a', externalUserId: AUTHOR, mode: { ok: true, mode: 'free' },
      group: { threadId: run.reply_group_thread_id, externalGroupId: GROUP },
      run: { id: run.id, workspace_id: 'a', contact_id: run.contact_id, channel_id: 'uz-a', external_user_id: AUTHOR, channel_type: 'whatsapp',
        automation_version_id: 'uz-v', automation_id: 'auto-a', graph: JSON.stringify(graph), start_node_id: null, depth: 0 } }
  }
  const adapter = () => new UazapiAdapter({ ...env, CONNECTION_CREDENTIALS: JSON.stringify({ token: TOKEN, serverUrl: SERVER }), CONNECTION_SETTINGS: '{}' })
  it('sai para o JID do grupo mencionando o autor, e fica no grupo, não na conversa do autor', async () => {
    const ctx = await runContext()
    expect(await adapter().send(ctx, { kind: 'text', text: 'Oi, grupo' })).toMatchObject({ ok: true, externalId: 'OUT-G1' })
    expect(calls.find(c => c.path === '/send/text')!.body).toEqual({ number: GROUP, text: 'Oi, grupo', track_source: 'replica', mentions: '5511888888888' })
    expect(await runtime.DB.prepare("SELECT direction,external_message_id FROM group_messages WHERE direction='out'").first())
      .toEqual({ direction: 'out', external_message_id: 'OUT-G1' })
    expect(await count("SELECT count(*) n FROM messages WHERE connection_id='uz-a'")).toBe(0)
    expect(await count('SELECT count(*) n FROM conversations')).toBe(0)
  })
  it('responde mesmo sem consentimento de conversa privada, e recusa botões em grupo sem rede', async () => {
    const ctx = await runContext()
    const before = calls.length
    expect(await adapter().send(ctx, { kind: 'text', text: 'Escolha', buttons: [{ type: 'postback', id: 'b:x', title: 'Ir' }] })).toMatchObject({ ok: false, reason: 'unsupported' })
    expect(calls.length).toBe(before)
  })
})
