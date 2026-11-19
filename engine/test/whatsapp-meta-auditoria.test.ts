/**
 * Achados de severidade média da auditoria de 26/10 para o WhatsApp oficial (meta_whatsapp_cloud).
 * Fonte: skill docs-meta-whatsapp. Um bloco por achado.
 */
import { env as runtime } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeInbound } from '../src/jobs'
import { webhooks, type InboundEvent, type IntegrationEnv } from '../src/integrations'
import { upsertWhatsappIdentity } from '../src/db/contacts'
import { metaWhatsappCloud } from '../src/channels/meta-whatsapp-cloud'
import { effectiveProfile } from '../src/channels/core/profile-merge'
import { testKeyring, giveCredentials } from './credentials'
import { seed } from './fixtures'

const secret = 'TEST-APP-SECRET', user = 'BR.abc123', phoneId = '123456789', phone = '5511900000001'
let env: IntegrationEnv
let accepted: InboundEvent[]
const now = () => String(Math.floor(Date.now() / 1000))
const envelope = (messages: unknown[] = [], contacts: unknown[] = []) => ({ object: 'whatsapp_business_account', entry: [{ id: 'test-waba',
  changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneId }, messages, statuses: [], contacts } }] }] })
const prefs = (item: Record<string, unknown>) => ({ object: 'whatsapp_business_account', entry: [{ id: 'test-waba', time: Number(now()),
  changes: [{ field: 'user_preferences', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '551140000000', phone_number_id: phoneId },
    contacts: [{ wa_id: phone, profile: { name: 'Ana' } }], user_preferences: [{ category: 'marketing_messages', timestamp: Number(now()), ...item }] } }] }] })
async function signed(body: unknown) {
  const text = JSON.stringify(body)
  const hmac = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(text))
  return { method: 'POST', body: text, headers: { 'X-Hub-Signature-256': `sha256=${[...new Uint8Array(sig)].map(n => n.toString(16).padStart(2, '0')).join('')}` } }
}
async function deliver(body: unknown) {
  accepted = []
  expect((await webhooks.request('/meta', await signed(body), env)).status).toBe(200)
  const messages = accepted.map(event => ({ body: event, attempts: 1, ack: vi.fn(), retry: vi.fn(), id: crypto.randomUUID(), timestamp: new Date() }))
  await consumeInbound({ messages } as unknown as MessageBatch<unknown>, env)
  return messages
}
const one = <T>(sql: string, ...binds: unknown[]) => runtime.DB.prepare(sql).bind(...binds).first<T>()
const channelsOf = () => runtime.DB.prepare("SELECT external_user_id u, contact_id c, identity_kind k, opted_in o, window_expires_at w, phone_e164 p FROM contact_channels WHERE channel_id='wa-a' ORDER BY created_at, u").all<{ u: string; c: string; k: string; o: number; w: number | null; p: string | null }>()
const health = async () => JSON.parse((await one<{ h: string }>("SELECT provider_health h FROM channels WHERE id='wa-a'"))!.h) as Record<string, any>

beforeEach(async () => {
  await seed()
  accepted = []
  env = { DB: runtime.DB, ...testKeyring, INBOUND: { send: async (event: InboundEvent) => { accepted.push(event) } } as unknown as Queue<InboundEvent>,
    FLOW_RUN: { create: async () => ({}), get: async () => ({ sendEvent: async () => {}, status: async () => ({ status: 'running' }) }) } as unknown as NonNullable<IntegrationEnv['FLOW_RUN']> }
  await runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('wa-a','a','whatsapp',?)").bind(phoneId).run()
  await upsertWhatsappIdentity(runtime.DB, 'a', { contact_id: 'c-a', channel_id: 'wa-a', bsuid: user, phone_e164: `+${phone}` })
  await runtime.DB.prepare("UPDATE contact_channels SET opted_in=1,window_expires_at=? WHERE channel_id='wa-a'").bind(Date.now() + 86400000).run()
  await giveCredentials(runtime, 'wa-a', { accessToken: 'TESTONLY', phoneNumberId: phoneId, appSecret: secret, verifyToken: 'VERIFY-TEST' })
})
afterEach(() => { vi.restoreAllMocks() })

const connection = { id: 'conn', workspaceId: 'a', kind: 'whatsapp' as const, provider: 'meta_whatsapp_cloud' as const, externalId: phoneId, displayName: null, status: 'connected' as const,
  settings: {}, profile: effectiveProfile('whatsapp', 'meta_whatsapp_cloud') }

