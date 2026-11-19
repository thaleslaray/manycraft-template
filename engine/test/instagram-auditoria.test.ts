import { env as runtime } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConnectContext, ProviderCtx } from '../src/channels/contract'
import { connectionFromRow, liteRow } from '../src/channels/core/connection'
import { effectiveProfile } from '../src/channels/core/profile-merge'
import { instagramUnified } from '../src/channels/instagram-unified'
import { syncInstagramContact } from '../src/channels/instagram'
import type { IntegrationEnv } from '../src/integrations'
import { giveCredentials, testKeyring } from './credentials'
import { seed } from './fixtures'

const connection = connectionFromRow({ ...liteRow('instagram', 'ig-test', 'a'), external_id: '12345', provider: 'instagram_unified', settings: JSON.stringify({ apiBase: 'https://fake-graph.test' }) })
const credentials = { accountId: '12345', accessToken: 'TESTONLY' }
const ctx = (fetcher: typeof fetch): ProviderCtx => ({ connection, credentials, fetch: fetcher })
const connectCtx = (fetcher: typeof fetch, accountId = '12345'): ConnectContext => ({ connection, credentials: { ...credentials, accountId }, hookUrl: 'https://hook.test/x', webhookSecret: 'segredo', fetch: fetcher })
const account = '12345', user = '98765'
const item = (n: number, extra: Record<string, unknown> = {}) => ({ sender: { id: user }, recipient: { id: account }, timestamp: 1760000000000 + n, message: { mid: `m${n}`, text: 'oi' }, ...extra })

// alta: ice breakers no formato da doc (call_to_actions dentro de cada objeto), só no Instagram
it('publica ice breakers com call_to_actions dentro de cada objeto', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ result: 'success' }))
  const profile = effectiveProfile('instagram', 'instagram_unified')
  await instagramUnified.configureSurface!({ ...ctx(fetcher), connection: { ...connection, profile } }, { kind: 'conversation_starters', enabled: true, items: [{ title: 'Como comprar?', payload: 'p1' }, { title: 'Prazo?', payload: 'p2' }] })
  expect(JSON.parse(String(fetcher.mock.calls[0][1]!.body))).toEqual({ platform: 'instagram',
    ice_breakers: [{ call_to_actions: [{ question: 'Como comprar?', payload: 'p1' }, { question: 'Prazo?', payload: 'p2' }] }] })
})

// Curtir comentário (POST /<IG_ID>/likes) só existe no login com Facebook.
it('não tenta curtir comentário: a ficha declara a curtida indisponível e nada vai para a rede', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ success: true }))
  expect(effectiveProfile('instagram', 'instagram_unified').comments?.like).toBe(false)
  expect(await instagramUnified.comments!.like(ctx(fetcher), { commentId: 'comment-1' })).toMatchObject({ ok: false, reason: 'unsupported' })
  expect(fetcher).not.toHaveBeenCalled()
})

// alta: assinatura da conta em /subscribed_apps com o token colado
it('assina a conta em subscribed_apps ao conectar, com os campos que o motor entende', async () => {
  const calls: { url: string; method?: string }[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method })
    return String(input).includes('/12345?fields=') ? Response.json({ id: '12345', username: 'loja' }) : Response.json({ success: true })
  }) as typeof fetch
  expect(await instagramUnified.connect(connectCtx(fetcher))).toMatchObject({ kind: 'done', externalId: '12345' })
  const sub = calls.find(c => c.url.includes('/subscribed_apps'))!
  expect(sub.method).toBe('POST')
  const url = new URL(sub.url)
  expect(url.origin + url.pathname).toBe('https://fake-graph.test/v26.0/12345/subscribed_apps')
  expect(url.searchParams.get('subscribed_fields')!.split(',').sort()).toEqual(['comments', 'live_comments', 'messages', 'messaging_postbacks', 'messaging_referral', 'messaging_seen', 'standby'])
  expect(url.search).not.toContain('TESTONLY')
})
it('conexão segue válida quando a assinatura falha, e tenta de novo só com os campos de mensagem', async () => {
  const urls: string[] = []
  const fetcher = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    if (String(input).includes('/12345?fields=')) return Response.json({ id: '12345' })
    return String(input).includes('comments') ? Response.json({ error: { code: 10 } }, { status: 400 }) : Response.json({ success: true })
  }) as typeof fetch
  expect(await instagramUnified.connect(connectCtx(fetcher))).toMatchObject({ kind: 'done' })
  expect(urls.filter(u => u.includes('/subscribed_apps'))).toHaveLength(2)
  expect(urls.at(-1)).not.toContain('comments')
  const down = (async (input: RequestInfo | URL) => { if (String(input).includes('/12345?fields=')) return Response.json({ id: '12345' }); throw new Error('rede') }) as typeof fetch
  expect(await instagramUnified.connect(connectCtx(down))).toMatchObject({ kind: 'done' })
})

