import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'

beforeEach(async () => {
  await seedAuth()
  await authenticatedRequest('automations/auto-a/publish', 'a', { method: 'POST' })
})
const input = { name: 'Receber material', channel: 'instagram', automation_id: 'auto-a', active: true,
  rules: [{ condition: 'equals', words: [' Quero '] }] }
const request = (path: string, method = 'GET', body?: unknown) => authenticatedRequest(path, 'a',
  { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, undefined, { ...env, DEV_AUTO_LOGIN: '0' })

it('CRUD HTTP, prioridade e ativo escrevem nos gatilhos reais sem fallback', async () => {
  const response = await request('keywords', 'POST', input)
  expect(response.status).toBe(201)
  const keyword = await response.json() as any
  expect(keyword).toMatchObject({ name: input.name, rules: [{ condition: 'equals', words: ['Quero'] }], active: true })
  expect((await (await request('keywords')).json() as any[]).find(row => row.id === keyword.id)).toEqual(keyword)
  expect((await request(`keywords/${keyword.id}`, 'PATCH', { ...input, name: 'Novo nome', rules: [{ condition: 'starts', words: ['link'] }] })).status).toBe(200)
  const moved = await request(`keywords/${keyword.id}/priority`, 'PATCH', { target: 0 })
  expect(moved.status).toBe(200)
  expect((await moved.json() as any[])[0]).toMatchObject({ id: keyword.id, priority: 0 })
  expect(await (await request(`keywords/${keyword.id}`, 'PATCH', { active: false })).json()).toMatchObject({ active: false })
  expect((await request(`keywords/${keyword.id}`, 'DELETE')).status).toBe(200)
  expect((await request(`keywords/${keyword.id}`, 'PATCH', { active: true })).status).toBe(404)
})

it('rotas validam JSON, IDs estrangeiros, corpo e permissões por papel', async () => {
  for (const body of [{ ...input, active: 'true' }, { ...input, rules: [] }, { ...input, other: true }]) {
    expect((await request('keywords', 'POST', body)).status).toBe(400)
  }
  expect((await request('keywords?unknown=1')).status).toBe(400)
  expect((await request('keywords', 'POST', { ...input, automation_id: 'auto-b' })).status).toBe(404)
  expect((await request('keywords/key-b', 'PATCH', { active: true })).status).toBe(404)
  expect((await request('keywords/key-b', 'DELETE')).status).toBe(404)
  expect((await request('keywords/key-a/priority', 'PATCH', { target: -1 })).status).toBe(400)
  await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE user_id='user-a'").run()
  expect((await request('keywords')).status).toBe(200)
  expect((await request('keywords', 'POST', input)).status).toBe(403)
  await env.DB.prepare("UPDATE workspace_members SET role='livechat_agent' WHERE user_id='user-a'").run()
  expect((await request('keywords')).status).toBe(403)
  expect((await request('keywords/key-a', 'PATCH', { active: false })).status).toBe(403)
})

it('cria automação em rascunho e regra ligada em uma operação, inclusive ao substituir a resposta', async () => {
  const { automation_id: _automation, active: _active, ...rule } = input
  const response = await request('keywords/automation', 'POST', rule)
  expect(response.status).toBe(201)
  const keyword = await response.json() as any
  expect(keyword).toMatchObject({ name: input.name, active: false, rules: [{ condition: 'equals', words: ['Quero'] }] })
  const detail = await (await request(`automations/${keyword.automation_id}`)).json() as any
  expect(detail.automation).toMatchObject({ status: 'draft', published_version_id: null })
  expect((await (await request(`automations/${keyword.automation_id}/triggers`)).json() as any).rows[0]).toMatchObject({ name: input.name, state: 'draft' })
  expect((await request(`keywords/${keyword.id}`, 'PATCH', { active: true })).status).toBe(409)
  expect((await request(`keywords/${keyword.id}`, 'PATCH', { ...input, active: false, automation_id: keyword.automation_id, name: 'Rascunho atualizado' })).status).toBe(200)
  const replacement = await request('keywords/automation', 'POST', { ...rule, keyword_id: keyword.id })
  expect(replacement.status).toBe(201)
  expect(await replacement.json()).toMatchObject({ id: keyword.id, active: false })
  const before = await (await request('automations')).json()
  expect((await request('keywords/automation', 'POST', { ...rule, keyword_id: 'key-b' })).status).toBe(404)
  expect((await request('keywords/automation', 'POST', { ...rule, channel: 'tiktok' })).status).toBe(400)
  expect(await (await request('automations')).json()).toEqual(before)
  await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE user_id='user-a'").run()
  expect((await request('keywords/automation', 'POST', rule)).status).toBe(403)
})
