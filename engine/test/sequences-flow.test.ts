import { introspectWorkflow, type WorkflowIntrospector } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Graph, GraphNode } from '../src/contracts'
import { publishAutomation, saveDraft } from '../src/db/automations'
import { getSequence, saveSequence } from '../src/db/sequences'
import { ChannelLimiter } from '../src/flow/limiter'
import { actions } from '../src/flow/nodes'
import { dispatchSequences } from '../src/flow/sequences'
import type { FlowEnv, Run } from '../src/flow/types'
import { graph, seed } from './fixtures'

// The cron plans the sequence step and the real FlowRun Workflow executes it; only the provider network is simulated.
const bindings = env as unknown as FlowEnv
const origin = { id: 'origin', workspace_id: 'a', contact_id: 'c-a', channel_id: 'ch-a', depth: 0 } as Run
const node = (id: string, type: GraphNode['type'], config: GraphNode['config'] = {}): GraphNode => ({ id, type, config, position: { x: 0, y: 0 } })
let workflow: WorkflowIntrospector | undefined

beforeEach(async () => {
  await seed()
  await env.DB.batch([
    env.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('v1','a','auto-a',1,?)").bind(JSON.stringify(graph)),
    env.DB.prepare("UPDATE automations SET status='live',published_version_id='v1' WHERE id='auto-a'"),
    env.DB.prepare("UPDATE channels SET type='telegram' WHERE id='ch-a'"),
    env.DB.prepare("INSERT INTO flow_runs(id,workspace_id,contact_id,channel_id,automation_version_id) VALUES ('origin','a','c-a','ch-a','v1')"),
    env.DB.prepare("INSERT INTO sequences(id,workspace_id,name) VALUES ('seq-a','a','Série')"),
    env.DB.prepare("INSERT INTO sequence_steps(id,workspace_id,sequence_id,automation_id,position,delay_seconds,status) VALUES ('step-a','a','seq-a','auto-a',0,0,'live')"),
  ])
  vi.spyOn(ChannelLimiter.prototype, 'acquire').mockResolvedValue({ allowed: true, retryAfter: 0 })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ ok: true, result: { message_id: 11 } }))
})
afterEach(async () => {
  await workflow?.dispose()
  workflow = undefined
  vi.restoreAllMocks()
})

/** Enrolls through the action, lets the cron plan the first step and returns the Workflow instance it created. */
async function enroll(channel = 'ch-a', { realDelay = false } = {}) {
  workflow = await introspectWorkflow(env.FLOW_RUN)
  await workflow.modifyAll(async modifier => {
    if (!realDelay) await modifier.disableSleeps()
    await modifier.disableRetryDelays()
  })
  await actions(bindings, { ...origin, channel_id: channel }, { actions: [{ type: 'add_to_sequence', sequence_id: 'seq-a' }] }, 1)
  await dispatchSequences(bindings)
  const instances = await workflow.get()
  expect(instances).toHaveLength(1)
  const id = await env.DB.prepare("SELECT id FROM flow_runs WHERE id LIKE 'sequence-%'").first<string>('id')
  expect(id).toBeTruthy()
  return { instance: instances[0], id: id! }
}

it('uma inscrição de sequência percorre o executor e persiste envio Telegram com transporte simulado', async () => {
  const { instance, id } = await enroll()
  await instance.waitForStatus('complete')
  expect(fetch).toHaveBeenCalledTimes(1)
  const request = new Request(...(vi.mocked(fetch).mock.calls[0] as [RequestInfo, RequestInit]))
  expect(request.url).toBe('https://api.telegram.org/botTESTONLY/sendMessage')
  expect(await request.json()).toMatchObject({ chat_id: 'user-a', text: 'Olá!' })
  expect(await env.DB.prepare('SELECT status FROM flow_runs WHERE id=?').bind(id).first('status')).toBe('done')
  expect(await env.DB.prepare("SELECT count(*) AS n FROM node_events WHERE flow_run_id=? AND type='sent'").bind(id).first('n')).toBe(1)
})

it('publica passo só de ações, executa sem envio e avança para o próximo passo', async () => {
  await saveDraft(env.DB, 'a', 'auto-a', { nodes: [graph.nodes[0], node('action', 'action', { actions: [{ type: 'remove_tag', tag_id: 'tag-a' }] })],
    edges: [{ from: 't', port: 'next', to: 'action' }] } satisfies Graph)
  await publishAutomation(env.DB, 'a', 'auto-a')
  await saveSequence(env.DB, 'a', { name: 'Só ações', steps: [
    { id: 'step-a', automation_id: 'auto-a', status: 'live', delay_seconds: 0, sending_time_settings: { type: 'all' } },
    { id: 'step-next', automation_id: 'auto-a', status: 'live', delay_seconds: 60, sending_time_settings: { type: 'all' } },
  ] }, 'seq-a')
  const { instance, id } = await enroll()
  await instance.waitForStatus('complete')
  expect(await env.DB.prepare('SELECT status FROM flow_runs WHERE id=?').bind(id).first('status')).toBe('done')
  expect(await env.DB.prepare("SELECT tag_id FROM contact_tags WHERE workspace_id='a' AND contact_id='c-a'").first()).toBeNull()
  expect(fetch).not.toHaveBeenCalled()
  await dispatchSequences(bindings)
  expect(await env.DB.prepare("SELECT next_step,pending_run_id FROM sequence_subscriptions WHERE workspace_id='a' AND sequence_id='seq-a'").first())
    .toMatchObject({ next_step: 1, pending_run_id: null })
  expect(await getSequence(env.DB, 'a', 'seq-a')).toMatchObject({ stats: { sent: 0, delivered: 0, read: 0, clicked: 0, open_rate: 0, ctr: 0 } })
})

it('janela WhatsApp vencida bloqueia envio pelo mesmo executor', async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('wa-a','a','whatsapp','test-phone')"),
    env.DB.prepare("INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,identity_kind,opted_in,window_expires_at) VALUES ('cc-wa','a','c-a','wa-a','BR.testuser','bsuid',1,?)").bind(Date.now() - 1),
  ])
  const { instance, id } = await enroll('wa-a')
  await instance.waitForStatus('errored')
  expect(fetch).not.toHaveBeenCalled()
  expect(await env.DB.prepare('SELECT status,error FROM flow_runs WHERE id=?').bind(id).first()).toEqual({ status: 'failed', error: 'channel_outside_window' })
})

it('sair da sequência durante a espera impede o envio quando o Workflow retoma', async () => {
  const delayed: Graph = { nodes: [graph.nodes[0], node('wait', 'smart_delay', { duration: { value: 2, unit: 'seconds' } }), graph.nodes[1]],
    edges: [{ from: 't', port: 'next', to: 'wait' }, { from: 'wait', port: 'next', to: 'm' }] }
  await env.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('v2','a','auto-a',2,?)").bind(JSON.stringify(delayed)).run()
  await env.DB.prepare("UPDATE automations SET published_version_id='v2' WHERE id='auto-a'").run()
  // The real two-second sleep keeps the run parked while the contact leaves the sequence.
  const { instance, id } = await enroll('ch-a', { realDelay: true })
  await instance.waitForStepResult({ name: 'waiting:1' })
  await actions(bindings, origin, { actions: [{ type: 'remove_from_sequence', sequence_id: 'seq-a' }] }, 2)
  await instance.waitForStatus('errored')
  expect(fetch).not.toHaveBeenCalled()
  expect(await env.DB.prepare('SELECT status,error FROM flow_runs WHERE id=?').bind(id).first()).toEqual({ status: 'failed', error: 'sequence_unsubscribed' })
}, 30_000)
