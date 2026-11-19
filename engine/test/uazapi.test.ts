import { env as runtime } from 'cloudflare:workers'
import type { Env } from '../src/env'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hooks } from '../src/channels/core/hooks'
import { deliverHuman } from '../src/channels/core/delivery'
import { reconcileConnections } from '../src/channels/core/reconcile'
import { connectionRuntime } from '../src/channels/core/runtime'
import { claimNumber } from '../src/channels/core/whatsapp-numbers'
import { connectionFromRow, liteRow } from '../src/channels/core/connection'
import { splitUazapi, uazapi } from '../src/channels/uazapi'
import { UazapiAdapter } from '../src/channels/uazapi-adapter'
import type { SendContext } from '../src/channels'
import { syncWhatsappContact } from '../src/channels/whatsapp'
import { upsertWhatsappIdentity } from '../src/db/contacts'
import { deleteContacts } from '../src/contacts'
import { ensureConversation } from '../src/inbox/service'
import { consumeInbound } from '../src/jobs'
import type { InboundEvent, IntegrationEnv } from '../src/integrations'
import { giveCredentials, testKeyring } from './credentials'
import { seed } from './fixtures'

const SERVER = 'https://loja.uazapi.com', TOKEN = 'UZ-INSTANCE-TOKEN', OWNER = '5511999999999'
const PN = '5511888888888@s.whatsapp.net', PHONE = '+5511888888888', LID = '99887766@lid'
const graph = { nodes: [
  { id: 'start', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
  { id: 'offer', type: 'message', position: { x: 1, y: 0 }, config: { blocks: [
    { kind: 'text', text: 'Escolha' }, { kind: 'button', id: 'next', label: 'Continuar', action: { type: 'go_to_node' } } ] } },
], edges: [{ from: 'start', port: 'next', to: 'offer' }] }

type Call = { path: string; body: Record<string, unknown>; token: string | null }
let calls: Call[]
let accepted: InboundEvent[]
let env: IntegrationEnv
let create: ReturnType<typeof vi.fn>
let forced: ((path: string) => Response | undefined) | undefined
let files: Record<string, { mime: string; bytes: Uint8Array }>
let found: unknown[]                       // what POST /message/find returns
let instance: { id: string; status: string; qrcode?: string; profileName?: string }
const stamp = () => Date.now() - 2000

/** The UAZAPI server, as the docs describe it. Nothing leaves the process. */
function fakeServer() {
  let sent = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.origin !== SERVER) throw new Error(`Unexpected request: ${url.href}`)
    const headers = new Headers(init?.headers)
    const call = { path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : {}, token: headers.get('token') }
    calls.push(call)
    if (url.pathname.startsWith('/files/')) {   // the public link of a downloaded file: no token travels to it
      const file = files[url.pathname.slice(7)]
      return file ? new Response(file.bytes, { headers: { 'content-type': file.mime, 'content-length': String(file.bytes.length) } }) : new Response('gone', { status: 404 })
    }
    if (call.token !== TOKEN) return Response.json({ error: 'Invalid token' }, { status: 401 })
    const override = forced?.(url.pathname)
    if (override) return override
    if (url.pathname === '/instance/status') return Response.json({ instance, status: { connected: instance.status === 'connected', loggedIn: instance.status === 'connected' } })
    if (url.pathname === '/instance/connect') { instance = { ...instance, status: 'connecting', qrcode: 'data:image/png;base64,QR1' }; return Response.json({ response: 'Connecting' }) }
    if (url.pathname === '/webhook') return Response.json([{ id: 'wh1', enabled: true }])
    if (url.pathname === '/send/text' || url.pathname === '/send/menu') { sent++; return Response.json({ id: `${OWNER}:OUT-${sent}`, messageid: `OUT-${sent}`, response: { status: 'success' } }) }
    if (url.pathname === '/message/download') {
      const file = files[String(call.body.id)]
      return file ? Response.json({ fileURL: `${SERVER}/files/${call.body.id}`, mimetype: file.mime }) : Response.json({ error: 'Message not found' }, { status: 404 })
    }
    if (url.pathname === '/chat/check') return Response.json((call.body.numbers as string[]).map(n => ({ query: n, jid: `${n}@s.whatsapp.net`, isInWhatsapp: !n.endsWith('0001'), ...(n.endsWith('0001') ? { jid: '', error: `the number ${n}@s.whatsapp.net is not on WhatsApp` } : {}) })))
    if (url.pathname === '/message/markread') return Response.json({ success: true })
    if (url.pathname === '/call/reject') return Response.json({ response: 'Call rejected' })
    if (url.pathname === '/message/find') {
      const offset = Number(call.body.offset ?? 0)
      return Response.json({ messages: found.slice(offset, offset + 100), pagination: { limit: 100, offset, hasMore: found.length > offset + 100, nextOffset: offset + 100 } })
    }
    return Response.json({ error: 'not found' }, { status: 404 })
  })
}

const incoming = (over: Record<string, unknown> = {}, root: Record<string, unknown> = {}) => ({ EventType: 'messages', owner: OWNER, token: TOKEN, BaseUrl: SERVER, instanceName: 'Loja',
  chat: { name: 'segredo-do-chat' }, ...root,
  message: { id: `${OWNER}:IN-1`, messageid: 'IN-1', chatid: PN, sender: PN, senderName: 'Ana', fromMe: false, isGroup: false, messageType: 'Conversation',
    text: 'quero', messageTimestamp: stamp(), ...over } })
const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
async function deliver(body: unknown, expected = 200) {
  accepted = []
  expect((await hooks.request('/uz-a', post(body), env)).status).toBe(expected)
  return consume(...accepted)
}
async function consume(...events: InboundEvent[]) {
  const messages = events.map(body => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn(), id: crypto.randomUUID(), timestamp: new Date() }))
  await consumeInbound({ messages } as unknown as MessageBatch<unknown>, env)
  if (process.env.UZ_DEBUG) console.log('retry', messages.map(m => m.retry.mock.calls.length))
  return messages
}
const count = (sql: string) => runtime.DB.prepare(sql).first<number>('n')
const rows = async (sql: string) => (await runtime.DB.prepare(sql).all()).results

