import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/env'
import { origin, seedAuth } from './auth-helpers'

// Ficha 15: "Atualizar conexão" do Instagram confere o token, as permissões de mensagens, comentários e curtidas e reassina o webhook.
const bindings = () => ({ ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: 'a', DEV_PROVIDER_API_BASE: undefined, PUBLIC_BASE_URL: undefined } as Env)
const call = (method: string, path: string, body?: unknown) => app.request(`${origin}/api/connections${path === '/' ? '' : path}`,
  { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'x-workspace': 'a', origin, 'content-type': 'application/json' } }, bindings())

type Graph = { tokenOk: boolean; tokenExpired: boolean; messages: boolean; comments: boolean; media: boolean; subscribe: boolean; appWebhook: 'ok' | 'refused' | 'down'; down: boolean }
let graph: Graph, calls: { method: string; path: string; fields?: string }[]
const error = (code: number, status = 400) => Response.json({ error: { message: 'x', type: 'OAuthException', code } }, { status })
function fakeGraph() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.host !== 'graph.facebook.com') throw new Error(`Unexpected request: ${url}`)
    const path = url.pathname.replace('/v26.0', '')
    calls.push({ method: init?.method ?? 'GET', path, fields: url.searchParams.get('subscribed_fields') ?? undefined })
    if (graph.down) throw new Error('rede')
    if (path === '/17840001') return graph.tokenExpired || !graph.tokenOk ? error(190, 401) : Response.json({ id: '17840001', username: 'loja' })
    if (path === '/me/accounts') return Response.json({ data: [{ id: '9001', name: 'Loja', access_token: 'PAGETOKEN', instagram_business_account: { id: '17840001' } }] })
    if (path === '/me/permissions') return Response.json({ data: [] })   // lista vazia não decide: vale a prova por leitura
    if (path === '/9001/subscribed_apps') return Response.json({ success: true })
    // Webhook do app: GET /app dá o id; a lista de assinaturas vem vazia e a assinatura (token do app) é aceita.
    if (path === '/app') return Response.json({ id: '5550001' })
    if (path === '/5550001/subscriptions' && init?.method === 'POST') {
      if (graph.appWebhook === 'down') throw new Error('rede')
      return graph.appWebhook === 'refused' ? error(100) : Response.json({ success: true })
    }
    if (path === '/5550001/subscriptions') return Response.json({ data: [] })
    if (path.endsWith('/subscribed_apps')) return graph.subscribe ? Response.json({ success: true }) : error(10)
    if (path === '/17840001/conversations') return graph.messages ? Response.json({ data: [] }) : error(10, 403)
    if (path === '/17840001/media') return Response.json({ data: graph.media ? [{ id: 'm1' }] : [] })
    if (path === '/m1/comments') return graph.comments ? Response.json({ data: [] }) : error(10, 403)
    throw new Error(`Unexpected path: ${path}`)
  })
}
type Item = { key: string; label: string; status: 'ok' | 'missing' | 'unknown'; fix?: string }
type Result = { ok: boolean; detail: string | null; permissions: Item[]; connection: { status: string; statusDetail: string | null } }
const refresh = async (id: string) => await (await call('POST', `/${id}/refresh`)).json() as Result
const state = (id: string) => env.DB.prepare('SELECT connection_state s FROM channels WHERE id=?').bind(id).first('s')
let id: string

beforeEach(async () => {
  await seedAuth()
  calls = []
  graph = { tokenOk: true, tokenExpired: false, messages: true, comments: true, media: true, subscribe: true, appWebhook: 'ok', down: false }
  fakeGraph()
  id = ((await (await call('POST', '/', { kind: 'instagram', credentials: { accessToken: 'TESTONLY', accountId: '17840001', appSecret: 's' } })).json()) as { connection: { id: string } }).connection.id
  calls = []
})
afterEach(() => { vi.restoreAllMocks() })

