/**
 * Conta (WABA) dona do número e saúde de envio lidas em GET /{phone-number-id}?fields=health_status
 * (developers.facebook.com/documentation/business-messaging/whatsapp/support/health-status).
 * Um número pode aparecer em /{waba}/phone_numbers de duas contas (a compartilhada, CLIENT_OWNED, e a dona); a Meta procura os modelos na dona.
 */
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createConnection, getConnection, refreshConnection, rotateCredentials } from '../src/channels/core/connections'
import { openRow } from '../src/channels/core/credentials'
import { templateAccountOf } from '../src/channels/meta-templates'
import { seedAuth } from './auth-helpers'

const phone = '511', shared = '537', owner = '1657', base = 'https://motor.exemplo.test'
const blocked = { health_status: { can_send_message: 'BLOCKED', entities: [
  { entity_type: 'PHONE_NUMBER', id: phone, can_send_message: 'AVAILABLE' },
  { entity_type: 'WABA', id: owner, can_send_message: 'BLOCKED', errors: [{ error_code: 141006, error_description: 'There is an error with the payment method. This will block business initiated conversations.', possible_solution: 'Update the payment method.' }] },
  { entity_type: 'BUSINESS', id: '524', can_send_message: 'AVAILABLE' },
  { entity_type: 'APP', id: '287', can_send_message: 'AVAILABLE', can_receive_call_sip: 'BLOCKED', errors: [{ error_code: 138025, error_description: 'SIP not configured' }] },
] }, id: phone }
const clean = { health_status: { can_send_message: 'AVAILABLE', entities: blocked.health_status.entities.map(({ errors: _e, ...e }) => ({ ...e, can_send_message: 'AVAILABLE', ...(e.entity_type === 'APP' ? { can_receive_call_sip: 'AVAILABLE' } : {}) })) }, id: phone }

let health: { status: number; body: unknown }
const paths: string[] = []
beforeEach(async () => {
  await seedAuth()
  health = { status: 200, body: blocked }
  paths.length = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input)), path = url.pathname.replace(/^\/v[\d.]+/, ''), method = init?.method ?? 'GET'
    paths.push(`${method} ${path}${url.search}`)
    if (path === '/debug_token') return Response.json({ data: { app_id: 'APP1', granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: [shared, owner] }] } })
    if (path === `/${shared}/phone_numbers` || path === `/${owner}/phone_numbers`) return Response.json({ data: [{ id: phone }] })
    if (path.endsWith('/subscribed_apps')) return Response.json({ data: [{ whatsapp_business_api_data: { id: 'APP1' } }] })
    if (path === `/${phone}` && method === 'POST') return Response.json({ success: true })
    if (path === `/${phone}`) {
      const fields = url.searchParams.get('fields') ?? ''
      if (fields === 'health_status') return Response.json(health.body, { status: health.status })
      if (fields.includes('webhook_configuration')) return Response.json({ id: phone, webhook_configuration: {} })
      return Response.json({ id: phone, verified_name: 'Loja', display_phone_number: '+55 11 4000-0000' })
    }
    return Response.json({ error: { code: 100 } }, { status: 400 })
  })
})
afterEach(() => vi.restoreAllMocks())

const create = (wabaId?: string) => createConnection(env, 'a', { kind: 'whatsapp', provider: 'meta_whatsapp_cloud',
  credentials: { accessToken: 'TESTONLY', phoneNumberId: phone, appSecret: 'segredo', ...(wabaId ? { wabaId } : {}) } }, base)
const stored = async (id: string) => {
  const row = await env.DB.prepare('SELECT settings, provider_health, credentials_ciphertext, credentials_iv, credentials_key_version FROM channels WHERE id=?').bind(id).first<Record<string, any>>()
  return { settings: JSON.parse(row!.settings), health: JSON.parse(row!.provider_health), credentials: await openRow(env, 'a', id, row as never) as Record<string, string> }
}

