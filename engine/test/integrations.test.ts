import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { webhooks, MAX_WEBHOOK_BYTES, type InboundEvent, type IntegrationEnv } from '../src/integrations'
import { cleanupInbound, consumeInbound } from '../src/jobs'
import { giveCredentials, testKeyring } from './credentials'
import { seed } from './fixtures'

beforeEach(async () => {
  await seed()
  await env.DB.batch(['a', 'b'].map((ws) => env.DB.prepare(
    "INSERT INTO channels (id,workspace_id,type,external_id) VALUES (?,?,'telegram',?)",
  ).bind(`tg-${ws}`, ws, `bot-${ws}`)))
  // Each connection holds its own secrets, encrypted; the Worker environment holds none.
  await giveCredentials(env, 'tg-a', { botToken: 'TESTONLY', webhookSecret: secret })
  await giveCredentials(env, 'tg-b', { botToken: 'TESTONLY', webhookSecret: 'secret-of-b' })
  for (const id of ['ch-a', 'ch-b']) await giveCredentials(env, id, { accessToken: 'TESTONLY', accountId: `external-${id.slice(-1)}`, appSecret: secret, verifyToken: secret })
})
const secret = 'local-webhook-secret'
function testEnv(send = vi.fn(async (_body: InboundEvent) => {})): IntegrationEnv {
  return { DB: env.DB, ...testKeyring, INBOUND: { send } as unknown as Queue<InboundEvent> }
}
function telegram(body: unknown = { update_id: 1, message: { text: 'Teste inventado' } }, token = secret) {
  return { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': token }, body: JSON.stringify(body) }
}
async function meta(body: string, key = secret) {
  const cryptoKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(body))
  const hex = Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, '0')).join('')
  return { method: 'POST', body, headers: { 'x-hub-signature-256': `sha256=${hex}` } }
}
function message(body: unknown, attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn(), id: crypto.randomUUID(), timestamp: new Date() }
}
function batch(...messages: ReturnType<typeof message>[]): MessageBatch<unknown> {
  return { messages, queue: 'inbound', metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } }, ackAll() {}, retryAll() {} }
}
const envelope = (overrides: Partial<InboundEvent> = {}): InboundEvent => ({
  version: 1, provider: 'telegram', workspaceId: 'a', channelId: 'tg-a', eventId: '123',
  receivedAt: Date.now(), payload: { update_id: 123 }, ...overrides,
})

it('Telegram autentica secret, valida payload e resolve canal sem confiar em workspace cliente', async () => {
  const bindings = testEnv()
  const send = vi.mocked(bindings.INBOUND!.send)
  expect((await webhooks.request('/telegram', telegram(undefined, 'errado'), bindings)).status).toBe(401)
  expect((await webhooks.request('/telegram', telegram({ update_id: 'inválido' }), bindings)).status).toBe(400)
  expect(send).not.toHaveBeenCalled()
  const request = telegram()
  request.headers = { ...request.headers, 'x-workspace': 'b' } as typeof request.headers
  expect((await webhooks.request('/telegram', request, bindings)).status).toBe(200)
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'a', channelId: 'tg-a', eventId: '1' }))
  // Each bot has its own secret: the secret alone picks the connection (and its workspace).
  expect((await webhooks.request('/telegram', telegram(undefined, 'secret-of-b'), bindings)).status).toBe(200)
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: 'b', channelId: 'tg-b' }))
  expect((await webhooks.request('/telegram', { method: 'POST', body: '{}' }, bindings)).status).toBe(401)
  await env.DB.prepare("UPDATE channels SET status='disconnected' WHERE id='tg-b'").run()
  expect((await webhooks.request('/telegram', telegram(undefined, 'secret-of-b'), bindings)).status).toBe(401)
})

it('não confirma webhook antes da aceitação da fila e limita bytes sem content-length', async () => {
  const bindings = testEnv(vi.fn(async () => { throw new Error('Queue indisponível') }))
  expect((await webhooks.request('/telegram', telegram(), bindings)).status).toBe(503)
  expect((await webhooks.request('/telegram', telegram({ update_id: 1, text: 'x'.repeat(MAX_WEBHOOK_BYTES) }), testEnv())).status).toBe(413)
})

it('Meta valida HMAC sobre bytes originais e handshake; usa mapeamento de canal assinado', async () => {
  const bindings = testEnv()
  const body = JSON.stringify({ object: 'instagram', entry: [{ id: 'external-b', messaging: [{ message: { mid: 'm-1', text: 'Olá' } }] }] })
  expect((await webhooks.request('/meta?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=123', {}, bindings)).status).toBe(403)
  expect(await (await webhooks.request(`/meta?hub.mode=subscribe&hub.verify_token=${secret}&hub.challenge=123`, {}, bindings)).text()).toBe('123')
  expect((await webhooks.request('/meta', await meta(body, 'errado'), bindings)).status).toBe(401)
  const signed = await meta(body)
  expect((await webhooks.request('/meta', { ...signed, body: body + ' ' }, bindings)).status).toBe(401)
  expect((await webhooks.request('/meta', signed, bindings)).status).toBe(200)
  expect(bindings.INBOUND!.send).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'b', channelId: 'ch-b', eventId: 'm-1' }))
  const missing = JSON.stringify({ object: 'instagram', entry: [{ id: 'unknown', messaging: [{ message: { mid: 'm-1' } }] }] })
  // No connection holds this account, so no secret can prove the delivery.
  expect((await webhooks.request('/meta', await meta(missing), bindings)).status).toBe(401)
  expect((await webhooks.request('/meta', await meta('{'), bindings)).status).toBe(400)
})

