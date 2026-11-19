import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { moveRun, runGuard, type RunStatus } from '../src/flow/run-state'
import { seed } from './fixtures'

const graph = { nodes: [{ id: 'wait', type: 'smart_delay', position: { x: 0, y: 0 }, config: { duration: { value: 1, unit: 'hours' } } }], edges: [] }
const row = () => env.DB.prepare("SELECT status,wait_reason,wait_until,error FROM flow_runs WHERE id='r1'").first<{ status: string; wait_reason: string | null; wait_until: number | null; error: string | null }>()
const put = (status: RunStatus, extra = '') => env.DB.prepare(`UPDATE flow_runs SET status=?${extra} WHERE id='r1'`).bind(status).run()

beforeEach(async () => {
  await seed()
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('tg-a','a','telegram','bot')"),
    env.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('cc','a','c-a','tg-a','100',1)"),
    env.DB.prepare("INSERT INTO conversations (id,workspace_id,contact_channel_id) VALUES ('conv','a','cc')"),
    env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('v1','a','auto-a',1,?)").bind(JSON.stringify(graph)),
    env.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,automation_version_id,channel_id) VALUES ('r1','a','c-a','v1','tg-a')"),
  ])
})

describe('transições de flow_runs', () => {
  it('nenhum final é sobrescrito: done, failed e cancelled ficam como estão', async () => {
    for (const final of ['done', 'failed', 'cancelled'] as const) {
      await put(final)
      for (const to of ['running', 'waiting_click', 'waiting_input', 'done', 'failed', 'cancelled'] as const)
        expect((await moveRun(env.DB, 'r1', to).run()).meta.changes, `${final} → ${to}`).toBe(0)
      expect((await moveRun(env.DB, 'r1', 'waiting_delay', { waitReason: 'delay', waitUntil: 1 }).run()).meta.changes).toBe(0)
      expect((await row())!.status).toBe(final)
    }
  })
  it('esperas: waiting_input só nasce de running; waiting_click de running ou de si mesmo (lembrete)', async () => {
    await put('waiting_delay', ",wait_reason='delay'")
    expect((await moveRun(env.DB, 'r1', 'waiting_input').run()).meta.changes).toBe(0)
    expect((await moveRun(env.DB, 'r1', 'waiting_click', { waitUntil: 5 }).run()).meta.changes).toBe(0)
    await moveRun(env.DB, 'r1', 'running').run()
    expect((await moveRun(env.DB, 'r1', 'waiting_click', { waitUntil: 5 }).run()).meta.changes).toBeGreaterThan(0)
    expect((await moveRun(env.DB, 'r1', 'waiting_click', { waitUntil: 6 }).run()).meta.changes).toBeGreaterThan(0)
    expect(await row()).toMatchObject({ status: 'waiting_click', wait_until: 6, wait_reason: null })
  })
  it('waiting_delay leva o motivo; outra transição limpa motivo e hora, e o erro só muda quando pedido', async () => {
    expect(() => moveRun(env.DB, 'r1', 'waiting_delay')).toThrow()
    expect(() => moveRun(env.DB, 'r1', 'running', { waitReason: 'delay' })).toThrow()
    expect(() => runGuard('waiting_input', 'status', ['waiting_delay'])).toThrow()
    await moveRun(env.DB, 'r1', 'waiting_delay', { waitReason: 'safety_pause', error: 'consecutive_block_limit' }).run()
    expect(await row()).toMatchObject({ status: 'waiting_delay', wait_reason: 'safety_pause', error: 'consecutive_block_limit' })
    await moveRun(env.DB, 'r1', 'done').run()
    expect(await row()).toMatchObject({ status: 'done', wait_reason: null, wait_until: null, error: 'consecutive_block_limit' })
  })
  it('cancelamento em lote de outro arquivo (sem moveRun) também limpa o motivo da espera', async () => {
    await moveRun(env.DB, 'r1', 'waiting_delay', { waitReason: 'connection', waitUntil: Date.now() + 1000 }).run()
    await env.DB.prepare("UPDATE flow_runs SET status='cancelled',wait_until=NULL WHERE contact_id='c-a'").run()
    expect(await row()).toMatchObject({ status: 'cancelled', wait_reason: null })
  })
  it('a conversa só ganha "espera iniciada" no passo Espera, não na espera da conexão nem na pausa humana', async () => {
    const events = () => env.DB.prepare("SELECT count(*) n FROM messages WHERE conversation_id='conv' AND json_extract(content,'$.event.kind')='delay_started'").first<number>('n')
    await moveRun(env.DB, 'r1', 'running', { currentNodeId: 'wait' }).run()
    await moveRun(env.DB, 'r1', 'waiting_delay', { waitReason: 'connection', waitUntil: Date.now() + 1000 }).run()
    await moveRun(env.DB, 'r1', 'running').run()
    await moveRun(env.DB, 'r1', 'waiting_delay', { waitReason: 'human_pause', waitUntil: Date.now() + 1000 }).run()
    expect(await events()).toBe(0)
    await moveRun(env.DB, 'r1', 'running').run()
    await moveRun(env.DB, 'r1', 'waiting_delay', { waitReason: 'delay', waitUntil: Date.now() + 1000 }).run()
    expect(await events()).toBe(1)
  })
})
