import { describe, expect, it, vi } from 'vitest'
import { effectiveProfile } from '../src/channels/core/profile-merge'
import { TikTokAdapter } from '../src/channels/stubs'
import { resolveAdapter, resolveProvider, resolveProviderAdapter } from '../src/channels/registry'
import type { OutboundMessage } from '../src/channels/types'
import { fixtures } from './conformance/fixtures'

/** One battery, every registered provider (replica/arquitetura-mensageria.md §5). Case ids follow that table. */
describe.each(fixtures)('conformidade: $provider', ({ provider: provider_, kind, env, contract }) => {
  const provider = provider_
  const adapter = resolveAdapter(kind, provider, env)
  const profile = effectiveProfile(kind, provider)

  it('registro: o provedor declara o canal e o adaptador devolve a ficha efetiva', () => {
    expect(resolveProvider(kind, provider).kinds).toContain(kind)
    expect(adapter.capabilities()).toEqual(profile)
  })
  it('C12: fit respeita a ficha efetiva (texto acima do limite degrada ou recusa, sem rede)', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const long: OutboundMessage = { kind: 'text', text: 'a'.repeat(profile.text.maxLength + 1) }
    const fitted = adapter.fit(long, profile)
    if ('messages' in fitted) {
      for (const part of fitted.messages) if (part.kind === 'text') expect(part.text.length).toBeLessThanOrEqual(profile.text.maxLength)
    } else expect(fitted).toMatchObject({ ok: false, reason: 'unsupported' })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
  it('C13: fit é puro (mesma entrada, mesma saída)', () => {
    const message: OutboundMessage = { kind: 'text', text: 'Olá', buttons: [{ type: 'postback', id: 'a', title: 'Ir' }] }
    expect(adapter.fit(message, profile)).toEqual(adapter.fit(message, profile))
  })
  it('C18: ajuste que tenta aumentar limite não verificado é ignorado', () => {
    expect(effectiveProfile(kind, provider, { text: { maxLength: profile.text.maxLength * 10 } }).text.maxLength).toBe(profile.text.maxLength)
  })
  it('recurso sem implementação é recusado de forma explícita, nunca com sucesso falso', async () => {
    const stub = new TikTokAdapter()
    expect(await stub.send({} as never, { kind: 'text', text: 'x' })).toMatchObject({ ok: false, reason: 'unsupported' })
  })

  // Cases below need a provider on the contract (Telegram F1, WhatsApp F2; Instagram joined in F3).
  if (contract) describe('contrato', () => {
    const c = contract
    const provider = resolveProviderAdapter(kind, provider_)!
    const connection = { id: 'conn', workspaceId: 'w', kind, provider: provider_, externalId: 'x', displayName: null, status: 'connected' as const, settings: {}, profile, ...c.connection }
    const raw = (headers: Record<string, string>, body: unknown = c.inbound.text, query = '') => ({ method: 'POST' as const, headers: new Headers(headers), query: new URLSearchParams(query), body: new TextEncoder().encode(JSON.stringify(body)) })
    const secrets = { webhookSecret: c.webhookSecret, credentials: c.credentials }
    const ctx = (fetchImpl: () => Promise<Response>) => ({ connection, credentials: c.credentials, fetch: fetchImpl as unknown as typeof fetch,
      target: { kind: 'direct' as const, externalUserId: c.user.id }, bindings: c.binding?.(fetchImpl) })
    const text: OutboundMessage = { kind: 'text', text: 'Oi' }

    it('C01: webhook de texto vira uma mensagem com chave de evento, remetente e id', () => {
      expect(provider.parseInbound(c.inbound.text, connection)).toMatchObject([{ kind: 'message', eventKey: c.inbound.eventKey, from: { externalUserId: c.user.id }, externalMessageId: c.user.messageId, text: c.user.text }])
    })
    it('C02: segredo errado ou ausente é recusado', async () => {
      const valid = raw(await c.headersFor(c.inbound.text), c.authBody?.valid(c.inbound.text) ?? c.inbound.text, c.authQuery?.valid)
      expect(await provider.verifyWebhook(valid, secrets)).toEqual(c.native ? { ok: false, status: 403 } : { ok: true })
      expect(await provider.verifyWebhook(raw(await c.tamperedFor(c.inbound.text), c.authBody?.tampered(c.inbound.text) ?? c.inbound.text), secrets)).toMatchObject({ ok: false })
      expect(await provider.verifyWebhook(raw({}), secrets)).toMatchObject({ ok: false })
      expect(await provider.verifyWebhook(valid, c.unconfigured)).toMatchObject({ ok: false })
    })
    it('C03: o mesmo evento duas vezes tem a mesma chave', () => {
      expect(provider.parseInbound(c.inbound.text, connection)).toEqual(provider.parseInbound(structuredClone(c.inbound.text), connection))
    })
    it('C04/C05: eco da própria conta e tipo desconhecido são ignorados, nunca exceção', () => {
      for (const body of [c.inbound.ownEcho, c.inbound.unknownType]) expect(provider.parseInbound(body, connection)).toMatchObject([{ kind: 'ignored', eventKey: expect.any(String) }])
    })
    it('C07: o evento interpretado não carrega credencial', () => {
      const dump = JSON.stringify([c.inbound.text, c.inbound.click].flatMap(body => provider.parseInbound(body, connection)))
      for (const secret of Object.values(c.credentials)) expect(dump).not.toContain(secret)
    })
    it('C16: clique chega com o payload intacto e o token de confirmação', () => {
      expect(provider.parseInbound(c.inbound.click, connection)).toMatchObject([{ kind: 'click', payload: c.inbound.clickPayload, ...(c.inbound.clickAck ? { ackToken: expect.any(String) } : {}) }])
    })
    it('C08: envio ok devolve o id externo com uma chamada de rede', async () => {
      const fetchImpl = vi.fn(async () => c.responses.ok.clone())
      expect(await provider.send(ctx(fetchImpl), text)).toMatchObject({ ok: true, externalId: expect.any(String) })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })
    it('C09: rede caindo ou resposta inválida é incerto, sem segunda chamada', async () => {
      const down = vi.fn(async () => { throw new Error('rede') })
      expect(await provider.send(ctx(down), text)).toMatchObject({ ok: false, reason: 'uncertain' })
      expect(down).toHaveBeenCalledTimes(1)
      const bad = vi.fn(async () => c.responses.malformed.clone())
      expect(await provider.send(ctx(bad), text)).toMatchObject({ ok: false, reason: 'uncertain' })
      expect(bad).toHaveBeenCalledTimes(1)
    })
    it('C10: limite de taxa devolve o tempo de espera', async () => {
      expect(await provider.send(ctx(async () => c.responses.rateLimited.clone()), text)).toEqual({ ok: false, reason: 'rate_limited', retryAfterSec: 3 })
    })
    it('C11: recusa 4xx devolve o código', async () => {
      expect(await provider.send(ctx(async () => c.responses.rejected.clone()), text)).toMatchObject({ ok: false, reason: 'rejected', code: '400' })
    })
    it('recurso que o provedor não transporta é recusado, nunca com sucesso falso', async () => {
      const fetchImpl = vi.fn()
      expect(await provider.send(ctx(fetchImpl), { kind: 'cards', cards: [] })).toMatchObject({ ok: false, reason: 'unsupported' })
      expect(await provider.send({ ...ctx(fetchImpl), target: { kind: 'group', externalGroupId: 'g' } }, text)).toMatchObject({ ok: false, reason: profile.groups?.reply ? 'rejected' : 'unsupported' })   // a provider with groups refuses a malformed group id; the others have no groups
      expect(fetchImpl).not.toHaveBeenCalled()
    })
    if (c.webhook.mode === 'app') it('C20: registrar webhook assina o webhook do app com a URL e o segredo da conexão e é repetível', async () => {
      const hook = c.webhook as Extract<typeof c.webhook, { mode: 'app' }>
      const requests: { method: string; url: string; auth: string | null; body?: string }[] = []
      const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ method: init.method ?? 'GET', url: String(url), auth: new Headers(init.headers).get('Authorization'), ...(init.body === undefined ? {} : { body: String(init.body) }) })
        return hook.reply(String(url), init)
      })
      const context = { connection, credentials: c.credentials, hookUrl: 'https://x.test/api/hooks/conn', webhookSecret: c.webhookSecret, fetch: fetchImpl as unknown as typeof fetch }
      const first = await provider.registerWebhook(context), second = await provider.registerWebhook(context)
      expect(second).toEqual(first)
      expect(first).toEqual({ registered: true })
      expect(provider.registersSharedWebhook).toBe(true)
      // One subscription per registration, made with the app credential (never the connection token) and the connection's own URL and secret.
      const posts = requests.filter(r => r.method === 'POST')
      expect(posts.map(r => r.url)).toEqual([hook.subscribeUrl, hook.subscribeUrl])
      for (const post of posts) expect(post.auth).toBe(hook.appAuth)
      expect(posts[1].body).toBe(posts[0].body)
      const form = Object.fromEntries(new URLSearchParams(posts[0].body))
      expect(form).toMatchObject({ ...hook.form, callback_url: 'https://x.test/api/hooks/conn', verify_token: c.webhookSecret })
      // Repetível: a segunda vez faz exatamente as mesmas chamadas, e nenhum segredo vai na URL.
      expect(requests.slice(requests.length / 2).map(r => [r.method, r.url])).toEqual(requests.slice(0, requests.length / 2).map(r => [r.method, r.url]))
      for (const secret of Object.values(c.credentials)) for (const r of requests) expect(r.url).not.toContain(secret)
      // A Meta recusando, cai no passo manual com a URL e o segredo da conexão e o motivo.
      const refused = vi.fn(async () => Response.json({ error: { code: 200 } }, { status: 403 }))
      expect(await provider.registerWebhook({ ...context, fetch: refused as unknown as typeof fetch }))
        .toMatchObject({ registered: false, manual: { kind: 'manual_webhook', callbackUrl: 'https://x.test/api/hooks/conn', verifyToken: c.webhookSecret, reason: expect.any(String) } })
    })
    else it('C20: registrar webhook usa a URL e o segredo da conexão e é repetível', async () => {
      const calls: unknown[] = []
      const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return Response.json({ ok: true }) })
      const context = { connection, credentials: c.credentials, hookUrl: 'https://x.test/api/hooks/conn', webhookSecret: c.webhookSecret, fetch: fetchImpl as unknown as typeof fetch }
      const first = await provider.registerWebhook(context), second = await provider.registerWebhook(context)
      expect(second).toEqual(first)
      if (c.webhook.mode === 'auto') {
        expect(first).toEqual({ registered: true })
        expect(calls[0]).toMatchObject(c.webhook.body)
        expect(calls[1]).toEqual(calls[0])
      } else {
        // The provider configures webhooks elsewhere: the admin gets the URL and the token, and no network call is made.
        // Native channels (email) receive through the Worker's own handler: there is no HTTP webhook, so no URL or token is shown.
        expect(first).toMatchObject({ registered: false, manual: c.native ? { kind: 'manual_webhook', callbackUrl: '', verifyToken: '' } : { kind: 'manual_webhook', callbackUrl: 'https://x.test/api/hooks/conn', verifyToken: c.webhookSecret } })
        expect(fetchImpl).not.toHaveBeenCalled()
      }
    })
    it('C21: conectar só dá por pronto com prova do provedor', async () => {
      const ok = vi.fn(async () => c.connect.ok.clone())
      expect(await provider.connect({ connection, credentials: c.credentials, hookUrl: '', webhookSecret: '', fetch: ok as unknown as typeof fetch })).toMatchObject(c.native ? { kind: 'manual_webhook' } : { kind: 'done', externalId: c.connect.externalId })
      const refused = vi.fn(async () => c.connect.refused.clone())
      expect(await provider.connect({ connection, credentials: c.credentials, hookUrl: '', webhookSecret: '', fetch: refused as unknown as typeof fetch })).toMatchObject(c.native ? { kind: 'manual_webhook' } : { kind: 'failed' })
      if (c.native) { expect(ok).not.toHaveBeenCalled(); expect(refused).not.toHaveBeenCalled() }
    })
    if (c.handshake) it('handshake: o token da conexão devolve o desafio; token errado é recusado', async () => {
      const get = (query: string) => ({ method: 'GET' as const, headers: new Headers(), query: new URLSearchParams(query), body: new Uint8Array() })
      expect(await provider.verifyWebhook(get(c.handshake!.query(c.webhookSecret)), secrets)).toEqual({ ok: true, challenge: '1158201444' })
      expect(await provider.verifyWebhook(get(c.handshake!.query('errado')), secrets)).toMatchObject({ ok: false })
      expect(await provider.verifyWebhook(get(c.handshake!.query(c.webhookSecret)), { ...secrets, webhookSecret: '' })).toMatchObject({ ok: false })
    })
    if (c.receipts) it('C14: recibo vira evento com id externo e estado, com chave própria por estado', () => {
      expect(provider.parseInbound(c.receipts!.body, connection)).toMatchObject([{ kind: 'receipt', eventKey: c.receipts!.eventKey ?? `${c.receipts!.externalMessageId}:${c.receipts!.status}`,
        externalMessageId: c.receipts!.externalMessageId, status: c.receipts!.status }])
    })
  })

  // Not applicable to Telegram (it has no receipts) or still waiting for their provider:
  it.todo('C15: recibo antes da confirmação do envio (Instagram e WhatsApp em test/instagram.test.ts e test/whatsapp.test.ts)')
  it.todo('C17 e C06 na rota: isolamento por workspace e corpo grande (cobertos em test/hooks.test.ts para Telegram)')
})
