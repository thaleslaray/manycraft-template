import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { hooks, legacyHooks } from '../src/channels/core/hooks'
import { upsertContact } from '../src/channels/core/identity'
import { normalizeInbound } from '../src/channels/core/inbound'
import { metaWhatsappCloud } from '../src/channels/meta-whatsapp-cloud'
import { telegramBot } from '../src/channels/telegram-bot'
import { webhooks, type InboundEvent, type IntegrationEnv } from '../src/integrations'
import { giveCredentials, testKeyring } from './credentials'
import { seed } from './fixtures'

const appSecret = 'APP-SECRET', verify = 'VERIFY-TOKEN'
beforeEach(async () => {
  await seed()
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('wa-a','a','whatsapp','phone-a')"),
    env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('tg-a','a','telegram','bot-a')"),
  ])
  await giveCredentials(env, 'wa-a', { accessToken: 'TESTONLY', phoneNumberId: 'phone-a', appSecret, webhookSecret: verify })
})
afterEach(() => vi.restoreAllMocks())
function bindings() {
  const send = vi.fn(async (_: InboundEvent) => {})
  return { send, env: { DB: env.DB, INBOUND: { send } as unknown as Queue<InboundEvent>, ...testKeyring } satisfies IntegrationEnv }
}
const change = (phone: string, messages: unknown[] = [], statuses: unknown[] = []) => ({ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phone }, messages, statuses } })
const delivery = (...changes: unknown[]) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes }] })
const text = (id: string) => ({ id, type: 'text', timestamp: '1760000000', from_user_id: 'BR.abc', text: { body: 'oi' } })
async function signed(body: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(body))
  return { method: 'POST', body, headers: { 'X-Hub-Signature-256': `sha256=${[...new Uint8Array(sig)].map(n => n.toString(16).padStart(2, '0')).join('')}` } }
}

it('1: conta desconhecida na entrega compartilhada é pulada; as conhecidas seguem', async () => {
  const { send, env: e } = bindings()
  const body = delivery(change('phone-a', [text('wamid.1')]), change('phone-x', [text('wamid.x')]))
  expect((await webhooks.request('/meta', await signed(body), e)).status).toBe(200)
  expect(send.mock.calls.map(([event]) => event.eventId)).toEqual(['wamid.1'])
})
it('2: mensagem sem BSUID continua ignorada (migração 0008), mas fica registrada sem dados pessoais', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { send, env: e } = bindings()
  const body = delivery(change('phone-a', [{ id: 'wamid.7', type: 'text', timestamp: '1760000000', from: '5511999991234', text: { body: 'oi' } }]))
  expect((await hooks.request('/wa-a', await signed(body), e)).status).toBe(200)
  expect(send).toHaveBeenCalledTimes(1)
  const logged = warn.mock.calls.map(c => JSON.stringify(c))
  expect(logged.some(l => l.includes('webhook_ignored') && l.includes('BSUID'))).toBe(true)
  expect(logged.join('')).not.toContain('5511999991234')
})
it('3: change sem metadata não derruba a entrega', async () => {
  const { send, env: e } = bindings()
  const bad = { field: 'messages', value: { messages: [text('wamid.bad')] } }
  const body = delivery(bad, change('phone-a', [text('wamid.1')]))
  expect((await hooks.request('/wa-a', await signed(body), e)).status).toBe(200)
  expect(send.mock.calls.map(([event]) => event.eventId)).toEqual(['wamid.1'])
})
it('4: item enfileirado no formato antigo (corpo inteiro como payload) é normalizado pelo seu próprio eventId', async () => {
  const body = JSON.parse(delivery(change('phone-a', [text('wamid.1'), text('wamid.2')])))
  const rt = { provider: metaWhatsappCloud, connection: { kind: 'whatsapp', externalId: 'phone-a' } } as never
  const events = await normalizeInbound(rt, { version: 1, provider: 'meta', workspaceId: 'a', channelId: 'wa-a', eventId: 'wamid.2', receivedAt: 1, payload: body })
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ kind: 'message', externalMessageId: 'wamid.2' })
  await expect(normalizeInbound(rt, { version: 1, provider: 'meta', workspaceId: 'a', channelId: 'wa-a', eventId: 'wamid.zzz', receivedAt: 1, payload: body })).rejects.toThrow('Mismatched event')
})
it('5: mensagem sem perfil não apaga nome nem username já gravados', async () => {
  const rt = { meta: { contacts: 'generic' }, connection: { kind: 'telegram' } } as never
  const event = { version: 1, provider: 'telegram', workspaceId: 'a', channelId: 'tg-a', eventId: '1', receivedAt: 10, payload: {} } as never
  const base = { kind: 'message', externalUserId: '42', externalMessageId: 'm' } as const
  await upsertContact(env as never, rt, event, 'in-1', { ...base, profile: { firstName: 'Ana', lastName: 'Lima', username: 'ana' } }, 10)
  await upsertContact(env as never, rt, { ...(event as object), receivedAt: 20 } as never, 'in-2', { ...base, externalMessageId: 'm2' }, 20)
  const row = await env.DB.prepare(`SELECT c.first_name f, c.last_name l, cc.username u FROM contact_channels cc JOIN contacts c ON c.id=cc.contact_id WHERE cc.external_user_id='42'`).first()
  expect(row).toEqual({ f: 'Ana', l: 'Lima', u: 'ana' })
})
it('6: o handshake GET /meta só decifra conexões cujo hash do token confere', async () => {
  await env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id,credentials_ciphertext,credentials_iv,credentials_key_version,webhook_secret_hash) VALUES ('wa-0','b','whatsapp','phone-0','lixo','xxxxxxxxxxxxxxxx',1,?)")
    .bind('f'.repeat(64)).run()
  const { env: e } = bindings()
  const ok = await legacyHooks.request(`/meta?hub.mode=subscribe&hub.verify_token=${verify}&hub.challenge=55`, {}, e)
  expect(ok.status).toBe(200)
  expect(await ok.text()).toBe('55')
  expect((await legacyHooks.request('/meta?hub.mode=subscribe&hub.verify_token=outro&hub.challenge=55', {}, e)).status).toBe(403)
})
it('7: status sem o campo status não vira a chave "<id>:undefined"', () => {
  const body = JSON.parse(delivery(change('phone-a', [], [{ id: 'wamid.9', timestamp: '1' }, { id: 'wamid.9', status: 'read', timestamp: '2' }])))
  const keys = metaWhatsappCloud.splitDelivery!(body)
  expect((keys as { eventKey: string }[]).map(part => part.eventKey)).toEqual(['wamid.9:read'])
})
it('8: o ack do Telegram respeita settings.apiBase da conexão', async () => {
  const fetch = vi.fn(async (_: unknown) => new Response('{}'))
  await telegramBot.ack!({ credentials: { botToken: 'TESTONLY' }, fetch: fetch as never, connection: { settings: { apiBase: 'http://fake.test' } } } as never,
    { kind: 'click', eventKey: '1', from: { externalUserId: '1', addressKind: 'telegram_id' }, thread: { kind: 'direct' }, payload: 'p', ackToken: 'cb' })
  expect(String(fetch.mock.calls[0][0])).toBe('http://fake.test/botTESTONLY/answerCallbackQuery')
})
