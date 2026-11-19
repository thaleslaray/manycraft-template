import { env } from 'cloudflare:workers'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/env'
import { connectionFromRow, liteRow } from '../src/channels/core/connection'
import { syncZapi } from '../src/channels/zapi-sync'
import { telegramBot } from '../src/channels/telegram-bot'
import { markUnreachable } from '../src/email-channel/service'
import { emailConnection, emailContact } from '../src/email-channel/store'
import { sendVia } from '../src/channels/core/delivery'
import { ChannelLimiter } from '../src/flow/limiter'
import type { Run } from '../src/flow/types'
import { graph } from './fixtures'
import { origin, seedAuth } from './auth-helpers'
import { ZAPI_USER, zapiMessage } from './conformance/zapi-fixture'

// Alcance e consentimento (channels/core/consent.ts): toda mudança grava a hora; fato mais velho que a última mudança não vale.
const bindings = () => ({ ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: 'a', DEV_PROVIDER_API_BASE: undefined, PUBLIC_BASE_URL: undefined } as Env)
const call = (method: string, path: string, body?: unknown) => app.request(`${origin}/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
  headers: { 'x-workspace': 'a', origin, 'content-type': 'application/json' } }, bindings())
const identity = (id: string) => env.DB.prepare('SELECT opted_in,opted_out_at,consent_changed_at,blocked_at,block_changed_at FROM contact_channels WHERE id=?').bind(id)
  .first<{ opted_in: number; opted_out_at: number | null; consent_changed_at: number | null; blocked_at: number | null; block_changed_at: number | null }>()

beforeEach(seedAuth)

describe('mudanças de consentimento feitas pela equipe e pelo sistema gravam a hora', () => {
  it('descadastro em massa (portabilidade de contatos)', async () => {
    const before = Date.now()
    expect((await call('POST', '/contacts/bulk-unsubscribe', { ids: ['c-a'], confirmation: 'DESCADASTRAR' })).status).toBe(200)
    const row = await identity('cc-a')
    expect(row).toMatchObject({ opted_in: 0 })
    expect(row!.consent_changed_at).toBeGreaterThanOrEqual(before)
    expect(row!.opted_out_at).toBe(row!.consent_changed_at)
  })
  it('limpeza da lista com descadastro', async () => {
    await env.DB.prepare('UPDATE contacts SET last_interaction_at=1 WHERE id=?').bind('c-a').run()
    expect((await call('POST', '/contacts/cleanup', { inactive_days: 30, action: 'unsubscribe', apply: true })).status).toBe(200)
    expect((await identity('cc-a'))!.consent_changed_at).not.toBeNull()
  })
  it('e-mail inalcançável e e-mail cadastrado já inscrito', async () => {
    const channel = await emailConnection(env, 'a')
    const contact = await emailContact(env, 'a', channel, 'pessoa@example.test', true)
    const row = () => env.DB.prepare('SELECT opted_in,consent_changed_at FROM contact_channels WHERE channel_id=? AND contact_id=?').bind(channel, contact).first<{ opted_in: number; consent_changed_at: number | null }>()
    expect(await row()).toMatchObject({ opted_in: 1, consent_changed_at: expect.any(Number) })
    await markUnreachable(env, 'a', contact)
    expect(await row()).toMatchObject({ opted_in: 0, consent_changed_at: expect.any(Number) })
  })
})

describe('primeira mensagem', () => {
  const zapi = (payload: Record<string, unknown>, receivedAt: number) => syncZapi({
    env, event: { version: 1, provider: 'meta', workspaceId: 'a', channelId: 'zp', eventId: crypto.randomUUID(), receivedAt, payload },
    connection: connectionFromRow({ ...liteRow('whatsapp', 'zp', 'a'), provider: 'zapi' }), credentials: {}, fetch,
  } as Parameters<typeof syncZapi>[0])
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO channels (id,workspace_id,type,provider,external_id) VALUES ('zp','a','whatsapp','zapi','5511999990000')"),
      env.DB.prepare("INSERT INTO contacts (id,workspace_id,first_name) VALUES ('c-z','a','Ana')"),
      env.DB.prepare(`INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,identity_kind,address_kind,opted_in)
        VALUES ('cc-z','a','c-z','zp',?,'provider_id','wa_pn',0)`).bind(ZAPI_USER),
    ])
  })
  it('mais velha que um descadastro feito pela equipe não inscreve (antes inscrevia)', async () => {
    const now = Date.now()
    await call('POST', '/contacts/bulk-unsubscribe', { ids: ['c-z'], confirmation: 'DESCADASTRAR' })
    await zapi({ ...zapiMessage(), momment: now - 60_000 }, now + 1000)
    expect(await identity('cc-z')).toMatchObject({ opted_in: 0 })
  })
  it('sem mudança registrada, a primeira mensagem inscreve como antes', async () => {
    await zapi({ ...zapiMessage(), momment: Date.now() - 1000 }, Date.now())
    expect(await identity('cc-z')).toMatchObject({ opted_in: 1, consent_changed_at: null })
  })
})

describe('bloqueio', () => {
  const T = Math.floor(Date.now() / 1000) - 100
  const member = (status: 'kicked' | 'member', date: number) => telegramBot.sync!({
    env, event: { version: 1, provider: 'telegram', workspaceId: 'a', channelId: 'ch-a', eventId: crypto.randomUUID(), receivedAt: Date.now(),
      payload: { update_id: 1, my_chat_member: { date, from: { id: 1 }, chat: { id: 1, type: 'private' }, new_chat_member: { status } } } },
    connection: connectionFromRow({ ...liteRow('telegram', 'ch-a', 'a'), provider: 'telegram_bot' }), credentials: {}, fetch,
  } as never, { kind: status === 'kicked' ? 'optout' : 'optin', externalUserId: 'user-a' } as never)
  it('desbloqueio (t=2) entregue antes do bloqueio (t=1) termina desbloqueado (antes o bloqueio atrasado valia)', async () => {
    await member('member', T + 2)
    await member('kicked', T + 1)
    expect(await identity('cc-a')).toMatchObject({ blocked_at: null, block_changed_at: (T + 2) * 1000 })
    await member('kicked', T + 3)
    expect(await identity('cc-a')).toMatchObject({ blocked_at: (T + 3) * 1000 })
  })
  it('Telegram: a recusa de envio por bloqueio grava a hora no segundo (a do my_chat_member); o desbloqueio no mesmo segundo vale', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('v-bloq','a','auto-a',1,?)").bind(JSON.stringify(graph)),
      env.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,automation_version_id,channel_id) VALUES ('run-bloq','a','c-a','v-bloq','ch-a')"),
    ])
    vi.spyOn(ChannelLimiter.prototype, 'acquire').mockResolvedValue({ allowed: true, retryAfter: 0 })
    const now = vi.spyOn(Date, 'now').mockReturnValue((T + 20) * 1000 + 700)
    const run = { id: 'run-bloq', workspace_id: 'a', contact_id: 'c-a', channel_id: 'ch-a', external_user_id: 'user-a' } as Run
    const result = await sendVia(env as never, { run, runId: 'run-bloq', step: 0, part: 0, channelId: 'ch-a', externalUserId: 'user-a', mode: { ok: true, mode: 'free' } },
      'telegram', 'oi', [], async () => ({ ok: false, reason: 'blocked' }))
    now.mockRestore()
    vi.restoreAllMocks()
    expect(result).toMatchObject({ ok: false, reason: 'blocked' })
    expect(await identity('cc-a')).toMatchObject({ blocked_at: (T + 20) * 1000, block_changed_at: (T + 20) * 1000 })
    // Desbloqueou logo depois, no mesmo segundo: o Telegram manda só o segundo, e o desbloqueio não pode perder para a recusa.
    await member('member', T + 20)
    expect(await identity('cc-a')).toMatchObject({ blocked_at: null })
  })
  it('bloqueio mais velho que a última mensagem do contato não vale', async () => {
    await env.DB.prepare('UPDATE contact_channels SET last_inbound_at=? WHERE id=?').bind((T + 5) * 1000, 'cc-a').run()
    await member('kicked', T + 4)
    expect(await identity('cc-a')).toMatchObject({ blocked_at: null })
  })
})

describe('código-fonte', () => {
  const sources = Object.entries(import.meta.glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
  // Já seguem a regra com SQL à mão; são do executor de fluxos (ver o cabeçalho de consent.ts).
  const handWritten = ['/channels/core/consent.ts', '/flow/dispatch.ts', '/flow/questions.ts']
  it('só o módulo de consentimento escreve opted_in, opted_out_at, consent_changed_at, blocked_at e block_changed_at', () => {
    expect(sources.length).toBeGreaterThan(100)
    const offenders: string[] = []
    for (const [path, text] of sources) {
      if (handWritten.some(end => path.endsWith(end))) continue
      for (const statement of text.match(/UPDATE contact_channels SET[\s\S]*?WHERE/g) ?? []) {
        if (/\b(opted_in|opted_out_at|consent_changed_at|blocked_at|block_changed_at)\s*=/.test(statement)) offenders.push(`${path}: ${statement.slice(0, 80)}`)
      }
      for (const statement of text.match(/INSERT INTO contact_channels\s*\([^)]*\)/g) ?? []) {
        // Cópia de identidade (troca de número) leva as horas junto; identidade nova inscrita grava a hora (newIdentityConsent, conferido acima).
        if (/\b(blocked_at|opted_out_at)\b/.test(statement) && !/consent_changed_at/.test(statement)) offenders.push(`${path}: ${statement.slice(0, 80)}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
