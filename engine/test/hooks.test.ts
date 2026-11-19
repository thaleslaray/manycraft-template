import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { hooks } from '../src/channels/core/hooks'
import { normalizeInbound } from '../src/channels/core/inbound'
import { connectionRuntime } from '../src/channels/core/runtime'
import { MAX_WEBHOOK_BYTES, webhooks, type InboundEvent, type IntegrationEnv } from '../src/integrations'
import { consumeInbound } from '../src/jobs'
import { giveCredentials, testKeyring } from './credentials'
import { seed } from './fixtures'

const secret = 'local-webhook-secret'
afterEach(() => vi.restoreAllMocks())
beforeEach(async () => {
  await seed()
  await env.DB.batch(['a', 'b'].map(ws => env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES (?,?,'telegram',?)").bind(`tg-${ws}`, ws, `bot-${ws}`)))
  await giveCredentials(env, 'tg-a', { botToken: 'TESTONLY', webhookSecret: secret })
  await giveCredentials(env, 'tg-b', { botToken: 'TESTONLY', webhookSecret: 'secret-of-b' })
})
function bindings() {
  const send = vi.fn(async (_: InboundEvent) => {})
  return { send, env: { DB: env.DB, INBOUND: { send } as unknown as Queue<InboundEvent>, ...testKeyring } satisfies IntegrationEnv }
}
const update = { update_id: 41, message: { message_id: 5, from: { id: 100, first_name: 'Ana' }, chat: { id: 100, type: 'private' }, text: 'quero' } }
const post = (body: unknown, token = secret) => ({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': token }, body: JSON.stringify(body) })

it('rota única da conexão: verifica, interpreta e enfileira com a chave do evento', async () => {
  const { send, env: e } = bindings()
  expect((await hooks.request('/tg-a', post(update), e)).status).toBe(200)
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'a', channelId: 'tg-a', eventId: '41', provider: 'telegram' }))
})
it('rota única: segredo errado 401, conexão de outro workspace ou inexistente 404 sem verificar, corpo grande 413, GET 400', async () => {
  const { send, env: e } = bindings()
  expect((await hooks.request('/tg-a', post(update, 'errado'), e)).status).toBe(401)
  expect((await hooks.request('/nao-existe', post(update), e)).status).toBe(404)
  await env.DB.prepare("UPDATE channels SET status='disconnected' WHERE id='tg-b'").run()
  expect((await hooks.request('/tg-b', post(update), e)).status).toBe(404)
  expect((await hooks.request('/tg-a', post({ update_id: 1, pad: 'x'.repeat(MAX_WEBHOOK_BYTES) }), e)).status).toBe(413)
  expect((await hooks.request('/tg-a', { method: 'GET' }, e)).status).toBe(400)
  expect(send).not.toHaveBeenCalled()
})
it('rota antiga repassa para o mesmo caminho: mesmo evento nas duas rotas gera uma só linha de entrada', async () => {
  const { send, env: e } = bindings()
  expect((await webhooks.request('/telegram', post(update), e)).status).toBe(200)
  expect((await hooks.request('/tg-a', post(update), e)).status).toBe(200)
  expect(send).toHaveBeenCalledTimes(2)
  expect(send.mock.calls[0][0]).toMatchObject({ channelId: 'tg-a', eventId: '41', workspaceId: 'a', provider: 'telegram', payload: update })
  expect(send.mock.calls[1][0]).toMatchObject({ channelId: 'tg-a', eventId: '41', workspaceId: 'a', provider: 'telegram', payload: update })
  const batch = { messages: send.mock.calls.map(([body]) => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn(), id: crypto.randomUUID(), timestamp: new Date() })),
    queue: 'inbound', metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } }, ackAll() {}, retryAll() {} } as unknown as MessageBatch<unknown>
  await consumeInbound(batch, { DB: env.DB })
  expect(await env.DB.prepare('SELECT count(*) AS n FROM inbound_events WHERE channel_id=?').bind('tg-a').first('n')).toBe(1)
  // Who wrote is stored at ingestion, so erasure does not need the payload layout.
  expect(await env.DB.prepare('SELECT external_user_id FROM inbound_events WHERE channel_id=?').bind('tg-a').first('external_user_id')).toBe('100')
})
it('Telegram: a rota confere o segredo e a fila lê só conversas privadas de pessoas, com o clique e seu token de confirmação', async () => {
  const { send, env: e } = bindings()
  const pending: Promise<void>[] = []
  const ctx = { waitUntil: (p: Promise<void>) => pending.push(p), passThroughOnException() {}, props: {} }
  const ack = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true, result: true }))
  const callback = { update_id: 42, callback_query: { id: 'callback-1', from: { id: 100 }, data: `b:${'a'.repeat(24)}`, message: { chat: { id: 100, type: 'private' } } } }
  expect((await hooks.request('/tg-a', post(callback, 'errado'), e, ctx)).status).toBe(401)
  expect(send).not.toHaveBeenCalled()
  expect((await hooks.request('/tg-a', post(callback), e, ctx)).status).toBe(200)
  await Promise.all(pending)
  expect(ack).toHaveBeenCalledWith('https://api.telegram.org/botTESTONLY/answerCallbackQuery', expect.any(Object))
  // What the queue consumer reads, with the same runtime it builds (core/inbound.ts).
  const rt = await connectionRuntime(e, 'a', 'tg-a', { secrets: false })
  expect(await normalizeInbound(rt, send.mock.calls[0][0])).toEqual([{ kind: 'click', externalUserId: '100', payload: callback.callback_query.data, ackToken: 'callback-1' }])
  const queued = (payload: Record<string, unknown> & { update_id: number }): InboundEvent => ({ version: 1, provider: 'telegram', workspaceId: 'a', channelId: 'tg-a',
    eventId: String(payload.update_id), receivedAt: Date.now(), payload })
  expect(await normalizeInbound(rt, queued({ update_id: 2, message: { message_id: 3, from: { id: 100 }, chat: { id: 100, type: 'private' }, text: 'Olá' } })))
    .toEqual([{ kind: 'message', externalUserId: '100', externalMessageId: '3', text: 'Olá' }])
  expect(await normalizeInbound(rt, queued({ update_id: 3, message: { message_id: 4, from: { id: 100 }, chat: { id: -1, type: 'group' } } }))).toMatchObject([{ kind: 'ignored' }])
  expect(await normalizeInbound(rt, queued({ update_id: 4, message: { message_id: 5, from: { id: 100, is_bot: true }, chat: { id: 100, type: 'private' }, text: 'Olá' } })))
    .toMatchObject([{ kind: 'ignored' }])
  // Without a readable update_id nothing can key the event: refused before the queue.
  expect((await hooks.request('/tg-a', post({ update_id: 'invalid' }), e, ctx)).status).toBe(400)
  expect(send).toHaveBeenCalledTimes(1)
})
it('fila indisponível não confirma o webhook', async () => {
  const { env: e } = bindings()
  e.INBOUND = { send: async () => { throw new Error('fila') } } as unknown as Queue<InboundEvent>
  expect((await hooks.request('/tg-a', post(update), e)).status).toBe(503)
})

