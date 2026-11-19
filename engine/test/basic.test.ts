import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'

beforeEach(async () => {
  await seedAuth()
  await env.DB.prepare("UPDATE channels SET type='telegram' WHERE id='ch-a'").run()
})
const save = (body: unknown, connection = 'ch-a', kind = 'default_reply') => authenticatedRequest(
  `basic/${connection}/${kind}`, 'a', { method: 'PUT', body: JSON.stringify(body) })
const input = { automation_id: 'auto-a', enabled: true, repeat_mode: 'once_per_24_hours', dm_only: false }

it('persiste associação, frequência e estado por conexão, sem ativar rascunho', async () => {
  expect((await save(input)).status).toBe(409)
  expect((await save({ ...input, enabled: false })).status).toBe(200)
  expect((await authenticatedRequest('automations/auto-a/publish', 'a', { method: 'POST' })).status).toBe(201)
  expect((await save(input)).status).toBe(200)
  expect((await save({ ...input, repeat_mode: 'every_time' }, 'ch-a', 'welcome_message')).status).toBe(200)
  const result = await (await authenticatedRequest('basic')).json() as { connections: unknown[]; entries: unknown[] }
  expect(result.connections).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'ch-a', profile: expect.objectContaining({ inbound: expect.objectContaining({ message: true }) }) })]))
  expect(JSON.stringify(result)).not.toMatch(/TESTONLY|ciphertext|credentials|webhookSecret/)
  expect(result.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ ...input, connection_id: 'ch-a', kind: 'default_reply', automation_name: 'Automação a' }),
    expect.objectContaining({ connection_id: 'ch-a', kind: 'welcome_message', repeat_mode: 'every_time', enabled: true }),
  ]))
  expect((await save({ ...input, enabled: false })).status).toBe(200)
  expect((await (await authenticatedRequest('basic')).json() as { entries: { kind: string; enabled: boolean }[] }).entries.find(e => e.kind === 'default_reply')?.enabled).toBe(false)
})

it('exige automação e ficha efetiva, isola workspace e respeita permissões', async () => {
  expect((await save({ ...input, automation_id: '' })).status).toBe(400)
  expect((await save({ ...input, automation_id: 'auto-b' })).status).toBe(404)
  expect((await save(input, 'ch-b')).status).toBe(404)
  expect((await save({ ...input, enabled: false, dm_only: true })).status).toBe(400)
  await env.DB.prepare(`UPDATE channels SET capabilities_override='{"inbound":{"message":false}}' WHERE id='ch-a'`).run()
  expect((await save({ ...input, enabled: false })).status).toBe(400)
  await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE user_id='user-a'").run()
  expect((await authenticatedRequest('basic')).status).toBe(200)
  expect((await save(input)).status).toBe(403)
  await env.DB.prepare("UPDATE workspace_members SET role='livechat_agent' WHERE user_id='user-a'").run()
  expect((await authenticatedRequest('basic')).status).toBe(403)
})

it('liga confirmações de inscrição e descadastro a automações, fora da contagem de palavras-chave', async () => {
  await authenticatedRequest('automations/auto-a/publish', 'a', { method: 'POST' })
  const before = await env.DB.prepare('SELECT count(*) n FROM keywords').first('n')
  for (const kind of ['system_opt_in', 'system_opt_out']) {
    const response = await save({ ...input, repeat_mode: 'every_time' }, 'ch-a', kind)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ kind, connection_id: 'ch-a', automation_id: 'auto-a', enabled: true })
  }
  const entries = (await (await authenticatedRequest('basic')).json() as { entries: { kind: string }[] }).entries
  expect(entries.map(e => e.kind)).toEqual(expect.arrayContaining(['system_opt_in', 'system_opt_out']))
  expect(await env.DB.prepare('SELECT count(*) n FROM keywords').first('n')).toBe(before)
})

it('descadastro padrão: cria o fluxo de 4 passos com botão Inscrever, publica e liga como confirmação; {{nome_da_pagina}} vira o nome do espaço', async () => {
  const r = await authenticatedRequest('basic/ch-a/system_opt_out/default', 'a', { method: 'POST', body: '{}' })
  expect(r.status).toBe(201)
  const { automation_id } = await r.json() as { automation_id: string }
  const entries = await (await authenticatedRequest('basic')).json() as { entries: { kind: string; automation_id: string; enabled: boolean }[] }
  expect(entries.entries).toContainEqual(expect.objectContaining({ kind: 'system_opt_out', automation_id, enabled: true }))
  const graph = JSON.parse((await env.DB.prepare('SELECT graph FROM automation_versions WHERE automation_id=?').bind(automation_id).first<string>('graph'))!)
  expect(graph.nodes.map((n: { type: string }) => n.type)).toEqual(['trigger', 'message', 'action', 'message'])
  const { contactVariableRenderer } = await import('../src/db/message-variables')
  const name = await env.DB.prepare("SELECT name FROM workspaces WHERE id='a'").first<string>('name')
  expect((await contactVariableRenderer(env.DB, 'a', 'c-a'))('Oi de {{page_name|x}}')).toBe(`Oi de ${name}`)
})
