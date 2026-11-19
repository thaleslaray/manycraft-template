import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import type { Graph, GraphNode } from '../src/contracts'
import { publishAutomation } from '../src/db/automations'
import { startAutomation } from '../src/flow/nodes'
import type { FlowEnv, Run } from '../src/flow/types'
import { seed } from './fixtures'

// Auditoria de segurança, D1: automação que inicia a si mesma não multiplica execuções.
const node = (id: string, type: GraphNode['type'], config: GraphNode['config'] = {}): GraphNode => ({ id, type, position: { x: 0, y: 0 }, config })
const say = node('m', 'message', { blocks: [{ kind: 'text', text: 'Oi' }] })
const draft = (...middle: GraphNode[]): Graph => {
  const nodes = [node('t', 'trigger'), say, ...middle]
  return { nodes, edges: nodes.slice(0, -1).map((n, i) => ({ from: n.id, port: 'next', to: nodes[i + 1].id })) }
}
const publish = async (graph: Graph) => {
  await env.DB.prepare("UPDATE automations SET draft_graph=? WHERE id='auto-a'").bind(JSON.stringify(graph)).run()
  return publishAutomation(env.DB, 'a', 'auto-a')
}
beforeEach(seed)

it('publicar automação que inicia a si mesma sem espera antes é recusado com mensagem clara', async () => {
  for (const type of ['start_automation', 'goto'] as const) {
    const error = await publish(draft(node('self', type as GraphNode['type'], { automation_id: 'auto-a', wait_for_finish: false }))).catch(e => e as Error)
    expect((error as Error).message).toMatch(/inicia a própria automação/)
    expect((error as { status?: number }).status).toBe(400)
  }
  const waiting = await publish(draft(node('self', 'start_automation', { automation_id: 'auto-a', wait_for_finish: true }))).catch(e => e as Error)
  expect((waiting as Error).message).toMatch(/própria automação/)
})
it('iniciar a si mesma depois de uma espera (ou outra automação, sem espera) continua publicável', async () => {
  const wait = node('w', 'smart_delay', { duration: { value: 1, unit: 'days' } })
  expect((await publish(draft(wait, node('self', 'start_automation', { automation_id: 'auto-a' })))).version).toBe(1)
  await env.DB.batch([
    env.DB.prepare("INSERT INTO automations (id,workspace_id,name) VALUES ('auto-t','a','Alvo')"),
    env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('auto-t-v1','a','auto-t',1,?)").bind(JSON.stringify(draft())),
    env.DB.prepare("UPDATE automations SET status='live',published_version_id='auto-t-v1' WHERE id='auto-t'"),
  ])
  expect((await publish(draft(node('other', 'start_automation', { automation_id: 'auto-t' })))).version).toBe(2)
})

async function seedRoot() {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO automations (id,workspace_id,name) VALUES ('auto-c','a','C')"),
    env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('auto-c-v1','a','auto-c',1,?)").bind(JSON.stringify(draft())),
    env.DB.prepare("UPDATE automations SET status='live',published_version_id='auto-c-v1' WHERE id='auto-c'"),
    env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('auto-a-v1','a','auto-a',1,?)").bind(JSON.stringify(draft())),
    env.DB.prepare("UPDATE automations SET status='live',published_version_id='auto-a-v1' WHERE id='auto-a'"),
    env.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,automation_version_id,channel_id) VALUES ('root','a','c-a','auto-a-v1','ch-a')"),
  ])
  const created: string[] = []
  const flowEnv = { ...env, FLOW_RUN: { create: async ({ id }: { id: string }) => { created.push(id); return {} }, get: async () => ({ status: async () => ({ status: 'running' }) }) } } as unknown as FlowEnv
  const run = (id: string, depth = 0, root: string | null = null) => ({ id, workspace_id: 'a', contact_id: 'c-a', channel_id: 'ch-a', channel_type: 'instagram', automation_version_id: 'auto-a-v1',
    automation_id: 'auto-a', graph: '{}', start_node_id: null, depth, external_user_id: 'user-a', root_run_id: root }) as Run
  return { created, flowEnv, run }
}
it('ciclo A → B → A com vários passos para no teto de 20 execuções filhas por execução raiz, sem criar a 21ª', async () => {
  const { created, flowEnv, run } = await seedRoot()
  // A raiz inicia B em 3 passos; cada filha de B inicia A em 3 passos, e assim por diante (a árvore cresceria 3, 9, 27...).
  let level = [run('root')], started = 0, refused = 0
  for (let depth = 0; depth < 4 && level.length; depth++) {
    const next: Run[] = []
    for (const parent of level) for (let index = 0; index < 3; index++) {
      try {
        const id = await startAutomation(flowEnv, parent, index, { automation_id: depth % 2 === 0 ? 'auto-c' : 'auto-a' })
        started++
        const row = await env.DB.prepare('SELECT root_run_id FROM flow_runs WHERE id=?').bind(id).first<{ root_run_id: string }>()
        expect(row!.root_run_id).toBe('root')
        next.push(run(id, depth + 1, 'root'))
      } catch (error) {
        expect((error as Error).message).toBe('Automation child run limit')
        refused++
      }
    }
    level = next
  }
  expect(started).toBe(20)
  expect(refused).toBeGreaterThan(0)
  expect(created.length).toBe(20)
  expect(await env.DB.prepare("SELECT count(*) n FROM flow_runs WHERE root_run_id='root'").first('n')).toBe(20)
})
it('uma automação legítima que chama outra uma vez continua funcionando, e o replay não conta de novo', async () => {
  const { flowEnv, run } = await seedRoot()
  const id = await startAutomation(flowEnv, run('root'), 0, { automation_id: 'auto-c' })
  expect(await startAutomation(flowEnv, run('root'), 0, { automation_id: 'auto-c' })).toBe(id)
  expect(await env.DB.prepare("SELECT count(*) n FROM flow_runs WHERE root_run_id='root'").first('n')).toBe(1)
})
