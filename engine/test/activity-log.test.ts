import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest, fixtureCookie, seedAuth } from './auth-helpers'

let cookie = ''
beforeEach(async () => { await seedAuth(); cookie = await fixtureCookie() })

it('alteração bem-sucedida entra no log de atividade com quem fez; leitura e erro não entram', async () => {
  await authenticatedRequest('automations/auto-a', 'a', { method: 'PATCH', body: JSON.stringify({ name: 'Renomeada' }) }, cookie)
  await authenticatedRequest('automations/auto-a', 'a', { method: 'PATCH', body: JSON.stringify({}) }, cookie)
  await authenticatedRequest('automations', 'a', {}, cookie)
  const log = await (await authenticatedRequest('activity-log', 'a', {}, cookie)).json() as { items: { method: string; path: string; user_name: string }[] }
  expect(log.items).toEqual([expect.objectContaining({ method: 'PATCH', path: '/api/automations/auto-a', user_name: 'Pessoa a' })])
  await env.DB.prepare("UPDATE workspace_members SET role='editor' WHERE user_id='user-a' AND workspace_id='a'").run()
  expect((await authenticatedRequest('activity-log', 'a', {}, cookie)).status).toBe(403)
})

it('toda rota da API devolve o estado booleano em x-state', async () => {
  const { authenticatedRequest } = await import('./auth-helpers')
  expect((await authenticatedRequest('team')).headers.get('x-state')).toBe('true')
  expect((await authenticatedRequest('automations/nao-existe')).headers.get('x-state')).toBe('false')
})