describe('achado 1: mensagem sem from_user_id', () => {
  const sem = (extra: Record<string, unknown> = {}) => ({ id: 'wamid.sem', type: 'text', timestamp: now(), from: phone, text: { body: 'oi' }, ...extra })
  it('usa o user_id do contato do mesmo wa_id quando from_user_id não vem', () => {
    const events = metaWhatsappCloud.parseInbound(envelope([sem()], [{ user_id: 'BR.novo1', wa_id: phone, profile: { name: 'Ana' } }]), connection)
    expect(events).toMatchObject([{ kind: 'message', from: { externalUserId: 'BR.novo1', addressKind: 'bsuid' }, text: 'oi' }])
  })
  it('sem nenhum BSUID a mensagem continua fora (o telefone nunca vira identidade), com motivo claro', () => {
    expect(metaWhatsappCloud.parseInbound(envelope([sem()], [{ wa_id: phone }]), connection))
      .toMatchObject([{ kind: 'ignored', why: expect.stringContaining('BSUID') }])
  })
  it('a conexão avisa que está recebendo mensagem sem BSUID', async () => {
    await deliver(envelope([sem()], [{ wa_id: phone }]))
    expect((await health()).alerts.NO_BSUID).toMatchObject({ severity: 'WARNING', description: expect.stringContaining('BSUID') })
  })
})

describe('achado 2: troca de número e de BSUID (system)', () => {
  const sistema = (system: Record<string, unknown>, id = 'wamid.sys1', from = phone) => envelope([{ id, from, timestamp: now(), type: 'system', system: { body: 'mudou', ...system } }])
  it('user_changed_number liga o BSUID novo ao mesmo contato e herda consentimento e janela', async () => {
    await deliver(sistema({ type: 'user_changed_number', wa_id: '5511900000002', user_id: 'BR.novo9', previous_user_id: user }))
    const rows = (await channelsOf()).results
    expect(rows.map(r => r.u).sort()).toEqual([user, 'BR.novo9'].sort())
    const novo = rows.find(r => r.u === 'BR.novo9')!
    expect(novo).toMatchObject({ c: 'c-a', k: 'bsuid', o: 1, p: '+5511900000002' })
    expect(novo.w).toBe(rows.find(r => r.u === user)!.w)
  })
  it('user_changed_user_id (sem telefone) também liga, e repetir o aviso não duplica nem falha', async () => {
    await deliver(sistema({ type: 'user_changed_user_id', user_id: 'BR.novo8', previous_user_id: user }))
    await deliver(sistema({ type: 'user_changed_user_id', user_id: 'BR.novo8', previous_user_id: user }, 'wamid.sys2'))
    const rows = (await channelsOf()).results
    expect(rows.filter(r => r.u === 'BR.novo8')).toMatchObject([{ c: 'c-a', o: 1, p: null }])
  })
  it('sem previous_user_id acha o contato pelo telefone antigo', async () => {
    await deliver(sistema({ type: 'user_changed_number', wa_id: '5511900000003', user_id: 'BR.novo7' }))
    expect((await channelsOf()).results.find(r => r.u === 'BR.novo7')).toMatchObject({ c: 'c-a', p: '+5511900000003' })
  })
  it('contato desconhecido não cria nada', async () => {
    await deliver(sistema({ type: 'user_changed_user_id', user_id: 'BR.novo6', previous_user_id: 'BR.ninguem' }, 'wamid.sys3', '5511955555555'))
    expect((await channelsOf()).results.map(r => r.u)).toEqual([user])
  })
  it('depois da troca, quem escreve com o BSUID novo cai no mesmo contato', async () => {
    await deliver(sistema({ type: 'user_changed_user_id', user_id: 'BR.novo5', previous_user_id: user }))
    await deliver(envelope([{ id: 'wamid.in2', type: 'text', timestamp: now(), from_user_id: 'BR.novo5', text: { body: 'voltei' } }], [{ user_id: 'BR.novo5' }]))
    expect((await channelsOf()).results.filter(r => r.c === 'c-a')).toHaveLength(2)
    expect(await one<{ n: number }>("SELECT count(DISTINCT contact_id) n FROM contact_channels WHERE channel_id='wa-a'")).toEqual({ n: 1 })
  })
})

