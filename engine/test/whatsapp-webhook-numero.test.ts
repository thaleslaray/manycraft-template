/**
 * Webhook do WhatsApp oficial configurado sozinho, só no número: endereço alternativo por número de telefone
 * (POST /{phone-number-id} com webhook_configuration; developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override).
 * Nunca mexe na assinatura do app (/{app-id}/subscriptions), que trocaria o destino de todos os números do app.
 */
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/env'
import { metaWhatsappCloud } from '../src/channels/meta-whatsapp-cloud'
import { effectiveProfile } from '../src/channels/core/profile-merge'
import type { Connection } from '../src/channels/contract'
import { origin, seedAuth } from './auth-helpers'

const phoneId = '5550123', waba = '888', hookUrl = 'https://motor.exemplo.test/api/webhooks/meta'
type Call = { method: string; url: string; body: unknown }
type Options = { subscribed?: string[]; refuse?: { status: number; error: Record<string, unknown> }; noDebug?: boolean; current?: Record<string, string> }

/** Graph simulada: o número, o debug_token, os números da conta, as inscrições do app na conta e o endereço alternativo do número. */
function graph(options: Options = {}) {
  const calls: Call[] = []
  let current: Record<string, string> = { ...options.current }
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input), method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? (() => { try { return JSON.parse(init.body as string) } catch { return init.body } })() : undefined
    calls.push({ method, url, body })
    if (url.includes('/debug_token')) return options.noDebug ? Response.json({ error: { code: 190 } }, { status: 400 })
      : Response.json({ data: { app_id: 'APP1', granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: [waba] }] } })
    if (url.includes('/subscribed_apps')) return method === 'POST' ? Response.json({ success: true })
      : Response.json({ data: (options.subscribed ?? ['APP1']).map(id => ({ whatsapp_business_api_data: { id, name: 'x' } })) })
    if (url.includes(`/${waba}/phone_numbers`)) return Response.json({ data: [{ id: phoneId }] })
    if (url.includes('/subscriptions')) return Response.json({ error: { code: 100 } }, { status: 400 })
    if (new RegExp(`/${phoneId}\\?fields=webhook_configuration`).test(url)) return Response.json({ id: phoneId, webhook_configuration: { application: 'https://app.exemplo.test/hook', ...current } })
    if (method === 'POST' && new RegExp(`/${phoneId}$`).test(url)) {
      if (options.refuse) return Response.json({ error: options.refuse.error }, { status: options.refuse.status })
      const uri = (body as { webhook_configuration?: { override_callback_uri?: string } })?.webhook_configuration?.override_callback_uri
      current = uri ? { ...current, phone_number: uri } : Object.fromEntries(Object.entries(current).filter(([k]) => k !== 'phone_number'))
      return Response.json({ success: true })
    }
    if (new RegExp(`/${phoneId}\\?`).test(url)) return Response.json({ id: phoneId, verified_name: 'Loja', display_phone_number: '+55 11 4000-0000' })
    return Response.json({ error: { code: 803 } }, { status: 404 })
  })
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch, current: () => current }
}
const overridePosts = (calls: Call[]) => calls.filter(c => c.method === 'POST' && new RegExp(`/${phoneId}$`).test(c.url))
const appSubscriptions = (calls: Call[]) => calls.filter(c => /\/subscriptions(\?|$)/.test(c.url))

describe('nome do WABA', () => {
  it('o campo da conexão e as mensagens de modelos usam o mesmo nome, com a sigla', async () => {
    const { providers } = await import('../src/channels/providers')
    const { TEMPLATE_ACCOUNT_LABEL } = await import('../src/channels/meta-templates')
    const field = providers.meta_whatsapp_cloud.connect!.fields.find(f => f.key === 'wabaId')!
    expect(field.label).toBe(TEMPLATE_ACCOUNT_LABEL)
    expect(field.label).toBe('ID da conta do WhatsApp Business (WABA)')
    expect(field.help).toMatch(/Configuração da API, abaixo do ID do número de telefone/)
  })
})

