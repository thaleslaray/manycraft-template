import { env } from 'cloudflare:workers'
import { createExecutionContext, createMessageBatch, getQueueResult, introspectWorkflow, type WorkflowIntrospector } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { instagramUnified } from '../src/channels/instagram-unified'
import { connectionFromRow, liteRow } from '../src/channels/core/connection'
import type { ProviderCtx } from '../src/channels/contract'
import { consumeInbound } from '../src/jobs'
import { ChannelLimiter } from '../src/flow/limiter'
import { giveCredentials } from './credentials'
import { graph, seed } from './fixtures'

// Comentários e stories pela conexão unificada (ficha 05): os mesmos casos de comment-provider.test.ts, agora com o host do graph.facebook.com.
const ACCOUNT = '17841400000000001', HOST = 'https://graph.facebook.com/v26.0'
const connection = connectionFromRow({ ...liteRow('instagram', 'ig-u', 'a'), external_id: ACCOUNT, provider: 'instagram_unified' })
const ctx = (fetcher: typeof fetch): ProviderCtx => ({ connection, credentials: { accountId: ACCOUNT, accessToken: 'TESTONLY' }, fetch: fetcher })
// No login unificado o webhook de comentário traz `comment_id` (o do login do Instagram traz `id`).
const change = (value: Record<string, unknown>) => ({ field: 'comments', value: { comment_id: 'comment-1', from: { id: '98765', username: 'ana' }, media: { id: 'post-1' }, text: 'Quero', ...value } })
const envelope = (value: Record<string, unknown> = {}) => ({ object: 'instagram', entry: [{ id: ACCOUNT, time: 1760000000, changes: [change(value)] }] })

