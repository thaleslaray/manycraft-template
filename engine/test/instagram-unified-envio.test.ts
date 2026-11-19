import { env as runtime } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InstagramAdapter, type SendContext } from '../src/channels'
import { recordInstagramReceipt } from '../src/channels/instagram'
import { instagramUnified } from '../src/channels/instagram-unified'
import { connectionFromRow, liteRow } from '../src/channels/core/connection'
import { deliverHuman } from '../src/channels/core/delivery'
import { connectionRuntime } from '../src/channels/core/runtime'
import { ensureConversation } from '../src/inbox/service'
import type { InboundEvent, IntegrationEnv } from '../src/integrations'
import type { ProviderCtx } from '../src/channels/contract'
import { giveCredentials, testKeyring } from './credentials'
import { seed } from './fixtures'

// Responder pela conexão unificada (ficha 04): a fachada e o provider falam com graph.facebook.com/v26.0/<IG_ID>/..., nunca com graph.instagram.com.
const ACCOUNT = '17841400000000001', USER = '987654321012345', TOKEN = 'TESTONLY-UNIFICADO', SECRET = 'segredo-do-app'
const HOST = 'https://graph.facebook.com/v26.0'
const graph = { nodes: [
  { id: 'start', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
  { id: 'offer', type: 'message', position: { x: 1, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Escolha' }] } },
], edges: [{ from: 'start', port: 'next', to: 'offer' }] }
let env: IntegrationEnv, adapter: InstagramAdapter, context: SendContext
const view = { IG_APP_SECRET: SECRET, IG_ACCESS_TOKEN: TOKEN, IG_ACCOUNT_ID: ACCOUNT, META_APP_SECRET: SECRET, META_VERIFY_TOKEN: 'VERIFY-TEST' }
const count = (sql: string) => runtime.DB.prepare(sql).first<number>('n')
const sentRow = () => runtime.DB.prepare("SELECT content,delivery_status,delivery_error FROM messages WHERE source='automation'").first<{ content: string; delivery_status: string; delivery_error: string | null }>()

beforeEach(async () => {
  await seed()
  env = { DB: runtime.DB, ...testKeyring } as IntegrationEnv
  // A conexão unificada é uma linha nova (o provider é imutável); o contato c-a ganha a identidade dele nela, com a janela de 24 h aberta.
  await runtime.DB.batch([
    runtime.DB.prepare("INSERT INTO channels (id,workspace_id,type,provider,external_id) VALUES ('ch-u','a','instagram','instagram_unified',?)").bind(ACCOUNT),
    runtime.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in,window_expires_at,human_window_expires_at) VALUES ('cc-u','a','c-a','ch-u',?,1,?,?)")
      .bind(USER, Date.now() + 86400000, Date.now() + 7 * 86400000),
    runtime.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('ig-v','a','auto-a',1,?)").bind(JSON.stringify(graph)),
  ])
  await runtime.DB.prepare("INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,channel_id,current_node_id) VALUES ('ig-run','a','c-a','ig-v','ch-u','offer')").run()
  await giveCredentials(runtime, 'ch-u', { accessToken: TOKEN, accountId: ACCOUNT, appSecret: SECRET })
  context = { runId: 'ig-run', step: 1, part: 0, channelId: 'ch-u', externalUserId: USER, mode: { ok: true, mode: 'free' },
    run: { id: 'ig-run', workspace_id: 'a', contact_id: 'c-a', channel_id: 'ch-u', external_user_id: USER, channel_type: 'instagram',
      automation_version_id: 'ig-v', automation_id: 'auto-a', graph: JSON.stringify(graph), start_node_id: null, depth: 0 } }
  adapter = new InstagramAdapter({ ...env, ...view } as never, instagramUnified)
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(String(input)).toBe(`${HOST}/${ACCOUNT}/messages`)
    expect(new Headers(init!.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`)
    return Response.json({ recipient_id: USER, message_id: `mid.u.${vi.mocked(fetch).mock.calls.length}` })
  })
})
afterEach(() => { vi.restoreAllMocks() })

describe('instagram_unified: resposta de fluxo pela fachada', () => {
  it('a fachada usa o provider da conexão: capacidades, host do unificado e IGSID como destinatário', async () => {
    expect(await adapter.send(context, { kind: 'text', text: 'Oi' })).toMatchObject({ ok: true, externalId: 'mid.u.1', parts: 1 })
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]!.body))).toEqual({ recipient: { id: USER }, message: { text: 'Oi' } })
    expect(JSON.parse((await sentRow())!.content)).toMatchObject({ status: 'sent', instagram: { runId: 'ig-run', nodeId: 'offer' } })
    // O replay do mesmo passo não repete a rede.
    expect(await adapter.send(context, { kind: 'text', text: 'Oi' })).toMatchObject({ ok: true, externalId: 'mid.u.1' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('grava o message_id e a leitura correlaciona a mensagem enviada', async () => {
    await adapter.send(context, { kind: 'text', text: 'Oi' })
    expect(await runtime.DB.prepare("SELECT external_message_id FROM flow_outbound WHERE run_id='ig-run'").first('external_message_id')).toBe('mid.u.1')
    expect(await runtime.DB.prepare("SELECT external_message_id FROM messages WHERE source='automation'").first('external_message_id')).toBe(`instagram:ch-u:${USER}:mid.u.1`)
    const event: InboundEvent = { version: 1, provider: 'meta', workspaceId: 'a', channelId: 'ch-u', eventId: 'read:mid.u.1', receivedAt: Date.now(), payload: {} }
    await recordInstagramReceipt(event, { kind: 'receipt', externalMessageId: 'mid.u.1', status: 'read', occurredAt: Date.now() }, env)
    expect(await sentRow()).toMatchObject({ delivery_status: 'read' })
    expect(await count("SELECT count(*) n FROM node_events WHERE type='read' AND flow_run_id='ig-run'")).toBe(1)
    // Leitura de uma mensagem que esta conexão não enviou não é correlacionada.
    await expect(recordInstagramReceipt({ ...event, eventId: 'read:outra' }, { kind: 'receipt', externalMessageId: 'outra', status: 'read' }, env)).rejects.toThrow('not yet correlated')
  })
  it('botões, respostas rápidas, mídia e cards saem pelo mesmo endereço', async () => {
    const buttons = [{ type: 'postback' as const, id: 'sim', title: 'Sim' }]
    const quickReplies = [{ id: 'a', title: 'Opção A' }]
    const cards = { kind: 'cards' as const, aspectRatio: 'square' as const, cards: [{ title: 'Curso', subtitle: 'No seu ritmo', imageUrl: 'https://media.test/curso.png', actionUrl: 'https://example.test/curso',
      buttons: [{ type: 'url' as const, title: 'Conhecer', url: 'https://example.test/curso' }] }] }
    for (const [step, message] of [[1, { kind: 'text' as const, text: 'Escolha', buttons }], [2, { kind: 'text' as const, text: 'Escolha', quickReplies }],
      [3, { kind: 'media' as const, media: 'image' as const, url: 'https://cdn.example.com/a.png' }], [4, cards]] as const) {
      expect(await adapter.send({ ...context, step }, message)).toMatchObject({ ok: true })
    }
    const sent = vi.mocked(fetch).mock.calls.map(call => JSON.parse(String(call[1]!.body)))
    expect(sent[0].message.attachment.payload).toMatchObject({ template_type: 'button', text: 'Escolha', buttons: [{ type: 'postback', title: 'Sim', payload: 'sim' }] })
    expect(sent[1].message.quick_replies).toEqual([{ content_type: 'text', title: 'Opção A', payload: 'a' }])
    expect(sent[2].message).toEqual({ attachments: [{ type: 'image', payload: { url: 'https://cdn.example.com/a.png' } }] })
    expect(sent[3].message.attachment.payload.template_type).toBe('generic')
    expect(sent.every(body => body.recipient.id === USER)).toBe(true)
  })
  it('fora da janela de 24 h: outside_window, sem rede', async () => {
    await runtime.DB.prepare("UPDATE contact_channels SET window_expires_at=1 WHERE id='cc-u'").run()
    expect(await adapter.send(context, { kind: 'text', text: 'Oi' })).toMatchObject({ ok: false, reason: 'outside_window' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('conta de outra conexão no contexto não faz rede', async () => {
    expect(await adapter.send({ ...context, channelId: 'ch-a' }, { kind: 'text', text: 'Oi' })).toMatchObject({ ok: false, code: 'context_mismatch' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('instagram_unified: erros da Meta no envio', () => {
  it('10/2018278 é outside_window; 551 é bloqueado; 429 e code 4 pedem nova tentativa', async () => {
    vi.mocked(fetch).mockReset()
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ error: { code: 10, error_subcode: 2018278 } }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ error: { code: 551 } }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ error: { code: 4 } }, { status: 429, headers: { 'Retry-After': '3' } }))
    expect(await adapter.send(context, { kind: 'text', text: 'Oi' })).toMatchObject({ ok: false, reason: 'outside_window' })
    expect(await adapter.send({ ...context, step: 2 }, { kind: 'text', text: 'Oi' })).toMatchObject({ ok: false, reason: 'blocked' })
    // O 551 marca o contato como bloqueado e o envio seguinte nem sai; para ver o 429, o contato desbloqueia.
    expect(await runtime.DB.prepare("SELECT blocked_at FROM contact_channels WHERE id='cc-u'").first('blocked_at')).toEqual(expect.any(Number))
    await runtime.DB.prepare("UPDATE contact_channels SET blocked_at=NULL WHERE id='cc-u'").run()
    expect(await adapter.send({ ...context, step: 3 }, { kind: 'text', text: 'Oi' })).toMatchObject({ ok: false, reason: 'rate_limited', retryAfterSec: 3 })
  })
  it('190 é recusa com o MetaErrorInfo e sem o token, na resposta, na linha e no log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(fetch).mockReset()
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { message: `Invalid OAuth access token (access_token=${TOKEN})`, type: 'OAuthException', code: 190, error_subcode: 460, fbtrace_id: 'Trace190' } }, { status: 401 }))
    const result = await adapter.send(context, { kind: 'text', text: 'Oi' })
    expect(result).toMatchObject({ ok: false, reason: 'rejected', code: '190', meta: { code: 190, subcode: 460, type: 'OAuthException', traceId: 'Trace190' } })
    const saved = await sentRow()
    expect(saved).toMatchObject({ delivery_status: 'failed' })
    expect(saved!.delivery_error).toContain('token de acesso')
    for (const text of [JSON.stringify(result), JSON.stringify(saved), ...warn.mock.calls.map(call => String(call[0]))]) expect(text).not.toContain(TOKEN)
  })
})

describe('instagram_unified: resposta humana pela Caixa de entrada', () => {
  it('sai por POST /<ID>/messages com o IGSID, grava o message_id e o estado de entrega', async () => {
    const conversationId = await ensureConversation(env, 'a', 'c-a', 'ch-u')
    const rt = await connectionRuntime(env, 'a', 'ch-u')
    expect(rt.provider?.id).toBe('instagram_unified')
    const sent = await deliverHuman(env, { connection: rt.connection, provider: rt.provider!, credentials: rt.credentials },
      { workspaceId: 'a', conversationId, contactId: 'c-a', externalUserId: USER, text: 'Resposta da equipe' })
    expect(sent.ok).toBe(true)
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]!.body))).toEqual({ recipient: { id: USER }, message: { text: 'Resposta da equipe' } })
    expect(await runtime.DB.prepare("SELECT connection_id,delivery_status,delivery_error,external_message_id FROM messages WHERE conversation_id=? AND json_extract(content,'$.sender')='human'").bind(conversationId).first())
      .toEqual({ connection_id: 'ch-u', delivery_status: 'sent', delivery_error: null, external_message_id: `instagram:ch-u:${USER}:mid.u.1` })
  })
})

describe('instagram_unified: nenhum pedido vai para graph.instagram.com', () => {
  const connection = connectionFromRow({ ...liteRow('instagram', 'ch-u', 'a'), external_id: ACCOUNT, provider: 'instagram_unified' })
  const withApiBase = connectionFromRow({ ...liteRow('instagram', 'ch-u', 'a'), external_id: ACCOUNT, provider: 'instagram_unified', settings: JSON.stringify({ apiBase: 'http://127.0.0.1:8799' }) })
  const credentials = { accountId: ACCOUNT, accessToken: TOKEN }
  /** Tudo o que o provider faz pela rede, exceto conectar (coberto em instagram-unified.test.ts). */
  async function exercitar(conn: typeof connection) {
    const urls: string[] = []
    // Corpos válidos por rota: nenhum passo depende de `.catch` para esconder resposta que o provider não entende.
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input); urls.push(url)
      if (/\/media\?|\/stories\?/.test(url)) return Response.json({ data: [] })
      if (/\/messenger_profile$/.test(url)) return Response.json({ result: 'success' })
      if (/\/replies$/.test(url)) return Response.json({ id: 'reply-1' })
      if (url.includes(`/${USER}?`)) return Response.json({ name: 'Maria', username: 'maria', id: USER })
      return Response.json({ message_id: 'mid.1', recipient_id: USER, id: 'x', success: true, result: 'success', data: [] })
    }) as typeof fetch
    const ctx: ProviderCtx = { connection: conn, credentials, fetch: fetcher }
    const target = { kind: 'direct', externalUserId: USER }
    const p = instagramUnified
    const passos: [string, () => Promise<unknown>][] = [
      ['enviar texto', () => p.send({ ...ctx, target } as never, { kind: 'text', text: 'Oi' })],
      ['enviar mídia', () => p.send({ ...ctx, target } as never, { kind: 'media', media: 'image', url: 'https://cdn.example.com/a.png' })],
      ['reagir', () => p.react!({ ...ctx, target } as never, { messageId: 'mid.in', reaction: 'love' })],
      ['iniciadores de conversa', () => p.configureSurface!(ctx, { kind: 'conversation_starters', enabled: true, items: [{ title: 'Quero saber mais', payload: 'saber' }] } as never)],
      ['perfil', () => p.fetchProfile!(ctx, { externalUserId: USER, addressKind: 'igsid' })],
      ['stories', () => p.stories!.list(ctx, { limit: 5 })],
      ['publicações', () => p.comments!.listPosts(ctx, { limit: 5 })],
      ['resposta pública', () => p.comments!.replyPublic!(ctx, { commentId: '17900000000000001', text: 'Valeu' })],
      ['resposta privada', () => p.comments!.replyPrivate!(ctx, { commentId: '17900000000000001', text: 'Te chamei no direct' })],
      ['registrar webhook', () => p.registerWebhook!({ ...ctx, hookUrl: 'https://hook.test/x', webhookSecret: 's' } as never)],
    ]
    const feitos: Record<string, number> = {}
    for (const [nome, passo] of passos) {
      const antes = urls.length
      const resultado = await passo()
      // Os passos que respondem com { ok } não podem ter falhado antes da rede ou na resposta.
      if (resultado && typeof resultado === 'object' && 'ok' in resultado) expect(resultado, nome).toMatchObject({ ok: true })
      feitos[nome] = urls.length - antes
    }
    return { urls, feitos }
  }
  /** Só o registrar webhook é guiado (não faz pedido); todos os outros passos precisam ter pedido pela rede. */
  const semPedido = ['registrar webhook']
  const conferirPassos = (feitos: Record<string, number>) => {
    for (const [nome, pedidos] of Object.entries(feitos)) {
      if (semPedido.includes(nome)) expect(pedidos, nome).toBe(0)
      else expect(pedidos, nome).toBeGreaterThanOrEqual(1)
    }
  }
  it('sem apiBase, todos os pedidos vão para graph.facebook.com', async () => {
    const { urls, feitos } = await exercitar(connection)
    conferirPassos(feitos)
    expect(urls.length).toBeGreaterThanOrEqual(6)
    for (const url of urls) expect(url).toMatch(/^https:\/\/graph\.facebook\.com\/v26\.0\//)
    expect(urls.some(url => /graph\.instagram\.com/.test(url))).toBe(false)
    // react e iniciadores de conversa usam o mesmo host, na conta colada (spec §7: ainda não confirmados com o token do unificado).
    expect(urls).toContain(`${HOST}/${ACCOUNT}/messenger_profile`)
    expect(urls.filter(url => url === `${HOST}/${ACCOUNT}/messages`).length).toBeGreaterThanOrEqual(4)
  })
  it('com apiBase (desenvolvimento), todos os pedidos vão para a Graph falsa', async () => {
    const { urls, feitos } = await exercitar(withApiBase)
    conferirPassos(feitos)
    for (const url of urls) expect(url).toMatch(/^http:\/\/127\.0\.0\.1:8799\/v26\.0\//)
  })
})
