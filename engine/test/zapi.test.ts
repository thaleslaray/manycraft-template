import { env as runtime } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hooks } from '../src/channels/core/hooks'
import { deliverHuman } from '../src/channels/core/delivery'
import { connectionRuntime } from '../src/channels/core/runtime'
import { claimNumber } from '../src/channels/core/whatsapp-numbers'
import { ZapiAdapter } from '../src/channels/zapi-adapter'
import type { SendContext } from '../src/channels'
import { upsertWhatsappIdentity } from '../src/db/contacts'
import { ensureConversation } from '../src/inbox/service'
import { consumeInbound } from '../src/jobs'
import type { InboundEvent, IntegrationEnv } from '../src/integrations'
import { giveCredentials, testKeyring } from './credentials'
import { buttonToken, HOOK_SECRET, hookQuery, ZAPI_CLIENT_TOKEN, ZAPI_INSTANCE, ZAPI_TOKEN, ZAPI_USER, zapiClick, zapiConnected, zapiDelivery, zapiDisconnected, zapiMessage, zapiStatus } from './conformance/zapi-fixture'
import { seed } from './fixtures'

const PHONE = `+${ZAPI_USER}`
const graph = { nodes: [
  { id: 'start', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
  { id: 'offer', type: 'message', position: { x: 1, y: 0 }, config: { blocks: [
    { kind: 'text', text: 'Escolha' }, { kind: 'button', id: 'next', label: 'Continuar', action: { type: 'go_to_node' } } ] } },
], edges: [{ from: 'start', port: 'next', to: 'offer' }] }

type Call = { method: string; path: string; body: Record<string, unknown>; auth: string | null }
let calls: Call[]
let accepted: InboundEvent[]
let env: IntegrationEnv
let create: ReturnType<typeof vi.fn>
let sendAnswer: () => Response

const BASE = `/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}`
/** The classic Z-API server, as its docs describe it. Nothing leaves the process. */
function fakeZapi() {
  let sent = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.origin !== 'https://api.z-api.io') throw new Error(`Unexpected request: ${url.href}`)
    const call = { method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : {}, auth: new Headers(init?.headers).get('client-token') }
    calls.push(call)
    if (call.auth !== ZAPI_CLIENT_TOKEN || !url.pathname.startsWith(BASE)) return Response.json({ error: 'null not allowed' }, { status: 401 })
    if (/\/send-(text|button-list|button-actions)$/.test(url.pathname)) { sent++; return sendAnswer().status === 200 ? Response.json({ zaapId: `Z${sent}`, messageId: `OUT${sent}`.padEnd(32, '0'), id: `OUT${sent}`.padEnd(32, '0') }) : sendAnswer() }
    if (call.method === 'PUT') return Response.json({ value: true })
    return Response.json({}, { status: 404 })
  })
}
const OUT1 = 'OUT1'.padEnd(32, '0')

const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
async function deliver(body: unknown, expected = 200) {
  accepted = []
  expect((await hooks.request(`/zp-a?${hookQuery()}`, post(body), env)).status).toBe(expected)
  return consume(...accepted)
}
async function consume(...events: InboundEvent[]) {
  const messages = events.map(body => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn(), id: crypto.randomUUID(), timestamp: new Date() }))
  await consumeInbound({ messages } as unknown as MessageBatch<unknown>, env)
  return messages
}
const count = (sql: string) => runtime.DB.prepare(sql).first<number>('n')
const rows = async (sql: string) => (await runtime.DB.prepare(sql).all()).results

