import { afterEach, expect, it, vi } from 'vitest'
import { channelAdapter, type ContactChannelState, type OutboundMessage, type SendContext } from '../src/channels'
import { webhooks, type IntegrationEnv } from '../src/integrations'
import { encryptCredentials } from '../src/channels/core/crypto'
import { testKeyring } from './credentials'

const env = { DB: {} as D1Database, TELEGRAM_BOT_TOKEN: 'TESTONLY', TELEGRAM_CHANNEL_ID: 'tg-a', TELEGRAM_WEBHOOK_SECRET: 'test-secret' }
// The connection row the (fake) database hands the legacy route: its credentials are sealed, as in production.
const sealed = await encryptCredentials(testKeyring, { workspaceId: 'a', connectionId: 'tg-a' }, { botToken: 'TESTONLY', webhookSecret: 'test-secret' })
const connectionRow = { id: 'tg-a', workspace_id: 'a', type: 'telegram', provider: 'telegram_bot', external_id: 'bot', display_name: null, connection_state: 'connected',
  settings: '{}', capabilities_override: null, credentials_ciphertext: sealed.ciphertext, credentials_iv: sealed.iv, credentials_key_version: sealed.keyVersion }
const fakeDb = (row: unknown) => ({ prepare: () => ({ bind: () => ({ first: async () => row }) }) }) as unknown as D1Database
const open: ContactChannelState = { optedIn: true, windowExpiresAt: 100_000, humanWindowExpiresAt: 200_000 }
const closed = { ...open, windowExpiresAt: 1 }
const context: SendContext = { runId: 'run', step: 0, part: 0, channelId: 'tg-a', externalUserId: '100', mode: { ok: true, mode: 'free' },
  run: { id: 'run', workspace_id: 'a', contact_id: 'c', channel_id: 'tg-a', channel_type: 'telegram', automation_version_id: 'v',
    automation_id: 'auto', graph: '{}', start_node_id: null, depth: 0, external_user_id: '100' } }
const callback = { update_id: 1, callback_query: { id: 'callback-1', from: { id: 100 }, data: `b:${'a'.repeat(24)}`,
  message: { chat: { id: 100, type: 'private' } } } }
