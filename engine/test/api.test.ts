import { env, exports } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { app } from '../src/index'
import { seedAuth, fixtureCookie } from './auth-helpers'
import type { AutomationDetail, AutomationRow, AutomationVersion, ContactDetail, ContactPage, Tag } from '../src/contracts'
import { graph } from './fixtures'

let cookieA = ''
beforeEach(async () => { await seedAuth(); cookieA = await fixtureCookie() })

const request = (path: string, workspace = 'a', init: RequestInit = {}) => exports.default.fetch(
  new Request(`https://engine.test/api/${path}`, {
    ...init,
    headers: { 'x-workspace': workspace, 'content-type': 'application/json', cookie: cookieA, origin: 'https://engine.test', ...init.headers },
  }))

it('GETs devolvem contratos do painel com JSON, ISO e booleans decodificados', async () => {
  const automationsResponse = await request('automations')
  expect(automationsResponse.status).toBe(200)
  const automations = await automationsResponse.json() as AutomationRow[]
  expect(automations).toHaveLength(1)
  expect(automations[0]).toMatchObject({ id: 'auto-a', draft_graph: graph, has_unpublished_changes: false, runs: 0, ctr: null, trigger_count: 1 })
  expect(automations[0]?.updated_at).toMatch(/^\d{4}-\d\d-\d\dT/)
  const automation = await (await request('automations/auto-a')).json() as AutomationDetail
  expect(automation).toMatchObject({ automation: { id: 'auto-a' }, published_version: null,
    triggers: [{ type: 'dm_keyword', active: true, config: { include: ['quero'], exclude: [], public_replies: [], target: 'all' } }] })
  const contacts = await (await request('contacts')).json() as ContactPage
  expect(contacts).toMatchObject({ rows: [{ id: 'c-a', workspace_id: 'a', tags: [{ id: 'tag-a', name: 'Etiqueta a' }], fields: { 'field-a': 'Curso' } }], total: 1, next_cursor: null })
  const detail = await (await request('contacts/c-a')).json() as ContactDetail
  expect(detail.channels[0]?.opted_in).toBe(true)
  const tags = await (await request('tags')).json() as Tag[]
  expect(tags).toMatchObject([{ id: 'tag-a', contact_count: 1 }])
  expect((await (await request('contacts?search=riana')).json() as ContactPage).rows).toHaveLength(1)
})

it('rotas escondem IDs e recusam escritas de outro workspace', async () => {
  expect((await request('automations/auto-b')).status).toBe(404)
  expect((await request('contacts/c-b')).status).toBe(404)
  expect((await request('automations/auto-b/draft', 'a', { method: 'PUT', body: JSON.stringify({ graph }) })).status).toBe(404)
  expect((await request('automations/auto-b/publish', 'a', { method: 'POST' })).status).toBe(404)
  expect((await (await request('contacts?tag_id=tag-b')).json() as ContactPage).rows).toEqual([])
})

it('rotas de draft/publicação preservam o snapshot anterior', async () => {
  const published = await request('automations/auto-a/publish', 'a', { method: 'POST' })
  expect(published.status).toBe(201)
  const version = await published.json() as AutomationVersion
  const next = structuredClone(graph)
  next.nodes[1]!.config = { blocks: [{ kind: 'text', text: 'Rascunho novo' }] }
  expect((await request('automations/auto-a/draft', 'a', { method: 'PUT', body: JSON.stringify({ graph: next }) })).status).toBe(200)
  const detail = await (await request('automations/auto-a')).json() as AutomationDetail
  expect(detail.automation.draft_graph).toEqual(next)
  expect(detail.published_version).toEqual(version)
})

it('header não autentica; sem sessão e input inválido retornam erros claros', async () => {
  expect((await exports.default.fetch(new Request('https://engine.test/api/tags'))).status).toBe(401)
  const production = await app.request('/api/tags', { headers: { 'x-workspace': 'a' } }, { ...env, APP_ENV: 'production' })
  expect(production.status).toBe(401)
  expect((await request('automations?status=unknown')).status).toBe(400)
  expect((await request('contacts?cursor=invalid')).status).toBe(400)
  expect((await request('automations/auto-a/draft', 'a', { method: 'PUT', body: 'inválido' })).status).toBe(400)
  expect((await request('automations/auto-a/draft', 'a', { method: 'PUT', body: JSON.stringify({ graph: { nodes: [{}] } }) })).status).toBe(400)
  expect((await request('inexistente')).status).toBe(404)
})

