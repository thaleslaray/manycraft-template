import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { app } from '../src/index'
import { authenticatedRequest, fixtureCookie, origin, seedAuth } from './auth-helpers'

beforeEach(seedAuth)

it('o contexto do painel exige sessão e retorna apenas um espaço do usuário verificado', async () => {
  expect((await app.request(`${origin}/api/session/workspace`, {}, env)).status).toBe(401)
  const cookie = await fixtureCookie('b')
  const response = await app.request(`${origin}/api/session/workspace`, { headers: { cookie, 'x-workspace': 'a' } }, env)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ workspace_id: 'b', name: 'Workspace b', role: 'owner', user_name: expect.any(String) })
  await env.DB.prepare("UPDATE user SET emailVerified=0 WHERE id='user-b'").run()
  expect((await app.request(`${origin}/api/session/workspace`, { headers: { cookie } }, env)).status).toBe(401)
})

it('conta nova pode criar seu primeiro espaço e carregar o painel sem contexto de desenvolvimento', async () => {
  await env.DB.prepare("DELETE FROM workspace_members WHERE user_id='user-b'").run()
  const cookie = await fixtureCookie('b')
  const read = () => app.request(`${origin}/api/session/workspace`, { headers: { cookie } }, env)
  expect(await (await read()).json()).toBeNull()
  const created = await authenticatedRequest('workspaces', 'a', { method: 'POST', body: JSON.stringify({ name: 'Meu espaço' }) }, cookie)
  expect(created.status).toBe(201)
  const { id } = await created.json() as { id: string }
  expect(await (await read()).json()).toMatchObject({ workspace_id: id, name: 'Meu espaço', role: 'owner', user_name: expect.any(String) })
})

it('auto login só funciona no desenvolvimento e nunca substitui uma sessão real', async () => {
  const bindings = { ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: 'a' }
  const read = (cookie?: string) => app.request(`${origin}/api/session/workspace`, { headers: cookie ? { cookie } : {} }, bindings)
  expect(await (await read()).json()).toMatchObject({ workspace_id: 'a', name: 'Workspace a', role: 'owner', user_name: expect.any(String) })
  expect(await (await read(await fixtureCookie('b'))).json()).toMatchObject({ workspace_id: 'b', name: 'Workspace b', role: 'owner', user_name: expect.any(String) })
  const prod = { ...bindings, APP_ENV: 'production' as const }
  expect((await app.request(`${origin}/api/session/workspace`, {}, prod)).status).toBe(401)
  const cookie = await fixtureCookie('b')
  expect((await authenticatedRequest('contacts', 'b', {}, cookie, bindings)).status).toBe(200)
  expect((await authenticatedRequest('contacts', 'a', {}, cookie, bindings)).status).toBe(404)
})

it('o painel recebe o papel do membro para esconder o que o motor recusa', async () => {
  await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE user_id='user-b' AND workspace_id='b'").run()
  const cookie = await fixtureCookie('b')
  const response = await app.request(`${origin}/api/session/workspace`, { headers: { cookie } }, env)
  expect(await response.json()).toMatchObject({ workspace_id: 'b', name: 'Workspace b', role: 'viewer', user_name: expect.any(String) })
})

it('DEV_ROLE troca o papel do auto login na sessão e no motor', async () => {
  const bindings = { ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: 'a', DEV_ROLE: 'livechat_agent' }
  const session = await app.request(`${origin}/api/session/workspace`, {}, bindings)
  expect(await session.json()).toMatchObject({ workspace_id: 'a', name: 'Workspace a', role: 'livechat_agent', user_name: expect.any(String) })
  expect((await app.request(`${origin}/api/automations`, { headers: { 'x-workspace': 'a' } }, bindings)).status).toBe(403)
  const invalid = { ...bindings, DEV_ROLE: 'superuser' }
  expect(await (await app.request(`${origin}/api/session/workspace`, {}, invalid)).json()).toMatchObject({ workspace_id: 'a', name: 'Workspace a', role: 'owner', user_name: expect.any(String) })
})
