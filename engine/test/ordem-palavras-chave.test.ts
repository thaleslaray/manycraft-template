import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest as request, seedAuth } from './auth-helpers'
import { listKeywordRules } from '../src/db/keywords'

const priorities = async (workspace = 'a') => (await env.DB.prepare(
  'SELECT id,priority FROM keywords WHERE workspace_id=? AND parent_id IS NULL ORDER BY priority,id').bind(workspace).all<{ id: string; priority: number }>()).results

beforeEach(async () => {
  await seedAuth()
  await env.DB.prepare("UPDATE channels SET type='telegram' WHERE id='ch-a'").run()
})

it('gatilho criado no editor entra no fim da lista do workspace, não com prioridade 0', async () => {
  const create = (name: string) => request('automations/auto-a/triggers', 'a', { method: 'POST',
    body: JSON.stringify({ name, connection_id: 'ch-a', node_id: 't', rule: 'contains', words: [name] }) })
  expect((await create('um')).status).toBe(201)
  expect((await create('dois')).status).toBe(201)
  expect((await priorities()).map(row => row.priority)).toEqual([1, 2, 3])
})

it('modelo de automação grava a palavra no fim da lista do workspace', async () => {
  const response = await request('automation-templates?connection_id=ch-a')
  const model = (await response.json() as { templates: { id: string; version: number }[] }).templates.find(t => t.id === 'link-palavra')!
  for (const word of ['alfa', 'beta']) {
    expect((await request('automation-templates', 'a', { method: 'POST',
      body: JSON.stringify({ template_id: model.id, version: model.version, connection_id: 'ch-a', word, url: 'https://exemplo.test' }) })).status).toBe(201)
  }
  expect((await priorities()).map(row => row.priority)).toEqual([1, 2, 3])
})

it('duplicar automação põe as cópias no fim da lista, na mesma ordem relativa', async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES ('k-late','a','trg-a','is','[\"x\"]','live',7)"),
    env.DB.prepare("INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES ('k-child','a','trg-a','contains','[\"y\"]','draft',0)"),
    env.DB.prepare("UPDATE keywords SET parent_id='k-late' WHERE id='k-child'"),
  ])
  const copy = await (await request('automations/auto-a/duplicate', 'a', { method: 'POST' })).json() as { id: string }
  const rows = (await env.DB.prepare(`SELECT k.priority,k.words,k.parent_id FROM keywords k JOIN triggers t ON t.id=k.trigger_id
    WHERE t.automation_id=? AND k.parent_id IS NULL ORDER BY k.priority`).bind(copy.id).all<{ priority: number; words: string }>()).results
  expect(rows.map(row => [row.priority, row.words])).toEqual([[8, '["quero"]'], [9, '["x"]']])
})

it('a página lista na mesma ordem em que o motor desempata', async () => {
  const add = (id: string, created: number) => env.DB.batch([
    env.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config,created_at) VALUES (?,?,?,?,?,'keyword','active','every_time','{}',?)")
      .bind(`t-${id}`, 'a', 'auto-a', 'ch-a', id, created),
    env.DB.prepare("INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES (?,?,?,'contains','[\"z\"]','live',5)").bind(id, 'a', `t-${id}`),
  ])
  await add('aaa-novo', 3000)
  await add('zzz-antigo', 1000)
  const ids = (await listKeywordRules(env.DB, 'a')).map(row => row.id)
  expect(ids.indexOf('zzz-antigo')).toBeLessThan(ids.indexOf('aaa-novo'))
})

it('a migração renumera empates preservando a ordem antiga (especificidade, depois idade)', async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM keywords WHERE workspace_id='a'"),
    ...[['t-contem', 'contains', 1000], ['t-exato', 'is', 3000], ['t-exato-velho', 'is', 2000]].flatMap(([id, rule, created]) => [
      env.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config,created_at) VALUES (?,?,?,?,?,'keyword','active','every_time','{}',?)")
        .bind(id, 'a', 'auto-a', 'ch-a', id, created),
      env.DB.prepare("INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES (?,?,?,?,'[\"x\"]','live',0)").bind(`k-${id}`, 'a', id, rule),
    ]),
    env.DB.prepare("INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES ('k-manual','a','t-contem','contains','[\"m\"]','live',9)"),
  ])
  const migration = env.TEST_MIGRATIONS.find(m => m.name.startsWith('0055'))!
  for (const query of migration.queries) await env.DB.prepare(query).run()
  expect((await priorities()).map(row => row.id)).toEqual(['k-t-exato-velho', 'k-t-exato', 'k-t-contem', 'k-manual'])
  expect((await priorities()).map(row => row.priority)).toEqual([0, 1, 2, 3])
})
