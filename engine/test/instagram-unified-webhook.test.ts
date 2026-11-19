import { env as runtime } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeInbound } from '../src/jobs'
import { webhooks, type InboundEvent, type IntegrationEnv } from '../src/integrations'
import { connectionRuntime } from '../src/channels/core/runtime'
import { normalizeInbound } from '../src/channels/core/inbound'
import { giveCredentials, testKeyring } from './credentials'
import { seed } from './fixtures'

// Rota compartilhada (POST /api/webhooks/meta) com uma conexão instagram_unified: a assinatura é conferida pelo provider da própria linha.
const OLD = '17841400000000001', NEW = '17841400000000002', USER = '987654321012345'
// Cada conexão guarda o segredo do seu app da Meta: dois segredos diferentes provam que a assinatura é conferida com o da linha certa.
const KEY = 'CHAVE-DO-APP-UNIFICADO', KEY_OLD = 'CHAVE-DO-APP-ANTIGO', OTHER = 'CHAVE-DE-OUTRO-APP'
let env: IntegrationEnv
let accepted: InboundEvent[]

async function signed(body: unknown, key = KEY) {
  const text = JSON.stringify(body)
  const hmac = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const hex = [...new Uint8Array(await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(text)))].map(n => n.toString(16).padStart(2, '0')).join('')
  return { method: 'POST', body: text, headers: { 'X-Hub-Signature-256': `sha256=${hex}` } }
}
const dm = (account: string, mid: string, text = 'quero') => ({ sender: { id: USER }, recipient: { id: account }, timestamp: Date.now(), message: { mid, text } })
const entry = (account: string, extra: Record<string, unknown>) => ({ id: account, time: Math.floor(Date.now() / 1000), ...extra })
const delivery = (...entries: unknown[]) => ({ object: 'instagram', entry: entries })
async function consume(...events: InboundEvent[]) {
  const messages = events.map(body => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn(), id: crypto.randomUUID(), timestamp: new Date() }))
  await consumeInbound({ messages } as unknown as MessageBatch<unknown>, env)
  return messages
}

beforeEach(async () => {
  await seed()
  accepted = []
  env = { DB: runtime.DB, ...testKeyring,
    INBOUND: { send: async (event: InboundEvent) => { accepted.push(event) } } as unknown as Queue<InboundEvent>,
    FLOW_RUN: { create: async () => ({}), get: async () => ({ sendEvent: async () => {}, status: async () => ({ status: 'running' }) }) } as unknown as NonNullable<IntegrationEnv['FLOW_RUN']> }
  // ch-a: conta do login do Instagram (segredo KEY_OLD); ch-u: conta do login unificado (segredo KEY).
  await runtime.DB.batch([
    runtime.DB.prepare("UPDATE channels SET external_id=? WHERE id='ch-a'").bind(OLD),
    // O provider é imutável na linha: a conexão unificada nasce como linha nova.
    runtime.DB.prepare("INSERT INTO channels (id,workspace_id,type,provider,external_id) VALUES ('ch-u','b','instagram','instagram_unified',?)").bind(NEW),
  ])
  await giveCredentials(runtime, 'ch-a', { accessToken: 'TOKEN-ANTIGO', accountId: OLD, appSecret: KEY_OLD })
  await giveCredentials(runtime, 'ch-u', { accessToken: 'TOKEN-UNIFICADO', accountId: NEW, appSecret: KEY })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith(`https://graph.facebook.com/v26.0/${USER}?`)) return Response.json({ name: 'Maria Souza', username: 'maria', profile_pic: 'https://example.com/m.png' })
    throw new Error(`Pedido inesperado: ${url}`)
  })
})
afterEach(() => { vi.restoreAllMocks() })

