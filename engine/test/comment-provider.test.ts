import { expect, it, vi } from 'vitest'
import { instagramUnified } from '../src/channels/instagram-unified'
import { connectionFromRow, liteRow } from '../src/channels/core/connection'
import type { ProviderCtx } from '../src/channels/contract'

const connection = connectionFromRow({ ...liteRow('instagram', 'ig-test', 'a'), external_id: '12345', provider: 'instagram_unified', settings: JSON.stringify({ apiBase: 'https://fake-graph.test' }) })
const ctx = (fetcher: typeof fetch): ProviderCtx => ({ connection, credentials: { accountId: '12345', accessToken: 'TESTONLY' }, fetch: fetcher })
const change = (value: Record<string, unknown>) => ({ field: 'comments', value: { id: 'comment-1', from: { id: '98765', username: 'ana' }, media: { id: 'post-1' }, text: 'Quero', ...value } })
const envelope = (value: Record<string, unknown> = {}) => ({ object: 'instagram', entry: [{ id: '12345', time: 1760000000, changes: [change(value)] }] })

it('normaliza comentário e preserva chave estável no replay, ignorando comentários próprios e apagados', async () => {
  const [event] = instagramUnified.parseInbound(envelope(), connection)
  expect(event).toMatchObject({ kind: 'comment', eventKey: 'comments:comment-1', commentId: 'comment-1', postId: 'post-1', text: 'Quero', from: { externalUserId: '98765', addressKind: 'igsid', profile: { username: 'ana' } } })
  expect(event.kind === 'comment' && event.createdAt).toBe(1760000000000)
  expect((await instagramUnified.splitDelivery!(envelope()))[0].eventKey).toBe('comments:comment-1')
  expect((await instagramUnified.splitDelivery!(envelope({ text: 'texto editado' })))[0].eventKey).toBe('comments:comment-1')
  expect(instagramUnified.parseInbound(change({ from: { id: '12345' } }), connection)).toMatchObject([{ kind: 'ignored' }])
  expect(instagramUnified.parseInbound(change({ verb: 'remove' }), connection)).toMatchObject([{ kind: 'ignored' }])
  expect(instagramUnified.parseInbound(change({ deleted: true }), connection)).toMatchObject([{ kind: 'ignored' }])
})

it('lista uma página de publicações com cursor opaco, sem seguir URLs ou retornar token', async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    expect(url.origin).toBe('https://fake-graph.test')
    expect(url.pathname).toBe('/v26.0/12345/media')
    expect(url.searchParams.get('after')).toBe('pagina-2')
    expect(url.searchParams.get('limit')).toBe('12')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer TESTONLY' })
    return Response.json({ data: [{ id: 'post-1', caption: 'Minha publicação', media_type: 'IMAGE', media_url: 'https://example.test/photo.jpg', permalink: 'https://example.test/p/1', timestamp: '2026-10-24T12:00:00+0000' }], paging: { cursors: { after: 'pagina-3' }, next: 'https://forbidden.test/?access_token=secret' } })
  }) as unknown as typeof fetch
  expect(connection.profile.comments).toMatchObject({ posts: true, publicReply: true, like: false, privateReply: { textMaxLength: 1000, urlButtonsMax: 1 } })
  expect(await instagramUnified.comments!.listPosts(ctx(fetcher), { limit: 12, after: 'pagina-2' })).toEqual({ posts: [{ id: 'post-1', caption: 'Minha publicação', mediaType: 'IMAGE', mediaUrl: 'https://example.test/photo.jpg', permalink: 'https://example.test/p/1', publishedAt: Date.parse('2026-10-24T12:00:00Z') }], nextCursor: 'pagina-3' })
  expect(fetcher).toHaveBeenCalledOnce()
})

