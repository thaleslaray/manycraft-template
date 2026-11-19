/// <reference types="vite/client" />
import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { hooks } from '../src/channels/core/hooks'
import { webhooks, type InboundEvent, type IntegrationEnv } from '../src/integrations'
import { giveCredentials, testKeyring } from './credentials'
import { seed } from './fixtures'

const appSecret = 'APP-SECRET', verify = 'VERIFY-TOKEN'
beforeEach(async () => {
  await seed()
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('wa-a','a','whatsapp','phone-a')"),
    env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('wa-b','b','whatsapp','phone-b')"),
  ])
  for (const id of ['wa-a', 'wa-b']) await giveCredentials(env, id, { accessToken: 'TESTONLY', phoneNumberId: id === 'wa-a' ? 'phone-a' : 'phone-b', appSecret, webhookSecret: verify })
})
function bindings() {
  const send = vi.fn(async (_: InboundEvent) => {})
  return { send, env: { DB: env.DB, INBOUND: { send } as unknown as Queue<InboundEvent>, ...testKeyring } satisfies IntegrationEnv }
}
const change = (phone: string, messages: unknown[] = [], statuses: unknown[] = []) => ({ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phone }, messages, statuses } })
const delivery = (...changes: unknown[]) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes }] })
const text = (id: string) => ({ id, type: 'text', timestamp: '1760000000', from_user_id: 'BR.abc', text: { body: 'oi' } })
async function signed(body: string, key = appSecret) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(body))
  return { method: 'POST', body, headers: { 'X-Hub-Signature-256': `sha256=${[...new Uint8Array(sig)].map(n => n.toString(16).padStart(2, '0')).join('')}` } }
}

it('handshake por conexão: o token da conexão devolve o desafio; errado, 403; conexão desconhecida, 404', async () => {
  const { env: e } = bindings()
  expect(await (await hooks.request(`/wa-a?hub.mode=subscribe&hub.verify_token=${verify}&hub.challenge=123`, {}, e)).text()).toBe('123')
  expect((await hooks.request('/wa-a?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=123', {}, e)).status).toBe(403)
  expect((await hooks.request(`/nao-existe?hub.mode=subscribe&hub.verify_token=${verify}&hub.challenge=123`, {}, e)).status).toBe(404)
})
it('rota da conexão: verifica a assinatura, enfileira um item por evento e ignora números de outra conexão', async () => {
  const { send, env: e } = bindings()
  const body = delivery(change('phone-a', [text('wamid.1')], [{ id: 'wamid.9', status: 'sent', timestamp: '1760000001' }, { id: 'wamid.9', status: 'read', timestamp: '1760000002' }]), change('phone-b', [text('wamid.other')]))
  expect((await hooks.request('/wa-a', await signed(body, 'errado'), e)).status).toBe(401)
  expect(send).not.toHaveBeenCalled()
  expect((await hooks.request('/wa-a', await signed(body), e)).status).toBe(200)
  expect(send.mock.calls.map(([event]) => event.eventId)).toEqual(['wamid.1', 'wamid.9:sent', 'wamid.9:read'])
  expect(send.mock.calls[0][0]).toMatchObject({ workspaceId: 'a', channelId: 'wa-a', provider: 'meta', payload: { id: 'wamid.1', kind: 'message', field: 'messages' } })
})
it('rota antiga da Meta repassa para o mesmo caminho e entrega cada número à sua conexão', async () => {
  const { send, env: e } = bindings()
  const body = delivery(change('phone-a', [text('wamid.1')]), change('phone-b', [text('wamid.2')]))
  expect((await webhooks.request('/meta', await signed(body), e)).status).toBe(200)
  expect(send.mock.calls.map(([event]) => [event.workspaceId, event.channelId, event.eventId])).toEqual([['a', 'wa-a', 'wamid.1'], ['b', 'wa-b', 'wamid.2']])
  const unknown = delivery(change('phone-x', [text('wamid.3')]))
  // No connection holds that number, so no secret can prove the delivery.
  expect((await webhooks.request('/meta', await signed(unknown), e)).status).toBe(401)
  expect(send).toHaveBeenCalledTimes(2)
})
it('sem segredo do app o provedor não autentica (503), sem fila a rota recusa antes de ler', async () => {
  const { env: e } = bindings()
  await giveCredentials(env, 'wa-a', { accessToken: 'TESTONLY', phoneNumberId: 'phone-a', webhookSecret: verify })
  expect((await hooks.request('/wa-a', await signed(delivery(change('phone-a', [text('wamid.1')]))), e)).status).toBe(503)
  expect((await hooks.request('/wa-a', await signed(delivery(change('phone-a', [text('wamid.1')]))), { ...e, INBOUND: undefined })).status).toBe(503)
})

// Limites oficiais da Meta (limites.md, Webhooks): 3 MB por payload e 1.000 atualizações por POST.
const MB = 1024 * 1024
const manyTexts = (n: number) => Array.from({ length: n }, (_, i) => text(`wamid.${i}`))
const padded = (bytes: number, messages: unknown[]) => {
  const body = delivery({ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: 'phone-a' }, messages, padding: '' } })
  return body.replace('"padding":""', `"padding":"${'x'.repeat(bytes - body.length)}"`)
}
const warnings = () => vi.spyOn(console, 'warn').mockImplementation(() => {})
const logged = (spy: ReturnType<typeof warnings>) => spy.mock.calls.map(([line]) => JSON.parse(String(line)))

