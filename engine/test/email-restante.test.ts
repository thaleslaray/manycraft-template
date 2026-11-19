import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { authenticatedRequest as request, seedAuth } from './auth-helpers'
import { app } from '../src/index'
import { condition } from '../src/flow/nodes'
import { receiveReply } from '../src/email-channel/receive'

beforeEach(seedAuth)
const write = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) })
const json = async (path: string, init?: RequestInit) => (await request(path, 'a', init)).json() as Promise<any>
async function mail() {
  const settings = await json('email/settings')
  await json('email/settings', write('PATCH', { company: { name: 'Empresa', address: 'Rua teste' } }))
  const sent = await json('email/test', write('POST', { senderId: settings.defaultSenderId, to: 'metricas@example.test', subject: 'Sua inscrição', text: 'Conteúdo', html: '<a href="https://example.test/acao">Abrir</a>', consent: true }))
  return (await env.DB.prepare('SELECT * FROM email_messages WHERE id=?').bind(sent.id).first<any>())!
}
it('filtra lista global por endereço, consentimento e interações sem misturar o workspace', async () => {
  expect(await json('contacts?email_filter=defined')).toMatchObject({ total: 0 })
  const m = await mail()
  expect(await json('contacts?email_filter=defined')).toMatchObject({ total: 1 })
  expect(await json('contacts?email_filter=opened')).toMatchObject({ total: 0 })
  await app.request(`https://engine.test/api/email-public/open/${m.token}.gif`, {}, env)
  expect(await json('contacts?email_filter=opened_not_clicked')).toMatchObject({ total: 1 })
  expect(await json('contacts?email_filter=not_opened')).toMatchObject({ total: 0 })
  await json(`email/contacts/${m.contact_id}`, write('PATCH', { optedIn: false }))
  expect(await json('contacts?email_filter=unsubscribed')).toMatchObject({ total: 1 })
  expect(await json('contacts?email_filter=subscribed')).toMatchObject({ total: 0 })
})
it('segmento persistido reutiliza filtro aninhado nas condições e na lista global', async () => {
  const m = await mail()
  const filter = { match: 'all', rules: [{ type: 'email', filter: 'defined' }, { match: 'any', rules: [{ type: 'email', filter: 'opened' }, { type: 'email', filter: 'subscribed' }] }] }
  const segment = await json('email/segments', write('POST', { name: 'Inscritos interessados', filter }))
  expect(segment).toMatchObject({ name: 'Inscritos interessados', filter })
  expect(await json(`contacts?segment_id=${segment.id}`)).toMatchObject({ total: 1 })
  const unopenedFilter = encodeURIComponent(JSON.stringify({ match: 'all', rules: [{ type: 'system_field', field: 'email_opens', operator: 'gte', value: 1 }] }))
  expect(await json(`contacts?segment_id=${segment.id}&contact_filter=${unopenedFilter}`)).toMatchObject({ total: 0 })
  const run = { workspace_id: 'a', contact_id: m.contact_id } as any
  expect(await condition(env as any, run, { match: 'all', rules: [{ type: 'segment', segment_id: segment.id, operator: 'has' }, { type: 'system_field', field: 'email_opens', operator: 'equals', value: 0 }] })).toBe('true')
  expect(await condition(env as any, run, { match: 'all', rules: [{ type: 'segment', segment_id: segment.id, operator: 'not_has' }] })).toBe('false')
  expect((await request(`email/segments/${segment.id}`, 'b')).status).toBe(404)
})
it('regra global de abertura com condição dispara só uma vez, aplica trava e permite editar/desligar', async () => {
  const m = await mail()
  await env.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) SELECT 'v-email-restante',workspace_id,id,1,draft_graph FROM automations WHERE id='auto-a'").run()
  await env.DB.prepare("UPDATE automations SET status='live',published_version_id='v-email-restante' WHERE id='auto-a'").run()
  const rule = await json('email/rules', write('POST', { name: 'Quem abriu', event: 'email_opened', automationId: 'auto-a', frequency: 'once', active: true, filter: { match: 'all', rules: [{ type: 'email', filter: 'opened_not_clicked' }] } }))
  expect(rule).toMatchObject({ name: 'Quem abriu', event: 'email_opened', active: true })
  const create = vi.fn().mockResolvedValue({}), local = { ...env, FLOW_RUN: { create, get: vi.fn() } as any }
  for (let i = 0; i < 2; i++) await app.request(`https://engine.test/api/email-public/open/${m.token}.gif`, {}, local)
  expect(create).toHaveBeenCalledTimes(1)
  expect(await json(`email/rules/${rule.id}`, write('PATCH', { active: false }))).toMatchObject({ active: false, frequency: 'once', event: 'email_opened', filter: { match: 'all', rules: [{ type: 'email', filter: 'opened_not_clicked' }] } })
  expect(await json('email/rules')).toContainEqual(expect.objectContaining({ id: rule.id, active: false }))
})
it('STOP executa confirmação padrão uma vez e preserva descadastro sem liberar marketing', async () => {
  const m = await mail()
  await env.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) SELECT 'v-stop',workspace_id,id,1,draft_graph FROM automations WHERE id='auto-a'").run()
  await env.DB.prepare("UPDATE automations SET status='live',published_version_id='v-stop' WHERE id='auto-a'").run()
  expect(await json(`email/connections/${m.connection_id}/stop`, write('PUT', { text: 'Seu descadastro foi confirmado.', subject: 'Descadastro confirmado', automationId: 'auto-a' }))).toMatchObject({ text: 'Seu descadastro foi confirmado.' })
  const input = { from: m.recipient, to: m.reply_to, messageId: 'stop-default', inReplyTo: m.message_id, text: 'STOP' }
  const create = vi.fn().mockResolvedValue({}), local = { ...env, FLOW_RUN: { create, get: vi.fn() } as any }
  await receiveReply(local, input); await receiveReply(local, input)
  expect(create).toHaveBeenCalledTimes(1)
  expect(await env.DB.prepare("SELECT count(*) AS n FROM email_messages WHERE contact_id=? AND subject='Descadastro confirmado'").bind(m.contact_id).first()).toEqual({ n: 1 })
  expect(await env.DB.prepare('SELECT opted_in FROM contact_channels WHERE contact_id=? AND channel_id=?').bind(m.contact_id, m.connection_id).first()).toEqual({ opted_in: 0 })
})