it('token e permissões ok: lista tudo como ok e reassina o webhook com os campos de mensagem e comentário', async () => {
  const r = await refresh(id)
  expect(r).toMatchObject({ ok: true, detail: null })
  expect(r.permissions.map(p => [p.key, p.status])).toEqual([['token', 'ok'], ['secret', 'ok'], ['messages', 'ok'], ['comments', 'ok'], ['likes', 'unavailable'], ['webhook', 'ok'], ['page', 'ok'], ['routing', 'unknown']])
  expect(r.permissions.find(p => p.key === 'likes')?.fix).toMatch(/Curtir comentário não está disponível/)
  const sub = calls.filter(c => c.method === 'POST' && c.path === '/17840001/subscribed_apps')
  expect(sub).toHaveLength(1)
  expect(sub[0].fields).toContain('messages')
  expect(calls.filter(c => c.method === 'POST' && c.path === '/5550001/subscriptions'), 'Atualizar conexão reassina o webhook do app').toHaveLength(1)
  expect(await state(id)).toBe('connected')
})

it('permissão de mensagens faltando deixa a conexão em erro, com o motivo e o passo no painel da Meta', async () => {
  graph.messages = false
  const r = await refresh(id)
  expect(r.ok).toBe(false)
  expect(r.detail).toContain('mensagens')
  expect(r.permissions.find(p => p.key === 'messages')).toMatchObject({ status: 'missing', fix: expect.stringContaining('Meta') })
  expect(r.permissions.find(p => p.key === 'comments')?.status).toBe('ok')
  expect(await state(id)).toBe('error')
  const view = await (await call('GET', `/${id}`)).json() as { status: string; statusDetail: string }
  expect(view).toMatchObject({ status: 'error', statusDetail: expect.stringContaining('mensagens') })
})

it('comentários faltando aparece como falta; as curtidas seguem indisponíveis (não há o que consertar)', async () => {
  graph.comments = false
  const r = await refresh(id)
  expect(r.permissions.filter(p => p.status === 'missing').map(p => p.key)).toEqual(['comments'])
  expect(r.permissions.find(p => p.key === 'likes')?.status).toBe('unavailable')
  expect(r.detail).toContain('comentários')
})

it('conta sem publicações não permite conferir comentários: aparece como não conferido e não derruba a conexão', async () => {
  graph.media = false
  const r = await refresh(id)
  expect(r.ok).toBe(true)
  expect(r.permissions.find(p => p.key === 'comments')).toMatchObject({ status: 'unknown' })
})

it('token vencido: a conexão fica em erro dizendo que o token venceu', async () => {
  graph.tokenExpired = true
  const r = await refresh(id)
  expect(r.ok).toBe(false)
  expect(r.detail).toMatch(/venc/)
  expect(r.permissions.find(p => p.key === 'token')).toMatchObject({ status: 'missing', fix: expect.stringContaining('token') })
  expect(r.permissions.filter(p => p.key !== 'token' && p.key !== 'likes').every(p => p.status === 'unknown')).toBe(true)
  expect(r.permissions.find(p => p.key === 'likes')?.status).toBe('unavailable')
  expect(await state(id)).toBe('error')
})

it('webhook que não dá para reassinar agora (Meta sem resposta) fica como não conferido, sem derrubar a conexão', async () => {
  graph.subscribe = false
  graph.appWebhook = 'down'
  const r = await refresh(id)
  expect(r.permissions.find(p => p.key === 'webhook')).toMatchObject({ status: 'unknown', fix: expect.stringContaining('Webhooks') })
  expect(r.ok).toBe(true)
})

it('webhook do app que a Meta recusa assinar falta, com o código e o passo em Webhooks > Instagram', async () => {
  graph.appWebhook = 'refused'
  const r = await refresh(id)
  expect(r.permissions.find(p => p.key === 'webhook')).toMatchObject({ status: 'missing', fix: expect.stringMatching(/código 100.*Webhooks > Instagram.*Atualizar conexão/) })
  expect(r.ok).toBe(false)
  expect(r.detail).toContain('webhook')
})

it('Meta fora do ar: nada é marcado como faltando', async () => {
  graph.down = true
  const r = await refresh(id)
  expect(r.permissions.some(p => p.status === 'missing')).toBe(false)
})

it('depois de corrigir a permissão, atualizar de novo volta a conexão para conectada', async () => {
  graph.messages = false
  await refresh(id)
  graph.messages = true
  expect(await refresh(id)).toMatchObject({ ok: true })
  expect(await state(id)).toBe('connected')
})