beforeEach(async () => {
  await seed()
  calls = []; accepted = []; sendAnswer = () => new Response('{}', { status: 200 })
  create = vi.fn(async () => ({}))
  env = { DB: runtime.DB, ...testKeyring,
    INBOUND: { send: async (event: InboundEvent) => { accepted.push(event) } } as unknown as Queue<InboundEvent>,
    FLOW_RUN: { create, get: async () => ({ sendEvent: async () => {}, status: async () => ({ status: 'running' }) }) } as unknown as NonNullable<IntegrationEnv['FLOW_RUN']> }
  await runtime.DB.batch([
    runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,connection_state) VALUES ('zp-a','a','whatsapp','zapi',?,'connected')").bind(`zapi:${ZAPI_INSTANCE}`),
    runtime.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('zp-v','a','auto-a',1,?)").bind(JSON.stringify(graph)),
    runtime.DB.prepare("UPDATE automations SET published_version_id='zp-v',status='live' WHERE id='auto-a'"),
    runtime.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,config) VALUES ('zp-trg','a','auto-a','zp-a','Palavra','keyword','active',?)").bind(JSON.stringify({ node_id: 'start' })),
    runtime.DB.prepare("INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES ('zp-key','a','zp-trg','contains','[\"quero\"]','live',1)"),
  ])
  await giveCredentials(runtime, 'zp-a', { instanceId: ZAPI_INSTANCE, token: ZAPI_TOKEN, clientToken: ZAPI_CLIENT_TOKEN, webhookSecret: HOOK_SECRET })
  fakeZapi()
})
afterEach(() => { vi.restoreAllMocks() })

describe('entrada', () => {
  const hook = (body: unknown, query = hookQuery()) => hooks.request(`/zp-a${query ? `?${query}` : ''}`, post(body), env)
  it('confere o segredo da conexão na URL, tira o id da instância da fila e responde 401 sem ele', async () => {
    expect((await hook(zapiMessage(), hookQuery('outro'))).status).toBe(401)
    expect((await hook(zapiMessage(), '')).status).toBe(401)
    expect((await hooks.request(`/zp-a?${hookQuery()}`, { method: 'GET' }, env)).status).toBe(400)
    expect(accepted).toHaveLength(0)
    expect((await hook(zapiMessage())).status).toBe(200)
    expect(accepted).toHaveLength(1)
    expect(accepted[0]).toMatchObject({ channelId: 'zp-a', eventId: 'IN0000000000000000000000000000001', workspaceId: 'a' })
    const queued = JSON.stringify(accepted[0])
    for (const secret of [ZAPI_TOKEN, ZAPI_CLIENT_TOKEN, HOOK_SECRET, ZAPI_INSTANCE]) expect(queued).not.toContain(secret)
  })
  it('o eco de um envio pela API (fromApi), o que é só ruído e o que não é evento nem chegam à fila', async () => {
    for (const body of [zapiMessage({ id: 'ECHO1', fromMe: true, fromApi: true, text: 'eco' }), { outro: true }, zapiDelivery('OUT1'), zapiStatus('READ_BY_ME', ['X1']),
      { type: 'PresenceChatCallback', status: 'COMPOSING', phone: ZAPI_USER, instanceId: ZAPI_INSTANCE }]) {
      expect((await hook(body)).status).toBe(200)
    }
    expect(accepted).toHaveLength(0)
  })
  it('status de várias mensagens vira um evento por mensagem, cada um com a sua chave', async () => {
    expect((await hook(zapiStatus('READ', ['M1', 'M2']))).status).toBe(200)
    expect(accepted.map(e => e.eventId)).toEqual(['M1:read', 'M2:read'])
    expect(JSON.stringify(accepted[0])).not.toContain('M2')
  })
})

