import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'

beforeEach(seedAuth)
const call = (method: string, body?: unknown) => authenticatedRequest('workspace-settings', 'a', { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

it('lê e salva nome, fuso e preferências de exibição; descadastrados escondidos por padrão', async () => {
  expect(await (await call('GET')).json()).toMatchObject({ name: 'Workspace a', show_only_subscribed: true, hide_keywords_tab: false, hide_rules_tab: false })
  const saved = await call('PATCH', { name: 'Oficina', timezone: 'Europe/Lisbon', show_only_subscribed: false, hide_rules_tab: true })
  expect(saved.status).toBe(200)
  expect(await saved.json()).toMatchObject({ name: 'Oficina', timezone: 'Europe/Lisbon', show_only_subscribed: false, hide_rules_tab: true })
  expect(await env.DB.prepare("SELECT timezone FROM workspaces WHERE id='a'").first('timezone')).toBe('Europe/Lisbon')
  expect((await call('PATCH', { timezone: 'Lua/Base' })).status).toBe(400)
})

it('só dono e administrador alteram', async () => {
  await env.DB.prepare("UPDATE workspace_members SET role='editor' WHERE workspace_id='a'").run()
  expect((await call('GET')).status).toBe(200)
  expect((await call('PATCH', { name: 'X' })).status).toBe(403)
})

it('importação desligada no espaço é recusada com o motivo', async () => {
  expect(await (await call('GET')).json()).toMatchObject({ import_enabled: true })
  await env.DB.prepare("UPDATE workspaces SET import_enabled=0 WHERE id='a'").run()
  const refused = await authenticatedRequest('contact-imports', 'a', { method: 'POST', body: JSON.stringify({}) })
  expect(refused.status).toBe(403)
  expect(await refused.text()).toContain('liberação')
})

it('questionário de perfil grava as respostas do espaço e volta nas preferências', async () => {
  const { authenticatedRequest, fixtureCookie, seedAuth } = await import('./auth-helpers')
  await seedAuth()
  const cookie = await fixtureCookie()
  const saved = await authenticatedRequest('workspace-settings/profile', 'a', { method: 'PUT', body: JSON.stringify({ segment: 'Loja virtual', goal: 'sales' }) }, cookie)
  expect(await saved.json()).toMatchObject({ profile_answers: { segment: 'Loja virtual', goal: 'sales' } })
  expect((await authenticatedRequest('workspace-settings/profile', 'a', { method: 'PUT', body: JSON.stringify({ goal: 'outro' }) }, cookie)).status).toBe(400)
})
