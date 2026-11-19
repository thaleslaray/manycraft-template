import { env as runtime } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InstagramAdapter, type SendContext } from '../src/channels'
import { consumeInbound } from '../src/jobs'
import { webhooks, MAX_WEBHOOK_BYTES, type InboundEvent, type IntegrationEnv } from '../src/integrations'
import { giveCredentials, testKeyring } from './credentials'
import { seed } from './fixtures'
import { instagramUnified } from '../src/channels/instagram-unified'
import { capabilities } from '../src/channels/capabilities'
import { providers } from '../src/channels/providers'
import { connectionRuntime } from '../src/channels/core/runtime'
import { normalizeInbound } from '../src/channels/core/inbound'

const secret = 'TEST-INSTAGRAM-APP-SECRET', metaSecret = 'TEST-DIFFERENT-META-APP-SECRET'
const user = '987654321012345', account = '123456789012345', token = 'a'.repeat(24)
// What the adapter class reads; the connection's stored credentials hold the same values.
const view = { IG_APP_SECRET: secret, IG_ACCESS_TOKEN: 'TESTONLY', IG_ACCOUNT_ID: account, META_APP_SECRET: metaSecret, META_VERIFY_TOKEN: 'VERIFY-TEST' }
let env: IntegrationEnv, adapter: InstagramAdapter, context: SendContext
let accepted: InboundEvent[]
let create: ReturnType<typeof vi.fn>, sendEvent: ReturnType<typeof vi.fn>
const graph = { nodes: [
  { id: 'start', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
  { id: 'offer', type: 'message', position: { x: 1, y: 0 }, config: { blocks: [
    { kind: 'text', text: 'Escolha' }, { kind: 'button', id: 'next', label: 'Continuar', action: { type: 'go_to_node' } },
  ] } },
], edges: [{ from: 'start', port: 'next', to: 'offer' }] }
const incoming = (overrides: Record<string, unknown> = {}) => ({ sender: { id: user }, recipient: { id: account }, timestamp: Date.now(), message: { mid: 'ig.in', text: 'quero' }, ...overrides })
const envelope = (...messaging: unknown[]) => ({ object: 'instagram', entry: [{ id: account, messaging }] })
async function signed(body: unknown, key = secret) {
  const text = JSON.stringify(body)
  const hmac = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(text))
  const hex = [...new Uint8Array(sig)].map(n => n.toString(16).padStart(2, '0')).join('')
  return { method: 'POST', body: text, headers: { 'X-Hub-Signature-256': `sha256=${hex}` } }
}
async function consume(...events: InboundEvent[]) {
  const messages = events.map(body => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn(), id: crypto.randomUUID(), timestamp: new Date() }))
  await consumeInbound({ messages } as unknown as MessageBatch<unknown>, env)
  return messages
}
async function deliver(body: unknown) {
  accepted = []
  expect((await webhooks.request('/meta', await signed(body), env)).status).toBe(200)
  return consume(...accepted)
}
async function count(sql: string) { return runtime.DB.prepare(sql).first<number>('n') }
async function body() { return JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)![1]!.body)) }
async function row() { return runtime.DB.prepare("SELECT content FROM messages WHERE source='automation'").first<{ content: string }>() }
async function identity(externalUserId = user, workspace = 'a', channel = 'ch-a') {
  return runtime.DB.prepare('SELECT * FROM contact_channels WHERE workspace_id=? AND channel_id=? AND external_user_id=?')
    .bind(workspace, channel, externalUserId).first<{ id: string; contact_id: string; external_user_id: string; opted_in: number; window_expires_at: number; human_window_expires_at: number }>()
}
const seen = (mid = 'ig.out.1', timestamp = Date.now()) => incoming({ timestamp, read: { mid }, message: undefined })