describe('contato e automação', () => {
  it('mensagem vira contato com telefone, número e consentimento; a automação dispara uma vez mesmo com o evento repetido', async () => {
    await deliver(zapiMessage())
    await deliver(zapiMessage())
    const identity = await runtime.DB.prepare("SELECT * FROM contact_channels WHERE channel_id='zp-a'").first<Record<string, unknown>>()
    expect(identity).toMatchObject({ external_user_id: ZAPI_USER, identity_kind: 'provider_id', address_kind: 'wa_pn', phone_e164: PHONE, opted_in: 1 })
    expect(identity!.last_inbound_at).toBeGreaterThan(0)
    expect(await runtime.DB.prepare('SELECT first_name FROM contacts WHERE id=?').bind(identity!.contact_id).first('first_name')).toBe('Ana')
    expect(await count("SELECT count(*) n FROM messages WHERE direction='in' AND connection_id='zp-a'")).toBe(1)
    expect(create).toHaveBeenCalledTimes(1)
  })
  it('o banco aceita contato sem BSUID na conexão Z-API só com telefone em dígitos', async () => {
    await runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('wa-a','a','whatsapp','phone-id')").run()
    const insert = (channel: string, user: string, kind: string, address: string | null) => runtime.DB.prepare(
      'INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,identity_kind,address_kind) VALUES (?,?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), 'a', 'c-a', channel, user, kind, address).run()
    await expect(insert('wa-a', ZAPI_USER, 'provider_id', 'wa_pn')).rejects.toThrow(/whatsapp_requires_bsuid/)
    await expect(insert('zp-a', 'BR.abc123', 'bsuid', 'wa_pn')).rejects.toThrow(/whatsapp_requires_bsuid/)
    await expect(insert('zp-a', '55abc', 'provider_id', 'wa_pn')).rejects.toThrow(/whatsapp_requires_bsuid/)
    await expect(insert('zp-a', `${ZAPI_USER}@lid`, 'provider_id', 'wa_pn')).rejects.toThrow(/whatsapp_requires_bsuid/)
    await expect(insert('zp-a', ZAPI_USER, 'provider_id', null)).rejects.toThrow(/whatsapp_requires_bsuid/)
    await insert('zp-a', ZAPI_USER, 'provider_id', 'wa_pn')
  })
  it('o banco só aceita o provedor zapi em canal de WhatsApp', async () => {
    await expect(runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id) VALUES ('zp-x','a','telegram','zapi','x')").run()).rejects.toThrow(/provider_kind_mismatch/)
  })
  it('clique em botão chega com o id do botão e aparece uma vez na caixa de entrada', async () => {
    await deliver(zapiMessage())
    await deliver(zapiClick())
    expect(await count("SELECT count(*) n FROM inbound_events WHERE channel_id='zp-a'")).toBe(2)
    expect(await count("SELECT count(*) n FROM messages WHERE direction='in' AND connection_id='zp-a'")).toBe(2)
  })
  it('mensagem de grupo, de edição e de endereço que não é telefone não viram contato', async () => {
    await deliver(zapiMessage({ id: 'G1', phone: '120363430845284251-group', group: true }))
    await deliver(zapiMessage({ id: 'E1', edit: true }))
    await deliver(zapiMessage({ id: 'L1', phone: '99887766@lid' }))
    expect(await count("SELECT count(*) n FROM contact_channels WHERE channel_id='zp-a'")).toBe(0)
  })
})

describe('união por número', () => {
  const official = async () => {
    await runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('wa-a','a','whatsapp','phone-id')").run()
    await upsertWhatsappIdentity(runtime.DB, 'a', { contact_id: 'c-a', channel_id: 'wa-a', bsuid: 'BR.abc123', phone_e164: PHONE })
    await claimNumber(runtime.DB, 'a', PHONE, 'c-a', 'wa-a', null)
  }
  it('quem fala pelo número oficial e depois pela Z-API com o mesmo telefone é um só contato', async () => {
    await official()
    await deliver(zapiMessage())
    expect(await rows("SELECT DISTINCT contact_id FROM contact_channels WHERE channel_id IN ('wa-a','zp-a')")).toEqual([{ contact_id: 'c-a' }])
    expect(await count("SELECT count(*) n FROM contacts WHERE optin_source='whatsapp'")).toBe(0)
  })
  it('na ordem inversa também, e com a UAZAPI no meio', async () => {
    await deliver(zapiMessage())
    const first = await runtime.DB.prepare("SELECT contact_id FROM contact_channels WHERE channel_id='zp-a'").first<{ contact_id: string }>()
    await runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id) VALUES ('uz-a','a','whatsapp','uazapi','uazapi:r1')").run()
    const owner = await claimNumber(runtime.DB, 'a', PHONE, 'outro', 'uz-a', null)
    expect(owner).toBe(first!.contact_id)
  })
  it('a resposta humana sai pela conexão em que a pessoa escreveu por último', async () => {
    await official()
    await runtime.DB.prepare("UPDATE contact_channels SET last_inbound_at=? WHERE channel_id='wa-a'").bind(Date.now() - 3_600_000).run()
    await giveCredentials(runtime, 'wa-a', { accessToken: 'TESTONLY', phoneNumberId: 'phone-id', appSecret: 's', webhookSecret: 'v' })
    await deliver(zapiMessage())
    const conversationId = await ensureConversation(env, 'a', 'c-a', 'wa-a')
    const rt = await connectionRuntime(env, 'a', 'wa-a')
    const sent = await deliverHuman(env, { connection: rt.connection, provider: rt.provider!, credentials: rt.credentials },
      { workspaceId: 'a', conversationId, contactId: 'c-a', externalUserId: 'BR.abc123', text: 'Oi, Ana' })
    expect(sent.ok).toBe(true)
    expect(sends().map(c => c.body)).toEqual([{ phone: ZAPI_USER, message: 'Oi, Ana' }])
    expect(await runtime.DB.prepare("SELECT connection_id,delivery_status,external_message_id FROM messages WHERE conversation_id=? AND source='human' AND json_extract(content,'$.sender')='human'").bind(conversationId).first())
      .toEqual({ connection_id: 'zp-a', delivery_status: 'sent', external_message_id: `whatsapp:zp-a:${ZAPI_USER}:${OUT1}` })
  })
})