beforeEach(async () => {
  await seed()
  calls = []; accepted = []; found = []; files = {}; forced = undefined
  instance = { id: 'r183e2ef', status: 'connected', profileName: 'Loja da Ana' }
  create = vi.fn(async () => ({}))
  env = { DB: runtime.DB, ...testKeyring,
    INBOUND: { send: async (event: InboundEvent) => { accepted.push(event) } } as unknown as Queue<InboundEvent>,
    FLOW_RUN: { create, get: async () => ({ sendEvent: async () => {}, status: async () => ({ status: 'running' }) }) } as unknown as NonNullable<IntegrationEnv['FLOW_RUN']> }
  await runtime.DB.batch([
    runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,connection_state,sync_cursor) VALUES ('uz-a','a','whatsapp','uazapi','uazapi:r183e2ef','connected',?)").bind(Date.now() - 600_000),
    runtime.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('uz-v','a','auto-a',1,?)").bind(JSON.stringify(graph)),
    runtime.DB.prepare("UPDATE automations SET published_version_id='uz-v',status='live' WHERE id='auto-a'"),
    runtime.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,config) VALUES ('uz-trg','a','auto-a','uz-a','Palavra','keyword','active',?)").bind(JSON.stringify({ node_id: 'start' })),
    runtime.DB.prepare("INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES ('uz-key','a','uz-trg','contains','[\"quero\"]','live',1)"),
  ])
  await giveCredentials(runtime, 'uz-a', { serverUrl: SERVER, token: TOKEN, webhookSecret: 'hook-secret' })
  fakeServer()
})
afterEach(() => { vi.restoreAllMocks() })

describe('entrada', () => {
  it('confere o token da instância no corpo, não enfileira o token e responde 401 sem ele', async () => {
    expect((await hooks.request('/uz-a', post({ ...incoming(), token: 'outro' }), env)).status).toBe(401)
    expect((await hooks.request('/uz-a', post({ ...incoming(), token: undefined }), env)).status).toBe(401)
    expect((await hooks.request('/uz-a', { method: 'GET' }, env)).status).toBe(400)
    expect(accepted).toHaveLength(0)
    expect((await hooks.request('/uz-a', post(incoming()), env)).status).toBe(200)
    expect(accepted).toHaveLength(1)
    expect(accepted[0]).toMatchObject({ channelId: 'uz-a', eventId: 'IN-1', workspaceId: 'a' })
    const queued = JSON.stringify(accepted[0])
    for (const secret of [TOKEN, SERVER, 'segredo-do-chat']) expect(queued).not.toContain(secret)
  })
  it('evento que a camada não usa nem chega à fila', async () => {
    expect((await hooks.request('/uz-a', post({ EventType: 'presence', token: TOKEN, event: {} }), env)).status).toBe(200)
    expect(accepted).toHaveLength(0)
  })
})

describe('mídia recebida', () => {
  const connection = () => connectionFromRow({ ...liteRow('whatsapp', 'uz-a', 'a'), provider: 'uazapi', settings: '{}' })
  const parse = (over: Record<string, unknown>) => uazapi.parseInbound(incoming({ id: `${OWNER}:MED-1`, messageid: 'MED-1', ...over }), connection())
  const ctx = () => ({ env, connection: connection(), credentials: { serverUrl: SERVER, token: TOKEN }, fetch: globalThis.fetch })
  const read = async (r: Awaited<ReturnType<NonNullable<typeof uazapi.downloadMedia>>>) => r.ok ? { mime: r.mime, size: r.size, bytes: new Uint8Array(await new Response(r.body).arrayBuffer()) } : r

  it('foto com legenda vira mensagem com mídia e o texto é a legenda', () => {
    expect(parse({ messageType: 'ImageMessage', text: 'Meu comprovante', content: { mimetype: 'image/jpeg', URL: 'https://mmg.whatsapp.net/x' } }))
      .toMatchObject([{ kind: 'message', externalMessageId: 'MED-1', text: 'Meu comprovante', media: { type: 'image', ref: 'MED-1', mime: 'image/jpeg' } }])
  })
  it('documento sem legenda guarda o nome do arquivo e não inventa texto', () => {
    const [event] = parse({ messageType: 'DocumentMessage', text: '', content: JSON.stringify({ mimetype: 'application/pdf', fileName: 'contrato.pdf' }) })
    expect(event).toMatchObject({ kind: 'message', media: { type: 'file', ref: 'MED-1', mime: 'application/pdf', filename: 'contrato.pdf' } })
    expect(event).not.toHaveProperty('text')
  })
  it('áudio de voz, vídeo e figurinha entram como mídia, mesmo sem content legível', () => {
    expect(parse({ messageType: 'AudioMessage', text: '', content: { mimetype: 'audio/ogg; codecs=opus', PTT: true } })).toMatchObject([{ media: { type: 'audio', mime: 'audio/ogg', voice: true } }])
    expect(parse({ messageType: 'VideoMessage', text: 'olha', content: 'não é json' })).toMatchObject([{ text: 'olha', media: { type: 'video' } }])
    expect(parse({ messageType: 'StickerMessage', text: '' })).toMatchObject([{ media: { type: 'sticker' } }])
  })
  it('tipo que o inbox não mostra vira o aviso explícito; tipo técnico segue ignorado', () => {
    expect(parse({ messageType: 'LocationMessage', text: '' })).toMatchObject([{ kind: 'message', externalMessageId: 'MED-1', unsupported: { type: 'LocationMessage' } }])
    expect(parse({ messageType: 'ProtocolMessage', text: '' })).toMatchObject([{ kind: 'ignored' }])
    expect(parse({ messageType: 'ImageMessage', reaction: 'X', text: '' })).toMatchObject([{ kind: 'ignored', why: 'Reaction' }])
    expect(parse({ messageType: 'error', text: '' })).toMatchObject([{ kind: 'ignored' }])
  })
  it('baixa pelo /message/download com o token e busca o link sem ele', async () => {
    files['MED-1'] = { mime: 'image/jpeg', bytes: new Uint8Array([1, 2, 3, 4]) }
    const out = await read(await uazapi.downloadMedia!(ctx(), { type: 'image', ref: 'MED-1' }, 1000))
    expect(out).toEqual({ mime: 'image/jpeg', size: 4, bytes: new Uint8Array([1, 2, 3, 4]) })
    expect(calls.map(c => [c.path, c.token, c.body])).toEqual([['/message/download', TOKEN, { id: 'MED-1' }], ['/files/MED-1', null, {}]])
  })
  it('respeita o limite de tamanho e traduz as recusas', async () => {
    files['MED-1'] = { mime: 'application/pdf', bytes: new Uint8Array(50) }
    expect(await uazapi.downloadMedia!(ctx(), { type: 'file', ref: 'MED-1' }, 10)).toEqual({ ok: false, transient: false, code: 'too_large' })
    expect(await uazapi.downloadMedia!(ctx(), { type: 'file', ref: 'SUMIU' }, 1000)).toEqual({ ok: false, transient: false, code: 'not_found' })
    forced = () => Response.json({ error: 'Failed to download media' }, { status: 500 })
    expect(await uazapi.downloadMedia!(ctx(), { type: 'file', ref: 'MED-1' }, 1000)).toEqual({ ok: false, transient: true, code: 'server' })
    forced = () => Response.json({ fileURL: 'http://evil.test/x', mimetype: 'image/png' })
    expect(await uazapi.downloadMedia!(ctx(), { type: 'image', ref: 'MED-1' }, 1000)).toEqual({ ok: false, transient: false, code: 'invalid' })
  })
  it('mensagem de tipo não suportado chega ao histórico com o aviso, não some', async () => {
    await deliver(incoming({ id: `${OWNER}:LOC-1`, messageid: 'LOC-1', messageType: 'LocationMessage', text: '' }))
    expect(await count("SELECT count(*) n FROM messages WHERE json_extract(content,'$.unsupported.type')='LocationMessage'")).toBe(1)
  })
})

