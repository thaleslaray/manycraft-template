import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import { API_KEY_BLOCKED, PANEL_ONLY_MESSAGE, NOT_RELEASED_MESSAGE, apiKeyAllowed } from '../src/api-key-access'
import { authenticatedRequest, fixtureCookie, origin, seedAuth } from './auth-helpers'

// Ficha 01 (API total): a chave de perfil abre as rotas do painel com o mesmo papel do cookie. Só dados fictícios.
let ownerCookie = ''
const byCookie = (path: string, method = 'GET', body?: unknown, cookie = ownerCookie, workspace = 'a') =>
  authenticatedRequest(path, workspace, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, cookie)
const byKey = (token: string, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = { 'x-workspace': 'a' }) =>
  app.request(`${origin}/api/${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env)
async function profileKey(cookie = ownerCookie, input: unknown = { name: 'Script de teste', scope: 'write' }) {
  const created = await byCookie('profile/api-key', 'POST', input, cookie)
  expect(created.status).toBe(201)
  return await created.json() as { id: string; name: string; scope: string; token: string; last4: string }
}
const addMemberB = (role: string) => env.DB.prepare("INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES ('m-ab','a','user-b',?)").bind(role).run()
beforeEach(async () => { await seedAuth(); ownerCookie = await fixtureCookie('a') })

it('criar e listar chave de perfil aceita e devolve nome e tipo; várias ficam ativas; sem corpo segue valendo', async () => {
  const key = await profileKey(ownerCookie, { name: 'Planilha', scope: 'read' })
  expect(key).toMatchObject({ name: 'Planilha', scope: 'read', token: expect.stringMatching(/^perfil:/) })
  await profileKey(ownerCookie, { name: 'Zapier' })
  const list = await (await byCookie('profile/api-keys')).json() as { items: { name: string; scope: string }[] }
  expect(list.items.map(k => [k.name, k.scope]).sort()).toEqual([['Planilha', 'read'], ['Zapier', 'write']])
  expect((await byCookie('profile/api-key', 'POST', { name: '  ' })).status).toBe(400)
  expect((await byCookie('profile/api-key', 'POST')).status).toBe(201)
  expect((await byCookie(`profile/api-keys/${key.id}`, 'DELETE')).status).toBe(204)
  expect((await byKey(key.token, 'contacts')).status).toBe(401)
})

it('paridade: por área, o mesmo GET por cookie e por chave dá a mesma resposta; last_used_at é gravado', async () => {
  const { token, id } = await profileKey()
  for (const path of ['contacts', 'automations', 'broadcasts', 'inbox/conversations', 'segments', 'fields', 'tags', 'workspace-settings', 'team', 'folders']) {
    const [cookie, key] = await Promise.all([byCookie(path), byKey(token, path)])
    expect([path, key.status]).toEqual([path, cookie.status])
    expect(await key.json()).toEqual(await cookie.json())
  }
  expect(await env.DB.prepare('SELECT last_used_at FROM user_api_keys WHERE id=?').bind(id).first('last_used_at')).toBeGreaterThan(0)
})

it('mutação por chave sem Origin passa e aparece no painel; por cookie com Origin estranha segue barrada', async () => {
  const { token } = await profileKey()
  const created = await byKey(token, 'tags', 'POST', { name: 'Veio da API' })
  expect(created.status).toBe(201)
  expect(JSON.stringify(await (await byCookie('tags')).json())).toContain('Veio da API')
  expect((await byKey(token, 'tags', 'POST', { name: 'Origem estranha' }, { 'x-workspace': 'a', origin: 'https://evil.test' })).status).toBe(201)
  const evil = await app.request(`${origin}/api/tags`, { method: 'POST', headers: { 'x-workspace': 'a', 'content-type': 'application/json', cookie: ownerCookie, origin: 'https://evil.test' }, body: JSON.stringify({ name: 'x' }) }, env)
  expect(evil.status).toBe(403)
})

it('papéis: visualizador e agente recebem pela chave o mesmo 403/200 que o painel daria', async () => {
  const cookieB = await fixtureCookie('b')
  for (const role of ['viewer', 'livechat_agent']) {
    await env.DB.prepare("DELETE FROM workspace_members WHERE id='m-ab'").run()
    await addMemberB(role)
    const { token } = await profileKey(cookieB)
    for (const [path, method, body] of [['tags', 'POST', { name: `t-${role}` }], ['contacts', 'GET'], ['inbox/conversations', 'GET'], ['team/invites', 'POST', { email: 'x@example.test', role: 'viewer' }]] as const) {
      const viaCookie = (await byCookie(path, method, body, cookieB)).status
      const viaKey = (await byKey(token, path, method, body)).status
      expect([role, path, viaKey]).toEqual([role, path, viaCookie])
    }
    expect((await byKey(token, 'contacts')).status).toBe(200)
    expect((await byKey(token, 'tags', 'POST', { name: 'nao' })).status).toBe(403)
  }
})

it('chave revogada → 401; espaço em que não é membro → 404; sem x-workspace → 400; chave do espaço → 401', async () => {
  const { token } = await profileKey()
  expect((await byKey(token, 'contacts', 'GET', undefined, { 'x-workspace': 'b' })).status).toBe(404)
  expect((await byKey(token, 'contacts', 'GET', undefined, {})).status).toBe(400)
  const workspaceKey = (await (await byCookie('api-keys', 'POST')).json() as { token: string }).token
  expect((await byKey(workspaceKey, 'contacts')).status).toBe(401)
  expect((await byCookie('profile/api-key', 'DELETE')).status).toBe(204)
  expect((await byKey(token, 'contacts')).status).toBe(401)
})

it('chave só de leitura: GET 200; POST, PATCH e DELETE → 403 "Esta chave é só de leitura."', async () => {
  const { token } = await profileKey(ownerCookie, { name: 'Painel de métricas', scope: 'read' })
  expect((await byKey(token, 'contacts')).status).toBe(200)
  for (const [path, method] of [['tags', 'POST'], ['contacts/c-a', 'PATCH'], ['tags/tag-a', 'DELETE']] as const) {
    const response = await byKey(token, path, method, method === 'DELETE' ? undefined : { name: 'x' })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'Esta chave é só de leitura.' })
  }
  expect(await env.DB.prepare("SELECT count(*) FROM tags WHERE name='x'").first('count(*)')).toBe(0)
})

it('cada rota da lista "só no painel" → 403 por chave; WebSocket do inbox → 403; por cookie seguem abertas', async () => {
  const { token } = await profileKey()
  for (const route of API_KEY_BLOCKED) {
    const path = route.path.replace(/^\/api\//, '').replace(/\/\*$/, '/api-key').replace(/:[^/]+/g, 'x')
    const response = await byKey(token, path, route.method === '*' ? 'POST' : route.method, route.method === 'GET' ? undefined : {})
    expect([route.path, response.status]).toEqual([route.path, 403])
    expect(await response.json()).toEqual({ error: PANEL_ONLY_MESSAGE })
  }
  const upgrade = await byKey(token, 'inbox/live', 'GET', undefined, { 'x-workspace': 'a', upgrade: 'websocket' })
  expect(upgrade.status).toBe(403)
  expect((await byKey(token, 'profile/api-keys')).status).toBe(403)
  expect((await byCookie('profile/api-keys')).status).toBe(200)
  expect((await byCookie('api-keys')).status).toBe(200)
  expect((await byCookie('account/sessions')).status).not.toBe(403)
})

it('regras e trava valem igual pela chave', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Rede proibida'))
  try {
    await env.DB.prepare("INSERT INTO tags(id,workspace_id,name) VALUES('lead','a','Lead')").run()
    await env.DB.prepare("INSERT INTO sequences(id,workspace_id,name) VALUES('nurture','a','Nutrição')").run()
    const rule = await (await byCookie('rules', 'POST', { name: 'Lead', trigger: { type: 'tag_added' }, event_filter: { tag_id: 'lead' }, actions: [{ type: 'add_to_sequence', sequence_id: 'nurture' }], frequency: 'always' })).json() as { id: string }
    expect((await byCookie(`rules/${rule.id}/publish`, 'POST')).status).toBe(200)
    const { token } = await profileKey()
    expect((await byKey(token, 'contacts/c-a/tags', 'POST', { tag_id: 'lead', op: 'add' })).status).toBe(200)
    expect(await env.DB.prepare("SELECT sequence_id FROM sequence_subscriptions WHERE contact_id='c-a'").first('sequence_id')).toBe('nurture')

    expect((await byCookie('automations/auto-a/lock', 'POST', { locked: true })).status).toBe(200)
    const cookieB = await fixtureCookie('b')
    await addMemberB('editor')
    const keyB = await profileKey(cookieB)
    const viaCookie = await byCookie('automations/auto-a/trash', 'POST', {}, cookieB)
    const viaKey = await byKey(keyB.token, 'automations/auto-a/trash', 'POST', {})
    expect(viaKey.status).toBe(viaCookie.status)
    expect(viaKey.status).toBeGreaterThanOrEqual(400)
  } finally { network.mockRestore() }
})

it('limite: o 601º pedido no minuto pela mesma chave recebe 429 com Retry-After; outra chave segue livre', async () => {
  const { token } = await profileKey()
  for (let i = 0; i < 600; i++) expect((await byKey(token, 'tags')).status).toBe(200)
  const blocked = await byKey(token, 'tags')
  expect(blocked.status).toBe(429)
  const retry = Number(blocked.headers.get('retry-after'))
  expect(retry).toBeGreaterThanOrEqual(1)
  expect(retry).toBeLessThanOrEqual(60)
  const other = await profileKey(ownerCookie, { name: 'Outra' })
  expect((await byKey(other.token, 'tags')).status).toBe(200)
}, 120_000)

it('registro: alteração por chave sai como via=api com nome e final da chave; por cookie como via=painel', async () => {
  const key = await profileKey(ownerCookie, { name: 'Zapier', scope: 'write' })
  expect((await byKey(key.token, 'tags', 'POST', { name: 'Pela API' })).status).toBe(201)
  expect((await byCookie('tags', 'POST', { name: 'Pelo painel' })).status).toBe(201)
  const log = await (await byKey(key.token, 'activity-log')).json() as { items: Record<string, unknown>[] }
  expect(log.items.filter(i => i.path === '/api/tags')).toEqual([
    expect.objectContaining({ via: 'painel', api_key_id: null, api_key_name: null, api_key_last4: null }),
    expect.objectContaining({ via: 'api', api_key_id: key.id, api_key_name: 'Zapier', api_key_last4: key.last4 }),
  ])
})

it('negado por padrão: rota fora da lista liberada → 403 por chave', async () => {
  const { token } = await profileKey()
  const response = await byKey(token, 'rota-que-nao-esta-na-lista')
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ error: NOT_RELEASED_MESSAGE })
  expect(apiKeyAllowed('GET', '/api/contacts', ['GET /api/contacts'])).toBe(true)
  expect(apiKeyAllowed('GET', '/api/montada-fora', ['GET /api/contacts'])).toBe(false)
  expect(apiKeyAllowed('POST', '/api/contacts', ['GET /api/contacts'])).toBe(false)
  expect(apiKeyAllowed('HEAD', '/api/contacts/c-1', ['GET /api/contacts/:id'])).toBe(true)
})

it('limite conta antes da busca: segredo inválido também gasta o limite', async () => {
  const bad = 'perfil:segredo-que-nao-existe'
  for (let i = 0; i < 600; i++) expect((await byKey(bad, 'tags')).status).toBe(401)
  expect((await byKey(bad, 'tags')).status).toBe(429)
}, 120_000)

it('dono da chave sem e-mail verificado → 401', async () => {
  const { token, id } = await profileKey()
  await env.DB.prepare('UPDATE "user" SET "emailVerified"=0 WHERE id=(SELECT user_id FROM user_api_keys WHERE id=?)').bind(id).run()
  expect((await byKey(token, 'contacts')).status).toBe(401)
})

it('last_used_at só é regravado depois de 60 s', async () => {
  const { token, id } = await profileKey()
  const usedAt = (stamp: number) => env.DB.prepare('UPDATE user_api_keys SET last_used_at=? WHERE id=?').bind(stamp, id).run()
  const read = () => env.DB.prepare('SELECT last_used_at FROM user_api_keys WHERE id=?').bind(id).first<number>('last_used_at')
  const recent = Date.now() - 10_000
  await usedAt(recent)
  expect((await byKey(token, 'tags')).status).toBe(200)
  expect(await read()).toBe(recent)
  await usedAt(Date.now() - 61_000)
  expect((await byKey(token, 'tags')).status).toBe(200)
  expect(await read()).toBeGreaterThan(Date.now() - 5_000)
})

it('/api/auth/* (trocar senha, trocar e-mail, excluir conta) recusa a chave', async () => {
  const { token } = await profileKey()
  for (const [path, body] of [['auth/change-password', { currentPassword: 'x', newPassword: 'y12345678' }], ['auth/change-email', { newEmail: 'novo@example.test' }], ['auth/delete-user', {}]] as const) {
    const response = await byKey(token, path, 'POST', body)
    expect([path, response.status >= 400]).toEqual([path, true])
  }
  expect(await env.DB.prepare(`SELECT count(*) FROM "user" WHERE email='novo@example.test'`).first('count(*)')).toBe(0)
})

it('paridade de mídia: upload por cookie e por chave dão o mesmo status', async () => {
  const { token } = await profileKey()
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const headers = { 'content-type': 'image/png', 'content-length': String(png.byteLength) }
  const viaCookie = await authenticatedRequest('media', 'a', { method: 'POST', headers, body: png }, ownerCookie)
  const viaKey = await app.request(`${origin}/api/media`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${token}`, 'x-workspace': 'a' }, body: png }, env)
  expect(viaKey.status).toBe(viaCookie.status)
})