it('Meta faz retry de lote parcialmente enviado e consumer deduplica sem perder outros eventos', async () => {
  const accepted: InboundEvent[] = []
  let fail = true
  const bindings = testEnv(vi.fn(async (event) => {
    if (event.eventId === 'm-2' && fail) throw new Error('Falhou')
    accepted.push(event)
  }))
  const body = JSON.stringify({ object: 'instagram', entry: [{ id: 'external-a', messaging: [
    { message: { mid: 'm-1' } }, { message: { mid: 'm-2' } },
  ] }] })
  expect((await webhooks.request('/meta', await meta(body), bindings)).status).toBe(503)
  fail = false
  expect((await webhooks.request('/meta', await meta(body), bindings)).status).toBe(200)
  expect(accepted).toHaveLength(3)
  const messages = accepted.map((event) => message(event))
  await consumeInbound(batch(...messages), bindings)
  expect(messages.every((m) => m.ack.mock.calls.length === 1 && m.retry.mock.calls.length === 0)).toBe(true)
  expect(await env.DB.prepare('SELECT count(*) AS count FROM inbound_events WHERE workspace_id = ?').bind('a').first('count')).toBe(2)
})

it('consumer mantém IDs por canal, escopo workspace e pendência real de execução', async () => {
  const messages = [message(envelope()), message(envelope()), message(envelope({ workspaceId: 'b', channelId: 'tg-b' })),
    message(envelope({ workspaceId: 'b' })), message({ invalid: true })]
  await consumeInbound(batch(...messages), { DB: env.DB })
  expect(messages.slice(0, 3).every((m) => m.ack.mock.calls.length === 1)).toBe(true)
  expect(messages.slice(3).every((m) => m.retry.mock.calls.length === 1 && m.ack.mock.calls.length === 0)).toBe(true)
  const rows = await env.DB.prepare('SELECT workspace_id,processed_at FROM inbound_events ORDER BY workspace_id').all()
  expect(rows.results).toEqual([{ workspace_id: 'a', processed_at: null }, { workspace_id: 'b', processed_at: null }])
})

it('consumer reenvia erro temporário de D1 e Cron mantém pendências e remove apenas processados antigos', async () => {
  const failed = message(envelope(), 12)
  await consumeInbound(batch(failed), { DB: { prepare() { throw new Error('D1 unavailable') } } as unknown as D1Database })
  expect(failed.ack).not.toHaveBeenCalled()
  expect(failed.retry).toHaveBeenCalledWith({ delaySeconds: 256 })
  const now = Date.now()
  const old = now - 31 * 86400000
  await consumeInbound(batch(message(envelope({ receivedAt: old })), message(envelope({ eventId: '124', receivedAt: old })),
    message(envelope({ eventId: '125', receivedAt: now }))), { DB: env.DB })
  await env.DB.prepare('UPDATE inbound_events SET processed_at = ? WHERE workspace_id = ? AND id IN (?,?)')
    .bind(now, 'a', JSON.stringify(['telegram', 'tg-a', '123']), JSON.stringify(['telegram', 'tg-a', '125'])).run()
  await cleanupInbound({ DB: env.DB }, now)
  const rows = await env.DB.prepare('SELECT id FROM inbound_events ORDER BY id').all<{ id: string }>()
  expect(rows.results.map((row) => JSON.parse(row.id)[2])).toEqual(['124', '125'])
})


it('Meta recusa entrega de página sem conexão que a prove, sem enfileirar, e recusa objeto desconhecido', async () => {
  const bindings = testEnv()
  const page = JSON.stringify({ object: 'page', entry: [{ id: 'page-a', messaging: [{ message: { mid: 'm-9', text: 'Olá' } }] }] })
  const response = await webhooks.request('/meta', await meta(page), bindings)
  expect(response.status).toBe(401)
  expect(bindings.INBOUND!.send).not.toHaveBeenCalled()
  expect((await webhooks.request('/meta', await meta(JSON.stringify({ object: 'user', entry: [] })), bindings)).status).toBe(400)
})

it('WhatsApp resolve phone_number_id e preserva mensagem e transições de status distintas', async () => {
  await env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('wa-a','a','whatsapp','phone-a')").run()
  await giveCredentials(env, 'wa-a', { accessToken: 'TESTONLY', phoneNumberId: 'phone-a', appSecret: secret })
  const bindings = testEnv()
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba-a', changes: [
    { field: 'messages', value: { metadata: { phone_number_id: 'phone-a' }, messages: [{ id: 'wamid.1', text: { body: 'Olá' } }],
      statuses: [{ id: 'wamid.1', status: 'sent', timestamp: '100' }, { id: 'wamid.1', status: 'delivered', timestamp: '101' }] } },
  ] }] })
  expect((await webhooks.request('/meta', await meta(body), bindings)).status).toBe(200)
  const sent = vi.mocked(bindings.INBOUND!.send).mock.calls.map(([event]) => event)
  expect(sent).toHaveLength(3)
  expect(new Set(sent.map((event) => event.eventId)).size).toBe(3)
  expect(sent.every((event) => event.workspaceId === 'a' && event.channelId === 'wa-a')).toBe(true)
  await consumeInbound(batch(...sent.map((event) => message(event))), bindings)
  expect(await env.DB.prepare('SELECT count(*) FROM inbound_events WHERE workspace_id = ?').bind('a').first('count(*)')).toBe(3)
})
