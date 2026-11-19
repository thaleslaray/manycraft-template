import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectContext } from '../src/channels/contract'
import { connectionFromRow, liteRow } from '../src/channels/core/connection'
import { createConnection, refreshConnection, rotateCredentials } from '../src/channels/core/connections'
import { connectionRuntime } from '../src/channels/core/runtime'
import { metaReviewRoutes } from '../src/channels/meta-review'
import { instagramUnified } from '../src/channels/instagram-unified'
import { appSecretProof } from '../src/channels/instagram-permissions'
import type { Env } from '../src/env'
import { giveCredentials } from './credentials'
import { seed } from './fixtures'

// "Atualizar conexão", "Trocar credencial" e revisão da Meta na conexão unificada (ficha 06).
const ACCOUNT = '17841400000000001', OTHER = '17841400000000009', HOST = 'https://graph.facebook.com/v26.0'
const connection = connectionFromRow({ ...liteRow('instagram', 'ig-perm', 'a'), external_id: ACCOUNT, provider: 'instagram_unified' })
const ctx = (fetcher: typeof fetch): ConnectContext => ({ connection, credentials: { accountId: ACCOUNT, accessToken: 'TESTONLY' }, hookUrl: 'https://hook.test/x', webhookSecret: 'segredo', fetch: fetcher })
const done = { kind: 'done', externalId: ACCOUNT, webhookSubscribed: true } as const

/** Formato real de GET /me/permissions com o token do login unificado (conta de anúncios não escolhida: sem permissões de anúncio). */
const REAIS = ['pages_show_list', 'pages_manage_metadata', 'pages_messaging', 'instagram_basic', 'instagram_manage_comments', 'instagram_manage_insights', 'instagram_content_publish', 'instagram_manage_messages', 'instagram_manage_events', 'public_profile']
const lista = (...fora: string[]) => ({ data: REAIS.map(permission => ({ permission, status: fora.includes(permission) ? 'declined' : 'granted' })) })

/** Graph falsa da conferência: cada leitura pode ser negada (403 code 10), vencida (401 code 190) ou sumir (/me/permissions com 500). */
function graph(options: { mensagens?: boolean; comentarios?: boolean; vencido?: boolean; permissoes?: 'lista' | 'fora'; fora?: string[]; pagina?: 'ok' | 'sem_permissao' | 'nao_ligada'; segredo?: string } = {}) {
  const urls: string[] = []
  const posts: { url: string; authorization: string | null }[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input); urls.push(url)
    const negar = (status: number, code: number) => Response.json({ error: { code, message: 'falso' } }, { status })
    if (options.vencido) return negar(401, 190)
    // appsecret_proof errado: a Meta devolve 400 code 100 citando o parâmetro (graph-api/guides/secure-requests).
    const proof = new URL(url).searchParams.get('appsecret_proof')
    if (proof && options.segredo !== undefined && proof !== await appSecretProof('TESTONLY', options.segredo ?? 'certo')) return Response.json({ error: { code: 100, message: 'Invalid appsecret_proof provided in the API argument' } }, { status: 400 })
    const pagina = options.pagina ?? 'ok'
    if (url.includes('/me/accounts?')) {
      if (pagina === 'sem_permissao') return Response.json({ data: [] })
      return Response.json({ data: [{ id: '9001', name: 'Loja', access_token: 'PAGETOKEN', ...(pagina === 'ok' ? { instagram_business_account: { id: ACCOUNT } } : {}) }] })
    }
    if (url.includes('/9001/subscribed_apps')) { posts.push({ url, authorization: new Headers(init?.headers).get('Authorization') }); return Response.json({ success: true }) }
    if (url.endsWith('/me/permissions')) return options.permissoes === 'fora' ? Response.json({}, { status: 500 }) : Response.json(lista(...(options.fora ?? []), ...(pagina === 'sem_permissao' ? ['pages_messaging', 'pages_manage_metadata'] : [])))
    if (url.includes('/conversations?')) return options.mensagens === false ? negar(403, 10) : Response.json({ data: [] })
    if (url.includes('/media?')) return Response.json({ data: [{ id: 'post-1' }] })
    if (url.includes('/comments?')) return options.comentarios === false ? negar(403, 10) : Response.json({ data: [] })
    return Response.json({ id: ACCOUNT, username: 'loja' })
  }) as typeof fetch
  return { fetcher, urls, posts }
}
type Item = { key: string; status: string; fix?: string; label: string }
const por = (items: Item[]) => Object.fromEntries(items.map(item => [item.key, item])) as Record<string, Item>

