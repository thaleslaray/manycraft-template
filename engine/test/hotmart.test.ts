import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { app } from '../src/index'
import { authenticatedRequest, fixtureCookie, origin, seedAuth } from './auth-helpers'

let cookie = ''
beforeEach(async () => { await seedAuth(); cookie = await fixtureCookie() })
const panel = (path: string, method = 'GET', body?: unknown) => authenticatedRequest(path, 'a', { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, cookie)
const deliver = (url: string, body: unknown, hottok?: string) => app.request(url.replace(/^https?:\/\/[^/]+/, origin), { method: 'POST', headers: { 'content-type': 'application/json', ...(hottok ? { 'X-HOTMART-HOTTOK': hottok } : {}) }, body: JSON.stringify(body) }, env)

it('webhook da Hotmart confere o hottok, cria o comprador como contato, preenche produto e dispara só o gatilho do evento e produto', async () => {
  const { url } = await (await panel('integrations/hotmart', 'PUT', { hottok: 'segredo-hot' })).json() as { url: string }
  expect(url).toMatch(/\/api\/hooks\/hotmart\/[a-f0-9]{36}$/)
  await env.DB.prepare("INSERT INTO custom_fields (id,workspace_id,name,type) VALUES ('f-prod','a','produto','text')").run()
  await env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('v-h','a','auto-a',1,(SELECT draft_graph FROM automations WHERE id='auto-a'))").run()
  await env.DB.prepare("UPDATE automations SET status='live',published_version_id='v-h' WHERE id='auto-a'").run()
  const trigger = await panel('automations/auto-a/triggers', 'POST', { type: 'hotmart', name: 'Compra', node_id: 't', config: { events: ['PURCHASE_APPROVED'], product_ids: ['123'] } })
  expect(trigger.status).toBe(201)
  expect((await panel('automations/auto-a/triggers/' + (await trigger.json() as { id: string }).id, 'PATCH', { state: 'active' })).status).toBe(200)
  const event = (name: string, product = '123') => ({ event: name, data: { buyer: { email: 'Joana@Exemplo.test', name: 'Joana Lima' }, product: { id: product, name: 'Curso X' }, purchase: { status: 'APPROVED' } } })
  expect((await deliver(url, event('PURCHASE_APPROVED'))).status).toBe(401)
  expect(await (await deliver(url, event('PURCHASE_APPROVED'), 'segredo-hot')).json()).toEqual({ accepted: true, started: 0 })
  const contact = await env.DB.prepare("SELECT id,first_name FROM contacts WHERE email='joana@exemplo.test'").first<{ id: string; first_name: string }>()
  expect(contact!.first_name).toBe('Joana')
  expect(await env.DB.prepare("SELECT value FROM contact_field_values WHERE contact_id=? AND field_id='f-prod'").bind(contact!.id).first('value')).toBe('"Curso X"')
  await env.DB.prepare("INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('cc-j','a',?,'ch-a','999',1)").bind(contact!.id).run()
  expect(await (await deliver(url, event('PURCHASE_APPROVED', '999'), 'segredo-hot')).json()).toMatchObject({ started: 0 })
  expect(await (await deliver(url, event('PURCHASE_CANCELED'), 'segredo-hot')).json()).toMatchObject({ started: 0 })
  const started = await (await deliver(url, event('PURCHASE_APPROVED'), 'segredo-hot')).json() as { started: number }
  expect(started.started).toBe(env.FLOW_RUN ? 1 : 0)
  expect((await deliver(url.replace(/[a-f0-9]{36}$/, '0'.repeat(36)), event('PURCHASE_APPROVED'))).status).toBe(404)
})
