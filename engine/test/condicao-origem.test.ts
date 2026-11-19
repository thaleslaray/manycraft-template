import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { seed, graph } from './fixtures'
import { condition } from '../src/flow/nodes'
import { publishAutomation } from '../src/db/automations'

const run: any = { id: 'run-origem', workspace_id: 'a', contact_id: 'c-a', channel_id: 'ch-a', automation_id: 'auto-a' }
const origem = (origin: string, operator = 'is') => ({ match: 'all', rules: [{ type: 'origin', origin, operator }] })

beforeEach(async () => {
  await seed()
  await env.DB.batch([
    env.DB.prepare("INSERT INTO automation_versions(workspace_id,id,automation_id,version,graph) VALUES ('a','ver-a','auto-a',1,?)").bind(JSON.stringify(graph)),
    env.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status) VALUES ('trg-ads','a','auto-a','ch-a','Anúncio','widget','ads','active')"),
  ])
})
const novaExecucao = (id: string, trigger: string | null, at: number) =>
  env.DB.prepare("INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,trigger_id,created_at) VALUES (?,'a','c-a','ver-a',?,?)").bind(id, trigger, at).run()

it('origem é o gatilho da primeira passagem do contato, por tipo de gatilho ou de widget', async () => {
  await novaExecucao('r1', 'trg-a', 1000)
  await novaExecucao('r2', 'trg-ads', 2000)
  expect(await condition(env, run, origem('keyword'))).toBe('true')
  expect(await condition(env, run, origem('ads'))).toBe('false')
  expect(await condition(env, run, origem('ads', 'is_not'))).toBe('true')
  expect(await condition(env, run, origem('keyword', 'is_not'))).toBe('false')
  expect(await condition(env, run, origem('widget'))).toBe('false')
})
it('origem por widget acha o tipo do widget e ignora passagens sem gatilho', async () => {
  await novaExecucao('r0', null, 500)
  await novaExecucao('r1', 'trg-ads', 1000)
  expect(await condition(env, run, origem('ads'))).toBe('true')
  expect(await condition(env, run, origem('widget'))).toBe('true')
})
it('contato sem passagem não tem origem: "é" falha e "não é" passa', async () => {
  expect(await condition(env, run, origem('keyword'))).toBe('false')
  expect(await condition(env, run, origem('keyword', 'is_not'))).toBe('true')
})
it('publicação recusa origem desconhecida', async () => {
  const draft = { nodes: [...graph.nodes, { id: 'logic', type: 'condition', position: { x: 0, y: 0 }, config: origem('inventada') }], edges: graph.edges }
  await env.DB.prepare("UPDATE automations SET draft_graph=? WHERE id='auto-a'").bind(JSON.stringify(draft)).run()
  await expect(publishAutomation(env.DB, 'a', 'auto-a')).rejects.toThrow()
})