describe('instagram_unified: conferência de permissões', () => {
  it('tudo certo: token, mensagens e comentários ok, curtidas indisponível, webhook ok, sempre pelo graph.facebook.com e sem /me', async () => {
    const { fetcher, urls } = graph()
    const items = por(await instagramUnified.checkPermissions!(ctx(fetcher), done))
    expect(Object.values(items).map(item => `${item.label}:${item.status}`)).toEqual(['Token de acesso:ok', 'Mensagens:ok', 'Comentários:ok', 'Curtidas em comentários:unavailable', 'Webhook:ok', 'Página do Facebook:ok', 'Encaminhamento de conversas:unknown'])
    expect(urls[0]).toBe(`${HOST}/${ACCOUNT}?fields=id,username`)
    expect(urls.every(url => url.startsWith(`${HOST}/`))).toBe(true)
    expect(urls.some(url => /\/me(\?|$)/.test(url))).toBe(false)
    expect(urls.some(url => url.includes('PAGETOKEN'))).toBe(false)
    expect(urls).toContain(`${HOST}/me/permissions`)
  })
  it('sem mensagens (leitura negada): item Mensagens falta, com instagram_manage_messages e o caminho do login unificado', async () => {
    const items = por(await instagramUnified.checkPermissions!(ctx(graph({ mensagens: false }).fetcher), done))
    expect(items.messages.status).toBe('missing')
    expect(items.messages.fix).toContain('instagram_manage_messages')
    expect(items.messages.fix).toContain('Login do Facebook para Empresas > configuração')
    expect(items.messages.fix).not.toMatch(/business|login do Instagram/i)
    expect(items.comments.status).toBe('ok')
  })
  it('a prova por leitura prevalece sobre a lista: lista sem a permissão com leitura ok deixa Mensagens e Comentários ok', async () => {
    const { fetcher } = graph({ fora: ['instagram_manage_messages', 'instagram_manage_comments'] })
    const items = por(await instagramUnified.checkPermissions!(ctx(fetcher), done))
    expect([items.messages.status, items.comments.status]).toEqual(['ok', 'ok'])
    const ausente = (async (input: RequestInfo | URL) => String(input).endsWith('/me/permissions') ? Response.json({ data: [{ permission: 'instagram_basic', status: 'granted' }] }) : graph().fetcher(input)) as typeof fetch
    const semLista = por(await instagramUnified.checkPermissions!(ctx(ausente), done))
    expect([semLista.messages.status, semLista.comments.status]).toEqual(['ok', 'ok'])
  })
  it('sem prova por leitura (leitura inconclusiva ou conta sem publicações), a lista recusada marca a permissão como faltando', async () => {
    const base = graph({ fora: ['instagram_manage_messages', 'instagram_manage_comments'] }).fetcher
    const semProva = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/conversations?')) return Response.json({}, { status: 500 })
      if (url.includes('/media?')) return Response.json({ data: [] })
      return base(input, init)
    }) as typeof fetch
    const items = por(await instagramUnified.checkPermissions!(ctx(semProva), done))
    expect([items.messages.status, items.comments.status]).toEqual(['missing', 'missing'])
  })
  it('Página do Facebook: achada pelo /me/accounts e inscrita com o token DA PÁGINA nos campos de mensagem', async () => {
    const { fetcher, posts, urls } = graph()
    const items = por(await instagramUnified.checkPermissions!(ctx(fetcher), done))
    expect(items.page.status).toBe('ok')
    expect(urls).toContain(`${HOST}/me/accounts?fields=id,name,access_token,instagram_business_account&limit=100`)
    expect(posts).toHaveLength(1)
    const url = new URL(posts[0].url)
    expect(url.pathname).toBe('/v26.0/9001/subscribed_apps')
    expect(url.searchParams.get('subscribed_fields')).toBe('messages,messaging_postbacks,message_reads,messaging_referrals,message_reactions')
    expect(posts[0].authorization).toBe('Bearer PAGETOKEN')
    expect(url.search).not.toContain('PAGETOKEN')
  })
  it('Página do Facebook sem permissão: falta, citando as pages_* que faltam, o caso de uso Messenger e a segunda tela Configurações', async () => {
    const { fetcher, posts } = graph({ pagina: 'sem_permissao' })
    const page = por(await instagramUnified.checkPermissions!(ctx(fetcher), done)).page
    expect(page.status).toBe('missing')
    expect(page.fix).toContain('pages_manage_metadata, pages_messaging')
    expect(page.fix).toContain('"Messenger"')
    expect(page.fix).toContain('SEGUNDA tela')
    expect(page.fix).toContain('Trocar credencial')
    expect(posts).toHaveLength(0)
  })
  it('Página do Facebook não ligada a este Instagram (permissões todas dadas): falta, explicando a ligação', async () => {
    const { fetcher, posts } = graph({ pagina: 'nao_ligada' })
    const page = por(await instagramUnified.checkPermissions!(ctx(fetcher), done)).page
    expect(page.status).toBe('missing')
    expect(page.fix).toContain('ligada a esta conta do Instagram')
    expect(posts).toHaveLength(0)
  })
  it('Encaminhamento de conversas: sem leitura documentada, fica desconhecido com o passo da tela da Página e do Business Suite', async () => {
    const routing = por(await instagramUnified.checkPermissions!(ctx(graph().fetcher), done)).routing
    expect(routing.status).toBe('unknown')
    expect(routing.fix).toContain('https://www.facebook.com/settings/?tab=ig_conversation_routing')
    expect(routing.fix).toContain('Encaminhamento da conversa')
  })
  it('chave secreta: a certa fica ok; a errada (Meta devolve 400 code 100 com appsecret_proof) falta, e o connect nem salva', async () => {
    const com = (appSecret: string): ConnectContext => ({ ...ctx(graph({ segredo: 'certo' }).fetcher), credentials: { accountId: ACCOUNT, accessToken: 'TESTONLY', appSecret } })
    expect(por(await instagramUnified.checkPermissions!(com('certo'), done)).secret.status).toBe('ok')
    const errada = por(await instagramUnified.checkPermissions!(com('errado'), done)).secret
    expect(errada.status).toBe('missing')
    expect(errada.fix).toContain('Mostrar')
    expect(await instagramUnified.connect(com('errado'))).toMatchObject({ kind: 'failed', code: 'invalid_credentials' })
    expect(await instagramUnified.connect(com('certo'))).toMatchObject({ kind: 'done' })
  })
  it('curtidas: o texto não manda trocar de login', async () => {
    const unificado = por(await instagramUnified.checkPermissions!(ctx(graph().fetcher), done)).likes.fix!
    expect(unificado).not.toMatch(/login com Facebook/i)
    expect(unificado).toContain('Curtir comentário não está disponível nesta conexão')
  })
  it('leitura da conta negada (code 10 ou 200-299): o token mostra que a Meta negou o acesso; falha transitória mantém o texto antigo', async () => {
    for (const code of [10, 200, 299]) {
      const negado = (async () => Response.json({ error: { code, message: 'falso' } }, { status: 403 })) as typeof fetch
      const token = por(await instagramUnified.checkPermissions!(ctx(negado), done)).token
      expect(token.status).toBe('unknown')
      expect(token.fix).toContain('negou o acesso')
      expect(token.fix).toContain('usuário do sistema')
      expect(token.fix).not.toContain('não respondeu')
    }
    const fora = (async () => Response.json({}, { status: 500 })) as typeof fetch
    expect(por(await instagramUnified.checkPermissions!(ctx(fora), done)).token.fix).toContain('A Meta não respondeu agora')
  })
  it('sem comentários (leitura negada): item Comentários falta, com instagram_manage_comments', async () => {
    for (const opcoes of [{ comentarios: false }]) {
      const items = por(await instagramUnified.checkPermissions!(ctx(graph(opcoes).fetcher), done))
      expect(items.comments.status).toBe('missing')
      expect(items.comments.fix).toContain('instagram_manage_comments')
      expect(items.comments.fix).toContain('Login do Facebook para Empresas > configuração')
      expect(items.messages.status).toBe('ok')
    }
  })
  it('token vencido (401, code 190): só o token falta, com o caminho "API setup with Unified login > Gerar tokens de acesso"; o resto não é conferido', async () => {
    const { fetcher, urls } = graph({ vencido: true })
    const items = por(await instagramUnified.checkPermissions!(ctx(fetcher), done))
    expect(items.token.status).toBe('missing')
    expect(items.token.fix).toContain('API setup with Unified login > Gerar tokens de acesso')
    expect(items.token.fix).toContain('Trocar credencial')
    expect(items.token.fix).not.toMatch(/business|login do Instagram/i)
    for (const key of ['messages', 'comments', 'webhook']) expect(items[key].status).toBe('unknown')
    expect(urls).toEqual([`${HOST}/${ACCOUNT}?fields=id,username`])
  })
  it('/me/permissions fora do ar: cai na prova por leitura e confere do mesmo jeito', async () => {
    const ok = por(await instagramUnified.checkPermissions!(ctx(graph({ permissoes: 'fora' }).fetcher), done))
    expect([ok.token.status, ok.messages.status, ok.comments.status]).toEqual(['ok', 'ok', 'ok'])
    const sem = por(await instagramUnified.checkPermissions!(ctx(graph({ permissoes: 'fora', mensagens: false }).fetcher), done))
    expect(sem.messages.status).toBe('missing')
    expect(sem.comments.status).toBe('ok')
  })
})