describe('instagram_unified: receber pela rota compartilhada', () => {
  it('assinatura com a chave da conexão: 200, entra na fila para a conexão unificada e vira contato com janela de 24 h e perfil do graph.facebook.com', async () => {
    expect((await webhooks.request('/meta', await signed(delivery(entry(NEW, { messaging: [dm(NEW, 'ig.in.1')] }))), env)).status).toBe(200)
    expect(accepted).toHaveLength(1)
    expect(accepted[0]).toMatchObject({ workspaceId: 'b', channelId: 'ch-u' })
    const rt = await connectionRuntime(env, 'b', 'ch-u')
    expect(rt.provider?.id).toBe('instagram_unified')
    expect(await normalizeInbound(rt, accepted[0])).toMatchObject([{ kind: 'message', externalUserId: USER, text: 'quero' }])
    const before = Date.now()
    expect((await consume(...accepted))[0].ack).toHaveBeenCalledOnce()
    const identity = await runtime.DB.prepare('SELECT opted_in,window_expires_at,username FROM contact_channels WHERE workspace_id=? AND channel_id=? AND external_user_id=?')
      .bind('b', 'ch-u', USER).first<{ opted_in: number; window_expires_at: number; username: string }>()
    expect(identity).toMatchObject({ opted_in: 1, username: 'maria' })
    expect(identity!.window_expires_at).toBeGreaterThan(before + 23 * 3600_000)
    expect(identity!.window_expires_at).toBeLessThanOrEqual(Date.now() + 24 * 3600_000)
    const calls = vi.mocked(fetch).mock.calls
    expect(calls).toHaveLength(1)
    expect(String(calls[0][0])).toMatch(new RegExp(`^https://graph\\.facebook\\.com/v26\\.0/${USER}\\?fields=name,username,profile_pic`))
    expect(new Headers(calls[0][1]!.headers).get('Authorization')).toBe('Bearer TOKEN-UNIFICADO')
    expect(await runtime.DB.prepare('SELECT first_name FROM contacts WHERE workspace_id=? AND id IN (SELECT contact_id FROM contact_channels WHERE channel_id=?)').bind('b', 'ch-u').first('first_name')).toBe('Maria')
  })
  it('standby (outro app é o dono da conversa): entra na fila, vira mensagem recebida como as outras e pede o controle da conversa fora da resposta', async () => {
    // A rota roda no Worker com contexto de execução: o pedido de controle vai no waitUntil (sem contexto, o waitUntil lança e a entrega vira 503).
    const pending: Promise<unknown>[] = []
    const executionCtx = { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
    const take: { url: string; authorization: string | null; body: unknown }[] = []
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.startsWith('https://graph.facebook.com/v26.0/me/accounts?')) return Response.json({ data: [{ id: '9001', access_token: 'PAGETOKEN', instagram_business_account: { id: NEW } }] })
      if (url === 'https://graph.facebook.com/v26.0/9001/take_thread_control') {
        take.push({ url, authorization: new Headers(init?.headers).get('Authorization'), body: JSON.parse(String(init?.body)) })
        return Response.json({ success: true })
      }
      throw new Error(`Pedido inesperado: ${url}`)
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    // Só a fila aqui (o caminho rápido tem o seu teste): o que se prova é a entrega e o pedido de controle.
    const route = { ...env, FAST_INBOUND: 'off' }
    expect((await webhooks.request('/meta', await signed(delivery(entry(NEW, { standby: [dm(NEW, 'ig.sb.1', 'oi')] }))), route, executionCtx)).status).toBe(200)
    expect(accepted).toHaveLength(1)
    expect(accepted[0]).toMatchObject({ workspaceId: 'b', channelId: 'ch-u' })
    expect(await normalizeInbound(await connectionRuntime(env, 'b', 'ch-u'), accepted[0])).toMatchObject([{ kind: 'message', externalUserId: USER, text: 'oi' }])
    await Promise.all(pending)
    expect(take).toEqual([{ url: 'https://graph.facebook.com/v26.0/9001/take_thread_control', authorization: 'Bearer PAGETOKEN', body: { recipient: { id: USER }, metadata: 'manycraft_standby' } }])
    expect(log.mock.calls.map(c => String(c[0]))).toContain(JSON.stringify({ event: 'instagram_take_control', ok: true, code: null }))
    expect(log.mock.calls.map(c => String(c[0])).join()).not.toMatch(/PAGETOKEN|TOKEN-UNIFICADO/)
    // A mesma conversa de novo dentro de 10 min: entra na fila, mas não pede o controle outra vez.
    expect((await webhooks.request('/meta', await signed(delivery(entry(NEW, { standby: [dm(NEW, 'ig.sb.2', 'oi de novo')] }))), route, executionCtx)).status).toBe(200)
    await Promise.all(pending)
    expect(accepted).toHaveLength(2)
    expect(take).toHaveLength(1)
  })
  it('standby sem contexto de execução (waitUntil lança): a entrega segue 200 e entra na fila, só sem pedir o controle', async () => {
    const executionCtx = { waitUntil: () => { throw new Error('This context has no ExecutionContext') }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
    vi.mocked(fetch).mockImplementation(async () => Response.json({ data: [] }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect((await webhooks.request('/meta', await signed(delivery(entry(NEW, { standby: [dm(NEW, 'ig.sb.ctx', 'oi')] }))), { ...env, FAST_INBOUND: 'off' }, executionCtx)).status).toBe(200)
    expect(accepted).toHaveLength(1)
  })

  it('assinatura errada registra o aviso na conexão; a próxima entrega autenticada apaga o aviso', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await webhooks.request('/meta', await signed(delivery(entry(NEW, { messaging: [dm(NEW, 'ig.bad.1')] })), OTHER), env)).status).toBe(401)
    const detail = () => runtime.DB.prepare("SELECT status_detail FROM channels WHERE id='ch-u'").first('status_detail')
    expect(await detail()).toMatch(/assinatura não confere.*Trocar credencial/)
    expect(warn.mock.calls.map(c => String(c[0])).some(l => l.includes('"webhook_rejected"') && l.includes('"signature"'))).toBe(true)
    expect(warn.mock.calls.map(c => String(c[0])).join()).not.toMatch(/TOKEN-UNIFICADO|CHAVE-DO-APP/)
    expect((await webhooks.request('/meta', await signed(delivery(entry(NEW, { messaging: [dm(NEW, 'ig.ok.2')] }))), env)).status).toBe(200)
    await consume(...accepted)
    expect(await detail()).toBeNull()
  })
  it('assinatura com outra chave: 401 e nada na fila', async () => {
    expect((await webhooks.request('/meta', await signed(delivery(entry(NEW, { messaging: [dm(NEW, 'ig.in.2')] })), OTHER), env)).status).toBe(401)
    expect(accepted).toHaveLength(0)
  })
  it('cada entrega assinada com o segredo da sua conexão é aceita e vai para a conexão certa', async () => {
    expect((await webhooks.request('/meta', await signed(delivery(entry(OLD, { messaging: [dm(OLD, 'ig.old.ok')] })), KEY_OLD), env)).status).toBe(200)
    expect((await webhooks.request('/meta', await signed(delivery(entry(NEW, { messaging: [dm(NEW, 'ig.new.ok')] })), KEY), env)).status).toBe(200)
    expect(accepted.map(event => [event.channelId, event.eventId]).sort()).toEqual([['ch-a', 'ig.old.ok'], ['ch-u', 'ig.new.ok']])
  })
  it('entrega assinada com o segredo da outra conexão: 401 nos dois sentidos e nada na fila', async () => {
    expect((await webhooks.request('/meta', await signed(delivery(entry(NEW, { messaging: [dm(NEW, 'ig.x.1')] })), KEY_OLD), env)).status).toBe(401)
    expect((await webhooks.request('/meta', await signed(delivery(entry(OLD, { messaging: [dm(OLD, 'ig.x.2')] })), KEY), env)).status).toBe(401)
    expect(accepted).toHaveLength(0)
  })
  it('entrega mista (uma conta de cada provider, do mesmo app da Meta): cada evento vai para a sua conexão; um segredo que só uma das contas tem derruba a entrega', async () => {
    const body = delivery(entry(OLD, { messaging: [dm(OLD, 'ig.old')] }), entry(NEW, { messaging: [dm(NEW, 'ig.new')] }))
    expect((await webhooks.request('/meta', await signed(body, KEY), env)).status).toBe(401)
    expect(accepted).toHaveLength(0)
    await giveCredentials(runtime, 'ch-a', { accessToken: 'TOKEN-ANTIGO', accountId: OLD, appSecret: KEY })
    expect((await webhooks.request('/meta', await signed(body), env)).status).toBe(200)
    expect(accepted.map(event => [event.channelId, event.eventId]).sort()).toEqual([['ch-a', 'ig.old'], ['ch-u', 'ig.new']])
    expect(accepted.find(event => event.channelId === 'ch-u')).toMatchObject({ workspaceId: 'b' })
    expect(accepted.find(event => event.channelId === 'ch-a')).toMatchObject({ workspaceId: 'a' })
  })
  it('mudança mentions é aceita e ignorada com webhook_ignored contado, sem erro, também no login do Instagram', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mention = { field: 'mentions', value: { media_id: '17900000000000001', comment_id: '17900000000000002' } }
    expect((await webhooks.request('/meta', await signed(delivery(entry(OLD, { changes: [mention] })), KEY_OLD), env)).status).toBe(200)
    expect(warn.mock.calls.map(call => JSON.parse(String(call[0])))).toEqual([expect.objectContaining({ event: 'webhook_ignored', provider: 'instagram_unified', channelId: 'ch-a', why: 'Instagram mention not handled', count: 1 })])
    const rt = await connectionRuntime(env, 'a', 'ch-a')
    expect(await normalizeInbound(rt, accepted[0])).toMatchObject([{ kind: 'ignored', why: 'Instagram mention not handled' }])
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })
  it('mudança mentions é aceita e ignorada com webhook_ignored contado, sem erro (login unificado)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const body = delivery(entry(NEW, { changes: [{ field: 'mentions', value: { media_id: '17900000000000001', comment_id: '17900000000000002' } }] }))
    expect((await webhooks.request('/meta', await signed(body), env)).status).toBe(200)
    expect(warn.mock.calls.map(call => JSON.parse(String(call[0])))).toEqual([expect.objectContaining({ event: 'webhook_ignored', provider: 'instagram_unified', channelId: 'ch-u', why: 'Instagram mention not handled', count: 1 })])
    const rt = await connectionRuntime(env, 'b', 'ch-u')
    expect(await normalizeInbound(rt, accepted[0])).toMatchObject([{ kind: 'ignored', why: 'Instagram mention not handled' }])
    expect((await consume(...accepted))[0].ack).toHaveBeenCalledOnce()
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })
  it('mudança comments com comment_id (sem id) gera um evento comment', async () => {
    const value = { comment_id: '17900000000000003', text: 'quero', from: { id: USER, username: 'maria' }, media: { id: '17900000000000004', media_product_type: 'FEED' } }
    expect((await webhooks.request('/meta', await signed(delivery(entry(NEW, { changes: [{ field: 'comments', value }] }))), env)).status).toBe(200)
    expect(accepted).toHaveLength(1)
    expect(accepted[0].eventId).toBe('comments:17900000000000003')
    const rt = await connectionRuntime(env, 'b', 'ch-u')
    expect(await normalizeInbound(rt, accepted[0])).toMatchObject([{ kind: 'comment', commentId: '17900000000000003', postId: '17900000000000004', text: 'quero' }])
  })
})