describe('achado 3: assinar o app na conta', () => {
  const ok = (body: unknown) => Response.json(body)
  /** Graph simulado: o número, o debug_token, a lista de números da conta e as inscrições do app. */
  function graph(options: { subscribed?: string[]; targets?: string[]; failSubscribe?: boolean; noDebug?: boolean } = {}) {
    const calls: { method: string; url: string }[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET'
      calls.push({ method, url })
      if (url.includes('/debug_token') && options.noDebug) return Response.json({ error: { code: 190 } }, { status: 400 })
      if (url.includes('/debug_token')) return ok({ data: { app_id: 'APP1', granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: options.targets ?? ['777', '888'] }, { scope: 'whatsapp_business_messaging', target_ids: ['777'] }] } })
      if (url.includes('/subscribed_apps')) {
        if (method === 'POST') return options.failSubscribe ? Response.json({ error: { code: 200 } }, { status: 403 }) : ok({ success: true })
        return ok({ data: (options.subscribed ?? []).map(id => ({ whatsapp_business_api_data: { id, name: 'x' } })) })
      }
      if (url.includes('/888/phone_numbers')) return ok({ data: [{ id: phoneId }] })
      if (url.includes('/phone_numbers')) return ok({ data: [{ id: '999' }] })
      return ok({ id: phoneId, verified_name: 'Loja', display_phone_number: '+55 11 4000-0000' })
    })
    return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
  }
  const connect = (fetchImpl: typeof fetch, credentials: Record<string, string> = {}) => metaWhatsappCloud.connect({ connection, credentials: { accessToken: 'TESTONLY', phoneNumberId: phoneId, ...credentials }, hookUrl: '', webhookSecret: '', fetch: fetchImpl })
  const posts = (calls: { method: string }[]) => calls.filter(c => c.method === 'POST')

  it('assina o app quando a conta não o tem na lista', async () => {
    const { calls, fetchImpl } = graph({ subscribed: [] })
    expect(await connect(fetchImpl, { wabaId: '888' })).toMatchObject({ kind: 'done', accountId: '888' })
    expect(posts(calls)).toMatchObject([{ url: expect.stringContaining('/888/subscribed_apps') }])
  })
  it('não assina de novo (nem apaga um callback alternativo) quando o app já está na lista', async () => {
    const { calls, fetchImpl } = graph({ subscribed: ['APP1'] })
    await connect(fetchImpl, { wabaId: '888' })
    expect(posts(calls)).toHaveLength(0)
  })
  it('com a lista ocupada por outro app e sem conseguir saber o nosso id, não mexe', async () => {
    const { calls, fetchImpl } = graph({ subscribed: ['OUTRO'], noDebug: true })
    await connect(fetchImpl, { wabaId: '888' })
    expect(posts(calls)).toHaveLength(0)
  })
  it('com o nosso id conhecido e a lista com outro app, assina', async () => {
    const { calls, fetchImpl } = graph({ subscribed: ['OUTRO'] })
    await connect(fetchImpl, { wabaId: '888' })
    expect(posts(calls)).toHaveLength(1)
  })
  it('sem wabaId digitado, acha a conta pelo debug_token que contém o número', async () => {
    const { calls, fetchImpl } = graph()
    expect(await connect(fetchImpl)).toMatchObject({ kind: 'done', accountId: '888' })
    expect(posts(calls)).toMatchObject([{ url: expect.stringContaining('/888/subscribed_apps') }])
  })
  it('recusa na assinatura não derruba a conexão', async () => {
    const { fetchImpl } = graph({ failSubscribe: true })
    expect(await connect(fetchImpl, { wabaId: '888' })).toMatchObject({ kind: 'done', externalId: phoneId, accountId: '888' })
  })
  it('o token só vai para o host do Graph configurado', async () => {
    const { calls, fetchImpl } = graph()
    await connect(fetchImpl)
    expect(calls.every(c => c.url.startsWith('https://graph.facebook.com/'))).toBe(true)
  })
})