beforeEach(async () => {
  await seed()
  accepted = []
  create = vi.fn(async () => ({})); sendEvent = vi.fn(async () => {})
  env = { DB: runtime.DB, ...testKeyring,
    INBOUND: { send: async (event: InboundEvent) => { accepted.push(event) } } as unknown as Queue<InboundEvent>,
    FLOW_RUN: { create, get: async () => ({ sendEvent, status: async () => ({ status: 'running' }) }) } as unknown as NonNullable<IntegrationEnv['FLOW_RUN']> }
  await runtime.DB.batch([
    runtime.DB.prepare("UPDATE channels SET external_id=? WHERE id='ch-a'").bind(account),
    runtime.DB.prepare("UPDATE contact_channels SET external_user_id=?,window_expires_at=?,human_window_expires_at=? WHERE id='cc-a'").bind(user, Date.now() + 86400000, Date.now() + 7 * 86400000),
    runtime.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('ig-v','a','auto-a',1,?)").bind(JSON.stringify(graph)),
  ])
  await runtime.DB.prepare("INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,channel_id,current_node_id) VALUES ('ig-run','a','c-a','ig-v','ch-a','offer')").run()
  context = { runId: 'ig-run', step: 1, part: 0, channelId: 'ch-a', externalUserId: user, mode: { ok: true, mode: 'free' },
    run: { id: 'ig-run', workspace_id: 'a', contact_id: 'c-a', channel_id: 'ch-a', external_user_id: user, channel_type: 'instagram',
      automation_version_id: 'ig-v', automation_id: 'auto-a', graph: JSON.stringify(graph), start_node_id: null, depth: 0 } }
  await giveCredentials(runtime, 'ch-a', { accessToken: 'TESTONLY', accountId: account, appSecret: secret, verifyToken: 'VERIFY-TEST' })
  adapter = new InstagramAdapter({ ...env, ...view })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(input).toBe(`https://graph.facebook.com/v26.0/${account}/messages`)
    expect(init!.headers).toMatchObject({ Authorization: 'Bearer TESTONLY' })
    return Response.json({ recipient_id: user, message_id: `ig.out.${vi.mocked(fetch).mock.calls.length}` })
  })
})
afterEach(() => { vi.restoreAllMocks() })

it.each(['envelope', 'item'])('preserva resposta de story na entrada %s sem confundir resposta de DM', async shape => {
  const rt = await connectionRuntime(env, 'a', 'ch-a')
  const wrap = (item: Record<string, unknown>) => shape === 'envelope' ? envelope(item) : item
  const story = wrap(incoming({ message: { mid: 'ig.story', text: 'Gostei', reply_to: { story: { id: 'story-1', url: 'https://example.com/story' } } } }))
  expect(instagramUnified.parseInbound(story, rt.connection)).toMatchObject([{ kind: 'message', storyReply: true }])
  expect(await normalizeInbound(rt, { version: 1, provider: 'meta', workspaceId: 'a', channelId: 'ch-a',
    eventId: 'ig.story', receivedAt: Date.now(), payload: story })).toMatchObject([{ kind: 'message', storyReply: true }])
  const direct = wrap(incoming({ message: { mid: 'ig.dm', text: 'Gostei', reply_to: { mid: 'ig.previous' } } }))
  const [read] = await normalizeInbound(rt, { version: 1, provider: 'meta', workspaceId: 'a', channelId: 'ch-a', eventId: 'ig.dm', receivedAt: Date.now(), payload: direct })
  expect(read).toMatchObject({ kind: 'message', text: 'Gostei' })
  expect(read).not.toHaveProperty('storyReply')
  expect(fetch).not.toHaveBeenCalled()
})

