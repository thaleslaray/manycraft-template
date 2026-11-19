import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'
import type { AutomationKeywordTrigger } from '../src/db/automation-triggers'
import { graph } from './fixtures'

beforeEach(async () => {
  await seedAuth()
  await env.DB.batch([
    env.DB.prepare("UPDATE channels SET type='telegram' WHERE id='ch-a'"),
    env.DB.prepare(`UPDATE triggers SET config='{"node_id":"t"}' WHERE id='trg-a'`),
    env.DB.prepare("UPDATE keywords SET status='live',rule='is' WHERE id='key-a'"),
  ])
})

const list = (automation = 'auto-a') => authenticatedRequest(`automations/${automation}/triggers`)
const patch = (value: unknown, trigger = 'trg-a', automation = 'auto-a') => authenticatedRequest(
  `automations/${automation}/triggers/${trigger}`, 'a', { method: 'PATCH', body: JSON.stringify(value) })

it('lista palavras reais do motor, canal e associação com nó sem depender do config.include', async () => {
  const response = await list()
  expect(response.status).toBe(200)
  const result = await response.json() as { rows: AutomationKeywordTrigger[] }
  expect(result.rows).toHaveLength(1)
  expect(result.rows[0]).toMatchObject({ id: 'trg-a', workspace_id: 'a', automation_id: 'auto-a', type: 'dm_keyword',
    channel_id: 'ch-a', channel_type: 'telegram', node_id: 't', enabled: true,
    keywords: [{ id: 'key-a', rule: 'is', words: ['quero'], status: 'live', parent_id: null, case_sensitive: false }] })
  expect(result.rows[0]?.updated_at).toMatch(/^\d{4}-\d\d-\d\dT/)
  await env.DB.prepare("UPDATE triggers SET kind='welcome_message' WHERE id='trg-a'").run()
  expect(await (await list()).json()).toEqual({ rows: [] })
  expect((await patch({ enabled: false })).status).toBe(404)
})

it('edita palavras/regra/ativo de forma persistida, preservando outras regras e o snapshot publicado', async () => {
  await authenticatedRequest('automations/auto-a/publish', 'a', { method: 'POST' })
  const before = await env.DB.prepare("SELECT graph FROM automation_versions WHERE automation_id='auto-a'").first()
  await env.DB.prepare(`INSERT INTO keywords (id,workspace_id,trigger_id,rule,words,status,priority)
    VALUES ('another','a','trg-a','contains','["extra"]','draft',2)`).run()
  const response = await patch({ keyword_id: 'key-a', words: [' Link ', 'curso'], rule: 'contains', enabled: false })
  expect(response.status).toBe(200)
  const result = await response.json() as AutomationKeywordTrigger
  expect(result).toMatchObject({ enabled: false, keywords: [
    { id: 'key-a', rule: 'contains', words: ['Link', 'curso'], status: 'live' },
    { id: 'another', rule: 'contains', words: ['extra'], status: 'draft' },
  ] })
  expect((await (await list()).json() as { rows: AutomationKeywordTrigger[] }).rows[0]).toEqual(result)
  expect(await env.DB.prepare("SELECT graph FROM automation_versions WHERE automation_id='auto-a'").first()).toEqual(before)
  expect((await patch({ enabled: true })).status).toBe(200)
  expect(await env.DB.prepare("SELECT status FROM triggers WHERE id='trg-a'").first()).toEqual({ status: 'active' })
  expect((await patch({ keyword_id: 'key-a', rule: 'any', words: [] })).status).toBe(200)
  expect((await patch({ keyword_id: 'key-a', rule: 'is' })).status).toBe(400)
  expect(await env.DB.prepare("SELECT rule,words FROM keywords WHERE id='key-a'").first()).toEqual({ rule: 'any', words: '[]' })
})

it('oculta automação/gatilho/palavra de outro workspace ou outra automação e registros excluídos', async () => {
  expect((await list('auto-b')).status).toBe(404)
  expect((await patch({ enabled: false }, 'trg-b')).status).toBe(404)
  expect((await patch({ enabled: false }, 'trg-b', 'auto-b')).status).toBe(404)
  expect((await patch({ keyword_id: 'key-b', words: ['inválida'], enabled: false })).status).toBe(404)
  await env.DB.prepare("INSERT INTO automations(id,workspace_id,name,draft_graph) SELECT 'other-a',workspace_id,'Outra',draft_graph FROM automations WHERE id='auto-a'").run()
  expect((await patch({ enabled: false }, 'trg-a', 'other-a')).status).toBe(404)
  expect(await env.DB.prepare("SELECT status FROM triggers WHERE id='trg-a'").first()).toEqual({ status: 'active' })
  expect(await env.DB.prepare("SELECT words FROM keywords WHERE id='key-b'").first()).toEqual({ words: '["quero"]' })
  await env.DB.prepare("UPDATE automations SET deleted_at=1 WHERE id='auto-a'").run()
  expect((await list()).status).toBe(404)
  expect((await patch({ enabled: false })).status).toBe(404)
})

