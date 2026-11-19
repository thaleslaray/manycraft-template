import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/env'
import type { ConnectContext, ProviderCtx } from '../src/channels/contract'
import { connectionFromRow, liteRow } from '../src/channels/core/connection'
import { effectiveProfile } from '../src/channels/core/profile-merge'
import { instagramUnified } from '../src/channels/instagram-unified'
import { InstagramAdapter } from '../src/channels'
import { providerFor, resolveAdapter, resolveProviderAdapter } from '../src/channels/registry'
import { catalog, manualChecklist } from '../src/channels/core/connections'
import { origin, seedAuth } from './auth-helpers'

const ACCOUNT = '17841400000000001'
const HOST = 'https://graph.facebook.com/v26.0'
const connection = connectionFromRow({ ...liteRow('instagram', 'ig-uni', 'a'), external_id: ACCOUNT, provider: 'instagram_unified' })
const credentials = { accountId: ACCOUNT, accessToken: 'TESTONLY' }
const connectCtx = (fetcher: typeof fetch, accountId = ACCOUNT): ConnectContext => ({ connection, credentials: { ...credentials, accountId }, hookUrl: 'https://hook.test/x', webhookSecret: 'segredo', fetch: fetcher })

/** Graph de mentira do login unificado: responde a conta e a assinatura; /me e /me/assigned_instagram_accounts derrubam o teste. */
function fakeGraph(options: { id?: string; status?: number; error?: unknown; subscribe?: 'ok' | 'refused' | 'only_messages' } = {}) {
  const calls: { url: string; method: string; authorization: string | null }[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('Authorization') })
    if (/\/me(\?|\/|$)/.test(url) && !/\/me\/(accounts|permissions)/.test(url)) throw new Error(`O login unificado só chama /me para achar a Página: ${url}`)
    if (url.includes('/subscribed_apps')) {
      if (options.subscribe === 'refused') return Response.json({ error: { code: 10 } }, { status: 400 })
      if (options.subscribe === 'only_messages' && new URL(url).searchParams.get('subscribed_fields')!.includes('comments')) return Response.json({ error: { code: 10 } }, { status: 400 })
      return Response.json({ success: true })
    }
    if (options.error) return Response.json({ error: options.error }, { status: options.status ?? 400 })
    if (options.status && options.status >= 400) return Response.json({}, { status: options.status })
    return Response.json({ id: options.id ?? ACCOUNT, username: 'loja' })
  }) as typeof fetch
  return { fetcher, calls }
}

describe('instagram_unified: conectar', () => {
  it('confere a conta por /<ID>?fields=id,username com o token no cabeçalho e assina a conta', async () => {
    const { fetcher, calls } = fakeGraph()
    expect(await instagramUnified.connect(connectCtx(fetcher))).toEqual({ kind: 'done', externalId: ACCOUNT, webhookSubscribed: true, displayName: '@loja' })
    expect(calls[0]).toMatchObject({ url: `${HOST}/${ACCOUNT}?fields=id,username`, authorization: 'Bearer TESTONLY' })
    const subscribe = calls.find(call => call.url.includes('/subscribed_apps'))!
    const url = new URL(subscribe.url)
    expect(subscribe.method).toBe('POST')
    expect(url.origin + url.pathname).toBe(`https://graph.facebook.com/v26.0/${ACCOUNT}/subscribed_apps`)
    expect(url.searchParams.get('subscribed_fields')!.split(',').sort()).toEqual(['comments', 'live_comments', 'messages', 'messaging_postbacks', 'messaging_referral', 'messaging_seen', 'standby'])
    expect(subscribe.authorization).toBe('Bearer TESTONLY')
    expect(url.search).not.toContain('TESTONLY')
    expect(calls.some(call => /\/me(\?|\/|$)/.test(call.url) && !/\/me\/(accounts|permissions)/.test(call.url))).toBe(false)
  })
  it('recusa quando o id devolvido não é o colado', async () => {
    expect(await instagramUnified.connect(connectCtx(fakeGraph({ id: '555' }).fetcher))).toMatchObject({ kind: 'failed', code: 'invalid_credentials' })
  })
  it.each([[401, { code: 190 }], [400, { code: 100 }], [403, { code: 10 }]])('erro %i da Meta é credencial recusada', async (status, error) => {
    expect(await instagramUnified.connect(connectCtx(fakeGraph({ status, error }).fetcher))).toMatchObject({ kind: 'failed', code: 'invalid_credentials' })
  })
  it('ID que não é número é recusado sem chamar a rede', async () => {
    const { fetcher, calls } = fakeGraph()
    expect(await instagramUnified.connect(connectCtx(fetcher, '12/../me'))).toMatchObject({ kind: 'failed', code: 'invalid_credentials' })
    expect(calls).toHaveLength(0)
  })
  it.each([500, 503, 429])('status %i é provedor fora do ar, não credencial ruim', async status => {
    expect(await instagramUnified.connect(connectCtx(fakeGraph({ status }).fetcher))).toMatchObject({ kind: 'failed', code: 'unreachable' })
  })
  it('rede caída é provedor fora do ar', async () => {
    const down = (async () => { throw new Error('rede') }) as typeof fetch
    expect(await instagramUnified.connect(connectCtx(down))).toMatchObject({ kind: 'failed', code: 'unreachable' })
  })
  it('assinatura recusada em tudo continua conectando; só mensagens vale como assinada', async () => {
    const refused = fakeGraph({ subscribe: 'refused' })
    expect(await instagramUnified.connect(connectCtx(refused.fetcher))).toMatchObject({ kind: 'done', externalId: ACCOUNT, webhookSubscribed: false })
    expect(refused.calls.filter(call => call.url.includes('/subscribed_apps'))).toHaveLength(2)
    const partial = fakeGraph({ subscribe: 'only_messages' })
    expect(await instagramUnified.connect(connectCtx(partial.fetcher))).toMatchObject({ kind: 'done', webhookSubscribed: true })
    expect(partial.calls.filter(call => call.url.includes('/subscribed_apps'))).toHaveLength(2)
  })
})