it.each([true, false])('preserva resposta de story no roteamento dm_only com distinção efetiva %s', async distinguishesStory => {
  await runtime.DB.batch([
    runtime.DB.prepare("UPDATE automations SET status='live',published_version_id='ig-v' WHERE id='auto-a'"),
    runtime.DB.prepare("UPDATE channels SET capabilities_override=? WHERE id='ch-a'")
      .bind(JSON.stringify({ inbound: { storyReply: distinguishesStory } })),
    runtime.DB.prepare(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config)
      VALUES ('ig-default','a','auto-a','ch-a','Resposta padrão','default_reply','active','every_time','{"dm_only":true}')`),
  ])
  const story = incoming({ message: { mid: 'ig.story', text: 'Gostei', reply_to: { story: { id: 'story-1' } } } })
  expect((await deliver(envelope(story)))[0].ack).toHaveBeenCalledOnce()
  expect(await count("SELECT count(*) n FROM flow_runs WHERE trigger_id='ig-default'"))
    .toBe(distinguishesStory ? 0 : 1)
  const direct = incoming({ message: { mid: 'ig.dm', text: 'Gostei' } })
  expect((await deliver(envelope(direct)))[0].ack).toHaveBeenCalledOnce()
  expect(await count("SELECT count(*) n FROM flow_runs WHERE trigger_id='ig-default'"))
    .toBe(distinguishesStory ? 1 : 2)
})

it('envia texto pelo IGSID, persiste correlação e replay não duplica rede', async () => {
  const message = { kind: 'text' as const, text: 'Texto de teste' }
  expect(await adapter.send(context, message)).toMatchObject({ ok: true, externalId: 'ig.out.1', parts: 1 })
  expect(await body()).toEqual({ recipient: { id: user }, message: { text: message.text } })
  expect(await adapter.send(context, message)).toMatchObject({ ok: true, externalId: 'ig.out.1' })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(JSON.parse((await row())!.content)).toMatchObject({ status: 'sent', instagram: { runId: 'ig-run', nodeId: 'offer' } })
})
it('divide texto Unicode respeitando os 1000 bytes sem perda de caracteres', async () => {
  const text = 'á'.repeat(501)
  expect(await adapter.send(context, { kind: 'text', text })).toMatchObject({ ok: true, parts: 2 })
  const texts = vi.mocked(fetch).mock.calls.map(call => JSON.parse(String(call[1]!.body)).message.text as string)
  expect(texts.join('')).toBe(text)
  expect(texts.every(part => new TextEncoder().encode(part).length <= 1000)).toBe(true)
})
it('button template preserva quatro opções em grupos de três e limita texto/título/payload', async () => {
  const buttons = Array.from({ length: 4 }, (_, i) => ({ type: 'postback' as const, id: `option-${i}`, title: `${i}${'a'.repeat(25)}` }))
  expect(await adapter.send(context, { kind: 'text', text: 'Escolha', buttons })).toMatchObject({ ok: true, parts: 2 })
  const payloads = vi.mocked(fetch).mock.calls.map(call => JSON.parse(String(call[1]!.body)).message.attachment)
  expect(payloads[0]).toMatchObject({ type: 'template', payload: { template_type: 'button', text: 'Escolha' } })
  expect(payloads[0].payload.buttons).toHaveLength(3)
  expect(payloads[1].payload.buttons).toHaveLength(1)
  expect(payloads.flatMap(payload => payload.payload.buttons).map(button => button.payload)).toEqual(buttons.map(button => button.id))
  expect(payloads[0].payload.buttons[0].title.length).toBeLessThanOrEqual(20)
  const fit = (id: string) => adapter.fit({ kind: 'text', text: 'Olá', buttons: [{ type: 'postback', id, title: 'Ir' }] }, adapter.capabilities())
  expect(fit('á'.repeat(500))).toHaveProperty('messages')
  expect(fit('á'.repeat(501))).toMatchObject({ reason: 'unsupported' })
  const long = adapter.fit({ kind: 'text', text: 'a'.repeat(641), buttons: buttons.slice(0, 1) }, adapter.capabilities())
  expect(long).toHaveProperty('messages')
  if ('messages' in long) expect(long.messages.every(message => message.kind !== 'text' || !message.buttons?.length || message.text.length <= 640)).toBe(true)
})
it('envia URL button e quick replies nativas com limites de treze opções', async () => {
  expect(await adapter.send(context, { kind: 'text', text: 'Link', buttons: [{ type: 'url', title: 'Abrir', url: 'https://example.com' }] })).toMatchObject({ ok: true })
  expect((await body()).message.attachment.payload.buttons).toEqual([{ type: 'web_url', title: 'Abrir', url: 'https://example.com' }])
  const quickReplies = Array.from({ length: 13 }, (_, i) => ({ id: `choice-${i}`, title: `Opção ${i}` }))
  expect(await adapter.send({ ...context, step: 2 }, { kind: 'text', text: 'Escolha', quickReplies })).toMatchObject({ ok: true })
  expect((await body()).message.quick_replies).toEqual(quickReplies.map(reply => ({ content_type: 'text', title: reply.title, payload: reply.id })))
  expect(adapter.fit({ kind: 'text', text: 'Olá', quickReplies: [...quickReplies, { id: '14', title: 'Extra' }] }, adapter.capabilities())).toMatchObject({ reason: 'unsupported' })
  expect(adapter.fit({ kind: 'text', text: 'Olá', quickReplies: [{ id: 'a'.repeat(1001), title: 'Ir' }] }, adapter.capabilities())).toMatchObject({ reason: 'unsupported' })
  expect(adapter.fit({ kind: 'text', text: 'Olá', quickReplies, buttons: [{ type: 'postback', id: 'x', title: 'Ir' }] }, adapter.capabilities())).toMatchObject({ reason: 'unsupported' })
})
it('consulta consentimento e janela reais mesmo com contexto free forjado; não usa HUMAN_AGENT para automação', async () => {
  const now = Date.now()
  expect(adapter.canSend({ optedIn: true, windowExpiresAt: now, humanWindowExpiresAt: now + 60000 }, now, 'automation')).toMatchObject({ reason: 'outside_window', canUseTemplate: false })
  expect(adapter.canSend({ optedIn: true, windowExpiresAt: null, humanWindowExpiresAt: now + 60000 }, now, 'human')).toMatchObject({ ok: true, mode: 'human_agent' })
  expect(adapter.canSend({ optedIn: true, windowExpiresAt: null, humanWindowExpiresAt: now }, now, 'human')).toMatchObject({ reason: 'outside_window' })
  await runtime.DB.prepare("UPDATE contact_channels SET window_expires_at=1 WHERE id='cc-a'").run()
  expect(await adapter.send(context, { kind: 'text', text: 'Olá' })).toMatchObject({ reason: 'outside_window' })
  await runtime.DB.prepare("UPDATE contact_channels SET opted_in=0,window_expires_at=? WHERE id='cc-a'").bind(now + 60000).run()
  expect(await adapter.send(context, { kind: 'text', text: 'Olá' })).toMatchObject({ reason: 'not_opted_in' })
  expect(fetch).not.toHaveBeenCalled()
  expect(await count('SELECT count(*) n FROM flow_outbound')).toBe(0)
})
it.each(['network', 'invalid', 'rejected'])('falha %s não confirma envio nem repete rede com resultado ambíguo', async kind => {
  if (kind === 'network') vi.mocked(fetch).mockRejectedValueOnce(new Error('sensitive'))
  else vi.mocked(fetch).mockResolvedValueOnce(Response.json(kind === 'invalid' ? { bogus: true } : { error: { code: 190, message: 'sensitive' } }, { status: kind === 'invalid' ? 200 : 401 }))
  expect(await adapter.send(context, { kind: 'text', text: 'Olá' })).toMatchObject({ ok: false, reason: kind === 'rejected' ? 'rejected' : 'uncertain' })
  // O 190 deixa a conexão com erro: a reexecução é barrada antes da rede; nos outros casos o envio fica incerto.
  expect(await adapter.send(context, { kind: 'text', text: 'Olá' })).toMatchObject(kind === 'rejected' ? { code: 'connection_unavailable' } : { reason: 'uncertain' })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect((await row())!.content).not.toContain('sensitive')
})
it('recusa da Meta grava código, subcódigo e mensagem no erro da entrega e no log, sem token', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const leaked = 'IGAAH' + 'x'.repeat(60)
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { message: `Invalid parameter (access_token=${leaked})`, type: 'OAuthException', code: 100, error_subcode: 2534014, fbtrace_id: 'AbCdEf123' } }, { status: 400 }))
  const result = await adapter.send(context, { kind: 'text', text: 'Olá' })
  expect(result).toMatchObject({ ok: false, reason: 'rejected', code: '100', meta: { code: 100, subcode: 2534014, type: 'OAuthException', traceId: 'AbCdEf123' } })
  const saved = await runtime.DB.prepare("SELECT delivery_status,delivery_error,content FROM messages WHERE source='automation'").first<{ delivery_status: string; delivery_error: string; content: string }>()
  expect(saved).toMatchObject({ delivery_status: 'failed' })
  expect(saved!.delivery_error).toContain('100')
  expect(saved!.delivery_error).toContain('2534014')
  expect(saved!.delivery_error).toContain('Invalid parameter')
  expect(JSON.stringify(saved)).not.toContain(leaked)
  expect(JSON.stringify(saved)).not.toContain('TESTONLY')
  const logged = warn.mock.calls.map(call => String(call[0])).find(line => line.includes('instagram_send_rejected'))!
  expect(JSON.parse(logged)).toMatchObject({ event: 'instagram_send_rejected', code: 100, subcode: 2534014, type: 'OAuthException', traceId: 'AbCdEf123', message: expect.stringContaining('Invalid parameter') })
  expect(logged).not.toContain(leaked)
  expect(logged).not.toContain('TESTONLY')
})
it('rate limit permite retry único e configuração/contexto incorretos não fazem rede', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { code: 4 } }, { status: 429, headers: { 'Retry-After': '2' } }))
  expect(await adapter.send(context, { kind: 'text', text: 'Olá' })).toMatchObject({ reason: 'rate_limited', retryAfterSec: 2 })
  expect(await adapter.send(context, { kind: 'text', text: 'Olá' })).toMatchObject({ ok: true })
  expect(await count("SELECT count(*) n FROM flow_outbound WHERE status='sent'")).toBe(1)
  expect(await adapter.send({ ...context, channelId: 'ch-b' }, { kind: 'text', text: 'Olá' })).toMatchObject({ code: 'context_mismatch' })
  expect(await new InstagramAdapter({ ...env, ...view, IG_ACCOUNT_ID: '999' }).send(context, { kind: 'text', text: 'Olá' })).toMatchObject({ code: 'channel_not_configured' })
  expect(fetch).toHaveBeenCalledTimes(2)
})
it('valida HMAC Instagram nos bytes originais, distingue META_APP_SECRET e preserva handshake/tamanho', async () => {
  const payload = envelope(incoming()), init = await signed(payload)
  expect((await webhooks.request('/meta', { ...init, body: init.body + ' ' }, env)).status).toBe(401)
  expect((await webhooks.request('/meta', await signed(payload, metaSecret), env)).status).toBe(401)
  expect((await webhooks.request('/meta', await signed(payload, 'wrong'), env)).status).toBe(401)
  expect(accepted).toHaveLength(0)
  // The same signed bytes go through, and the queued event reads as the message.
  expect((await webhooks.request('/meta', init, env)).status).toBe(200)
  expect(accepted).toHaveLength(1)
  expect(await normalizeInbound(await connectionRuntime(env, 'a', 'ch-a'), accepted[0])).toMatchObject([{ kind: 'message', externalUserId: user, externalMessageId: 'ig.in', text: 'quero' }])
  expect((await webhooks.request('/meta?hub.mode=subscribe&hub.verify_token=VERIFY-TEST&hub.challenge=123', {}, env)).status).toBe(200)
  expect((await webhooks.request('/meta', await signed({ object: 'instagram', padding: 'x'.repeat(MAX_WEBHOOK_BYTES) }), env)).status).toBe(413)
})
it('DM usa timestamp do provedor, dispara keyword uma vez e replay não prolonga janela', async () => {
  await runtime.DB.prepare("UPDATE automations SET status='live',published_version_id='ig-v' WHERE id='auto-a'").run()
  await runtime.DB.prepare("UPDATE keywords SET status='live' WHERE id='key-a'").run()
  await runtime.DB.prepare("UPDATE contact_channels SET window_expires_at=NULL,human_window_expires_at=NULL WHERE id='cc-a'").run()
  const at = Date.now() - 60000
  const result = await deliver(envelope(incoming({ timestamp: at })))
  expect(result[0].retry).not.toHaveBeenCalled()
  expect(result[0].ack).toHaveBeenCalledOnce()
  expect((await identity())?.window_expires_at).toBe(at + 86400000)
  expect((await identity())?.human_window_expires_at).toBe(at + 7 * 86400000)
  expect(create).toHaveBeenCalledOnce()
  await consume(...accepted.map(event => ({ ...event, receivedAt: Date.now() + 100000 })))
  expect(create).toHaveBeenCalledOnce()
  expect((await identity())?.window_expires_at).toBe(at + 86400000)
  expect(await count("SELECT count(*) n FROM messages WHERE direction='in'")).toBe(1)
})
it('primeira DM cria identidade IGSID e concede opt-in, próxima DM não desfaz opt-out', async () => {
  const other = '888888888888888'
  expect((await deliver(envelope(incoming({ sender: { id: other } }))))[0].ack).toHaveBeenCalledOnce()
  const created = await identity(other)
  expect(created).toMatchObject({ external_user_id: other, opted_in: 1 })
  expect(created!.contact_id).not.toBe('c-a')
  await runtime.DB.prepare('UPDATE contact_channels SET opted_in=0 WHERE id=?').bind(created!.id).run()
  await deliver(envelope(incoming({ sender: { id: other }, message: { mid: 'ig.next', text: 'Olá de novo' } })))
  expect(await identity(other)).toMatchObject({ id: created!.id, opted_in: 0 })
  expect(create).not.toHaveBeenCalled()
})
it.each(['quick_reply', 'postback'])('clique %s usa callback compartilhado, autoriza identidade/canal e deduplica', async kind => {
  await runtime.DB.prepare("UPDATE flow_runs SET status='waiting_click' WHERE id='ig-run'").run()
  await runtime.DB.prepare("INSERT INTO button_tokens(token,workspace_id,run_id,node_id,step_index,button_id,expires_at) VALUES (?,'a','ig-run','offer',1,'next',?)").bind(token, Date.now() + 60000).run()
  await runtime.DB.prepare("UPDATE contact_channels SET opted_in=0,window_expires_at=1 WHERE id='cc-a'").run()
  const click = kind === 'postback' ? { message: undefined, postback: { mid: 'ig.click', title: 'título não confiável', payload: `b:${token}` } }
    : { message: { mid: 'ig.click', text: 'título não confiável', quick_reply: { payload: `b:${token}` } } }
  await deliver(envelope(incoming({ ...click, sender: { id: '888888888888888' } })))
  expect(sendEvent).not.toHaveBeenCalled()
  // Each provider event has its own mid, even when a user guesses the same callback token.
  const validClick = kind === 'postback' ? { message: undefined, postback: { mid: 'ig.valid', payload: `b:${token}` } }
    : { message: { mid: 'ig.valid', text: 'título não confiável', quick_reply: { payload: `b:${token}` } } }
  const result = await deliver(envelope(incoming(validClick)))
  expect(result[0].retry).not.toHaveBeenCalled()
  expect(sendEvent).toHaveBeenCalledExactlyOnceWith({ type: 'click_1', payload: { token } })
  await consume(...accepted)
  expect(sendEvent).toHaveBeenCalledTimes(1)
  expect((await identity())?.opted_in).toBe(0)
  expect(await count("SELECT count(*) n FROM messages WHERE direction='in' AND json_extract(content,'$.text')='Continuar'")).toBe(1)
  expect(fetch).not.toHaveBeenCalled()
})
it('seen correlaciona nó original, conta read uma vez e não abre janela', async () => {
  await adapter.send(context, { kind: 'text', text: 'Olá' })
  await runtime.DB.prepare("UPDATE flow_runs SET current_node_id='another' WHERE id='ig-run'").run()
  await runtime.DB.prepare("UPDATE contact_channels SET window_expires_at=1 WHERE id='cc-a'").run()
  for (const timestamp of [Date.now(), Date.now() + 1000]) {
    const result = await deliver(envelope(seen('ig.out.1', timestamp)))
    expect(result[0].retry).not.toHaveBeenCalled()
    expect(result[0].ack).toHaveBeenCalledOnce()
  }
  const metrics = await runtime.DB.prepare("SELECT node_id,type FROM node_events WHERE flow_run_id='ig-run' ORDER BY type").all()
  expect(metrics.results).toEqual([{ node_id: 'offer', type: 'read' }])
  expect((await identity())?.window_expires_at).toBe(1)
  expect(await count("SELECT count(*) n FROM inbound_events WHERE id LIKE '%read:ig.out.1%'")).toBe(1)
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('seen adiantado fica pendente e retry após send persiste métricas sem duplicação', async () => {
  const pending = await deliver(envelope(seen()))
  expect(pending[0].retry).toHaveBeenCalledOnce()
  expect(pending[0].ack).not.toHaveBeenCalled()
  await adapter.send(context, { kind: 'text', text: 'Olá' })
  const retried = await consume(...accepted)
  expect(retried[0].ack).toHaveBeenCalledOnce()
  expect(await count("SELECT count(*) n FROM node_events WHERE type IN ('delivered','read')")).toBe(1)
})
it('seen e callbacks de outro workspace/canal não alteram o fluxo original', async () => {
  await adapter.send(context, { kind: 'text', text: 'Olá' })
  const event: InboundEvent = { version: 1, provider: 'meta', workspaceId: 'b', channelId: 'ch-b', eventId: 'read:ig.out.1', receivedAt: Date.now(), payload: seen() }
  expect((await consume(event))[0].retry).toHaveBeenCalledOnce()
  await runtime.DB.prepare("UPDATE flow_runs SET status='waiting_click' WHERE id='ig-run'").run()
  await runtime.DB.prepare("INSERT INTO button_tokens(token,workspace_id,run_id,node_id,step_index,button_id,expires_at) VALUES (?,'a','ig-run','offer',1,'next',?)").bind(token, Date.now() + 60000).run()
  await runtime.DB.prepare("UPDATE contact_channels SET external_user_id=? WHERE id='cc-b'").bind(user).run()
  const foreignClick = { ...event, eventId: 'foreign-click', payload: incoming({ recipient: { id: '111111111111111' }, message: { mid: 'foreign-click', text: 'Ir', quick_reply: { payload: `b:${token}` } } }) }
  // The valid identity must still be scoped to the owning channel/workspace.
  expect((await consume(foreignClick))[0].ack).toHaveBeenCalledOnce()
  expect(await count("SELECT count(*) n FROM node_events WHERE type='read'")).toBe(0)
  expect(await count("SELECT count(*) n FROM messages WHERE workspace_id='b'")).toBe(1) // the tap only reaches the inbox of the workspace that owns the identity
  expect(await count("SELECT count(*) n FROM messages WHERE workspace_id='a' AND direction='in'")).toBe(0)
  expect(sendEvent).not.toHaveBeenCalled()
})
it.each(['is_echo', 'is_self'])('ignora %s próprio sem opt-in, mensagens, disparos ou abertura de janela', async flag => {
  await runtime.DB.prepare("UPDATE contact_channels SET window_expires_at=1 WHERE id='cc-a'").run()
  const echo = incoming({ sender: { id: account }, recipient: { id: user }, message: { mid: 'ig.echo', text: 'quero', [flag]: true } })
  expect(await normalizeInbound(await connectionRuntime(env, 'a', 'ch-a'), { version: 1, provider: 'meta', workspaceId: 'a', channelId: 'ch-a', eventId: 'ig.echo',
    receivedAt: Date.now(), payload: echo })).toMatchObject([{ kind: 'ignored' }])
  const result = await deliver(envelope(echo))
  expect(result.every(message => message.retry.mock.calls.length === 0)).toBe(true)
  expect(await count("SELECT count(*) n FROM messages WHERE direction='in'")).toBe(0)
  expect(await identity(account)).toBeNull()
  expect((await identity())?.window_expires_at).toBe(1)
  expect(create).not.toHaveBeenCalled()
})

it('envia pela API configurada na conexão (settings.apiBase), não pela de produção', async () => {
  await runtime.DB.prepare(`UPDATE channels SET settings='{"apiBase":"https://fake-graph.test"}' WHERE id='ch-a'`).run()
  vi.mocked(fetch).mockImplementation(async input => {
    expect(String(input)).toBe(`https://fake-graph.test/v26.0/${account}/messages`)
    return Response.json({ recipient_id: user, message_id: 'ig.out.fake' })
  })
  expect(await adapter.send(context, { kind: 'text', text: 'Olá' })).toMatchObject({ ok: true, externalId: 'ig.out.fake' })
})
it('recibo de leitura grava também a coluna de entrega como lida', async () => {
  await adapter.send(context, { kind: 'text', text: 'Olá' })
  await deliver(envelope(seen('ig.out.1')))
  expect(await runtime.DB.prepare("SELECT delivery_status s FROM messages WHERE source='automation'").first<string>('s')).toBe('read')
})