describe('instagram_unified: comentários e stories pelo provider', () => {
  it('normaliza o comentário com comment_id e mantém a chave estável no replay', async () => {
    const [event] = instagramUnified.parseInbound(envelope(), connection)
    expect(event).toMatchObject({ kind: 'comment', eventKey: 'comments:comment-1', commentId: 'comment-1', postId: 'post-1', text: 'Quero', from: { externalUserId: '98765', addressKind: 'igsid', profile: { username: 'ana' } } })
    expect((await instagramUnified.splitDelivery!(envelope({ text: 'texto editado' })))[0].eventKey).toBe('comments:comment-1')
    expect(instagramUnified.parseInbound(change({ from: { id: ACCOUNT } }), connection)).toMatchObject([{ kind: 'ignored' }])
    expect(instagramUnified.parseInbound(change({ verb: 'remove' }), connection)).toMatchObject([{ kind: 'ignored' }])
  })

  it('lista publicações e stories no graph.facebook.com, só por cursors.after, sem seguir next nem devolver token', async () => {
    const urls: URL[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input)); urls.push(url)
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer TESTONLY' })
      return Response.json({ data: [{ id: 'item-1', caption: 'Legenda', media_type: 'IMAGE', media_url: 'https://example.test/a.jpg', permalink: 'https://example.test/p/1', timestamp: '2026-10-24T12:00:00+0000' }],
        paging: { cursors: { after: 'pagina-3' }, next: `https://graph.facebook.com/v27.0/${ACCOUNT}/media?access_token=secret&after=pagina-3` } })
    }) as unknown as typeof fetch
    expect(connection.profile.comments).toMatchObject({ posts: true, publicReply: true, like: false, privateReply: { textMaxLength: 1000, urlButtonsMax: 1 } })
    expect(connection.profile.stories).toMatchObject({ list: true })
    const posts = await instagramUnified.comments!.listPosts(ctx(fetcher), { limit: 12, after: 'pagina-2' })
    expect(posts).toEqual({ posts: [{ id: 'item-1', caption: 'Legenda', mediaType: 'IMAGE', mediaUrl: 'https://example.test/a.jpg', permalink: 'https://example.test/p/1', publishedAt: Date.parse('2026-10-24T12:00:00Z') }], nextCursor: 'pagina-3' })
    const stories = await instagramUnified.stories!.list(ctx(fetcher), { limit: 5 })
    expect(stories.nextCursor).toBe('pagina-3')
    expect(urls.map(url => `${url.origin}${url.pathname}`)).toEqual([`${HOST}/${ACCOUNT}/media`, `${HOST}/${ACCOUNT}/stories`])
    expect(urls[0].searchParams.get('after')).toBe('pagina-2')
    expect(urls[0].searchParams.get('limit')).toBe('12')
    expect(urls[1].searchParams.get('after')).toBeNull()
    expect(urls.every(url => !url.search.includes('access_token') && !url.search.includes('secret'))).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('responde em público e em privado pelo graph.facebook.com; curtir segue sem suporte e não toca a rede', async () => {
    const calls: { url: string; body: unknown }[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      return Response.json(calls.length === 2 ? { message_id: 'private-1', recipient_id: '98765' } : { id: 'public-1' })
    }) as unknown as typeof fetch
    expect(await instagramUnified.comments!.replyPublic(ctx(fetcher), { commentId: 'comment-1', text: 'Enviei!' })).toMatchObject({ ok: true, externalId: 'public-1' })
    expect(await instagramUnified.comments!.like(ctx(fetcher), { commentId: 'comment-1' })).toMatchObject({ ok: false, reason: 'unsupported' })
    expect(await instagramUnified.comments!.replyPrivate(ctx(fetcher), { commentId: 'comment-1', text: 'Aqui está', button: { title: 'Abrir', url: 'https://example.test/oferta' } })).toMatchObject({ ok: true, externalId: 'private-1' })
    expect(calls).toEqual([
      { url: `${HOST}/comment-1/replies`, body: { message: 'Enviei!' } },
      { url: `${HOST}/${ACCOUNT}/messages`, body: { recipient: { comment_id: 'comment-1' }, message: { attachment: { type: 'template', payload: { template_type: 'button', text: 'Aqui está', buttons: [{ type: 'web_url', title: 'Abrir', url: 'https://example.test/oferta' }] } } } } },
    ])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('recusa resposta privada inválida antes da rede e preserva rate limit e falha incerta', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { code: 4, message: 'secret' } }, { status: 429, headers: { 'Retry-After': '2' } })) as unknown as typeof fetch
    expect(await instagramUnified.comments!.replyPrivate(ctx(fetcher), { commentId: 'comment-1', text: 'x'.repeat(1001) })).toMatchObject({ ok: false, reason: 'unsupported' })
    expect(await instagramUnified.comments!.replyPrivate(ctx(fetcher), { commentId: 'comment-1', text: 'Oi', button: { title: 'Ir', url: 'javascript:alert(1)' } })).toMatchObject({ ok: false, reason: 'unsupported' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(await instagramUnified.comments!.replyPublic(ctx(fetcher), { commentId: 'comment-1', text: 'Oi' })).toEqual({ ok: false, reason: 'rate_limited', retryAfterSec: 2 })
    vi.mocked(fetcher).mockRejectedValueOnce(new Error('secret'))
    expect(await instagramUnified.comments!.replyPublic(ctx(fetcher), { commentId: 'comment-1', text: 'Oi' })).toMatchObject({ ok: false, reason: 'uncertain' })
  })
})