it('valida JSON, palavras, regra e corpo antes de qualquer alteração', async () => {
  const invalid = [ {}, { keyword_id: 'key-a' }, { words: ['oi'] }, { rule: 'is' }, { enabled: 'false' },
    { keyword_id: 'key-a', words: [' '] }, { keyword_id: 'key-a', words: Array(11).fill('oi') },
    { keyword_id: 'key-a', words: [] }, { keyword_id: 'key-a', words: ['x'.repeat(501)] },
    { keyword_id: 'key-a', rule: 'unknown' }, { enabled: false, config: {} },
  ]
  for (const body of invalid) expect((await patch(body)).status, JSON.stringify(body)).toBe(400)
  expect((await authenticatedRequest('automations/auto-a/triggers/trg-a', 'a', { method: 'PATCH', body: 'invalid' })).status).toBe(400)
  expect((await authenticatedRequest('automations/auto-a/triggers?unknown=1')).status).toBe(400)
  expect(await env.DB.prepare("SELECT status FROM triggers WHERE id='trg-a'").first()).toEqual({ status: 'active' })
  expect(await env.DB.prepare("SELECT rule,words FROM keywords WHERE id='key-a'").first()).toEqual({ rule: 'is', words: '["quero"]' })
})

it('aplica authorize para leitura de automações e escrita por papel, sem confiar no header', async () => {
  await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE user_id='user-a'").run()
  expect((await list()).status).toBe(200)
  expect((await patch({ enabled: false })).status).toBe(403)
  await env.DB.prepare("UPDATE workspace_members SET role='livechat_agent' WHERE user_id='user-a'").run()
  expect((await list()).status).toBe(403)
  expect((await patch({ enabled: false })).status).toBe(403)
  await env.DB.prepare("UPDATE workspace_members SET role='editor' WHERE user_id='user-a'").run()
  expect((await patch({ enabled: false })).status).toBe(200)
  expect((await authenticatedRequest('automations/auto-a/triggers', 'b')).status).toBe(404)
})