// Link ig.me/<usuário>?ref=<ref> (Instagram Platform, ig.me): o ref chega no postback, na mensagem ou sozinho (conversa que já existia).
const refLink = (repeat = 'every_time') => runtime.DB.prepare(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status,repeat_mode,config)
  VALUES ('ig-ref','a','auto-a','ch-a','Link da bio','widget','messenger_ref_url','active',?,?)`).bind(repeat, JSON.stringify({ node_id: 'start', code: 'abcd2345', handle: 'oficina' }))
const refRuns = () => count("SELECT count(*) n FROM flow_runs WHERE trigger_id='ig-ref'")
const withRef = { ref: 'abcd2345', source: 'SHORTLINKS', type: 'OPEN_THREAD' }

it('lê o referral do ig.me nas três formas e mantém a mensagem', async () => {
  const rt = await connectionRuntime(env, 'a', 'ch-a')
  const parse = (item: unknown) => instagramUnified.parseInbound(envelope(item), rt.connection)
  expect(parse(incoming({ message: { mid: 'ig.r1', text: 'oi', referral: withRef } }))).toMatchObject([{ kind: 'message', text: 'oi' }, { kind: 'referral', ref: 'abcd2345' }])
  expect(parse(incoming({ message: undefined, postback: { mid: 'ig.r2', payload: 'x', referral: withRef } }))).toMatchObject([{ kind: 'click' }, { kind: 'referral', ref: 'abcd2345' }])
  expect(parse(incoming({ message: undefined, referral: withRef }))).toMatchObject([{ kind: 'referral', ref: 'abcd2345' }])
  expect(parse(incoming({ message: { mid: 'ig.r3', text: 'oi' } }))).toHaveLength(1)
})

it('mensagem aberta por link ig.me com ref inicia a automação do link, antes da palavra-chave', async () => {
  await runtime.DB.prepare("UPDATE automations SET status='live',published_version_id='ig-v' WHERE id='auto-a'").run()
  await runtime.DB.prepare("UPDATE keywords SET status='live' WHERE id='key-a'").run()
  await refLink().run()
  vi.mocked(fetch).mockImplementation(async () => Response.json({ username: 'joana', name: 'Joana Prado' }))
  await deliver(envelope(incoming({ message: { mid: 'ig.ref.1', text: 'quero', referral: withRef } })))
  expect(await refRuns()).toBe(1)
  expect(await count("SELECT count(*) n FROM flow_runs WHERE trigger_id='trg-a'")).toBe(0)
  expect(await count("SELECT count(*) n FROM trigger_impressions WHERE trigger_id='ig-ref'")).toBe(1)
})

it('referral isolado do ig.me identifica o contato mas não é mensagem: sem primeira entrada, sem opt-in e sem janela de 24 horas', async () => {
  await refLink().run()
  const stranger = '987654321099999'
  await deliver(envelope(incoming({ sender: { id: stranger }, message: undefined, timestamp: 5000, referral: withRef })))
  const cc = await runtime.DB.prepare('SELECT opted_in,window_expires_at,human_window_expires_at,first_inbound_id FROM contact_channels WHERE channel_id=? AND external_user_id=?')
    .bind("ch-a", stranger).first<{ opted_in: number; window_expires_at: number | null; human_window_expires_at: number | null; first_inbound_id: string | null }>()
  expect(cc).not.toBeNull()
  expect(cc).toMatchObject({ opted_in: 0, first_inbound_id: null })
  expect(cc!.window_expires_at ?? 0).toBe(0)
  expect(cc!.human_window_expires_at ?? 0).toBe(0)
})

it('link ig.me aberto em conversa que já existia inicia a automação do link e conta a abertura', async () => {
  await runtime.DB.prepare("UPDATE automations SET status='live',published_version_id='ig-v' WHERE id='auto-a'").run()
  await refLink().run()
  await deliver(envelope(incoming({ message: undefined, timestamp: 5000, referral: withRef })))
  expect(await refRuns()).toBe(1)
  expect(await count("SELECT count(*) n FROM trigger_impressions WHERE trigger_id='ig-ref'")).toBe(1)
  await deliver(envelope(incoming({ message: undefined, timestamp: 6000, referral: { ...withRef, ref: 'outro' } })))
  expect(await refRuns()).toBe(1)
})

it('post ou reel compartilhado no direct vira mensagem de compartilhamento (Share to DM)', async () => {
  const rt = await connectionRuntime(env, 'a', 'ch-a')
  const shared = envelope(incoming({ message: { mid: 'ig.share', attachments: [{ type: 'ig_reel', payload: { url: 'https://instagram.example/reel/1' } }] } }))
  expect(instagramUnified.parseInbound(shared, rt.connection)).toMatchObject([{ kind: 'message', shared: { url: 'https://instagram.example/reel/1' } }])
  expect(await normalizeInbound(rt, { version: 1, provider: 'meta', workspaceId: 'a', channelId: 'ch-a', eventId: 'ig.share', receivedAt: Date.now(), payload: shared }))
    .toMatchObject([{ kind: 'message', shared: { url: 'https://instagram.example/reel/1' } }])
})

it('mensagem aberta por anúncio no Instagram carrega a origem do anúncio', async () => {
  const rt = await connectionRuntime(env, 'a', 'ch-a')
  const body = envelope(incoming({ message: { mid: 'ig.ad', text: 'Oi', referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: '120330000000002', ads_context_data: { ad_title: 'Promo' } } } }))
  expect(instagramUnified.parseInbound(body, rt.connection)).toMatchObject([{ kind: 'message', origin: { kind: 'ad', sourceId: '120330000000002', headline: 'Promo' } }])
})


// messaging-api.md: 'Media types and specifications', 'Send Images' e 'Send audio, video or file'
const igMedia = { image: 'https://cdn.example.com/a.png', audio: 'https://cdn.example.com/a.m4a', video: 'https://cdn.example.com/a.mp4', file: 'https://cdn.example.com/a.pdf' } as const
it.each(Object.entries(igMedia))('envia %s por URL no formato da doc', async (media, url) => {
  const kind = media as keyof typeof igMedia
  expect(await adapter.send(context, { kind: 'media', media: kind, url })).toMatchObject({ ok: true, parts: 1 })
  const attachment = { type: kind, payload: { url } }
  expect(await body()).toEqual({ recipient: { id: user }, message: kind === 'image' ? { attachments: [attachment] } : { attachment } })
})
it('mídia fora da janela de 24h volta outside_window e a ficha expõe os 4 tipos', async () => {
  await runtime.DB.prepare("UPDATE contact_channels SET window_expires_at=1 WHERE id='cc-a'").run()
  expect(await adapter.send(context, { kind: 'media', media: 'video', url: igMedia.video })).toMatchObject({ reason: 'outside_window' })
  expect(fetch).not.toHaveBeenCalled()
  expect(providers.instagram_unified.patch).not.toHaveProperty('media')
  const media = capabilities('instagram').media
  expect(Object.keys(media).sort()).toEqual(['audio', 'file', 'image', 'video'])
  expect(media.file).toEqual({ maxBytes: 25e6, mime: ['application/pdf'] })
})
it('legenda e botões viram mensagem de texto depois da mídia; tipo ou tamanho fora da doc é recusado', () => {
  const rt = capabilities('instagram')
  const fitted = instagramUnified.fit({ kind: 'media', media: 'image', url: igMedia.image, caption: 'Olha', buttons: [{ type: 'url', title: 'Abrir', url: 'https://example.com' }] }, rt)
  expect(fitted).toMatchObject({ messages: [{ kind: 'media', media: 'image' }, { kind: 'text', text: 'Olha', buttons: [{ title: 'Abrir' }] }] })
  expect((fitted as { messages: Array<{ caption?: string }> }).messages[0].caption).toBeUndefined()
  expect(instagramUnified.fit({ kind: 'media', media: 'image', url: igMedia.image, size: 9e6 }, rt)).toMatchObject({ ok: false, reason: 'unsupported' })
  expect(instagramUnified.fit({ kind: 'media', media: 'file', url: igMedia.file, mime: 'application/zip' }, rt)).toMatchObject({ ok: false, reason: 'unsupported' })
})