describe('assumir pelo celular', () => {
  const fromPhone = (over: Parameters<typeof zapiMessage>[0] = {}) => zapiMessage({ id: 'OWN1', fromMe: true, fromApi: false, text: 'Já te respondo!', ...over })
  it('o que o dono escreve do aparelho entra como resposta humana, pausa a automação e nunca dispara gatilho', async () => {
    await deliver(zapiMessage({ text: 'oi' }))
    await deliver(fromPhone({ text: 'quero' }))
    expect(await count('SELECT count(*) n FROM flow_runs')).toBe(0)
    expect(await rows("SELECT direction,source,connection_id,delivery_status,json_extract(content,'$.text') AS text FROM messages WHERE json_extract(content,'$.sender')<>'system' ORDER BY rowid")).toEqual([
      { direction: 'in', source: 'contact', connection_id: 'zp-a', delivery_status: null, text: 'oi' },
      { direction: 'out', source: 'human', connection_id: 'zp-a', delivery_status: 'sent', text: 'quero' }])
    const paused = await runtime.DB.prepare("SELECT automation_paused_until FROM contacts WHERE id IN (SELECT contact_id FROM contact_channels WHERE channel_id='zp-a')").first<number>('automation_paused_until')
    expect(paused!).toBeGreaterThan(Date.now() + 25 * 60_000)
    await deliver(fromPhone({ text: 'quero' }))
    expect(await count("SELECT count(*) n FROM messages WHERE json_extract(content,'$.sender')='human'")).toBe(1)
  })
  it('conversa que nunca escreveu para nós não vira contato', async () => {
    await deliver(fromPhone({ phone: '5511777777777' }))
    expect(await count("SELECT count(*) n FROM contact_channels WHERE channel_id='zp-a'")).toBe(0)
  })
})