it('lote de 1.000 atualizações (acima de 64 KiB) é aceito e enfileirado inteiro, na ordem', async () => {
  const { send, env: e } = bindings()
  const body = delivery(change('phone-a', manyTexts(1000)))
  expect(body.length).toBeGreaterThan(64 * 1024)
  expect((await hooks.request('/wa-a', await signed(body), e)).status).toBe(200)
  expect(send).toHaveBeenCalledTimes(1000)
  expect(send.mock.calls.map(([event]) => event.eventId)).toEqual(manyTexts(1000).map(m => m.id))
})
it('o lote vai à fila um evento por vez: nunca dois envios em voo, para a ordem chegar inteira', async () => {
  let inFlight = 0, peak = 0
  const order: string[] = []
  const send = vi.fn(async (event: InboundEvent) => {
    peak = Math.max(peak, ++inFlight)
    await new Promise(resolve => setTimeout(resolve, 3 - order.length % 3))
    order.push(event.eventId)
    inFlight--
  })
  const e = { DB: env.DB, INBOUND: { send } as unknown as Queue<InboundEvent>, ...testKeyring } satisfies IntegrationEnv
  const texts = manyTexts(12)
  expect((await hooks.request('/wa-a', await signed(delivery(change('phone-a', texts))), e)).status).toBe(200)
  expect(peak).toBe(1)
  expect(order).toEqual(texts.map(m => m.id))
})
it('corpo em gzip que incha além de 256 KiB cabe no limite do provedor (3 MB), não no do corpo comprimido', async () => {
  const { send, env: e } = bindings()
  const body = padded(300 * 1024, [text('wamid.zip')])
  const zipped = await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
  expect(zipped.byteLength).toBeLessThan(64 * 1024)
  const signedRequest = await signed(body)
  const response = await hooks.request('/wa-a', { method: 'POST', body: zipped, headers: { ...signedRequest.headers, 'content-encoding': 'gzip' } }, e)
  expect(response.status).toBe(200)
  expect(send.mock.calls.map(([event]) => event.eventId)).toEqual(['wamid.zip'])
})
it('payload de quase 3 MB é aceito pela rota da conexão e pela rota antiga', async () => {
  const { send, env: e } = bindings()
  const body = padded(3 * MB - 16, [text('wamid.big')])
  expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(3 * MB)
  expect((await hooks.request('/wa-a', await signed(body), e)).status).toBe(200)
  expect((await webhooks.request('/meta', await signed(body), e)).status).toBe(200)
  expect(send.mock.calls.map(([event]) => event.eventId)).toEqual(['wamid.big', 'wamid.big'])
})
it('acima de 3 MB a recusa é 413 e fica registrada com o motivo (sem corpo, id nem telefone)', async () => {
  const { send, env: e } = bindings()
  const spy = warnings()
  const body = padded(3 * MB + 1024, [text('wamid.big')])
  expect((await hooks.request('/wa-a', await signed(body), e)).status).toBe(413)
  expect((await webhooks.request('/meta', await signed(body), e)).status).toBe(413)
  expect(send).not.toHaveBeenCalled()
  const refusals = logged(spy).filter(l => l.event === 'webhook_rejected')
  expect(refusals).toHaveLength(2)
  expect(refusals[0]).toMatchObject({ reason: 'payload_too_large', limitBytes: 3 * MB })
  expect(JSON.stringify(refusals)).not.toContain('wamid')
  spy.mockRestore()
})
it('o mesmo corpo acima de 64 KiB continua recusado nos outros canais da rota antiga', async () => {
  const { env: e } = bindings()
  const body = JSON.stringify({ object: 'instagram', entry: [], padding: 'x'.repeat(65 * 1024) })
  expect((await webhooks.request('/meta', await signed(body), e)).status).toBe(413)
})
it('mais de 1.000 atualizações num POST é recusado (400) com o motivo registrado', async () => {
  const { send, env: e } = bindings()
  const spy = warnings()
  expect((await hooks.request('/wa-a', await signed(delivery(change('phone-a', manyTexts(1001)))), e)).status).toBe(400)
  expect(send).not.toHaveBeenCalled()
  expect(logged(spy)).toContainEqual(expect.objectContaining({ event: 'webhook_rejected', reason: 'too_many_events', limit: 1000 }))
  spy.mockRestore()
})
it('reentrega da Meta traz as mesmas chaves e repetição dentro do lote vira um evento só', async () => {
  const { send, env: e } = bindings()
  const body = delivery(change('phone-a', [text('wamid.1'), text('wamid.1'), text('wamid.2')]))
  expect((await hooks.request('/wa-a', await signed(body), e)).status).toBe(200)
  const first = send.mock.calls.map(([event]) => event.eventId)
  expect(first).toEqual(['wamid.1', 'wamid.2'])
  send.mockClear()
  expect((await hooks.request('/wa-a', await signed(body), e)).status).toBe(200)
  expect(send.mock.calls.map(([event]) => event.eventId)).toEqual(first)
})
const examples = import.meta.glob('../../replica/contratos/meta-whatsapp/exemplos/webhooks/messages-*.json', { query: '?raw', import: 'default', eager: true })
it.each([
  ['messages-bsuid-texto-recebido.json', ['message']],
  ['messages-status-entregue-com-preco.json', ['status']],
])('exemplo oficial %s passa pela rota da conexão', async (file, kinds) => {
  const sample = JSON.parse(String(examples[`../../replica/contratos/meta-whatsapp/exemplos/webhooks/${file}`]).replaceAll('<PHONE_NUMBER_ID>', 'phone-a')) as Record<string, unknown>
  delete sample._fonte
  const { send, env: e } = bindings()
  expect((await hooks.request('/wa-a', await signed(JSON.stringify(sample)), e)).status).toBe(200)
  expect(send.mock.calls.map(([event]) => event.payload.kind)).toEqual(kinds)
})