it('atalhos da lateral contam contatos por gatilho e por sequência e filtram a lista', async () => {
  await env.DB.batch([
    env.DB.prepare("UPDATE contacts SET optin_source='trigger:trg-a' WHERE id='c-a'"),
    env.DB.prepare("INSERT INTO sequences (id,workspace_id,name) VALUES ('seq-a','a','Boas-vindas em 3 dias')"),
    env.DB.prepare("INSERT INTO sequence_subscriptions (workspace_id,sequence_id,contact_id) VALUES ('a','seq-a','c-a')"),
  ])
  const facets = await (await request('contact-facets')).json() as { triggers: { id: string; count: number }[]; sequences: { id: string; count: number }[] }
  expect(facets.triggers).toEqual([expect.objectContaining({ id: 'trg-a', count: 1 })])
  expect(facets.sequences).toEqual([expect.objectContaining({ id: 'seq-a', count: 1 })])
  expect((await (await request('contacts?sequence_id=seq-a')).json() as ContactPage).total).toBe(1)
  expect((await (await request('contacts?sequence_id=outra')).json() as ContactPage).total).toBe(0)
})

it('contato com todas as conexões bloqueadas aparece como conversa apagada na lista', async () => {
  const row = async () => ((await (await request('contacts')).json()) as ContactPage).rows[0]
  expect(await row()).toMatchObject({ id: 'c-a', conversation_deleted: false })
  await env.DB.prepare("UPDATE contact_channels SET blocked_at=1 WHERE contact_id='c-a'").run()
  expect(await row()).toMatchObject({ id: 'c-a', conversation_deleted: true })
})

it('lote copia campo personalizado para telefone e pula valor inválido ou já preenchido', async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO custom_fields (id,workspace_id,scope,name,type) VALUES ('fone-a','a','contact','Celular','text')"),
    env.DB.prepare(`INSERT INTO contact_field_values (workspace_id,contact_id,field_id,value) VALUES ('a','c-a','fone-a','"+55 (11) 98765-4321"')`),
  ])
  const copy = (body: unknown) => request('contacts/bulk-copy-field', 'a', { method: 'POST', body: JSON.stringify(body) })
  expect(await (await copy({ ids: ['c-a'], field_id: 'fone-a', target: 'phone' })).json()).toEqual({ copied: 1, skipped: 0 })
  expect(await env.DB.prepare("SELECT phone FROM contacts WHERE id='c-a'").first('phone')).toBe('5511987654321')
  expect(await (await copy({ ids: ['c-a'], field_id: 'fone-a', target: 'phone' })).json()).toEqual({ copied: 0, skipped: 1 })
  expect(await (await copy({ ids: ['c-a'], field_id: 'fone-a', target: 'email' })).json()).toEqual({ copied: 0, skipped: 1 })
})

it('pedido do titular fica registrado com data e autor, e sobrevive à exclusão do contato', async () => {
  const created = await request('contacts/c-a/data-requests', 'a', { method: 'POST', body: JSON.stringify({ kind: 'export', note: 'Pediu por e-mail' }) })
  expect(created.status).toBe(201)
  await env.DB.prepare("UPDATE contacts SET status='deleted',first_name=NULL WHERE id='c-a'").run()
  const list = await (await request('contacts/c-a/data-requests')).json() as { kind: string; note: string; recorded_by: string; contact_label: string }[]
  expect(list).toEqual([expect.objectContaining({ kind: 'export', note: 'Pediu por e-mail', contact_label: expect.any(String) })])
  expect(list[0]?.recorded_by).toBeTruthy()
  expect((await request('contacts/c-a/data-requests', 'a', { method: 'POST', body: JSON.stringify({ kind: 'export' }) })).status).toBe(404)
})

it('limpeza conta e age em todos os contatos sem interação há N dias', async () => {
  const old = Date.now() - 40 * 86400_000
  await env.DB.prepare("UPDATE contacts SET last_interaction_at=? WHERE id='c-a'").bind(old).run()
  const cleanup = (body: unknown) => request('contacts/cleanup', 'a', { method: 'POST', body: JSON.stringify(body) })
  expect(await (await cleanup({ inactive_days: 30, action: 'unsubscribe' })).json()).toEqual({ count: 1 })
  expect(await (await cleanup({ inactive_days: 60, action: 'unsubscribe' })).json()).toEqual({ count: 0 })
  expect(await (await cleanup({ inactive_days: 30, action: 'unsubscribe', apply: true })).json()).toEqual({ count: 1, done: 1, remaining: 0 })
  expect(await env.DB.prepare("SELECT status FROM contacts WHERE id='c-a'").first('status')).toBe('unsubscribed')
  expect(await (await cleanup({ inactive_days: 30, action: 'delete', apply: true })).json()).toEqual({ count: 1, done: 1, remaining: 0 })
  expect(await env.DB.prepare("SELECT status FROM contacts WHERE id='c-a'").first('status')).toBe('deleted')
  expect((await cleanup({ inactive_days: 30, action: 'tag' })).status).toBe(400)
})