// media: o ID da conexão precisa ser o que chega em entry.id
it('conexão só aceita o ID colado quando a Graph devolve a mesma conta', async () => {
  const fetcher = (async (input: RequestInfo | URL) => String(input).includes('?fields=') ? Response.json({ id: '12345', username: 'loja' }) : Response.json({ success: true })) as typeof fetch
  expect(await instagramUnified.connect(connectCtx(fetcher, '555'))).toMatchObject({ kind: 'failed', code: 'invalid_credentials' })
  expect(await instagramUnified.connect(connectCtx(fetcher, '12345'))).toMatchObject({ kind: 'done', externalId: '12345' })
})

// media: entrega com até 1000 eventos
it('aceita entrega com mais de 100 eventos', async () => {
  const body = { object: 'instagram', entry: [{ id: account, messaging: Array.from({ length: 150 }, (_, n) => item(n)) }] }
  expect(await instagramUnified.splitDelivery!(body)).toHaveLength(150)
  expect(instagramUnified.parseInbound(body, connection)).toHaveLength(150)
  const changes = { object: 'instagram', entry: [{ id: account, changes: Array.from({ length: 300 }, (_, n) => ({ field: 'comments', value: { id: `c${n}`, from: { id: user }, media: { id: 'p' }, text: 'x' } })) }] }
  expect(await instagramUnified.splitDelivery!(changes)).toHaveLength(300)
  await expect(Promise.resolve().then(() => instagramUnified.splitDelivery!({ object: 'instagram', entry: [{ id: account, messaging: Array.from({ length: 1001 }, (_, n) => item(n)) }] }))).rejects.toThrow()
})

// media: tipos de compartilhamento e anexos
it.each(['share', 'ig_reel', 'reel', 'ig_post', 'ig_story', 'story', 'media'])('anexo %s sem texto vira compartilhamento', type => {
  const [event] = instagramUnified.parseInbound(item(1, { message: { mid: 'm1', attachments: [{ type, payload: { url: 'https://example.test/x' } }] } }), connection)
  expect(event).toMatchObject({ kind: 'message', text: '', shared: { url: 'https://example.test/x' } })
})
it.each(['image', 'audio', 'video', 'file'])('anexo %s sem texto chega como mensagem de tipo não aberto, não como evento perdido', type => {
  const [event] = instagramUnified.parseInbound(item(1, { message: { mid: 'm1', attachments: [{ type, payload: { url: 'https://example.test/x' } }] } }), connection)
  expect(event).toMatchObject({ kind: 'message', unsupported: { type } })
  expect(event).not.toHaveProperty('media')
})

// media: Human Agent no formato de tag de mensagem
it('envio humano com Human Agent manda messaging_type MESSAGE_TAG junto da tag', async () => {
  const bodies: unknown[] = []
  const fetcher = (async (_: RequestInfo | URL, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ message_id: 'm1', recipient_id: user }) }) as typeof fetch
  const target = { kind: 'direct' as const, externalUserId: user }
  expect(await instagramUnified.send({ ...ctx(fetcher), target, intent: 'human', humanAgent: true } as never, { kind: 'text', text: 'Oi' })).toMatchObject({ ok: true })
  expect(bodies[0]).toMatchObject({ recipient: { id: user }, message: { text: 'Oi' }, messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' })
})

const env = () => ({ DB: runtime.DB, ...testKeyring }) as unknown as IntegrationEnv
beforeEach(async () => {
  await seed()
  await runtime.DB.prepare("UPDATE channels SET type='instagram',provider='instagram_unified',status='connected',connection_state='connected',external_id=?,settings=? WHERE id='ch-a'")
    .bind(account, JSON.stringify({ apiBase: 'https://fake-graph.test' })).run()
  await giveCredentials(runtime, 'ch-a', { accessToken: 'TOKEN-VELHO', accountId: account, appSecret: 's', verifyToken: 'v', webhookSecret: 'v' })
})
afterEach(() => { vi.restoreAllMocks() })

// media: janela de até 7 dias depois do primeiro DM de anúncio Click-to-Direct
async function windowAfter(who: string, origin: unknown) {
  const at = Date.now() - 60000
  await syncInstagramContact({ version: 1, provider: 'meta', workspaceId: 'a', channelId: 'ch-a', eventId: `e-${who}`, receivedAt: at + 1000, payload: {} } as never,
    { kind: 'message', externalUserId: who, text: 'oi', ...(origin ? { origin } : {}), occurredAt: at } as never, env() as never)
  const cc = await runtime.DB.prepare("SELECT window_expires_at AS w FROM contact_channels WHERE workspace_id='a' AND channel_id='ch-a' AND external_user_id=?").bind(who).first<{ w: number }>()
  return { at, w: cc!.w }
}
it('mensagem aberta por anúncio Click-to-Direct estende a janela para 7 dias; as demais ficam em 24 horas', async () => {
  const ad = await windowAfter('111111111', { kind: 'ad', sourceId: '1', sourceType: 'ad' })
  expect(ad.w).toBe(ad.at + 7 * 86400000)
  const plain = await windowAfter('222222222', undefined)
  expect(plain.w).toBe(plain.at + 86400000)
})