it('envio humano e entrada gravam a conexão usada e o estado de entrega', async () => {
  const { ensureConversation } = await import('../src/inbox/service')
  const { deliverHuman } = await import('../src/channels/core/delivery')
  const { connectionRuntime } = await import('../src/channels/core/runtime')
  await env.DB.prepare("UPDATE channels SET type='telegram' WHERE id='ch-a'").run()
  const conversationId = await ensureConversation(env, 'a', 'c-a', 'ch-a')
  await giveCredentials(env, 'ch-a', { botToken: 'TESTONLY', webhookSecret: 'secret-of-ch-a' })
  const e = { ...bindings().env, DB: env.DB }
  const fake = vi.spyOn(globalThis, 'fetch')
  fake.mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 9 } }))
  const rt = await connectionRuntime(e, 'a', 'ch-a')
  const sent = await deliverHuman(e, { connection: rt.connection, provider: rt.provider, credentials: rt.credentials },
    { workspaceId: 'a', conversationId, contactId: 'c-a', externalUserId: 'user-a', text: 'Oi' })
  expect(sent.ok).toBe(true)
  expect(await env.DB.prepare("SELECT connection_id,delivery_status,delivery_error FROM messages WHERE conversation_id=? AND json_extract(content,'$.sender')='human'").bind(conversationId).first()).toEqual({ connection_id: 'ch-a', delivery_status: 'sent', delivery_error: null })
  fake.mockRestore()
})