describe('registro do webhook no número (adaptador)', () => {
  const connection = (settings: Record<string, unknown>): Connection => ({ id: 'wa-n', workspaceId: 'a', kind: 'whatsapp', provider: 'meta_whatsapp_cloud', externalId: phoneId,
    displayName: null, status: 'pending', settings, profile: effectiveProfile('whatsapp', 'meta_whatsapp_cloud') })
  const register = (fetchImpl: typeof fetch, settings: Record<string, unknown> = { accountId: waba }) => metaWhatsappCloud.registerWebhook({ connection: connection(settings),
    credentials: { accessToken: 'TESTONLY', phoneNumberId: phoneId }, hookUrl, webhookSecret: 'verifica-123', fetch: fetchImpl })

  it('o provedor registra o webhook compartilhado sozinho', () => {
    expect(metaWhatsappCloud.registersSharedWebhook).toBe(true)
  })
  it('sucesso grava o endereço alternativo no número com a URL do motor e o token de verificação da conexão', async () => {
    const { calls, fetchImpl } = graph()
    expect(await register(fetchImpl)).toMatchObject({ registered: true, awaitFirstEvent: true })
    expect(overridePosts(calls)).toEqual([{ method: 'POST', url: expect.stringMatching(new RegExp(`^https://graph\\.facebook\\.com/v[\\d.]+/${phoneId}$`)),
      body: { webhook_configuration: { override_callback_uri: hookUrl, verify_token: 'verifica-123' } } }])
  })
  it('nunca chama a assinatura do app (/{app-id}/subscriptions)', async () => {
    const { calls, fetchImpl } = graph()
    await register(fetchImpl)
    expect(appSubscriptions(calls)).toEqual([])
  })
  it('com o app já assinado na conta, não reassina (o POST sem corpo apagaria o endereço alternativo da conta)', async () => {
    const { calls, fetchImpl } = graph({ subscribed: ['APP1'] })
    await register(fetchImpl)
    expect(calls.filter(c => c.method === 'POST' && c.url.includes('/subscribed_apps'))).toEqual([])
  })
  it('com a conta sem o app, assina antes de gravar o endereço no número', async () => {
    const { calls, fetchImpl } = graph({ subscribed: [] })
    expect(await register(fetchImpl)).toMatchObject({ registered: true })
    const posts = calls.filter(c => c.method === 'POST').map(c => c.url)
    expect(posts[0]).toContain(`/${waba}/subscribed_apps`)
    expect(posts[1]).toMatch(new RegExp(`/${phoneId}$`))
  })
  it('recusa da Meta cai no passo manual com o motivo traduzido', async () => {
    const { fetchImpl } = graph({ refuse: { status: 403, error: { code: 200, message: '(#200) Permissions error', type: 'OAuthException' } } })
    const result = await register(fetchImpl)
    expect(result).toMatchObject({ registered: false, manual: { kind: 'manual_webhook', callbackUrl: hookUrl, verifyToken: 'verifica-123' } })
    if (result.registered) throw new Error('devia cair no manual')
    expect(result.manual.reason).toMatch(/permissão/)
    expect(result.manual.reason).toMatch(/código 200/)
    expect(result.manual.checklist.length).toBeGreaterThan(0)
    expect(result.manual.checklist.join(' ')).toMatch(/Cole a URL de retorno/)
  })
  it('sem a conta (WABA) confirmada não grava nada e explica o que falta', async () => {
    const { calls, fetchImpl } = graph()
    const result = await register(fetchImpl, {})
    expect(result.registered).toBe(false)
    if (result.registered) return
    expect(result.manual.reason).toMatch(/WABA/)
    expect(overridePosts(calls)).toEqual([])
  })
  it('sem confirmar a assinatura do app na conta não grava o endereço no número', async () => {
    const { calls, fetchImpl } = graph({ subscribed: ['OUTRO'], noDebug: true })
    const result = await register(fetchImpl)
    expect(result.registered).toBe(false)
    expect(overridePosts(calls)).toEqual([])
  })
  it('URL do motor maior que 200 caracteres (limite da Meta) cai no manual sem chamar a Meta', async () => {
    const { calls, fetchImpl } = graph()
    const result = await metaWhatsappCloud.registerWebhook({ connection: connection({ accountId: waba }), credentials: { accessToken: 'TESTONLY', phoneNumberId: phoneId },
      hookUrl: `https://${'a'.repeat(200)}.test/api/webhooks/meta`, webhookSecret: 'v', fetch: fetchImpl })
    expect(result.registered).toBe(false)
    expect(overridePosts(calls)).toEqual([])
  })
})

describe('desconectar remove o endereço do número só se for o do ManyCraft', () => {
  const connection: Connection = { id: 'wa-n', workspaceId: 'a', kind: 'whatsapp', provider: 'meta_whatsapp_cloud', externalId: phoneId,
    displayName: null, status: 'connected', settings: { accountId: waba }, profile: effectiveProfile('whatsapp', 'meta_whatsapp_cloud') }
  const disconnect = (fetchImpl: typeof fetch) => metaWhatsappCloud.disconnect!({ connection, credentials: { accessToken: 'TESTONLY', phoneNumberId: phoneId }, hookUrl, webhookSecret: 'v', fetch: fetchImpl })
  it('endereço igual ao do motor: limpa com override_callback_uri vazio', async () => {
    const { calls, fetchImpl } = graph({ current: { phone_number: hookUrl } })
    await disconnect(fetchImpl)
    expect(overridePosts(calls)).toMatchObject([{ body: { webhook_configuration: { override_callback_uri: '' } } }])
  })
  it('endereço de outro sistema no número: não mexe', async () => {
    const { calls, fetchImpl } = graph({ current: { phone_number: 'https://outro-sistema.test/hook' } })
    await disconnect(fetchImpl)
    expect(overridePosts(calls)).toEqual([])
  })
  it('número sem endereço alternativo: não mexe', async () => {
    const { calls, fetchImpl } = graph()
    await disconnect(fetchImpl)
    expect(overridePosts(calls)).toEqual([])
  })
})

