import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { webhooks, type InboundEvent, type IntegrationEnv } from '../src/integrations'
import { giveCredentials, testKeyring } from './credentials'
import { seed } from './fixtures'

// Auditoria de segurança, D3: a rota compartilhada da Meta limita o trabalho feito antes de conferir a assinatura.
const appSecret = 'APP-SECRET'
beforeEach(async () => {
  await seed()
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('wa-a','a','whatsapp','phone-a')"),
    env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('wa-b','b','whatsapp','phone-b')"),
  ])
  for (const id of ['wa-a', 'wa-b']) await giveCredentials(env, id, { accessToken: 'TESTONLY', phoneNumberId: id === 'wa-a' ? 'phone-a' : 'phone-b', appSecret, webhookSecret: 'V' })
})
/** DB que conta as consultas à tabela de conexões. */
function counted() {
  const queries: string[] = []
  const send = vi.fn(async (_: InboundEvent) => {})
  const DB = new Proxy(env.DB, { get(target, key) {
    if (key === 'prepare') return (sql: string) => { if (/FROM channels/i.test(sql)) queries.push(sql); return target.prepare(sql) }
    const value = Reflect.get(target, key) as unknown
    return typeof value === 'function' ? value.bind(target) : value
  } }) as D1Database
  return { queries, send, env: { DB, INBOUND: { send } as unknown as Queue<InboundEvent>, ...testKeyring } satisfies IntegrationEnv }
}
const text = (id: string) => ({ id, type: 'text', timestamp: '1760000000', from_user_id: 'BR.abc', text: { body: 'oi' } })
const change = (phone: string, id: string) => ({ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phone }, messages: [text(id)], statuses: [] } })
const accountChange = { field: 'account_update', value: { event: 'ACCOUNT_RECONNECTED' } }
const envelope = (entries: unknown[]) => JSON.stringify({ object: 'whatsapp_business_account', entry: entries })
async function signed(body: string, key = appSecret) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(body))
  return { method: 'POST', body, headers: { 'X-Hub-Signature-256': `sha256=${[...new Uint8Array(sig)].map(n => n.toString(16).padStart(2, '0')).join('')}` } }
}

it('entrega com 1.000 números diferentes é recusada antes de qualquer consulta de conexão', async () => {
  const c = counted()
  const body = envelope([{ id: 'waba', changes: Array.from({ length: 1000 }, (_, i) => change(`phone-x${i}`, `wamid.${i}`)) }])
  const response = await webhooks.request('/meta', await signed(body, 'errado'), c.env)
  expect(response.status).toBeGreaterThanOrEqual(400)
  expect(response.status).not.toBe(200)
  expect(c.queries.length).toBeLessThanOrEqual(1)
  expect(c.send).not.toHaveBeenCalled()
})
it('até o teto, os números desconhecidos custam uma consulta só, não uma por número', async () => {
  const c = counted()
  const body = envelope([{ id: 'waba', changes: Array.from({ length: 40 }, (_, i) => change(`phone-x${i}`, `wamid.${i}`)) }])
  expect((await webhooks.request('/meta', await signed(body), c.env)).status).toBe(401)
  expect(c.queries.length).toBe(1)
})
it('avisos da conta (entry.id diferentes) também viram uma consulta só', async () => {
  const c = counted()
  const body = envelope(Array.from({ length: 40 }, (_, i) => ({ id: `waba-${i}`, time: 1760000000, changes: [accountChange] })))
  expect((await webhooks.request('/meta', await signed(body), c.env)).status).toBe(401)
  expect(c.queries.length).toBe(1)
})
it('1.000 contas em avisos de conta são recusadas sem consulta por conta', async () => {
  const c = counted()
  const body = envelope(Array.from({ length: 1000 }, (_, i) => ({ id: `waba-${i}`, time: 1760000000, changes: [accountChange] })))
  expect((await webhooks.request('/meta', await signed(body, 'errado'), c.env)).status).toBeGreaterThanOrEqual(400)
  expect(c.queries.length).toBeLessThanOrEqual(1)
})
it('entrega legítima com 2 números continua roteada, cada um à sua conexão, com uma consulta', async () => {
  const c = counted()
  const body = envelope([{ id: 'waba', changes: [change('phone-a', 'wamid.1'), change('phone-b', 'wamid.2')] }])
  expect((await webhooks.request('/meta', await signed(body), c.env)).status).toBe(200)
  expect(c.send.mock.calls.map(([e]) => [e.workspaceId, e.channelId, e.eventId])).toEqual([['a', 'wa-a', 'wamid.1'], ['b', 'wa-b', 'wamid.2']])
  expect(c.queries.length).toBe(1)
})