describe('grupo: payload real', () => {
  const real = { EventType: 'messages', owner: '5521900000001', instanceName: 'marina', message: { buttonOrListid: '', chatid: '120300000000000002@g.us',
    content: { text: '@5521900000001 teste 2.5 de menção smartzap', contextInfo: { mentionedJID: ['5521900000001@s.whatsapp.net'], nonJIDMentions: 0 } },
    fromMe: false, groupName: 'Teste manycraft', id: '5521900000001:3EB001A45C1E4AC73FCED9', isGroup: true, messageTimestamp: 1793038826000, messageType: 'ExtendedTextMessage',
    messageid: '3EB001A45C1E4AC73FCED9', sender: '15380000000004:3@lid', senderName: 'Marina', sender_lid: '15380000000004@lid', sender_pn: '5521900000003@s.whatsapp.net',
    text: '@5521900000001 teste 2.5 de menção smartzap', type: 'text', wasSentByApi: false } }
  const connection = () => connectionFromRow({ ...liteRow('whatsapp', 'uz-a', 'a'), provider: 'uazapi', settings: '{}' })
  it('autor com sufixo de dispositivo é reconhecido pelo sender_pn e a menção à conta é detectada', () => {
    expect(uazapi.parseInbound(real, connection())).toMatchObject([{ kind: 'message', externalMessageId: '3EB001A45C1E4AC73FCED9', mentionsMe: true,
      from: { externalUserId: '5521900000003@s.whatsapp.net', phoneE164: '+5521900000003' }, thread: { kind: 'group', externalGroupId: '120300000000000002@g.us', subject: 'Teste manycraft' },
      text: '@5521900000001 teste 2.5 de menção smartzap', occurredAt: 1793038826000 }])
  })
  it('sem sender_pn nem sender_lid, tira o sufixo do sender', () => {
    const { sender_pn, sender_lid, ...rest } = real.message
    expect(uazapi.parseInbound({ ...real, message: rest }, connection())).toMatchObject([{ kind: 'message', from: { externalUserId: '15380000000004@lid' } }])
  })
})