it('recusa edição simples de grupos e filhos sem destruir a estrutura existente', async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,priority) VALUES ('group-a','a','trg-a','group','[]',0)`),
    env.DB.prepare("UPDATE keywords SET parent_id='group-a' WHERE id='key-a'"),
  ])
  expect((await patch({ keyword_id: 'group-a', rule: 'is', words: ['oi'] })).status).toBe(400)
  expect((await patch({ keyword_id: 'key-a', rule: 'contains' })).status).toBe(400)
  expect((await patch({ enabled: false })).status).toBe(200)
  expect(await env.DB.prepare("SELECT rule,words FROM keywords WHERE id='group-a'").first()).toEqual({ rule: 'group', words: '[]' })
})


it('grava política e três estados sem alterar o estado da automação', async () => {
  expect((await authenticatedRequest('automations/auto-a/publish', 'a', { method: 'POST' })).status).toBe(201)
  const before = (await (await authenticatedRequest('automations/auto-a')).json() as { automation: { status: string; published_version_id: string } }).automation
  for (const state of ['initial', 'draft', 'active']) {
    const response = await patch({ state, repeat_mode: 'once' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ state, repeat_mode: 'once', enabled: state === 'active' })
    expect((await (await list()).json() as { rows: AutomationKeywordTrigger[] }).rows[0]).toMatchObject({ state, repeat_mode: 'once' })
  }
  const after = (await (await authenticatedRequest('automations/auto-a')).json() as { automation: { status: string; published_version_id: string } }).automation
  expect(after.status).toBe(before.status)
  expect(after.published_version_id).toBe(before.published_version_id)
  expect((await patch({ state: 'inactive' })).status).toBe(400)
  expect((await patch({ repeat_mode: 'unknown' })).status).toBe(400)
  expect((await patch({ state: 'active', enabled: false })).status).toBe(400)
})

it('cria dois gatilhos iniciais em conexão efetiva, preserva isolamento e recusa conexão incompatível', async () => {
  const create = (value: unknown, automation = 'auto-a') => authenticatedRequest(`automations/${automation}/triggers`, 'a', { method: 'POST', body: JSON.stringify(value) })
  const input = { name: 'Pedido de material', connection_id: 'ch-a', node_id: 't', rule: 'contains', words: ['material'] }
  const response = await create(input)
  expect(response.status).toBe(201)
  const first = await response.json() as AutomationKeywordTrigger
  expect(first).toMatchObject({ name: input.name, channel_id: 'ch-a', node_id: 't', state: 'initial', repeat_mode: 'every_time', enabled: false })
  const second = await (await create({ ...input, name: 'Agenda', words: ['agenda'] })).json() as AutomationKeywordTrigger
  expect(second.id).not.toBe(first.id)
  expect((await (await list()).json() as { rows: AutomationKeywordTrigger[] }).rows.map(t => t.id)).toEqual(expect.arrayContaining([first.id, second.id]))
  expect((await create(input, 'auto-b')).status).toBe(404)
  expect((await create({ ...input, connection_id: 'ch-b' })).status).toBe(404)
  expect((await create({ ...input, node_id: 'm' })).status).toBe(400)
  expect((await create({ ...input, words: [] })).status).toBe(400)
  await env.DB.prepare(`UPDATE channels SET capabilities_override='{"inbound":{"message":false}}' WHERE id='ch-a'`).run()
  expect((await create(input)).status).toBe(400)
  await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE user_id='user-a'").run()
  expect((await create(input)).status).toBe(403)
})

it.each([{ state: 'active' }, { enabled: true }])('exige publicar o novo nó antes de ativar o gatilho por %j', async activation => {
  expect((await authenticatedRequest('automations/auto-a/publish', 'a', { method: 'POST' })).status).toBe(201)
  const draft = { nodes: [...graph.nodes, { id: 'new-trigger', type: 'trigger', position: { x: 0, y: 200 }, config: {} }],
    edges: [...graph.edges, { from: 'new-trigger', port: 'next', to: 'm' }] }
  expect((await authenticatedRequest('automations/auto-a/draft', 'a', { method: 'PUT', body: JSON.stringify({ graph: draft }) })).status).toBe(200)
  const created = await authenticatedRequest('automations/auto-a/triggers', 'a', { method: 'POST', body: JSON.stringify({
    name: 'Novo ponto de entrada', connection_id: 'ch-a', node_id: 'new-trigger', rule: 'contains', words: ['material'],
  }) })
  expect(created.status).toBe(201)
  const trigger = await created.json() as AutomationKeywordTrigger
  const blocked = await patch({ ...activation, repeat_mode: 'once', keyword_id: trigger.keywords[0]!.id, words: ['alterada'] }, trigger.id)
  expect(blocked.status).toBe(409)
  expect(await blocked.json()).toMatchObject({ error: expect.stringContaining('Publique') })
  const persisted = (await (await list()).json() as { rows: AutomationKeywordTrigger[] }).rows.find(row => row.id === trigger.id)
  expect(persisted).toEqual(trigger)
  expect((await authenticatedRequest('automations/auto-a/publish', 'a', { method: 'POST' })).status).toBe(201)
  const enabled = await patch(activation, trigger.id)
  expect(enabled.status).toBe(200)
  expect(await enabled.json()).toMatchObject({ id: trigger.id, state: 'active', enabled: true })
})

it('infere o passo do gatilho legado para mantê-lo visível com outro gatilho explícito, sem gravar config', async () => {
  await env.DB.prepare("UPDATE triggers SET config='{}' WHERE id='trg-a'").run()
  const response = await authenticatedRequest('automations/auto-a/triggers', 'a', { method: 'POST', body: JSON.stringify({
    name: 'Outro pedido', connection_id: 'ch-a', node_id: 't', rule: 'contains', words: ['agenda'],
  }) })
  expect(response.status).toBe(201)
  const created = await response.json() as AutomationKeywordTrigger
  const expected = [{ id: 'trg-a', node_id: 't' }, { id: created.id, node_id: 't' }]
  expect((await (await list()).json() as { rows: AutomationKeywordTrigger[] }).rows).toEqual(expect.arrayContaining(expected.map(value => expect.objectContaining(value))))
  const updated = await patch({ repeat_mode: 'once' })
  expect(updated.status).toBe(200)
  expect(await updated.json()).toMatchObject({ id: 'trg-a', node_id: 't', repeat_mode: 'once' })
  expect((await (await list()).json() as { rows: AutomationKeywordTrigger[] }).rows).toEqual(expect.arrayContaining(expected.map(value => expect.objectContaining(value))))
  expect(await env.DB.prepare("SELECT config FROM triggers WHERE id='trg-a'").first()).toEqual({ config: '{}' })
})

it('página do gatilho e Substituir: passa a disparar outra automação publicada, entrando pelo passo de gatilho dela', async () => {
  const { authenticatedRequest: req } = await import('./auth-helpers')
  const trig = await env.DB.prepare("SELECT id FROM triggers WHERE workspace_id='a' LIMIT 1").first<string>('id')
  const detail = await (await req(`triggers/${trig}`)).json() as { id: string; type_label: string }
  expect(detail).toMatchObject({ id: trig, type_label: expect.any(String) })
  await env.DB.batch([
    env.DB.prepare("INSERT INTO automations (id,workspace_id,name,status,draft_graph) VALUES ('auto-novo','a','Nova','live','{\"nodes\":[],\"edges\":[]}')"),
    env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('v-novo','a','auto-novo',1,?)").bind(JSON.stringify({ nodes: [{ id: 'entrada', type: 'trigger', position: { x: 0, y: 0 }, config: {} }], edges: [] })),
    env.DB.prepare("UPDATE automations SET published_version_id='v-novo' WHERE id='auto-novo'"),
  ])
  const r = await req(`triggers/${trig}/replace`, 'a', { method: 'POST', body: JSON.stringify({ automation_id: 'auto-novo' }) })
  expect(r.status).toBe(200)
  expect(await env.DB.prepare("SELECT automation_id,json_extract(config,'$.node_id') AS node FROM triggers WHERE id=?").bind(trig).first()).toEqual({ automation_id: 'auto-novo', node: 'entrada' })
})
