import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest, fixtureCookie, seedAuth } from './auth-helpers'

let cookie = ''
beforeEach(async () => { await seedAuth(); cookie = await fixtureCookie() })
const panel = (path: string, method = 'GET', body?: unknown) => authenticatedRequest(path, 'a', { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, cookie)

it('gatilho Hotmart e entrada externa criados em rascunho nascem Inicial, aparecem na lista e só ligam depois de publicar', async () => {
  const hotmart = await (await panel('automations/auto-a/triggers', 'POST', { type: 'hotmart', name: 'Compra', node_id: 't', config: { events: ['PURCHASE_APPROVED'], product_ids: [] } })).json() as { id: string }
  const api = await (await panel('automations/auto-a/triggers', 'POST', { type: 'api', name: 'compra_x', node_id: 't' })).json() as { id: string }
  expect(await env.DB.prepare("SELECT id,status FROM triggers WHERE id IN (?,?) ORDER BY name").bind(hotmart.id, api.id).all()).toMatchObject({ results: [{ status: 'initial' }, { status: 'initial' }] })

  const listed = await (await panel('automations/auto-a/triggers')).json() as { rows: { id: string; type: string; name: string; node_id: string; state: string; external: Record<string, unknown> }[] }
  expect(listed.rows.find(row => row.id === hotmart.id)).toMatchObject({ type: 'hotmart', name: 'Compra', node_id: 't', state: 'initial', external: { events: ['PURCHASE_APPROVED'] } })
  expect(listed.rows.find(row => row.id === api.id)).toMatchObject({ type: 'api', node_id: 't', external: { trigger_name: 'compra_x' } })

  const early = await panel(`automations/auto-a/triggers/${hotmart.id}`, 'PATCH', { state: 'active' })
  expect(early.status).toBe(409)
  expect(await env.DB.prepare('SELECT status FROM triggers WHERE id=?').bind(hotmart.id).first('status')).toBe('initial')

  await env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('v-ext','a','auto-a',1,(SELECT draft_graph FROM automations WHERE id='auto-a'))").run()
  await env.DB.prepare("UPDATE automations SET status='live',published_version_id='v-ext' WHERE id='auto-a'").run()
  const on = await panel(`automations/auto-a/triggers/${hotmart.id}`, 'PATCH', { state: 'active' })
  expect(on.status).toBe(200)
  expect(await env.DB.prepare('SELECT status FROM triggers WHERE id=?').bind(hotmart.id).first('status')).toBe('active')
})

it('pedir o gatilho já ativo numa automação em rascunho não o deixa ativo no banco', async () => {
  const late = await panel('automations/auto-a/triggers', 'POST', { type: 'hotmart', name: 'Tarde', node_id: 't', config: { events: ['PURCHASE_APPROVED'], product_ids: [] }, enabled: true })
  const created = await late.json() as { id: string }
  expect(await env.DB.prepare('SELECT status FROM triggers WHERE id=?').bind(created.id).first('status')).toBe('initial')
})
