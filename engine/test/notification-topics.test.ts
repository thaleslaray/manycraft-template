import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { graph } from './fixtures'
import { actions } from '../src/flow/nodes'
import { contactFilterSql } from '../src/email-channel/filters'
import { authenticatedRequest, seedAuth } from './auth-helpers'
import type { FlowEnv, Run } from '../src/flow/types'

const bindings = env as unknown as FlowEnv
const run = { id: 'tp-run', workspace_id: 'a', contact_id: 'c-a', channel_id: 'ch-a', automation_id: 'auto-a' } as Run
beforeEach(async () => {
  await seedAuth()
  await env.DB.batch([
    env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('tp-v','a','auto-a',1,?)").bind(JSON.stringify(graph)),
    env.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,channel_id,automation_version_id) VALUES ('tp-run','a','c-a','ch-a','tp-v')"),
  ])
})

it('tópicos: cria por conexão, o passo do fluxo inscreve (re-opt-in renova), a lista conta inscritos e o filtro de público usa o tópico', async () => {
  const created = await authenticatedRequest('notification-topics', 'a', { method: 'POST', body: JSON.stringify({ channel_id: 'ch-a', name: 'Ofertas da semana', validity_days: 3 }) })
  expect(created.status).toBe(201)
  const { id } = await created.json() as { id: string }
  expect((await authenticatedRequest('notification-topics', 'a', { method: 'POST', body: JSON.stringify({ channel_id: 'ch-a', name: 'Ofertas da semana' }) })).status).toBe(409)
  await actions(bindings, run, { actions: [{ type: 'subscribe_topic', topic_id: id }] }, 1)
  const list = async () => (await (await authenticatedRequest('notification-topics')).json() as { items: { subscribers: number; expiring: number }[] }).items[0]
  expect(await list()).toMatchObject({ subscribers: 1, expiring: 1 })
  const filter = await contactFilterSql(env.DB, 'a', { match: 'all', rules: [{ type: 'topic', topic_id: id, operator: 'has' }] })
  const matched = await env.DB.prepare(`SELECT c.id FROM contacts c WHERE c.workspace_id='a' AND ${filter.sql}`).bind(...filter.values).all()
  expect(matched.results).toEqual([{ id: 'c-a' }])
  const segment = await authenticatedRequest('email/segments', 'a', { method: 'POST', body: JSON.stringify({ name: 'Tópico: ofertas', filter: { match: 'all', rules: [{ type: 'topic', topic_id: id, operator: 'has' }] } }) })
  expect(segment.status).toBe(201)
  await actions(bindings, run, { actions: [{ type: 'unsubscribe_topic', topic_id: id }] }, 2)
  expect(await list()).toMatchObject({ subscribers: 0 })
})

it('condição inteligente de tópico: tem inscrição válida (em um tópico ou em qualquer um)', async () => {
  const { matchesFlowCondition } = await import('../src/flow/conditions')
  await env.DB.prepare("INSERT INTO notification_topics (id,workspace_id,channel_id,name,created_at) VALUES ('tp1','a','ch-a','X',1)").run()
  const ctx = { workspace_id: 'a', contact_id: 'c-a' } as never
  expect(await matchesFlowCondition(env.DB, ctx, { match: 'all', rules: [{ type: 'topic', operator: 'has' }] })).toBe(false)
  await env.DB.prepare("INSERT INTO topic_subscriptions VALUES ('a','tp1','c-a','subscribed',?,1)").bind(Date.now() + 60_000).run()
  expect(await matchesFlowCondition(env.DB, ctx, { match: 'all', rules: [{ type: 'topic', topic_id: 'tp1', operator: 'has' }] })).toBe(true)
})