it('condições globais preservam ausência, nulo e os tipos de campos personalizados', async () => {
  const run = { workspace_id: 'a', contact_id: 'c-a' } as any
  const test = async (operator: string, value?: unknown, field_id = 'field-a') => condition(env as any, run, { match: 'all', rules: [{ type: 'field', field_id, operator, value }] })
  expect(await test('not_equals', 'valor', 'ausente')).toBe('true')
  expect(await test('equals', null, 'ausente')).toBe('true')
  expect(await test('gt', 1)).toBe('false')
  expect(await test('contains', 'urs')).toBe('true')
  expect(await test('contains', 1)).toBe('false')
  await env.DB.prepare("UPDATE contact_field_values SET value='null' WHERE contact_id='c-a' AND field_id='field-a'").run()
  expect(await test('is_set')).toBe('true')
  expect(await test('equals', null)).toBe('true')
})

it('STOP confirma por padrão sem configuração e respeita o desligamento explícito', async () => {
  const m = await mail()
  expect(await json(`email/connections/${m.connection_id}/stop`)).toMatchObject({ enabled: true, subject: 'Descadastro confirmado', automationId: null })
  await receiveReply(env, { from: m.recipient, to: m.reply_to, messageId: 'stop-padrao', inReplyTo: m.message_id, text: 'parar' })
  expect(await env.DB.prepare("SELECT count(*) AS n FROM email_messages WHERE contact_id=? AND subject='Descadastro confirmado'").bind(m.contact_id).first()).toEqual({ n: 1 })
  await json(`email/connections/${m.connection_id}/stop`, write('PUT', { subject: 'Descadastro confirmado', text: '', enabled: false }))
  await receiveReply(env, { from: m.recipient, to: m.reply_to, messageId: 'stop-desligado', inReplyTo: m.message_id, text: 'STOP' })
  expect(await env.DB.prepare("SELECT count(*) AS n FROM email_messages WHERE contact_id=? AND subject='Descadastro confirmado'").bind(m.contact_id).first()).toEqual({ n: 1 })
})