describe('instagram_unified: atualizar e trocar credencial', () => {
  const e = () => env as unknown as Env
  const base = 'https://engine.test'
  beforeEach(seed)
  afterEach(() => { vi.restoreAllMocks() })
  const usar = (opcoes: Parameters<typeof graph>[0] = {}, conta = ACCOUNT) => {
    const fake = graph(opcoes)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('/subscribed_apps')) return Response.json({ success: true })
      // Um token só enxerga a própria conta: outro ID dá "permissão negada".
      if (!url.includes(`/${conta}`) && !url.includes('/me/')) return Response.json({ error: { code: 100, message: 'falso' } }, { status: 400 })
      return fake.fetcher(input, init)
    })
    return fake
  }
  const conectar = async () => (await createConnection(e(), 'a', { kind: 'instagram', provider: 'instagram_unified', credentials: { accessToken: 'token-antigo', accountId: ACCOUNT, appSecret: 'segredo' } }, base)).connection.id

  it('Atualizar conexão: tudo certo conecta; sem mensagens deixa com erro e o motivo; token vencido pede token novo', async () => {
    usar(); const id = await conectar()
    expect(await refreshConnection(e(), 'a', id, base)).toMatchObject({ ok: true, detail: null })
    vi.restoreAllMocks(); usar({ mensagens: false })
    expect(await refreshConnection(e(), 'a', id, base)).toMatchObject({ ok: false, detail: expect.stringContaining('Faltam permissões: mensagens') })
    expect(await env.DB.prepare('SELECT connection_state FROM channels WHERE id=?').bind(id).first('connection_state')).toBe('error')
    vi.restoreAllMocks(); usar({ vencido: true })
    const vencido = await refreshConnection(e(), 'a', id, base)
    expect(vencido).toMatchObject({ ok: false, detail: expect.stringContaining('token venceu') })
    expect(vencido.permissions?.find(item => item.key === 'token')?.fix).toContain('API setup with Unified login > Gerar tokens de acesso')
  })
  it('Trocar credencial: token novo da mesma conta troca; outro ID de conta é 400; token que não cobre a conta é recusado e o antigo continua valendo', async () => {
    usar(); const id = await conectar()
    expect(await rotateCredentials(e(), 'a', id, { accessToken: 'token-novo', accountId: ACCOUNT, appSecret: 'segredo-novo' }, base)).toMatchObject({ rotatedAt: expect.any(Number) })
    expect((await (await connectionRuntime(e(), 'a', id)).credentials()).accessToken).toBe('token-novo')
    await expect(rotateCredentials(e(), 'a', id, { accessToken: 'token-novo', accountId: OTHER, appSecret: 'segredo-novo' }, base)).rejects.toMatchObject({ status: 400 })
    // A Meta responde com erro quando o token não enxerga o ID colado (spec §7); a conexão recusa e não troca nada.
    vi.restoreAllMocks(); usar({}, OTHER)
    await expect(rotateCredentials(e(), 'a', id, { accessToken: 'token-de-outra-conta', accountId: ACCOUNT, appSecret: 'segredo-novo' }, base)).rejects.toMatchObject({ status: 422 })
    expect((await (await connectionRuntime(e(), 'a', id)).credentials()).accessToken).toBe('token-novo')
  })
  it('revisão da Meta: a conexão unificada lê /me/permissions no graph.facebook.com', async () => {
    await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,connection_state,status) VALUES ('ch-rev','a','instagram','instagram_unified',?,'connected','connected')").bind(ACCOUNT).run()
    await giveCredentials(env, 'ch-rev', { accessToken: 'TESTONLY', accountId: ACCOUNT })
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(lista('instagram_manage_comments')))
    const { Hono } = await import('hono')
    const app = new Hono<{ Bindings: Env; Variables: Record<string, unknown> }>()
    app.use('*', async (c, next) => { c.set('principal', { workspaceId: 'a', role: 'owner', userId: 'user-a' }); await next() })
    app.route('/', metaReviewRoutes as never)
    const response = await app.request('/connections/ch-rev/meta-review', {}, e())
    expect(response.status).toBe(200)
    const { items } = await response.json() as { items: { feature: string; source: string; status: string }[] }
    expect(items).toContainEqual({ feature: 'instagram_manage_messages', source: 'permission', status: 'granted' })
    expect(items).toContainEqual({ feature: 'instagram_manage_comments', source: 'permission', status: 'declined' })
    expect(String(spy.mock.calls[0][0])).toBe(`${HOST}/me/permissions`)
  })
})