describe('instagram_unified: pelas rotas e pelo fluxo', () => {
  let workflow: WorkflowIntrospector | undefined
  const sent: { path: string; body: Record<string, any> }[] = []
  // O provider é imutável na linha: a conexão unificada é uma linha nova no espaço `a`.
  const conectar = async () => {
    await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,connection_state,status) VALUES ('ch-u','a','instagram','instagram_unified',?,'connected','connected')").bind(ACCOUNT).run()
    await giveCredentials(env, 'ch-u', { accessToken: 'TESTONLY', accountId: ACCOUNT })
  }
  beforeEach(async () => {
    await seed()
    sent.length = 0
    await conectar()
    await env.DB.prepare(`UPDATE triggers SET channel_id='ch-u',kind='widget',widget_type='feed_comment',post_scope='specific',target_post_id='post-1',
      repeat_mode='every_time',public_replies='["Veja seu privado!"]',config='{"node_id":"t","include":["quero"]}' WHERE id='trg-a'`).run()
    const opening = structuredClone(graph)
    opening.nodes[1].config = { blocks: [{ kind: 'text', text: 'Seu guia está aqui.' }, { kind: 'button', id: 'link', label: 'Abrir guia', action: { type: 'url', url: 'https://example.com/guia' } }] }
    await env.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('v-comment-u','a','auto-a',1,?)").bind(JSON.stringify(opening)).run()
    await env.DB.prepare("UPDATE automations SET published_version_id='v-comment-u',status='live',draft_graph=? WHERE id='auto-a'").bind(JSON.stringify(opening)).run()
    vi.spyOn(ChannelLimiter.prototype, 'acquire').mockResolvedValue({ allowed: true, retryAfter: 0 })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const req = new Request(input, init)
      // Nada do unificado vai para o host do login do Instagram.
      expect(req.url).toMatch(/^https:\/\/graph\.facebook\.com\/v26\.0\//)
      const path = new URL(req.url).pathname
      if (req.method === 'GET') return Response.json({ data: [{ id: 'post-1', caption: 'Guia de estudos', media_type: 'IMAGE', timestamp: new Date().toISOString() }], paging: { cursors: { after: 'c2' }, next: 'https://graph.facebook.com/v27.0/proibido' } })
      sent.push({ path, body: await req.json() })
      return Response.json(path.endsWith('/messages') ? { message_id: `private-${sent.length}` } : { id: `public-${sent.length}`, success: true })
    })
  })
  afterEach(async () => { await workflow?.dispose(); workflow = undefined; vi.restoreAllMocks() })

  it('as rotas de publicações e de stories usam a conexão unificada, só no servidor, e respeitam o espaço de trabalho', async () => {
    const { app } = await import('../src/index')
    const { seedAuth, origin } = await import('./auth-helpers')
    await seedAuth()   // refaz o banco de teste: a conexão entra de novo
    await conectar()
    const get = (path: string, workspace = 'a') => app.request(`${origin}/api/connections/ch-u/${path}?limit=5`, { headers: { 'x-workspace': workspace, origin } }, { ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: workspace })
    for (const path of ['posts', 'stories']) {
      const response = await get(path)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ posts: [{ id: 'post-1', caption: 'Guia de estudos' }], nextCursor: 'c2' })
    }
    const urls = vi.mocked(fetch).mock.calls.map(([input]) => String(input instanceof Request ? input.url : input))
    expect(urls.map(url => new URL(url).pathname)).toEqual([`/v26.0/${ACCOUNT}/media`, `/v26.0/${ACCOUNT}/stories`])
    expect(urls.every(url => !url.includes('TESTONLY'))).toBe(true)
    expect((await get('posts', 'b')).status).toBe(404)
  })

  it('o gatilho de comentário num post da conta unificada abre o fluxo, manda a resposta privada e responde em público', async () => {
    workflow = await introspectWorkflow(env.FLOW_RUN!)
    await workflow.modifyAll(async m => { await m.disableRetryDelays() })
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contacts(id,workspace_id,first_name) VALUES ('comment-person','a','Ana')"),
      env.DB.prepare("INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('comment-person-cc','a','comment-person','ch-u','190001',0)"),
    ])
    const batch = createMessageBatch('inbound', [{ id: 'q-u', timestamp: new Date(), attempts: 1, body: {
      version: 1, provider: 'meta', workspaceId: 'a', channelId: 'ch-u', eventId: 'comments:comment-u1', receivedAt: Date.now(),
      payload: { field: 'comments', value: { comment_id: 'comment-u1', from: { id: '190001' }, media: { id: 'post-1' }, text: 'Eu quero', timestamp: new Date().toISOString() } },
    } }])
    await consumeInbound(batch, env)
    expect((await getQueueResult(batch, createExecutionContext())).retryMessages).toEqual([])
    await expect.poll(async () => (await env.DB.prepare("SELECT count(*) n FROM flow_runs WHERE trigger_id='trg-a' AND channel_id='ch-u' AND status='done'").first<{ n: number }>())?.n).toBe(1)
    expect(sent.find(s => s.path.endsWith('/messages'))).toMatchObject({ path: `/v26.0/${ACCOUNT}/messages`,
      body: { recipient: { comment_id: 'comment-u1' }, message: { attachment: { payload: { text: 'Seu guia está aqui.', buttons: [{ type: 'web_url', url: 'https://example.com/guia' }] } } } } })
    expect(sent.find(s => s.path.endsWith('/replies'))).toMatchObject({ path: '/v26.0/comment-u1/replies', body: { message: 'Veja seu privado!' } })
    expect(sent.some(s => s.path.endsWith('/likes'))).toBe(false)
  })
})
