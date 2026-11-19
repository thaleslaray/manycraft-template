import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { runDueFollowUps } from '../src/flow/follow-ups'
import type { IntegrationEnv } from '../src/integrations'
import { d1ComGancho } from './d1-gancho'
import { graph, seed } from './fixtures'

const now = Date.now()
/** Workflows falso; `foraDoAr` simula o serviço caído: criar falha e a instância não existe. */
function workflows(foraDoAr = false) {
  return {
    create: vi.fn(async () => { if (foraDoAr) throw new Error('Workflows indisponível'); return {} }),
    get: vi.fn(async () => ({ status: async () => ({ status: 'unknown' }) })),
  }
}
const runtime = (bindings: Record<string, unknown>) => ({ ...env, INBOX_HUB: undefined, ...bindings }) as unknown as IntegrationEnv
const followUp = () => env.DB.prepare("SELECT done_at,outcome FROM trigger_follow_ups WHERE id='fu-1'").first<{ done_at: number | null; outcome: string | null }>()
const execucao = () => env.DB.prepare("SELECT workflow_created_at FROM flow_runs WHERE id='followup-fu-1'").first<{ workflow_created_at: number | null }>()

beforeEach(async () => {
  await seed()
  await env.DB.batch([
    env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('v1','a','auto-a',1,?)").bind(JSON.stringify(graph)),
    env.DB.prepare("UPDATE automations SET status='live',published_version_id='v1' WHERE id='auto-a'"),
    env.DB.prepare(`INSERT INTO trigger_follow_ups (id,workspace_id,trigger_id,contact_id,channel_id,automation_id,created_at,due_at)
      VALUES ('fu-1','a','trg-a','c-a','ch-a','auto-a',?,?)`).bind(now - 600_000, now - 60_000),
  ])
})

it('se gravar a execução falhar, o follow-up continua vencido e começa no minuto seguinte', async () => {
  const flow = workflows()
  const queda = d1ComGancho(env.DB, 'INSERT INTO flow_runs', () => { throw new Error('D1 indisponível') })
  await expect(runDueFollowUps(runtime({ DB: queda, FLOW_RUN: flow }), now)).rejects.toThrow('D1 indisponível')
  expect(await followUp()).toEqual({ done_at: null, outcome: null })
  expect(await execucao()).toBeNull()
  await runDueFollowUps(runtime({ FLOW_RUN: flow }), now + 60_000)
  expect(await followUp()).toEqual({ done_at: now + 60_000, outcome: 'started' })
  expect((await execucao())?.workflow_created_at).not.toBeNull()
  expect(flow.create).toHaveBeenCalledOnce()
  expect(flow.create).toHaveBeenCalledWith({ id: 'followup-fu-1', params: { runId: 'followup-fu-1' } })
})

it('um follow-up que falha não segura os outros do mesmo minuto, e a falha ainda chega ao cron', async () => {
  await env.DB.prepare(`INSERT INTO trigger_follow_ups (id,workspace_id,trigger_id,contact_id,channel_id,automation_id,created_at,due_at)
    VALUES ('fu-2','a','trg-a','c-a','ch-a','auto-a',?,?)`).bind(now - 600_000, now - 30_000).run()
  const flow = workflows()
  // Só a primeira gravação cai: a do fu-1, primeiro da fila pelo vencimento.
  const queda = d1ComGancho(env.DB, 'INSERT INTO flow_runs', () => { throw new Error('D1 indisponível') })
  await expect(runDueFollowUps(runtime({ DB: queda, FLOW_RUN: flow }), now)).rejects.toThrow('D1 indisponível')
  expect(await followUp()).toEqual({ done_at: null, outcome: null })
  expect(await env.DB.prepare("SELECT done_at,outcome FROM trigger_follow_ups WHERE id='fu-2'").first()).toEqual({ done_at: now, outcome: 'started' })
  expect(flow.create).toHaveBeenCalledWith({ id: 'followup-fu-2', params: { runId: 'followup-fu-2' } })
})

it('se criar o Workflow falhar, o follow-up já decidido tenta de novo no minuto seguinte, com a mesma execução', async () => {
  await expect(runDueFollowUps(runtime({ FLOW_RUN: workflows(true) }), now)).rejects.toThrow('Workflows indisponível')
  expect(await followUp()).toEqual({ done_at: null, outcome: 'started' })
  expect((await execucao())?.workflow_created_at).toBeNull()
  // A decisão foi gravada junto com a execução: uma mensagem do contato depois disso não a desfaz.
  await env.DB.prepare("UPDATE contact_channels SET last_inbound_at=? WHERE id='cc-a'").bind(now + 30_000).run()
  const flow = workflows()
  await runDueFollowUps(runtime({ FLOW_RUN: flow }), now + 60_000)
  expect(flow.create).toHaveBeenCalledOnce()
  expect(await followUp()).toEqual({ done_at: now + 60_000, outcome: 'started' })
  expect((await execucao())?.workflow_created_at).not.toBeNull()
  expect(await env.DB.prepare("SELECT count(*) AS n FROM flow_runs WHERE id LIKE 'followup-%'").first('n')).toBe(1)
  // Feito é feito: o minuto seguinte não cria nada de novo.
  await runDueFollowUps(runtime({ FLOW_RUN: flow }), now + 120_000)
  expect(flow.create).toHaveBeenCalledOnce()
})