/** The legacy Telegram route with a valid secret, as the bot delivers it; `pending` collects what the route leaves running (the ACK). */
function deliverTelegram(body: unknown, pending: Promise<void>[], send = vi.fn(async () => {})) {
  const bindings: IntegrationEnv = { ...testKeyring, DB: fakeDb(connectionRow), INBOUND: { send } as unknown as Queue }
  return webhooks.request('/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test-secret' }, body: JSON.stringify(body) },
    bindings, { waitUntil: (p: Promise<void>) => pending.push(p), passThroughOnException() {}, props: {} })
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it.each([
  ['telegram', 4096, 'chars', 10, null, 'telegram_id'], ['instagram', 1000, 'bytes', 3, 24, 'igsid'],
  ['messenger', 2000, 'chars', 3, 24, 'psid'], ['whatsapp', 4096, 'chars', 3, 24, 'bsuid'],
  ['tiktok', 1000, 'chars', 3, 48, 'tiktok_id'],
  ['email', 100_000, 'chars', 10, null, 'email'],
])('registra %s com os limites aprovados', (type, max, unit, buttons, window, identity) => {
  const caps = channelAdapter(String(type), env).capabilities()
  expect(caps.text).toMatchObject({ maxLength: max, unit })
  expect(caps.buttons.maxPerMessage).toBe(buttons)
  expect(caps.window?.standardHours ?? null).toBe(window)
  expect(caps.identity.key).toBe(identity)
})
it('não inventa capacidades confirmadas nem deixa consumidores alterar o registro', () => {
  const tg = channelAdapter('telegram', env)
  const caps = tg.capabilities()
  caps.buttons.maxPerMessage = 999
  expect(tg.capabilities().buttons.maxPerMessage).toBe(10)
  expect(tg.capabilities().quickReplies).toBeNull()
  expect(channelAdapter('messenger', env).capabilities().verified.textMax).toBe(false)
  expect(channelAdapter('tiktok', env).capabilities().text.linksClickable).toBe(false)
  expect(channelAdapter('email', env).capabilities().inbound).toMatchObject({ message: true, emailOpenClick: true })
  expect(channelAdapter('whatsapp', env).capabilities().identity.phoneGuaranteed).toBe(false)
  expect(() => channelAdapter('unknown', env)).toThrow('No channel adapter registered')
  expect(() => channelAdapter('toString', env)).toThrow('No channel adapter registered')
})
it.each(['tiktok'])('%s permanece stub tipado sem rede', async type => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network must never be used'))
  const adapter = channelAdapter(type, env)
  expect(await adapter.send(context, { kind: 'text', text: 'Olá' })).toMatchObject({ ok: false, reason: 'unsupported' })
  expect(fetch).not.toHaveBeenCalled()
})
it.each(['telegram', 'instagram', 'messenger', 'whatsapp', 'tiktok', 'email'])('%s aplica opt-in e bloqueio antes da janela', type => {
  const adapter = channelAdapter(type, env)
  expect(adapter.canSend({ ...open, optedIn: false }, 1000, 'automation')).toEqual({ ok: false, reason: 'not_opted_in' })
  expect(adapter.canSend({ ...open, blocked: true }, 1000, 'human')).toEqual({ ok: false, reason: 'blocked' })
})
it('janela humana nunca autoriza automação ou broadcast; WhatsApp só indica template', () => {
  for (const type of ['instagram', 'messenger']) {
    const adapter = channelAdapter(type, env)
    expect(adapter.canSend(closed, 1000, 'human')).toEqual({ ok: true, mode: 'human_agent' })
    expect(adapter.canSend(closed, 1000, 'automation')).toMatchObject({ ok: false, reason: 'outside_window' })
    expect(adapter.canSend(closed, 1000, 'broadcast')).toMatchObject({ ok: false, reason: 'outside_window' })
  }
  expect(channelAdapter('whatsapp', env).canSend(closed, 1000, 'automation')).toMatchObject({ ok: false, reason: 'outside_window', canUseTemplate: true })
  expect(channelAdapter('telegram', env).canSend(closed, 1000, 'automation')).toEqual({ ok: true, mode: 'free' })
  expect(channelAdapter('tiktok', env).canSend({ ...open, windowMessagesSent: 10 }, 1000, 'automation')).toEqual({ ok: false, reason: 'window_message_cap' })
  expect(channelAdapter('tiktok', env).canSend({ ...open, windowMessagesSent: 9 }, 1000, 'automation')).toEqual({ ok: true, mode: 'free' })
  expect(channelAdapter('instagram', env).canSend({ ...open, windowExpiresAt: 1000, humanWindowExpiresAt: 1000 }, 1000, 'human')).toMatchObject({ ok: false, reason: 'outside_window' })
})
it('Instagram não usa resposta privada não implementada para contornar a janela', () => {
  const adapter = channelAdapter('instagram', env)
  const comment = { ...closed, commentReply: { commentId: 'comment', createdAt: 1000, used: false } }
  expect(adapter.canSend(comment, 1000, 'automation')).toMatchObject({ reason: 'outside_window' })
  expect(adapter.canSend({ ...comment, commentReply: { ...comment.commentReply, used: true } }, 1000, 'automation')).toMatchObject({ reason: 'outside_window' })
  expect(adapter.canSend(comment, 1000 + 7 * 86400000, 'automation')).toMatchObject({ reason: 'outside_window' })
})
it.each(['telegram', 'instagram'])('fit %s divide sem perder Unicode e põe os botões no último texto', type => {
  const adapter = channelAdapter(type, env), caps = adapter.capabilities()
  const text = '😀 Olá.\n'.repeat(1300)
  const message: OutboundMessage = { kind: 'text', text, buttons: [{ type: 'postback', id: 'short-token', title: 'Continuar' }] }
  const before = structuredClone(message)
  const fit = adapter.fit(message, caps)
  expect('ok' in fit).toBe(false)
  if ('ok' in fit) throw new Error('Expected fitted message')
  expect(fit.messages.every(m => m.kind === 'text')).toBe(true)
  const parts = fit.messages as Extract<OutboundMessage, { kind: 'text' }>[]
  expect(parts.map(m => m.text).join('')).toBe(text)
  for (const part of parts) expect(caps.text.unit === 'bytes' ? new TextEncoder().encode(part.text).length : [...part.text].length).toBeLessThanOrEqual(caps.text.maxLength)
  expect(parts.slice(0, -1).every(m => !m.buttons?.length)).toBe(true)
  expect(parts.at(-1)?.buttons).toEqual(message.buttons)
  expect(fit.degraded).toContainEqual({ kind: 'text_split', parts: parts.length })
  expect(message).toEqual(before)
})
it('fit limita botões, payload UTF-8, URLs e tipos sem descartar ações', () => {
  const adapter = channelAdapter('telegram', env), caps = adapter.capabilities()
  const buttons = Array.from({ length: 12 }, (_, i) => ({ type: 'postback' as const, id: `b:${i}`, title: `Opção ${i}` }))
  const fit = adapter.fit({ kind: 'text', text: 'Escolha', buttons }, caps)
  if ('ok' in fit) throw new Error('Expected fitted message')
  expect(fit.messages.map(m => m.kind === 'text' ? m.buttons?.length : 0)).toEqual([10, 2])
  expect(fit.degraded).toContainEqual({ kind: 'buttons_split', from: 12, messages: 2 })
  for (const button of [{ type: 'postback' as const, id: 'é'.repeat(33), title: 'Opção' },
    { type: 'call' as const, phone: '+551100000000', title: 'Ligar' }, { type: 'url' as const, url: 'javascript:alert(1)', title: 'Abrir' }]) {
    expect(adapter.fit({ kind: 'text', text: 'Escolha', buttons: [button] }, caps)).toMatchObject({ ok: false, reason: 'unsupported' })
  }
})
it('fit degrada quick replies Telegram para botões e informa truncamento de título', () => {
  const adapter = channelAdapter('telegram', env)
  const fit = adapter.fit({ kind: 'text', text: 'Escolha', quickReplies: [{ id: 'a', title: 'A'.repeat(80) }] }, adapter.capabilities())
  if ('ok' in fit) throw new Error('Expected fitted message')
  expect(fit.degraded).toContainEqual({ kind: 'quick_replies_to_buttons' })
  expect(fit.degraded).toContainEqual({ kind: 'text_truncated', at: 60 })
  expect(fit.messages[0]).toMatchObject({ buttons: [{ type: 'postback', id: 'a', title: 'A'.repeat(59) + '…' }] })
})
it('ACK pendente começa antes da fila e não impede a resposta do webhook', async () => {
  const order: string[] = []
  let release!: (response: Response) => void
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
    order.push('ack')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(String(init?.body))).toEqual({ callback_query_id: 'callback-1' })
    return new Promise(resolve => { release = resolve })
  })
  const pending: Promise<void>[] = []
  expect((await deliverTelegram(callback, pending, vi.fn(async () => { order.push('queue') }))).status).toBe(200)
  expect(order).toEqual(['ack', 'queue'])
  expect(fetch).toHaveBeenCalledTimes(1)
  release(Response.json({ ok: true }))
  await Promise.all(pending)
})
it('ACK tem timeout de 1s e sua falha não provoca erro ou retry', async () => {
  vi.useFakeTimers()
  const pending: Promise<void>[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true })
  }))
  // AbortSignal.timeout is a runtime timer; assert its explicit budget without relying on a real second.
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    expect(ms).toBe(1000)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), ms)
    return controller.signal
  })
  const send = vi.fn(async () => {})
  expect((await deliverTelegram(callback, pending, send)).status).toBe(200)
  expect(send).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1000)
  await expect(Promise.all(pending)).resolves.toEqual([undefined])
  expect(timeout).toHaveBeenCalledTimes(1)
  vi.useRealTimers()
})
it('webhook não reconhece clique sem autenticação e clique sem id não faz rede', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
  expect((await webhooks.request('/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' },
    body: JSON.stringify(callback) }, { ...testKeyring, DB: fakeDb(null), INBOUND: {} as Queue })).status).toBe(401)
  // Without a callback id there is nothing to acknowledge: the update is still queued (and read as ignored), with no ACK.
  const pending: Promise<void>[] = [], send = vi.fn(async () => {})
  expect((await deliverTelegram({ update_id: 2, callback_query: { ...callback.callback_query, id: '' } }, pending, send)).status).toBe(200)
  expect(send).toHaveBeenCalledOnce()
  expect(pending).toEqual([])
  expect(fetch).not.toHaveBeenCalled()
})