describe('achado 4: avisos de conta de um número só', () => {
  const conta = (value: Record<string, unknown>) => ({ object: 'whatsapp_business_account', entry: [{ id: 'test-waba', time: Number(now()), changes: [{ field: 'account_update', value }] }] })
  beforeEach(async () => { await runtime.DB.prepare("UPDATE channels SET settings=json_set(settings,'$.accountId','test-waba','$.displayPhone','+55 11 4000-0000') WHERE id='wa-a'").run() })
  const restricao = { event: 'ACCOUNT_RESTRICTION', restriction_info: [{ restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING', expiration: Number(now()) + 3600 }] }
  it('aviso sem phone_number vale para a conexão inteira', async () => {
    await deliver(conta(restricao))
    expect((await health()).restrictions.items).toHaveLength(1)
  })
  it('aviso de outro número não é gravado nesta conexão', async () => {
    await deliver(conta({ ...restricao, phone_number: '551199999999' }))
    expect((await health()).restrictions).toBeUndefined()
  })
  it('aviso deste número é gravado', async () => {
    await deliver(conta({ ...restricao, phone_number: '551140000000' }))
    expect((await health()).restrictions.items).toHaveLength(1)
  })
})

describe('achado 5: descadastro de marketing só com wa_id', () => {
  const marcado = async () => (await one<{ m: number | null }>("SELECT marketing_blocked_at m FROM contact_channels WHERE channel_id='wa-a' AND external_user_id=?", user))!.m
  it('stop sem user_id bloqueia o contato BSUID que tem aquele telefone', async () => {
    await deliver(prefs({ wa_id: phone, value: 'stop' }))
    expect(await marcado()).toBeGreaterThan(0)
  })
  it('resume sem user_id desbloqueia', async () => {
    const t = Number(now())
    await deliver(prefs({ wa_id: phone, value: 'stop', timestamp: t }))
    await deliver(prefs({ wa_id: phone, value: 'resume', timestamp: t + 5 }))
    expect(await marcado()).toBeNull()
  })
  it('telefone antigo guardado como apelido também acha o contato', async () => {
    await runtime.DB.prepare("UPDATE contact_channels SET phone_e164='+5511900000077' WHERE channel_id='wa-a' AND external_user_id=?").bind(user).run()
    await deliver(prefs({ wa_id: phone, value: 'stop' }))
    expect(await marcado()).toBeGreaterThan(0)
  })
  it('telefone de outra pessoa não bloqueia este contato', async () => {
    await deliver(prefs({ wa_id: '5511911111111', value: 'stop' }))
    expect(await marcado()).toBeNull()
  })
})

describe('achado 6: limite de taxa e marketing recusado em /messages', () => {
  const ctx = (fetchImpl: typeof fetch, settings: Record<string, unknown> = {}) => ({ connection: { ...connection, settings }, credentials: { accessToken: 'TESTONLY', phoneNumberId: phoneId }, fetch: fetchImpl,
    target: { kind: 'direct' as const, externalUserId: user } })
  const resposta = (code: number, headers: Record<string, string> = {}) => Response.json({ error: { code, message: 'x' } }, { status: 400, headers })
  it('131056 sem Retry-After espera o intervalo de 6 s do par', async () => {
    const fetchImpl = vi.fn(async () => resposta(131056)) as unknown as typeof fetch
    expect(await metaWhatsappCloud.send(ctx(fetchImpl), { kind: 'text', text: 'oi' })).toEqual({ ok: false, reason: 'rate_limited', retryAfterSec: 6 })
  })
  it('Retry-After da Meta continua mandando', async () => {
    const fetchImpl = vi.fn(async () => resposta(131056, { 'Retry-After': '9' })) as unknown as typeof fetch
    expect(await metaWhatsappCloud.send(ctx(fetchImpl), { kind: 'text', text: 'oi' })).toMatchObject({ retryAfterSec: 9 })
  })
  it('130429 sem cabeçalho segue em 1 s', async () => {
    const fetchImpl = vi.fn(async () => resposta(130429)) as unknown as typeof fetch
    expect(await metaWhatsappCloud.send(ctx(fetchImpl), { kind: 'text', text: 'oi' })).toMatchObject({ retryAfterSec: 1 })
  })
  it('131063 em /messages reenvia uma vez por /marketing_messages', async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => { urls.push(String(input)); return urls.length === 1 ? resposta(131063) : Response.json({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.ok' }] }) }) as unknown as typeof fetch
    const modelo = { kind: 'template' as const, templateId: 'promo', category: 'utility' as const, params: { language_code: 'pt_BR' } }
    expect(await metaWhatsappCloud.send(ctx(fetchImpl), modelo as never)).toMatchObject({ ok: true, externalId: 'wamid.ok' })
    expect(urls.map(u => u.split('/').pop())).toEqual(['messages', 'marketing_messages'])
  })
  it('131063 que continua recusado não entra em laço', async () => {
    const fetchImpl = vi.fn(async () => resposta(131063)) as unknown as typeof fetch
    const modelo = { kind: 'template' as const, templateId: 'promo', category: 'utility' as const, params: { language_code: 'pt_BR' } }
    expect(await metaWhatsappCloud.send(ctx(fetchImpl), modelo as never)).toMatchObject({ ok: false, reason: 'rejected', code: '131063' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