async function context(): Promise<SendContext> {
  await deliver(zapiMessage())
  const contactId = (await runtime.DB.prepare("SELECT contact_id FROM contact_channels WHERE channel_id='zp-a'").first<{ contact_id: string }>())!.contact_id
  await runtime.DB.prepare('DELETE FROM flow_runs').run()
  await runtime.DB.prepare("INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,channel_id,current_node_id) VALUES ('zp-run','a',?,'zp-v','zp-a','offer')").bind(contactId).run()
  return { runId: 'zp-run', step: 1, part: 0, channelId: 'zp-a', externalUserId: ZAPI_USER, mode: { ok: true, mode: 'free' },
    run: { id: 'zp-run', workspace_id: 'a', contact_id: contactId, channel_id: 'zp-a', external_user_id: ZAPI_USER, channel_type: 'whatsapp',
      automation_version_id: 'zp-v', automation_id: 'auto-a', graph: JSON.stringify(graph), start_node_id: null, depth: 0 } }
}
const adapterFor = () => new ZapiAdapter({ ...env, CONNECTION_CREDENTIALS: JSON.stringify({ instanceId: ZAPI_INSTANCE, token: ZAPI_TOKEN, clientToken: ZAPI_CLIENT_TOKEN }), CONNECTION_SETTINGS: '{}' })
const sends = () => calls.filter(c => /\/send-[a-z-]+$/.test(c.path))