it('conta informada é a compartilhada: grava a dona do número, avisa em português e os modelos usam a dona', async () => {
  const { connection, warning } = await create(shared)
  const { settings, credentials } = await stored(connection.id)
  expect(settings.accountId).toBe(owner)
  expect(credentials.wabaId).toBe(owner)
  expect(templateAccountOf('whatsapp', credentials, settings)).toBe(owner)
  expect(warning).toContain(shared)
  expect(warning).toContain(owner)
  expect(warning).toMatch(/dona do número/)
  // A assinatura do app vai para a conta dona, nunca para a compartilhada.
  expect(paths.some(p => p.includes(`/${owner}/subscribed_apps`))).toBe(true)
  expect(paths.some(p => p.includes(`/${shared}/subscribed_apps`))).toBe(false)
})

it('em branco: usa a dona do número, mesmo com a compartilhada primeiro na lista do token', async () => {
  const { connection, warning } = await create()
  expect((await stored(connection.id)).settings.accountId).toBe(owner)
  expect(warning).toBeUndefined()
})

it('conta informada já é a dona: sem aviso', async () => {
  const { connection, warning } = await create(owner)
  expect((await stored(connection.id)).settings.accountId).toBe(owner)
  expect(warning).toBeUndefined()
})

it('a leitura da saúde falhando não derruba a conexão: vale a prova pela lista de números, sem aviso e sem mexer na saúde', async () => {
  health = { status: 400, body: { error: { code: 100, message: '(#100) Tried accessing nonexisting field (health_status)' } } }
  const { connection, warning } = await create(shared)
  const { settings, health: kept } = await stored(connection.id)
  expect(settings.accountId).toBe(shared)
  expect(warning).toBeUndefined()
  expect(kept.sending).toBeUndefined()
  expect(connection.health.sending).toBeUndefined()
})

it('bloqueio de envio vai para a saúde por entidade (sem o bloqueio só de chamada SIP) e some quando a leitura seguinte vem limpa', async () => {
  const { connection } = await create(owner)
  const view = await getConnection(env, 'a', connection.id, base)
  expect(view.health.sending).toMatchObject({ status: 'BLOCKED', items: [{ entity: 'WABA', status: 'BLOCKED', errors: [{ code: 141006 }] }] })
  expect((view.health.sending as { items: unknown[] }).items).toHaveLength(1)
  health = { status: 200, body: clean }
  const refreshed = await refreshConnection(env, 'a', connection.id, base)
  expect(refreshed.connection.health.sending).toBeUndefined()
  // Leitura que falha depois não traz de volta nem apaga nada.
  health = { status: 500, body: {} }
  await refreshConnection(env, 'a', connection.id, base)
  expect((await getConnection(env, 'a', connection.id, base)).health.sending).toBeUndefined()
})

it('trocar credencial com a conta compartilhada corrige para a dona e devolve o aviso', async () => {
  health = { status: 400, body: {} }
  const { connection } = await create(shared)
  expect((await stored(connection.id)).settings.accountId).toBe(shared)
  health = { status: 200, body: clean }
  const result = await rotateCredentials(env, 'a', connection.id, { wabaId: shared }, base)
  expect(result.warning).toMatch(/dona do número/)
  const { settings, credentials } = await stored(connection.id)
  expect(settings.accountId).toBe(owner)
  expect(credentials.wabaId).toBe(owner)
})

it('atualizar a conexão troca a conta guardada pela dona e avisa', async () => {
  health = { status: 400, body: {} }
  const { connection } = await create(shared)
  health = { status: 200, body: blocked }
  const result = await refreshConnection(env, 'a', connection.id, base)
  expect(result.warning).toMatch(/dona do número/)
  const { settings } = await stored(connection.id)
  expect(settings.accountId).toBe(owner)
  expect(templateAccountOf('whatsapp', (await stored(connection.id)).credentials, settings)).toBe(owner)
  expect(result.connection.health.sending).toMatchObject({ status: 'BLOCKED' })
})