describe('pela API de conexões', () => {
  const bindings = (extra: Partial<Env> = {}) => ({ ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: 'a', DEV_PROVIDER_API_BASE: undefined, PUBLIC_BASE_URL: undefined, ...extra } as Env)
  const call = (method: string, path: string, body?: unknown) => app.request(`${origin}/api/connections${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'x-workspace': 'a', origin, 'content-type': 'application/json' } }, bindings())
  let fake: ReturnType<typeof graph>
  beforeEach(async () => {
    await seedAuth()
    fake = graph({ subscribed: ['APP1'] })
    vi.spyOn(globalThis, 'fetch').mockImplementation(fake.fetchImpl)
  })
  afterEach(() => { vi.restoreAllMocks() })
  const credentials = { accessToken: 'EAAG-TESTONLY', phoneNumberId: phoneId, wabaId: waba, appSecret: 'segredo-do-app' }

  it('conectar grava o endereço no número, não mostra o passo manual e espera o primeiro evento', async () => {
    const response = await call('POST', '', { kind: 'whatsapp', credentials })
    expect(response.status).toBe(201)
    const { connection, step } = await response.json() as { connection: { id: string; status: string; webhook: { mode: string; registered: boolean; subscribedAt: number | null; note: string | null } }; step: { kind: string; notice?: string } }
    expect(step.kind).toBe('done')
    expect(step.notice).toMatch(/número/)
    expect(connection.status).toBe('pending')
    expect(connection.webhook).toMatchObject({ mode: 'auto', registered: true, subscribedAt: expect.any(Number), note: expect.stringMatching(/no app da Meta/) })
    const [post] = overridePosts(fake.calls)
    expect(post.body).toMatchObject({ webhook_configuration: { override_callback_uri: `${origin}/api/webhooks/meta` } })
    expect(appSubscriptions(fake.calls)).toEqual([])
    // A Meta confere o endereço alternativo com o token de verificação desta conexão na rota compartilhada.
    const verify = (post.body as { webhook_configuration: { verify_token: string } }).webhook_configuration.verify_token
    const { webhooks } = await import('../src/integrations')
    expect(await (await webhooks.request(`/meta?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verify)}&hub.challenge=4242`, {}, bindings())).text()).toBe('4242')
  })
  it('recusa da Meta: passo manual de hoje com o motivo', async () => {
    fake = graph({ subscribed: ['APP1'], refuse: { status: 400, error: { code: 100, error_subcode: 33, message: 'Unsupported post request' } } })
    vi.spyOn(globalThis, 'fetch').mockImplementation(fake.fetchImpl)
    const { connection, step } = await (await call('POST', '', { kind: 'whatsapp', credentials })).json() as { connection: { status: string; webhook: { mode: string } }; step: { kind: string; reason?: string } }
    expect(step.kind).toBe('manual_webhook')
    expect(step.reason).toMatch(/código 100, subcódigo 33/)
    expect(connection).toMatchObject({ status: 'pending', webhook: { mode: 'manual' } })
  })
  it('trocar a credencial reaplica o endereço no número com o token de verificação novo', async () => {
    const { connection } = await (await call('POST', '', { kind: 'whatsapp', credentials })).json() as { connection: { id: string } }
    expect((await call('POST', `/${connection.id}/rotate`, { credentials: { accessToken: 'EAAG-TESTONLY-novo', verifyToken: 'token-novo-de-verificacao' } })).status).toBe(200)
    const posts = overridePosts(fake.calls)
    expect(posts).toHaveLength(2)
    expect(posts[1].body).toMatchObject({ webhook_configuration: { verify_token: 'token-novo-de-verificacao' } })
    expect(appSubscriptions(fake.calls)).toEqual([])
  })
  it('o passo do webhook (POST /:id/webhook) também reaplica', async () => {
    const { connection } = await (await call('POST', '', { kind: 'whatsapp', credentials })).json() as { connection: { id: string } }
    const step = await (await call('POST', `/${connection.id}/webhook`)).json() as { step: { kind: string } }
    expect(step.step.kind).toBe('done')
    expect(overridePosts(fake.calls)).toHaveLength(2)
  })
  it('arquivar limpa o endereço do número que o ManyCraft colocou', async () => {
    const { connection } = await (await call('POST', '', { kind: 'whatsapp', credentials })).json() as { connection: { id: string } }
    expect(fake.current().phone_number).toBe(`${origin}/api/webhooks/meta`)
    expect((await call('DELETE', `/${connection.id}`)).status).toBe(204)
    expect(fake.current().phone_number).toBeUndefined()
  })
})