describe('envio da automação e recibos', () => {
  it('texto e botões de resposta saem pelo canal, sem janela de 24 h, e o replay não envia de novo', async () => {
    const ctx = await context()
    const adapter = adapterFor()
    await runtime.DB.prepare("UPDATE contact_channels SET window_expires_at=1 WHERE channel_id='zp-a'").run()      // there is no window to expire
    const message = { kind: 'text' as const, text: 'Escolha', buttons: [{ type: 'postback' as const, id: buttonToken, title: 'Continuar' }] }
    expect(await adapter.send(ctx, message)).toMatchObject({ ok: true, externalId: OUT1 })
    expect(sends()[0]).toMatchObject({ method: 'POST', path: `${BASE}/send-button-list`, auth: ZAPI_CLIENT_TOKEN,
      body: { phone: ZAPI_USER, message: 'Escolha', buttonList: { buttons: [{ id: buttonToken, label: 'Continuar' }] } } })
    expect(await adapter.send(ctx, message)).toMatchObject({ ok: true, externalId: OUT1 })
    expect(sends()).toHaveLength(1)
  })
  it('texto simples sai por send-text; botões de link saem como ação, e misturar com resposta é recusado, sem rede', async () => {
    const ctx = await context()
    const adapter = adapterFor()
    expect(await adapter.send(ctx, { kind: 'text', text: 'Oi' })).toMatchObject({ ok: true })
    expect(sends()[0]).toMatchObject({ path: `${BASE}/send-text`, body: { phone: ZAPI_USER, message: 'Oi' } })
    const actions = await adapter.send({ ...ctx, step: 2 }, { kind: 'text', text: 'Veja', buttons: [{ type: 'url', title: 'Site', url: 'https://x.test' }] })
    expect(actions).toMatchObject({ ok: true })
    expect(sends()[1]).toMatchObject({ path: `${BASE}/send-button-actions`, body: { phone: ZAPI_USER, message: 'Veja', buttonActions: [{ id: '1', type: 'URL', label: 'Site', url: 'https://x.test' }] } })
    const before = calls.length
    for (const message of [{ kind: 'text' as const, text: 'x', buttons: [{ type: 'url' as const, title: 'A', url: 'https://x.test' }, { type: 'postback' as const, id: 'a', title: 'B' }] },
      { kind: 'text' as const, text: 'x', buttons: [{ type: 'call' as const, title: 'Ligar', phone: '+5511999999999' }] },
      { kind: 'template' as const, templateId: 't', params: {} }, { kind: 'cards' as const, cards: [] },
      { kind: 'media' as const, media: 'image' as const, url: 'https://x.test/a.png' }]) {
      expect(await adapter.send(ctx, message)).toMatchObject({ ok: false, reason: 'unsupported' })
    }
    expect(calls.length).toBe(before)
  })
  it('recusa 4xx do envio é definitiva, com o código HTTP', async () => {
    const ctx = await context()
    sendAnswer = () => Response.json({ error: 'Phone number does not exist' }, { status: 400 })
    expect(await adapterFor().send(ctx, { kind: 'text', text: 'Olá' })).toMatchObject({ ok: false, reason: 'rejected', code: '400' })
  })
  it('401 (token ou Client-Token recusado): conexão com erro e motivo em pt-BR; 4xx comum e 5xx não marcam', async () => {
    const ctx = await context()
    const health = () => runtime.DB.prepare("SELECT connection_state,status_detail FROM channels WHERE id='zp-a'").first<{ connection_state: string; status_detail: string | null }>()
    sendAnswer = () => Response.json({ error: 'Phone number does not exist' }, { status: 400 })
    await adapterFor().send(ctx, { kind: 'text', text: 'Olá' })
    sendAnswer = () => Response.json({}, { status: 502 })
    await adapterFor().send({ ...ctx, step: 2 }, { kind: 'text', text: 'Olá' })
    expect((await health())!.connection_state).toBe('connected')
    sendAnswer = () => Response.json({ error: 'Unauthorized' }, { status: 401 })
    expect(await adapterFor().send({ ...ctx, step: 3 }, { kind: 'text', text: 'Olá' })).toMatchObject({ ok: false, reason: 'rejected', code: 'token_refused', detail: expect.stringMatching(/recusado pela Z-API.*Trocar credencial/) })
    expect(await health()).toMatchObject({ connection_state: 'error', status_detail: expect.stringMatching(/recusado pela Z-API.*Trocar credencial/) })
  })
  it('recibo de leitura chega antes do de entrega e o estado não regride; lido por mim não conta', async () => {
    const ctx = await context()
    await adapterFor().send(ctx, { kind: 'text', text: 'Olá' })
    await deliver(zapiStatus('READ', [OUT1]))
    await deliver(zapiStatus('RECEIVED', [OUT1]))
    expect(await runtime.DB.prepare("SELECT delivery_status FROM messages WHERE source='automation'").first('delivery_status')).toBe('read')
    expect(await count("SELECT count(*) n FROM node_events WHERE type IN ('delivered','read')")).toBe(2)
    // A receipt for something this connection never sent is retried, then dropped once it is old enough to be sure.
    accepted = []
    await hooks.request(`/zp-a?${hookQuery()}`, post(zapiStatus('READ', ['FOREIGN'])), env)
    expect((await consume(...accepted))[0].retry).toHaveBeenCalled()
  })
  it('erro no "Ao enviar" marca a mensagem como falha', async () => {
    const ctx = await context()
    await adapterFor().send(ctx, { kind: 'text', text: 'Olá' })
    await deliver(zapiDelivery(OUT1, 'Phone number does not exist'))
    expect(await runtime.DB.prepare("SELECT delivery_status FROM messages WHERE source='automation'").first('delivery_status')).toBe('failed')
  })
})

describe('estado do número', () => {
  it('desconectou e conectou: o estado da conexão segue o que a Z-API avisa', async () => {
    await deliver(zapiDisconnected)
    expect(await runtime.DB.prepare("SELECT connection_state,status_detail FROM channels WHERE id='zp-a'").first()).toMatchObject({ connection_state: 'disconnected', status_detail: expect.stringMatching(/desconectado/) })
    await deliver(zapiConnected)
    expect(await runtime.DB.prepare("SELECT connection_state,status_detail FROM channels WHERE id='zp-a'").first()).toEqual({ connection_state: 'connected', status_detail: null })
  })
})