describe('contato e automação', () => {
  it('mensagem vira contato com JID, número e consentimento; a automação dispara uma vez mesmo com o evento repetido', async () => {
    await deliver(incoming())
    await deliver(incoming())
    const identity = await runtime.DB.prepare("SELECT * FROM contact_channels WHERE channel_id='uz-a'").first<Record<string, unknown>>()
    expect(identity).toMatchObject({ external_user_id: PN, identity_kind: 'provider_id', address_kind: 'wa_pn', phone_e164: PHONE, opted_in: 1 })
    expect(identity!.last_inbound_at).toBeGreaterThan(0)
    expect(await runtime.DB.prepare('SELECT first_name FROM contacts WHERE id=?').bind(identity!.contact_id).first('first_name')).toBe('Ana')
    expect(await count("SELECT count(*) n FROM messages WHERE direction='in' AND connection_id='uz-a'")).toBe(1)
    expect(await count("SELECT count(*) n FROM flow_runs WHERE channel_id='uz-a'")).toBe(1)
    expect(create).toHaveBeenCalledTimes(1)
  })
  it('o banco aceita contato sem BSUID só quando a conexão é não oficial, e exige um JID', async () => {
    await runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('wa-a','a','whatsapp','phone-id')").run()
    const insert = (channel: string, user: string, kind: string, address: string | null) => runtime.DB.prepare(
      'INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,identity_kind,address_kind) VALUES (?,?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), 'a', 'c-a', channel, user, kind, address).run()
    await expect(insert('wa-a', PN, 'provider_id', 'wa_pn')).rejects.toThrow(/whatsapp_requires_bsuid/)
    await expect(insert('uz-a', 'BR.abc123', 'bsuid', 'wa_pn')).rejects.toThrow(/whatsapp_requires_bsuid/)
    await expect(insert('uz-a', '5511', 'provider_id', 'wa_pn')).rejects.toThrow(/whatsapp_requires_bsuid/)
    await expect(insert('uz-a', PN, 'provider_id', null)).rejects.toThrow(/whatsapp_requires_bsuid/)
    await insert('uz-a', PN, 'provider_id', 'wa_pn')
    await insert('uz-a', LID, 'provider_id', 'wa_lid')
  })
  it('clique em botão chega com o id do botão', async () => {
    await deliver(incoming())
    const [{ payload }] = [{ payload: `b:${'a'.repeat(24)}` }]
    await deliver(incoming({ id: `${OWNER}:CLICK`, messageid: 'CLICK', messageType: 'ButtonsResponseMessage', text: 'Continuar', buttonOrListid: payload }))
    expect(await count("SELECT count(*) n FROM inbound_events WHERE channel_id='uz-a'")).toBe(2)
    // A click the flow was not waiting for still shows in the inbox, once.
    expect(await count("SELECT count(*) n FROM messages WHERE direction='in' AND connection_id='uz-a'")).toBe(2)
  })
})

describe('união por número', () => {
  const official = async () => {
    await runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('wa-a','a','whatsapp','phone-id')").run()
    await upsertWhatsappIdentity(runtime.DB, 'a', { contact_id: 'c-a', channel_id: 'wa-a', bsuid: 'BR.abc123', phone_e164: PHONE })
    await claimNumber(runtime.DB, 'a', PHONE, 'c-a', 'wa-a', null)
  }
  it('quem fala pelo número oficial e depois pela UAZAPI com o mesmo telefone é um só contato', async () => {
    await official()
    await deliver(incoming())
    const owners = await rows("SELECT DISTINCT contact_id FROM contact_channels WHERE channel_id IN ('wa-a','uz-a')")
    expect(owners).toEqual([{ contact_id: 'c-a' }])
    expect(await count('SELECT count(*) n FROM contact_channels WHERE contact_id=\'c-a\' AND channel_id IN (\'wa-a\',\'uz-a\')')).toBe(2)
    expect(await count("SELECT count(*) n FROM contacts WHERE optin_source='whatsapp'")).toBe(0)
  })
  it('na ordem inversa também: primeiro a UAZAPI, depois o número oficial', async () => {
    await deliver(incoming())
    const first = await runtime.DB.prepare("SELECT contact_id FROM contact_channels WHERE channel_id='uz-a'").first<{ contact_id: string }>()
    await runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('wa-a','a','whatsapp','phone-id')").run()
    await syncWhatsappContact({ version: 1, provider: 'meta', workspaceId: 'a', channelId: 'wa-a', eventId: 'w1', receivedAt: Date.now(), payload: {} },
      { kind: 'message', externalUserId: 'BR.abc123', externalMessageId: 'w1', text: 'oi', occurredAt: Date.now(), profile: { phoneE164: PHONE } }, env)
    const official = await runtime.DB.prepare("SELECT contact_id FROM contact_channels WHERE channel_id='wa-a'").first<{ contact_id: string }>()
    expect(official!.contact_id).toBe(first!.contact_id)
  })
  it('um LID sem número não une ninguém e fica como contato separado', async () => {
    await official()
    await deliver(incoming({ id: `${OWNER}:LID-1`, messageid: 'LID-1', chatid: LID, sender: LID }))
    const lid = await runtime.DB.prepare("SELECT contact_id,address_kind,phone_e164 FROM contact_channels WHERE external_user_id=?").bind(LID).first<Record<string, unknown>>()
    expect(lid).toMatchObject({ address_kind: 'wa_lid', phone_e164: null })
    expect(lid!.contact_id).not.toBe('c-a')
  })
  it('contato apagado libera o número', async () => {
    await official()
    await deleteContacts(runtime as never, 'a', ['c-a'])
    expect(await count("SELECT count(*) n FROM whatsapp_numbers WHERE phone_e164='+5511888888888'")).toBe(0)
    await deliver(incoming())
    const owner = await runtime.DB.prepare("SELECT contact_id FROM contact_channels WHERE channel_id='uz-a'").first<{ contact_id: string }>()
    expect(owner!.contact_id).not.toBe('c-a')
  })
  it('a resposta humana sai pela conexão em que a pessoa escreveu por último, mesmo respondendo na conversa da outra', async () => {
    await official()
    await runtime.DB.prepare("UPDATE contact_channels SET last_inbound_at=? WHERE channel_id='wa-a'").bind(Date.now() - 3_600_000).run()
    await giveCredentials(runtime, 'wa-a', { accessToken: 'TESTONLY', phoneNumberId: 'phone-id', appSecret: 's', webhookSecret: 'v' })
    await deliver(incoming())
    const conversationId = await ensureConversation(env, 'a', 'c-a', 'wa-a')
    const rt = await connectionRuntime(env, 'a', 'wa-a')
    const sent = await deliverHuman(env, { connection: rt.connection, provider: rt.provider!, credentials: rt.credentials },
      { workspaceId: 'a', conversationId, contactId: 'c-a', externalUserId: 'BR.abc123', text: 'Oi, Ana' })
    expect(sent.ok).toBe(true)
    expect(calls.filter(c => c.path === '/send/text').map(c => c.body)).toMatchObject([{ number: PN, text: 'Oi, Ana', track_source: 'replica' }])
    expect(await runtime.DB.prepare("SELECT connection_id,delivery_status,external_message_id FROM messages WHERE conversation_id=? AND source='human' AND json_extract(content,'$.sender')='human'").bind(conversationId).first())
      .toEqual({ connection_id: 'uz-a', delivery_status: 'sent', external_message_id: `whatsapp:uz-a:${PN}:OUT-1` })
  })
})

describe('assumir pelo celular', () => {
  const fromPhone = (over: Record<string, unknown> = {}) => incoming({ id: `${OWNER}:OWN-1`, messageid: 'OWN-1', fromMe: true, wasSentByApi: false, text: 'Já te respondo!', ...over })
  it('o que o dono escreve do aparelho entra como resposta humana, pausa a automação e nunca dispara gatilho nem vira mensagem do contato', async () => {
    await deliver(incoming({ text: 'oi' }))                                // the contact exists, no keyword match
    await deliver(fromPhone({ text: 'quero' }))                             // even with a trigger word, it is the owner talking
    expect(await count("SELECT count(*) n FROM flow_runs")).toBe(0)
    const messages = await rows("SELECT direction,source,connection_id,delivery_status,json_extract(content,'$.text') AS text FROM messages WHERE json_extract(content,'$.sender')<>'system' ORDER BY rowid")
    expect(messages).toEqual([
      { direction: 'in', source: 'contact', connection_id: 'uz-a', delivery_status: null, text: 'oi' },
      { direction: 'out', source: 'human', connection_id: 'uz-a', delivery_status: 'sent', text: 'quero' }])
    const paused = await runtime.DB.prepare("SELECT automation_paused_until FROM contacts WHERE id IN (SELECT contact_id FROM contact_channels WHERE channel_id='uz-a')").first<number>('automation_paused_until')
    expect(paused!).toBeGreaterThan(Date.now() + 25 * 60_000)
    // The same echo twice (webhook and reconciliation) is one message.
    await deliver(fromPhone({ text: 'quero' }))
    expect(await count("SELECT count(*) n FROM messages WHERE json_extract(content,'$.sender')='human'")).toBe(1)
  })
  it('conversa que nunca escreveu para nós não vira contato', async () => {
    await deliver(fromPhone({ chatid: '5511777777777@s.whatsapp.net' }))
    expect(await count("SELECT count(*) n FROM contact_channels WHERE channel_id='uz-a'")).toBe(0)
  })
  it('o eco do que a própria camada enviou é reconhecido pelo id e pela origem, e não duplica', async () => {
    await deliver(incoming({ text: 'oi' }))
    const conversationId = await ensureConversation(env, 'a', (await runtime.DB.prepare("SELECT contact_id FROM contact_channels WHERE channel_id='uz-a'").first<{ contact_id: string }>())!.contact_id, 'uz-a')
    const rt = await connectionRuntime(env, 'a', 'uz-a')
    const contactId = (await runtime.DB.prepare("SELECT contact_id FROM contact_channels WHERE channel_id='uz-a'").first<{ contact_id: string }>())!.contact_id
    await deliverHuman(env, { connection: rt.connection, provider: rt.provider!, credentials: rt.credentials }, { workspaceId: 'a', conversationId, contactId, externalUserId: PN, text: 'Pelo painel' })
    const before = await count("SELECT count(*) n FROM messages WHERE json_extract(content,'$.sender')='human'")
    // The server reports the same send back without telling it came from the API: the stored id gives it away.
    await deliver(fromPhone({ id: `${OWNER}:OUT-1`, messageid: 'OUT-1', text: 'Pelo painel' }))
    // And an echo that says so itself is ignored whatever its id.
    await deliver(fromPhone({ id: `${OWNER}:OUT-9`, messageid: 'OUT-9', wasSentByApi: true, text: 'Outra integração' }))
    expect(await count("SELECT count(*) n FROM messages WHERE json_extract(content,'$.sender')='human'")).toBe(before)
  })
})

describe('opções da conexão não oficial', () => {
  const setOptions = (settings: Record<string, unknown>) => runtime.DB.prepare("UPDATE channels SET settings=? WHERE id='uz-a'").bind(JSON.stringify(settings)).run()
  it('padrão desligado: nada de lida, digitando, recusa de ligação nem texto de mensagem sem abrir', async () => {
    await deliver(incoming())
    await deliver({ EventType: 'call', owner: OWNER, token: TOKEN, type: 'Call', fromMe: false, sender_pn: PN, event: { CallID: 'CALL-1', From: PN, Data: { Tag: 'offer' } } })
    await deliver(incoming({ id: `${OWNER}:ERR`, messageid: 'ERR', messageType: 'error', text: '' }))
    expect(calls.map(c => c.path).filter(p => ['/message/markread', '/call/reject', '/send/text'].includes(p))).toEqual([])
  })
  it('marcar como lida ao receber', async () => {
    await setOptions({ markRead: true })
    await deliver(incoming())
    expect(calls.filter(c => c.path === '/message/markread').map(c => c.body)).toEqual([{ id: ['IN-1'] }])
  })
  it('recusar ligação com mensagem configurável', async () => {
    await deliver(incoming())
    await setOptions({ rejectCalls: true, rejectCallMessage: 'Não atendo ligações, escreva aqui.' })
    await deliver({ EventType: 'call', owner: OWNER, token: TOKEN, type: 'Call', fromMe: false, sender_pn: PN, event: { CallID: 'CALL-1', From: PN, Data: { Tag: 'offer' } } })
    expect(calls.filter(c => c.path === '/call/reject').map(c => c.body)).toEqual([{ number: '5511888888888', id: 'CALL-1' }])
    expect(calls.filter(c => c.path === '/send/text').map(c => c.body)).toMatchObject([{ number: PN, text: 'Não atendo ligações, escreva aqui.' }])
    // Other signals of the same call (accept, terminate) never reach the queue.
    accepted = []
    await hooks.request('/uz-a', post({ EventType: 'call', token: TOKEN, type: 'Call', event: { CallID: 'CALL-1', Data: { Tag: 'terminate' } } }), env)
    expect(accepted).toHaveLength(0)
  })
  it('texto para mensagem que não pôde ser aberta', async () => {
    await deliver(incoming())
    await setOptions({ unopenedMessageText: 'Não consegui abrir sua mensagem. Pode reenviar?' })
    await deliver(incoming({ id: `${OWNER}:ERR`, messageid: 'ERR', messageType: 'error', text: '' }))
    expect(calls.filter(c => c.path === '/send/text').map(c => c.body)).toMatchObject([{ number: PN, text: 'Não consegui abrir sua mensagem. Pode reenviar?' }])
    expect(await count("SELECT count(*) n FROM messages WHERE source='automation' AND connection_id='uz-a'")).toBe(1)
    // A mensagem sem abrir não é mensagem do contato nem dispara gatilho.
    expect(await count("SELECT count(*) n FROM messages WHERE source='contact'")).toBe(1)
  })
  it('"digitando…" antes de enviar', async () => {
    const adapter = new UazapiAdapter({ ...env, CONNECTION_CREDENTIALS: JSON.stringify({ token: TOKEN, serverUrl: SERVER }), CONNECTION_SETTINGS: JSON.stringify({ typing: true }) })
    expect(await adapter.send(await context(), { kind: 'text', text: 'Olá' })).toMatchObject({ ok: true })
    expect(calls.find(c => c.path === '/send/text')!.body).toMatchObject({ number: PN, text: 'Olá', delay: 1500 })
  })
})

async function context(): Promise<SendContext> {
  await deliver(incoming())
  const contactId = (await runtime.DB.prepare("SELECT contact_id FROM contact_channels WHERE channel_id='uz-a'").first<{ contact_id: string }>())!.contact_id
  await runtime.DB.prepare("DELETE FROM flow_runs").run()
  await runtime.DB.prepare("INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,channel_id,current_node_id) VALUES ('uz-run','a',?,'uz-v','uz-a','offer')").bind(contactId).run()
  return { runId: 'uz-run', step: 1, part: 0, channelId: 'uz-a', externalUserId: PN, mode: { ok: true, mode: 'free' },
    run: { id: 'uz-run', workspace_id: 'a', contact_id: contactId, channel_id: 'uz-a', external_user_id: PN, channel_type: 'whatsapp',
      automation_version_id: 'uz-v', automation_id: 'auto-a', graph: JSON.stringify(graph), start_node_id: null, depth: 0 } }
}
const adapterFor = () => new UazapiAdapter({ ...env, CONNECTION_CREDENTIALS: JSON.stringify({ token: TOKEN, serverUrl: SERVER }), CONNECTION_SETTINGS: '{}' })

describe('envio da automação e recibos', () => {
  it('texto e botões saem pela instância, sem janela de 24 h, e o replay não envia de novo', async () => {
    const ctx = await context()
    const adapter = adapterFor()
    await runtime.DB.prepare("UPDATE contact_channels SET window_expires_at=1 WHERE channel_id='uz-a'").run()      // there is no window to expire
    expect(await adapter.send(ctx, { kind: 'text', text: 'Escolha', buttons: [{ type: 'postback', id: `b:${'a'.repeat(24)}`, title: 'Continuar' }, { type: 'url', title: 'Site', url: 'https://x.test' }] })).toMatchObject({ ok: true, externalId: 'OUT-1' })
    expect(calls.find(c => c.path === '/send/menu')!.body).toEqual({ number: PN, type: 'button', text: 'Escolha', track_source: 'replica',
      choices: [`Continuar|b:${'a'.repeat(24)}`, 'Site|https://x.test'] })
    expect(await adapter.send(ctx, { kind: 'text', text: 'Escolha', buttons: [{ type: 'postback', id: `b:${'a'.repeat(24)}`, title: 'Continuar' }, { type: 'url', title: 'Site', url: 'https://x.test' }] })).toMatchObject({ ok: true, externalId: 'OUT-1' })
    expect(calls.filter(c => c.path === '/send/menu')).toHaveLength(1)
  })
  it('recusa o que a UAZAPI não entrega, sem rede', async () => {
    const adapter = adapterFor()
    const ctx = await context()
    const before = calls.length
    for (const message of [{ kind: 'template' as const, templateId: 't', params: {} }, { kind: 'cards' as const, cards: [] },
      { kind: 'media' as const, media: 'image' as const, url: 'https://x.test/a.png' }, { kind: 'text' as const, text: 'x', buttons: [{ type: 'postback' as const, id: 'a|b', title: 'Ir' }] }]) {
      expect(await adapter.send(ctx, message)).toMatchObject({ ok: false, reason: 'unsupported' })
    }
    expect(calls.length).toBe(before)
  })
  it('recibo de leitura chega antes do de entrega e o estado não regride', async () => {
    const ctx = await context()
    await adapterFor().send(ctx, { kind: 'text', text: 'Olá' })
    const receipt = (state: string, type: string, key = 'OUT-1') => ({ EventType: 'messages_update', owner: OWNER, token: TOKEN, type: 'ReadReceipt', state,
      event: { Chat: PN, chatid: PN, MessageIDs: [key], Timestamp: Math.floor(Date.now() / 1000), Type: type, IsFromMe: false, IsGroup: false, Sender: PN } })
    await deliver(receipt('Read', 'Read'))
    await deliver(receipt('Delivered', 'Delivered'))
    expect(await runtime.DB.prepare("SELECT delivery_status FROM messages WHERE source='automation'").first('delivery_status')).toBe('read')
    expect(await count("SELECT count(*) n FROM node_events WHERE type IN ('delivered','read')")).toBe(2)
    // A receipt for something this connection never sent is dropped once it is old enough to be sure.
    const stale = await consume(...(await (async () => { accepted = []; await hooks.request('/uz-a', post(receipt('Read', 'Read', 'FOREIGN')), env); return accepted })()))
    expect(stale[0].retry).toHaveBeenCalled()
  })
  it('recibo com IsFromMe false (payload real) da nossa mensagem atualiza a entrega; id desconhecido não muda nada', async () => {
    const ctx = await context()
    await adapterFor().send(ctx, { kind: 'text', text: 'Olá' })
    const status = () => runtime.DB.prepare("SELECT delivery_status FROM messages WHERE source='automation'").first('delivery_status')
    const real = (state: string, key: string) => ({ EventType: 'messages_update', owner: OWNER, token: TOKEN, type: 'ReadReceipt', state,
      event: { Chat: PN, IsFromMe: false, IsGroup: false, MessageIDs: [key], Sender: PN, Timestamp: Math.floor(Date.now() / 1000), Type: state } })
    await deliver(real('Delivered', 'OUT-1'))
    expect(await status()).toBe('delivered')
    await deliver(real('Read', 'OUT-1'))
    expect(await status()).toBe('read')
    await deliver(real('Delivered', 'UNKNOWN-9'))
    expect(await status()).toBe('read')
    expect(await count("SELECT count(*) n FROM messages WHERE delivery_status='delivered'")).toBe(0)
  })
})

describe('reconciliação (a UAZAPI não reenvia webhook)', () => {
  it('recupera a mensagem de um webhook perdido uma vez só, mesmo que o webhook chegue depois', async () => {
    const lost = incoming({ id: `${OWNER}:LOST`, messageid: 'LOST', text: 'quero', messageTimestamp: Date.now() - 120_000 }).message
    const old = incoming({ id: `${OWNER}:OLD`, messageid: 'OLD', messageTimestamp: Date.now() - 3_600_000 }).message
    found = [lost, old]
    accepted = []
    expect(await reconcileConnections(env)).toEqual({ connections: 1, queued: 1 })
    expect(accepted).toHaveLength(1)
    expect(JSON.stringify(accepted[0])).not.toContain(TOKEN)
    await consume(...accepted)
    expect(await count("SELECT count(*) n FROM messages WHERE direction='in' AND connection_id='uz-a'")).toBe(1)
    expect(await count("SELECT count(*) n FROM flow_runs WHERE channel_id='uz-a'")).toBe(1)
    // The late webhook is the same event: nothing new is stored or fired.
    await deliver({ ...incoming({ id: `${OWNER}:LOST`, messageid: 'LOST', text: 'quero', messageTimestamp: lost.messageTimestamp }) })
    expect(await count("SELECT count(*) n FROM inbound_events WHERE channel_id='uz-a'")).toBe(1)
    expect(await count("SELECT count(*) n FROM messages WHERE direction='in' AND connection_id='uz-a'")).toBe(1)
    expect(await count("SELECT count(*) n FROM flow_runs WHERE channel_id='uz-a'")).toBe(1)
    // The cursor moved: the next run has nothing new to queue.
    accepted = []
    expect(await reconcileConnections(env)).toEqual({ connections: 1, queued: 0 })
  })
  it('um erro numa conexão não deixa a fila com meio lote nem avança o cursor', async () => {
    found = [incoming({ messageid: 'A', id: 'x:A', messageTimestamp: Date.now() - 60_000 }).message]
    const cursor = () => runtime.DB.prepare("SELECT sync_cursor FROM channels WHERE id='uz-a'").first<number>('sync_cursor')
    const before = await cursor()
    env = { ...env, INBOUND: { send: async () => { throw new Error('fila') } } as unknown as Queue<InboundEvent> }
    await reconcileConnections(env)
    expect(await cursor()).toBe(before)
  })
  it('conexão desligada ou arquivada não é consultada', async () => {
    await runtime.DB.prepare("UPDATE channels SET connection_state='disconnected' WHERE id='uz-a'").run()
    expect(await reconcileConnections(env)).toEqual({ connections: 0, queued: 0 })
  })
})

describe('auditoria 26/10: recibos de grupo, falhas, timelock 463 e conexão', () => {
  const connectionOf = () => connectionFromRow({ ...liteRow('whatsapp', 'uz-a', 'a'), provider: 'uazapi' })
  const groupReceipts = (receipts: unknown[], over: Record<string, unknown> = {}) => ({ EventType: 'messages_update', owner: OWNER, token: TOKEN, type: 'GroupReceipts',
    event: { Chat: '120363000000001@g.us', chatid: '120363000000001@g.us', IsFromMe: false, IsGroup: true, MessageIDs: ['GOUT-1'], Type: 'GroupReceipts', Receipts: receipts, ...over } })
  const item = (state: string, timestamp: number) => ({ participant: PN, state, timestamp })
  const receipt = (state: string, key = 'OUT-1') => ({ EventType: 'messages_update', owner: OWNER, token: TOKEN, type: 'ReadReceipt', state,
    event: { Chat: PN, chatid: PN, MessageIDs: [key], Timestamp: Math.floor(Date.now() / 1000), Type: state, IsFromMe: false, IsGroup: false, Sender: PN } })

  it('GroupReceipts: o estado mais adiantado entre os participantes vale para a mensagem, com o horário do próprio item', () => {
    const body = groupReceipts([item('Delivered', 1788868801), item('Read', 1788868820), item('Delivered', 1788868830)])
    const parts = splitUazapi(body)
    expect(parts).toHaveLength(1)
    expect(parts[0].eventKey).toBe('GOUT-1:read')
    expect(uazapi.parseInbound(parts[0].payload, connectionOf())).toEqual([{ kind: 'receipt', eventKey: 'GOUT-1:read', externalMessageId: 'GOUT-1', status: 'read', occurredAt: 1788868820_000 }])
    expect(uazapi.parseInbound(splitUazapi(groupReceipts([item('Delivered', 1788868801)]))[0].payload, connectionOf())).toMatchObject([{ kind: 'receipt', status: 'delivered', occurredAt: 1788868801_000 }])
    // Played conta como lida; lote sem estado reconhecível não vira recibo.
    expect(uazapi.parseInbound(splitUazapi(groupReceipts([item('Played', 1788868840)]))[0].payload, connectionOf())).toMatchObject([{ kind: 'receipt', status: 'read' }])
    expect(splitUazapi(groupReceipts([]))).toEqual([])
    expect(splitUazapi(groupReceipts([{ participant: PN }]))).toEqual([])
  })
  it('estados Failed, Expired e Canceled viram falha; Queued, Sent e Deleted não mudam a entrega', () => {
    for (const state of ['Failed', 'Expired', 'Canceled']) {
      const [part] = splitUazapi(receipt(state))
      expect(uazapi.parseInbound(part.payload, connectionOf())).toMatchObject([{ kind: 'receipt', status: 'failed', externalMessageId: 'OUT-1' }])
    }
    for (const state of ['Queued', 'Sent', 'Deleted']) expect(splitUazapi(receipt(state))).toEqual([])
  })
  it('falha assíncrona aparece como failed na mensagem e no evento do nó, e nunca desfaz uma leitura', async () => {
    const ctx = await context()
    await adapterFor().send(ctx, { kind: 'text', text: 'Olá' })
    await deliver(receipt('Failed'))
    expect(await runtime.DB.prepare("SELECT delivery_status FROM messages WHERE source='automation'").first('delivery_status')).toBe('failed')
    expect(await count("SELECT count(*) n FROM node_events WHERE type='failed'")).toBe(1)
    await deliver(receipt('Read'))
    expect(await runtime.DB.prepare("SELECT delivery_status FROM messages WHERE source='automation'").first('delivery_status')).toBe('read')
    await deliver(receipt('Expired'))
    expect(await runtime.DB.prepare("SELECT delivery_status FROM messages WHERE source='automation'").first('delivery_status')).toBe('read')
  })
  it('erro 463 (timelock de novas conversas): recusa com o código, marca o número como restrito e não insiste', async () => {
    const ctx = await context()
    forced = path => path === '/send/text' ? Response.json({ error: 'WhatsApp server error 463', error_source: 'whatsapp_server', provider_code: 463,
      error_key: 'WHATSAPP_REACHOUT_TIMELOCK', diagnostics_endpoint: '/instance/wa_messages_limits' }, { status: 500 }) : undefined
    expect(await adapterFor().send(ctx, { kind: 'text', text: 'Olá' })).toMatchObject({ ok: false, reason: 'rejected', code: 'WHATSAPP_REACHOUT_TIMELOCK' })
    expect(await runtime.DB.prepare("SELECT connection_state FROM channels WHERE id='uz-a'").first('connection_state')).toBe('restricted')
    expect(await runtime.DB.prepare("SELECT status_detail FROM channels WHERE id='uz-a'").first('status_detail')).toMatch(/novas conversas/)
    // Só sequências e transmissões esperam; o fluxo comum que tenta falar com quem não escreveu falha (não diz que "outros envios esperam").
    expect(await runtime.DB.prepare("SELECT status_detail FROM channels WHERE id='uz-a'").first('status_detail')).toMatch(/sequências e transmissões esperam.*param com falha/)
  })
  it('401 (token da instância recusado): conexão com erro e motivo em pt-BR; 5xx e 4xx comum não marcam', async () => {
    const ctx = await context()
    forced = path => path === '/send/text' ? Response.json({ error: 'Internal error' }, { status: 503 }) : undefined
    expect(await adapterFor().send(ctx, { kind: 'text', text: 'Olá' })).toMatchObject({ ok: false, reason: 'uncertain' })
    forced = path => path === '/send/text' ? Response.json({ error: 'Bad request' }, { status: 400 }) : undefined
    expect(await adapterFor().send({ ...ctx, step: 2 }, { kind: 'text', text: 'Olá' })).toMatchObject({ ok: false, reason: 'rejected', code: '400' })
    expect(await runtime.DB.prepare("SELECT connection_state FROM channels WHERE id='uz-a'").first('connection_state')).not.toBe('error')
    forced = path => path === '/send/text' ? Response.json({ error: 'Invalid token' }, { status: 401 }) : undefined
    expect(await adapterFor().send({ ...ctx, step: 3 }, { kind: 'text', text: 'Olá' })).toMatchObject({ ok: false, reason: 'rejected', code: 'token_refused', detail: expect.stringMatching(/recusado pela UAZAPI.*Trocar credencial/) })
    expect(await runtime.DB.prepare("SELECT connection_state FROM channels WHERE id='uz-a'").first('connection_state')).toBe('error')
    expect(await runtime.DB.prepare("SELECT status_detail FROM channels WHERE id='uz-a'").first('status_detail')).toMatch(/recusado pela UAZAPI.*Trocar credencial/)
  })
  it('número restrito responde a quem escreveu nas últimas 24 h e barra, sem chamar a UAZAPI, quem não escreveu', async () => {
    const ctx = await context()
    await runtime.DB.prepare("UPDATE channels SET connection_state='restricted' WHERE id='uz-a'").run()
    expect(await adapterFor().send(ctx, { kind: 'text', text: 'Resposta' })).toMatchObject({ ok: true })
    await runtime.DB.prepare("UPDATE contact_channels SET last_inbound_at=? WHERE channel_id='uz-a'").bind(Date.now() - 25 * 3600_000).run()
    expect(await adapterFor().send({ ...ctx, step: 2 }, { kind: 'text', text: 'Novidade' })).toMatchObject({ ok: false, reason: 'rejected', code: 'connection_restricted' })
    expect(calls.filter(c => c.path === '/send/text')).toHaveLength(1)
  })
  it.each(['disconnected', 'connecting', 'error'])('número %s não envia automação e não chama a UAZAPI', async connection => {
    const ctx = await context()
    await runtime.DB.prepare("UPDATE channels SET connection_state=? WHERE id='uz-a'").bind(connection).run()
    expect(await adapterFor().send(ctx, { kind: 'text', text: 'Olá' })).toMatchObject({ ok: false, reason: 'rejected', code: 'connection_unavailable' })
    expect(calls.filter(c => c.path.startsWith('/send/'))).toHaveLength(0)
  })
  it('conexão: 429 e 503 não viram QR vazio, e QR ainda não gerado também não', async () => {
    const connect = () => uazapi.connect({ connection: connectionOf(), credentials: { token: TOKEN, serverUrl: SERVER }, hookUrl: 'https://h.test/x', webhookSecret: 's', fetch: globalThis.fetch })
    instance = { id: 'r183e2ef', status: 'disconnected' }
    forced = path => path === '/instance/connect' ? Response.json({ error: 'too many' }, { status: 429 }) : undefined
    expect(await connect()).toMatchObject({ kind: 'failed', code: 'rate_limited' })
    forced = path => path === '/instance/connect' ? Response.json({ error: 'busy' }, { status: 503, headers: { 'Retry-After': '5' } }) : undefined
    expect(await connect()).toMatchObject({ kind: 'failed', code: 'unavailable' })
    forced = path => path === '/instance/connect' ? Response.json({ response: 'Connecting' }) : undefined
    instance = { id: 'r183e2ef', status: 'connecting' }
    expect(await connect()).toMatchObject({ kind: 'failed', code: 'qr_not_ready' })
    instance = { id: 'r183e2ef', status: 'connecting', qrcode: 'data:image/png;base64,QR9' }
    expect(await connect()).toMatchObject({ kind: 'qr', qr: 'data:image/png;base64,QR9' })
  })
})

describe('iniciar conversa pelo painel', () => {
  const start = async (connection: string, extra: Record<string, unknown>) => {
    const { startConversation, startSchema } = await import('../src/channels/core/start-conversation')
    return startConversation(env as unknown as Env, 'a', startSchema.parse({ connection_id: connection, phone: '+55 11 88888-8888', name: 'Ana', consent: true, ...extra }))
  }
  it('conexão com opt-in manda texto livre, guarda o JID e a resposta cai na mesma conversa', async () => {
    const { conversation } = await start('uz-a', { text: 'Oi, Ana!' })
    expect(calls.filter(c => c.path === '/send/text').map(c => c.body)).toMatchObject([{ number: PN, text: 'Oi, Ana!' }])
    expect(await runtime.DB.prepare("SELECT external_user_id,identity_kind,address_kind,phone_e164,opted_in FROM contact_channels WHERE channel_id='uz-a'").first())
      .toEqual({ external_user_id: PN, identity_kind: 'provider_id', address_kind: 'wa_pn', phone_e164: PHONE, opted_in: 1 })
    await deliver(incoming())
    expect(await count("SELECT count(*) n FROM contact_channels WHERE channel_id='uz-a'")).toBe(1)
    expect(await count(`SELECT count(*) n FROM messages WHERE conversation_id='${conversation.id}'`)).toBeGreaterThanOrEqual(2)
  })
  it('número sem WhatsApp (/chat/check): 409 claro e nada é criado nem enviado', async () => {
    const tables = ['contacts', 'contact_channels', 'conversations']
    const before = await Promise.all(tables.map(t => count(`SELECT count(*) n FROM ${t}`)))
    await expect(start('uz-a', { text: 'Oi', phone: '+55 21 90000-0001' })).rejects.toMatchObject({ status: 409, message: 'Este número não tem WhatsApp.' })
    expect(calls.filter(c => c.path === '/chat/check').map(c => c.body)).toEqual([{ numbers: ['5521900000001'] }])
    expect(calls.filter(c => c.path === '/send/text')).toHaveLength(0)
    expect(await Promise.all(tables.map(t => count(`SELECT count(*) n FROM ${t}`)))).toEqual(before)
  })
  it('verificação com falha do servidor (500) não bloqueia: segue o envio', async () => {
    forced = path => path === '/chat/check' ? Response.json({ error: 'WhatsApp client is not connected' }, { status: 500 }) : undefined
    await start('uz-a', { text: 'Oi' })
    expect(calls.filter(c => c.path === '/send/text')).toHaveLength(1)
  })
  it('exige texto na conexão com opt-in e recusa modelo; sem consentimento não cria nada', async () => {
    await expect(start('uz-a', { template: { id: 'x', params: {} } })).rejects.toMatchObject({ status: 400 })
    const { startSchema } = await import('../src/channels/core/start-conversation')
    expect(() => startSchema.parse({ connection_id: 'uz-a', phone: '+5511888888888', consent: false, text: 'oi' })).toThrow()
    expect(() => startSchema.parse({ connection_id: 'uz-a', phone: '+5511888888888', consent: true })).toThrow()
    expect(calls.filter(c => c.path === '/send/text')).toHaveLength(0)
  })
  it('conexão oficial continua exigindo modelo aprovado (texto livre é recusado)', async () => {
    await runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,connection_state) VALUES ('wa-a','a','whatsapp','meta_whatsapp_cloud','phone-id','connected')").run()
    await giveCredentials(runtime, 'wa-a', { accessToken: 'TESTONLY', phoneNumberId: 'phone-id', appSecret: 's', webhookSecret: 'v' })
    await expect(start('wa-a', { text: 'oi' })).rejects.toMatchObject({ status: 400 })
    await expect(start('wa-a', { template: { id: 'inexistente', params: {} } })).rejects.toMatchObject({ status: 404 })
  })
  it('conexão em que a pessoa precisa escrever primeiro recusa', async () => {
    await runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,connection_state) VALUES ('tg-a','a','telegram','telegram_bot','bot','connected')").run()
    await giveCredentials(runtime, 'tg-a', { botToken: '1:abc', webhookSecret: 'w' })
    await expect(start('tg-a', { text: 'oi' })).rejects.toMatchObject({ status: 409 })
  })
})
