import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { authenticatedRequest, fixtureCookie, seedAuth } from './auth-helpers'
import { graph } from './fixtures'
import { actions } from '../src/flow/nodes'
import type { FlowEnv, Run } from '../src/flow/types'

let cookie = ''
const bindings = env as unknown as FlowEnv
const run = { id: 'app-run', workspace_id: 'a', contact_id: 'c-a', channel_id: 'ch-a', automation_id: 'auto-a' } as Run
beforeEach(async () => {
  await seedAuth(); cookie = await fixtureCookie()
  await env.DB.batch([
    env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('app-v','a','auto-a',1,?)").bind(JSON.stringify(graph)),
    env.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,channel_id,automation_version_id) VALUES ('app-run','a','c-a','ch-a','app-v')"),
    env.DB.prepare("INSERT INTO custom_fields (id,workspace_id,name,type,scope) VALUES ('f-pts','a','pontos','number','contact')"),
  ])
})
afterEach(() => vi.restoreAllMocks())
const spec = {
  name: 'Fidelidade', auth: { type: 'APIKEY', params: [{ name: 'api_key', label: 'Chave' }], connection: { headers: { authorization: 'Bearer [[api_key]]' }, query: {} } },
  actions: [{ name: 'saldo', label: 'Consultar saldo', form: [{ name: 'loja', label: 'Loja', type: 'select', source: 'lojas' }],
    requests: [{ method: 'POST', url: 'https://api.fidelidade.example/saldo', body: { cliente: '[[system.user_id]]', loja: '[[input.loja]]', nome: '[[system.first_name]]' } }],
    mapping: [{ path: '$.pontos', field: 'pontos' }] }],
  sources: { lojas: { type: 'enum:static', values: [{ key: 'sp', value: 'São Paulo' }] },
    remotas: { type: 'enum:rpc', request: { url: 'https://api.fidelidade.example/lojas' }, mapping: { list: '$.items', key: 'id', value: 'nome' } } },
}

it('app por JSON: instala com APIKEY cifrada, lista static e rpc, e a ação no fluxo injeta auth, system fields e mapeia o JSONPath', async () => {
  const calls: { url: string; auth: string | null; body: string | null }[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const r = new Request(input, init); calls.push({ url: r.url, auth: r.headers.get('authorization'), body: init?.body ? String(init.body) : null })
    return r.url.endsWith('/lojas') ? Response.json({ items: [{ id: 'rj', nome: 'Rio' }] }) : Response.json({ pontos: 120 })
  })
  expect((await authenticatedRequest('apps', 'a', { method: 'POST', body: JSON.stringify({ spec, params: {} }) }, cookie)).status).toBe(400)
  const r = await authenticatedRequest('apps', 'a', { method: 'POST', body: JSON.stringify({ spec, params: { api_key: 'segredo-1' } }) }, cookie)
  expect(r.status).toBe(201)
  const { id } = await r.json() as { id: string }
  expect(await env.DB.prepare('SELECT spec LIKE ? AS leak FROM installed_apps WHERE id=?').bind('%segredo-1%', id).first('leak')).toBe(0)
  expect(await (await authenticatedRequest(`apps/${id}/sources/lojas`, 'a', {}, cookie)).json()).toEqual({ items: [{ key: 'sp', value: 'São Paulo' }] })
  expect(await (await authenticatedRequest(`apps/${id}/sources/remotas`, 'a', {}, cookie)).json()).toEqual({ items: [{ key: 'rj', value: 'Rio' }] })
  await actions(bindings, run, { actions: [{ type: 'apps_request', app_id: id, action: 'saldo', inputs: { loja: 'sp' } }] }, 1)
  const call = calls.find(c => c.url.endsWith('/saldo'))!
  expect(call.auth).toBe('Bearer segredo-1')
  expect(JSON.parse(call.body!)).toMatchObject({ cliente: 'c-a', loja: 'sp' })
  expect(await env.DB.prepare("SELECT value FROM contact_field_values WHERE contact_id='c-a' AND field_id='f-pts'").first('value')).toBe('120')
})