it('responde publicamente e em privado no comentário pelo contrato; curtir não é tentado (a Meta só libera no login com Facebook)', async () => {
  const calls: { url: string; body: unknown }[] = []
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
    return Response.json(calls.length === 2 ? { message_id: 'private-1', recipient_id: '98765' } : { id: 'public-1' })
  }) as unknown as typeof fetch
  expect(await instagramUnified.comments!.replyPublic(ctx(fetcher), { commentId: 'comment-1', text: 'Enviei!' })).toMatchObject({ ok: true, externalId: 'public-1' })
  expect(await instagramUnified.comments!.like(ctx(fetcher), { commentId: 'comment-1' })).toMatchObject({ ok: false, reason: 'unsupported' })
  expect(await instagramUnified.comments!.replyPrivate(ctx(fetcher), { commentId: 'comment-1', text: 'Aqui está', button: { title: 'Abrir', url: 'https://example.test/oferta' } })).toMatchObject({ ok: true, externalId: 'private-1' })
  expect(calls).toEqual([
    { url: 'https://fake-graph.test/v26.0/comment-1/replies', body: { message: 'Enviei!' } },
    { url: 'https://fake-graph.test/v26.0/12345/messages', body: { recipient: { comment_id: 'comment-1' }, message: { attachment: { type: 'template', payload: { template_type: 'button', text: 'Aqui está', buttons: [{ type: 'web_url', title: 'Abrir', url: 'https://example.test/oferta' }] } } } } },
  ])
})

it('recusa mensagem privada inválida antes da rede e preserva falha incerta ou rate limit', async () => {
  const fetcher = vi.fn(async () => Response.json({ error: { code: 4, message: 'secret' } }, { status: 429, headers: { 'Retry-After': '2' } })) as unknown as typeof fetch
  expect(await instagramUnified.comments!.replyPrivate(ctx(fetcher), { commentId: 'comment-1', text: 'x'.repeat(1001) })).toMatchObject({ ok: false, reason: 'unsupported' })
  expect(await instagramUnified.comments!.replyPrivate(ctx(fetcher), { commentId: 'comment-1', text: 'Oi', button: { title: 'Ir', url: 'javascript:alert(1)' } })).toMatchObject({ ok: false, reason: 'unsupported' })
  expect(fetcher).not.toHaveBeenCalled()
  expect(await instagramUnified.comments!.replyPublic(ctx(fetcher), { commentId: 'comment-1', text: 'Oi' })).toEqual({ ok: false, reason: 'rate_limited', retryAfterSec: 2 })
  vi.mocked(fetcher).mockRejectedValueOnce(new Error('secret'))
  expect(await instagramUnified.comments!.replyPublic(ctx(fetcher), { commentId: 'comment-1', text: 'Oi' })).toMatchObject({ ok: false, reason: 'uncertain' })
})

it('rota de publicações usa ficha efetiva, conexão do workspace e credencial só no servidor', async () => {
  const { env } = await import('cloudflare:workers')
  const { app } = await import('../src/index')
  const { seedAuth, origin } = await import('./auth-helpers')
  const { giveCredentials } = await import('./credentials')
  await seedAuth()
  await env.DB.prepare(`INSERT INTO channels(id,workspace_id,type,provider,external_id,connection_state,settings) VALUES ('posts-ig','a','instagram','instagram_unified','12345','connected','{"apiBase":"https://fake-graph.test"}')`).run()
  await giveCredentials(env, 'posts-ig', { accountId: '12345', accessToken: 'TESTONLY' })
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [{ id: 'post-1' }] }))
  try {
    const get = (workspace = 'a') => app.request(`${origin}/api/connections/posts-ig/posts?limit=12`, { headers: { 'x-workspace': workspace, origin } }, { ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: workspace })
    const response = await get()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ posts: [{ id: 'post-1' }], nextCursor: null })
    expect(fetcher).toHaveBeenCalledOnce()
    expect((await get('b')).status).toBe(404)
    await env.DB.prepare(`UPDATE channels SET capabilities_override='{"comments":{"posts":false}}' WHERE id='posts-ig'`).run()
    expect((await get()).status).toBe(400)
    expect(fetcher).toHaveBeenCalledOnce()
  } finally { fetcher.mockRestore() }
})