describe('instagram_unified: ficha, registro e permissões', () => {
  it('a ficha traz host, rótulo e o perfil do canal Instagram', async () => {
    const { providers } = await import('../src/channels/providers')
    expect(providers.instagram_unified).toMatchObject({ label: 'Instagram', api: { base: 'https://graph.facebook.com' }, metaObject: 'instagram', kinds: ['instagram'],
      connect: { webhook: 'manual', hook: 'shared', externalIdField: 'accountId', verifyTokenField: 'verifyToken' } })
    expect(effectiveProfile('instagram', 'instagram_unified')).toEqual(effectiveProfile('instagram'))
  })
  it('o catálogo oferece só o login unificado, que é o padrão do canal', () => {
    const instagram = catalog().find(entry => entry.kind === 'instagram')!
    expect(instagram.label).toBe('Instagram')
    expect(instagram.providers.map(p => [p.id, p.label])).toEqual([['instagram_unified', 'Instagram']])
    expect(instagram.providers[0].fields.map(field => field.key)).toEqual(['accessToken', 'accountId', 'appSecret'])
    expect(instagram.providers[0].notice).toMatch(/Unified login/)
    // O painel não renova o token: o aviso pede a configuração que não vence.
    expect(instagram.providers[0].notice).toContain("'O token nunca expira'")
    expect(providerFor('instagram', 'legacy')).toBe('instagram_unified')
    expect(providerFor('instagram')).toBe('instagram_unified')
  })
  it('o registro liga o provider e a fachada ao id instagram_unified', () => {
    expect(resolveProviderAdapter('instagram', 'instagram_unified')).toBe(instagramUnified)
    const adapter = resolveAdapter('instagram', 'instagram_unified', { DB: {} as D1Database })
    expect(adapter).toBeInstanceOf(InstagramAdapter)
    expect(adapter.capabilities()).toEqual(effectiveProfile('instagram', 'instagram_unified'))
  })
  it('permissões: conta lida por /<ID>, lista de /me/permissions e texto do painel do login unificado', async () => {
    const urls: string[] = []
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input); urls.push(url)
      if (url.includes('/me/permissions')) return Response.json({ data: [{ permission: 'instagram_manage_messages', status: 'granted' }, { permission: 'instagram_manage_comments', status: 'declined' }] })
      // Conta sem publicações: não há prova por leitura de comentários, então a lista recusada decide.
      if (url.includes('/media?')) return Response.json({ data: [] })
      return Response.json({ id: ACCOUNT, data: [] })
    }) as typeof fetch
    const items = await instagramUnified.checkPermissions!(connectCtx(fetcher), { kind: 'done', externalId: ACCOUNT, webhookSubscribed: true })
    const byKey = Object.fromEntries(items.map(item => [item.key, item]))
    expect(byKey.token.status).toBe('ok')
    expect(byKey.messages.status).toBe('ok')
    expect(byKey.comments).toMatchObject({ status: 'missing' })
    expect(byKey.comments.fix).toContain('instagram_manage_comments')
    expect(byKey.webhook.status).toBe('ok')
    expect(urls.some(url => /\/me\?/.test(url))).toBe(false)
    expect(urls[0]).toBe(`${HOST}/${ACCOUNT}?fields=id,username`)
  })
  it('envia DM pelo graph.facebook.com com o token no cabeçalho', async () => {
    const calls: { url: string; authorization: string | null }[] = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get('Authorization') })
      return Response.json({ message_id: 'mid.1', recipient_id: '98765' })
    }) as typeof fetch
    const ctx: ProviderCtx = { connection, credentials, fetch: fetcher }
    expect(await instagramUnified.send({ ...ctx, target: { kind: 'direct', externalUserId: '98765' } } as never, { kind: 'text', text: 'Oi' })).toMatchObject({ ok: true, externalId: 'mid.1' })
    expect(calls).toEqual([{ url: `${HOST}/${ACCOUNT}/messages`, authorization: 'Bearer TESTONLY' }])
  })
})