describe('webhook e pareamento', () => {
  const provider = async () => (await connectionRuntime(env, 'a', 'zp-a')).provider!
  const context_ = async () => { const rt = await connectionRuntime(env, 'a', 'zp-a'); return { connection: rt.connection, credentials: await rt.credentials(), hookUrl: 'https://x.test/api/hooks/zp-a', webhookSecret: HOOK_SECRET, fetch: globalThis.fetch } }
  it('registra os cinco webhooks com o segredo na URL, liga "enviadas por mim" e desliga a fila com o celular fora', async () => {
    const registered = await (await provider()).registerWebhook(await context_())
    expect(registered).toEqual({ registered: true })
    const url = `https://x.test/api/hooks/zp-a?${hookQuery()}`
    expect(calls.map(c => `${c.method} ${c.path.slice(BASE.length)}`)).toEqual(['PUT /update-webhook-received', 'PUT /update-webhook-delivery', 'PUT /update-webhook-message-status',
      'PUT /update-webhook-connected', 'PUT /update-webhook-disconnected', 'PUT /update-notify-sent-by-me', 'PUT /update-queue-settings'])
    expect(calls.slice(0, 5).map(c => c.body)).toEqual(Array(5).fill({ value: url }))
    expect(calls[5].body).toEqual({ notifySentByMe: true })
    expect(calls[6].body).toEqual({ disableEnqueueWhenDisconnected: true })
    expect(calls.every(c => c.auth === ZAPI_CLIENT_TOKEN)).toBe(true)
  })
  it('recusa da Z-API vira passo manual com a URL já com o segredo, sem exceção', async () => {
    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'invalid url' }, { status: 400 }))
    expect(await (await provider()).registerWebhook(await context_())).toMatchObject({ registered: false, manual: { kind: 'manual_webhook', callbackUrl: `https://x.test/api/hooks/zp-a?${hookQuery()}` } })
  })
  it('conectar: celular fora pede o QR (data URI), número conectado conclui, challenge de passkey falha com aviso', async () => {
    const rt = await connectionRuntime(env, 'a', 'zp-a')
    const ctx = async (answers: Record<string, Response>) => {
      vi.restoreAllMocks()
      vi.spyOn(globalThis, 'fetch').mockImplementation(async input => answers[new URL(String(input)).pathname.slice(BASE.length)]?.clone() ?? Response.json({}, { status: 404 }))
      return { connection: rt.connection, credentials: await rt.credentials(), hookUrl: '', webhookSecret: '', fetch: globalThis.fetch }
    }
    const status = (connected: boolean) => Response.json({ connected, error: connected ? 'You are already connected' : 'You are not connected', smartphoneConnected: connected })
    const p = await provider()
    expect(await p.connect(await ctx({ '/status': status(false), '/qr-code': Response.json({ value: 'data:image/png;base64,QR1' }) })))
      .toMatchObject({ kind: 'qr', qr: 'data:image/png;base64,QR1', externalId: `zapi:${ZAPI_INSTANCE}` })
    expect(await p.connect(await ctx({ '/status': status(true) }))).toEqual({ kind: 'done', externalId: `zapi:${ZAPI_INSTANCE}` })
    expect(await p.connect(await ctx({ '/status': status(false), '/qr-code': Response.json({ challenge: { challenge: 'x', rpId: 'whatsapp.com' } }) }))).toMatchObject({ kind: 'failed', code: 'passkey_required' })
    expect(await p.connect(await ctx({ '/status': Response.json({ error: 'null not allowed' }, { status: 401 }) }))).toMatchObject({ kind: 'failed', code: 'invalid_credentials' })
  })
  it('o QR vem como imagem pronta: data URI, link ou base64 puro', async () => {
    const { qrImage } = await import('../src/channels/zapi')
    expect(qrImage('data:image/png;base64,AAA')).toBe('data:image/png;base64,AAA')
    expect(qrImage('iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(qrImage('2@abc,def')).toBe('')
  })
})