// Pela rota: a mesma conta não conecta duas vezes, e arquivar a conexão libera o ID.
const bindings = () => ({ ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: 'a', DEV_PROVIDER_API_BASE: undefined, PUBLIC_BASE_URL: undefined } as Env)
const call = (method: string, path: string, body?: unknown, workspace = 'a') => app.request(`${origin}/api/connections${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
  headers: { 'x-workspace': workspace, origin, 'content-type': 'application/json' } }, bindings())
const form = (provider: string) => ({ kind: 'instagram', provider, credentials: { accessToken: 'TESTONLY', accountId: ACCOUNT, appSecret: 'segredo-do-app' } })

describe('instagram_unified: pela rota de conexões', () => {
  beforeEach(async () => {
    await seedAuth()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input instanceof Request ? input.url : input)
      if (/graph\.facebook\.com\/v26\.0\/\d+\?fields=id,username/.test(url)) return Response.json({ id: ACCOUNT, username: 'loja' })
      if (url.includes('/subscribed_apps')) return Response.json({ success: true })
      throw new Error(`Pedido inesperado: ${url}`)
    })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('conecta, guarda o provider e não devolve segredo; conta repetida é 409 com a dica de arquivar; arquivada, conecta de novo', async () => {
    const created = await call('POST', '', form('instagram_unified'))
    expect(created.status).toBe(201)
    const body = await created.json() as { connection: { id: string; provider: string; label: string; displayName: string }; step: { kind: string; verifyToken?: string } }
    expect(body.connection).toMatchObject({ provider: 'instagram_unified', label: 'Instagram', displayName: '@loja' })
    expect(body.step.kind).toBe('manual_webhook')
    expect(JSON.stringify(body)).not.toMatch(/TESTONLY|segredo-do-app/)
    expect(JSON.stringify((await env.DB.prepare('SELECT * FROM channels WHERE id=?').bind(body.connection.id).all()).results)).not.toMatch(/TESTONLY|segredo-do-app/)

    const duplicate = await call('POST', '', form('instagram_unified'))
    expect(duplicate.status).toBe(409)
    expect(JSON.stringify(await duplicate.json())).toContain('arquive-a em Configurações > Canais e conecte de novo')
    expect((await call('POST', '', { kind: 'instagram', credentials: form('x').credentials })).status).toBe(409)

    expect((await call('DELETE', `/${body.connection.id}`)).status).toBe(204)
    const again = await call('POST', '', form('instagram_unified'))
    expect(again.status).toBe(201)
    expect((await again.json() as { connection: { provider: string } }).connection.provider).toBe('instagram_unified')
  })
  it('sem escolher o provider, o canal usa o login unificado', async () => {
    const created = await call('POST', '', { kind: 'instagram', credentials: form('x').credentials })
    expect(created.status).toBe(201)
    expect((await created.json() as { connection: { provider: string } }).connection.provider).toBe('instagram_unified')
  })
  it('outro espaço de trabalho não enxerga nem arquiva a conexão', async () => {
    const created = await (await call('POST', '', form('instagram_unified'))).json() as { connection: { id: string } }
    expect((await call('DELETE', `/${created.connection.id}`, undefined, 'b')).status).toBe(404)
    expect(((await (await call('GET', '', undefined, 'b')).json()) as { id: string }[]).some(row => row.id === created.connection.id)).toBe(false)
  })
})

describe('guia do webhook manual por provider', () => {
  it('Instagram mostra os passos do Instagram, sem texto do WhatsApp; o WhatsApp segue igual', () => {
    const unificado = manualChecklist('instagram_unified').join('\n'), whatsapp = manualChecklist('meta_whatsapp_cloud').join('\n')
    expect(unificado).toContain('API setup with Unified login')
    expect(unificado).toContain('3. Configurar webhooks')
    expect(unificado).toContain('2. Gerar tokens de acesso')
    expect(unificado).toContain('Assinatura do webhook')
    expect(unificado).toContain('live_comments')
    expect(unificado).not.toMatch(/messaging_handovers|phone_number_quality_update|modelos|número/)
    expect(whatsapp).toContain('messaging_handovers')
    expect(manualChecklist('meta_whatsapp_cloud')).toHaveLength(5)
  })
  it('o Messenger mostra o checklist da página, sem o texto do WhatsApp; Instagram e WhatsApp mantêm o seu', () => {
    const messenger = manualChecklist('messenger_page').join('\n')
    expect(messenger).toContain('Messenger > Settings > Webhooks')
    expect(messenger).toContain('messaging_postbacks')
    expect(messenger).not.toMatch(/messaging_handovers|Conversation routing|Roteamento de conversas|phone_number_quality_update/)
    expect(manualChecklist('meta_whatsapp_cloud').join('\n')).toContain('Roteamento de conversas')
    expect(manualChecklist('instagram_unified')).toEqual(instagramUnified.webhookChecklist)
  })
})
