import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { seed, graph } from './fixtures'
import { actions } from '../src/flow/nodes'
import { dispatchSequences, nextSequenceWindow, rescheduleSequenceSubscriptions, sequenceRunActive } from '../src/flow/sequences'
import type { FlowEnv, Run } from '../src/flow/types'

const bindings = env as unknown as FlowEnv
const origin = { id: 'origin', workspace_id: 'a', contact_id: 'c-a', channel_id: 'ch-a', depth: 0 } as Run
const add = { actions: [{ type: 'add_to_sequence', sequence_id: 'seq-a' }] }
const remove = { actions: [{ type: 'remove_from_sequence', sequence_id: 'seq-a' }] }
let now: number
let create: ReturnType<typeof vi.fn>
const subscription = () => bindings.DB.prepare("SELECT * FROM sequence_subscriptions WHERE sequence_id='seq-a' AND contact_id='c-a'").first<any>()
const sequenceRuns = () => bindings.DB.prepare('SELECT r.* FROM flow_runs r JOIN sequence_flow_runs s ON s.run_id=r.id ORDER BY r.created_at,r.id').all<any>()

beforeEach(async () => {
  await seed()
  now = Date.parse('2026-10-23T12:00:00Z')
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  create = vi.fn(async () => ({}))
  bindings.FLOW_RUN = { create, get: vi.fn(async () => ({ status: async () => ({ status: 'unknown' }) })) } as unknown as FlowEnv['FLOW_RUN']
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('v1','a','auto-a',1,?)").bind(JSON.stringify(graph)),
    bindings.DB.prepare("UPDATE automations SET status='live',published_version_id='v1' WHERE id='auto-a'"),
    bindings.DB.prepare("UPDATE channels SET type='telegram' WHERE id='ch-a'"),
    bindings.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,channel_id,automation_version_id) VALUES ('origin','a','c-a','ch-a','v1')"),
    bindings.DB.prepare("INSERT INTO sequences (id,workspace_id,name) VALUES ('seq-a','a','Sequência de teste'),('seq-b','b','Outro espaço')"),
    bindings.DB.prepare(`INSERT INTO sequence_steps (id,workspace_id,sequence_id,automation_id,position,delay_seconds,status)
      VALUES ('step-1','a','seq-a','auto-a',0,60,'live'),('step-draft','a','seq-a',NULL,1,1,'draft'),('step-2','a','seq-a','auto-a',2,120,'live')`),
  ])
})
afterEach(() => vi.restoreAllMocks())

it('inscreve uma vez, ignora repetição da ação e bloqueia sequência de outro workspace', async () => {
  await actions(bindings, origin, add, 1)
  const original = await subscription()
  expect(original.next_at).toBe(now + 60000)
  await actions(bindings, origin, add, 1)
  await actions(bindings, origin, add, 2)
  expect(await subscription()).toEqual(original)
  await expect(actions(bindings, origin, { actions: [{ type: 'add_to_sequence', sequence_id: 'seq-b' }] }, 3)).rejects.toThrow('workspace')
  expect(await bindings.DB.prepare("SELECT count(*) AS n FROM sequence_subscriptions WHERE workspace_id='b'").first('n')).toBe(0)
})

it('calcula o primeiro atraso em segundos e congela uma versão por envio mesmo após retry', async () => {
  await actions(bindings, origin, add, 1)
  await dispatchSequences(bindings, now + 59999)
  expect(create).not.toHaveBeenCalled()
  now += 60000
  create.mockRejectedValueOnce(new Error('Transient binding outage'))
  expect(await dispatchSequences(bindings, now)).toEqual({ failed: 1 })
  const first = (await sequenceRuns()).results[0]
  expect(first.automation_version_id).toBe('v1')
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('v2','a','auto-a',2,?)").bind(JSON.stringify(graph)),
    bindings.DB.prepare("UPDATE automations SET published_version_id='v2' WHERE id='auto-a'"),
  ])
  expect(await dispatchSequences(bindings, now)).toEqual({ failed: 0 })
  expect((await sequenceRuns()).results).toHaveLength(1)
  expect((await sequenceRuns()).results[0].automation_version_id).toBe('v1')
  expect(create).toHaveBeenCalledTimes(2)
})

it('conta atraso seguinte desde o envio anterior, pula rascunhos e não reinscreve sequência concluída', async () => {
  await actions(bindings, origin, add, 1)
  now += 60000
  await dispatchSequences(bindings, now)
  let pending = (await subscription()).pending_run_id
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO node_events (workspace_id,automation_id,node_id,contact_id,flow_run_id,type,created_at) VALUES ('a','auto-a','m','c-a',?,'sent',?)").bind(pending, now),
    bindings.DB.prepare("UPDATE flow_runs SET status='done',updated_at=? WHERE id=?").bind(now + 10000, pending),
  ])
  await dispatchSequences(bindings, now)
  expect((await subscription()).next_at).toBe(now + 120000)
  expect((await subscription()).next_step).toBe(2)
  now += 120000
  await dispatchSequences(bindings, now)
  expect((await sequenceRuns()).results).toHaveLength(2)
  pending = (await subscription()).pending_run_id
  await bindings.DB.prepare("UPDATE flow_runs SET status='done',updated_at=? WHERE id=?").bind(now, pending).run()
  await dispatchSequences(bindings, now)
  expect((await subscription()).next_at).toBeNull()
  await actions(bindings, origin, add, 3)
  expect((await subscription()).next_at).toBeNull()
  expect(create).toHaveBeenCalledTimes(2)
})

it('desinscrição cancela o run antigo inclusive após nova inscrição, e recibo não a desfaz', async () => {
  await actions(bindings, origin, add, 1)
  now += 60000
  await dispatchSequences(bindings, now)
  const old = await subscription()
  expect(await sequenceRunActive(bindings, old.pending_run_id)).toBe(true)
  await actions(bindings, origin, remove, 2)
  expect(await sequenceRunActive(bindings, old.pending_run_id)).toBe(false)
  await expect(actions(bindings, { ...origin, id: old.pending_run_id }, { actions: [{ type: 'add_tag', tag_id: 'tag-a' }] }, 4)).rejects.toThrow('cancelled')
  await actions(bindings, origin, add, 3)
  expect((await subscription()).enrollment_id).not.toBe(old.enrollment_id)
  await actions(bindings, origin, remove, 2)
  expect(await subscription()).not.toBeNull()
  expect(await sequenceRunActive(bindings, old.pending_run_id)).toBe(false)
})

it('isola falha de criação do Workflow e continua planejando os outros contatos', async () => {
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO contacts (id,workspace_id,first_name) VALUES ('c-second','a','Outra pessoa')"),
    bindings.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('cc-second','a','c-second','ch-a','second',1)"),
    bindings.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,channel_id,automation_version_id) VALUES ('second','a','c-second','ch-a','v1')"),
  ])
  await actions(bindings, origin, add, 1)
  await actions(bindings, { ...origin, id: 'second', contact_id: 'c-second' }, add, 1)
  create.mockRejectedValueOnce(new Error('Temporary outage'))
  now += 60000
  expect(await dispatchSequences(bindings, now)).toEqual({ failed: 1 })
  expect(create).toHaveBeenCalledTimes(2)
  expect((await sequenceRuns()).results).toHaveLength(2)
})

it('janela local respeita dia, horário e DST; o fim é exclusivo', () => {
  const step = { id: 'x', position: 0, delay_seconds: 0, send_type: 'timelimit', from_hour: 9, to_hour: 18, weekdays: '[1,2,3,4,5]' }
  expect(nextSequenceWindow(step, Date.parse('2026-10-23T21:00:00Z'), 'America/Sao_Paulo')).toBe(Date.parse('2026-10-26T12:00:00Z'))
  expect(nextSequenceWindow(step, Date.parse('2026-03-06T23:00:00Z'), 'America/New_York')).toBe(Date.parse('2026-03-09T13:00:00Z'))
  expect(nextSequenceWindow(step, now, 'America/Sao_Paulo')).toBe(now)
})

it('salvar reativa passos novos ou publicados e reajusta atraso, sem repetir ids já enviados', async () => {
  await bindings.DB.prepare("UPDATE sequence_steps SET status='draft' WHERE sequence_id='seq-a'").run()
  await actions(bindings, origin, add, 1)
  expect((await subscription()).next_at).toBeNull()
  await bindings.DB.prepare("UPDATE sequence_steps SET status='live',delay_seconds=15 WHERE id='step-1'").run()
  await rescheduleSequenceSubscriptions(bindings.DB, 'b', 'seq-a')
  expect((await subscription()).next_at).toBeNull()
  await rescheduleSequenceSubscriptions(bindings.DB, 'a', 'seq-a')
  expect((await subscription()).next_at).toBe(now + 15000)
  now += 15000
  await dispatchSequences(bindings, now)
  const pending = (await subscription()).pending_run_id
  await bindings.DB.prepare("UPDATE flow_runs SET status='done',updated_at=? WHERE id=?").bind(now, pending).run()
  await dispatchSequences(bindings, now)
  expect((await subscription()).next_at).toBeNull()
  await bindings.DB.prepare("UPDATE sequence_steps SET status='live',delay_seconds=30 WHERE id='step-2'").run()
  await rescheduleSequenceSubscriptions(bindings.DB, 'a', 'seq-a')
  expect((await subscription()).next_step).toBe(2)
  expect((await subscription()).next_at).toBe(now - 15000 + 30000)
  await rescheduleSequenceSubscriptions(bindings.DB, 'a', 'seq-a')
  expect((await subscription()).next_step).toBe(2)
})

/** Planeja o primeiro passo e devolve a execução que a inscrição passa a esperar. */
async function firstStepRun() {
  await actions(bindings, origin, add, 1)
  now += 60000
  await dispatchSequences(bindings, now)
  const pending = (await subscription()).pending_run_id as string
  expect(pending).toMatch(/^sequence-/)
  return pending
}

it('STOP cancela o passo em andamento: o contato sai da sequência e nada mais é planejado', async () => {
  const pending = await firstStepRun()
  // O mesmo lote do STOP (flow/dispatch.ts): o consentimento sai da conexão e as execuções em andamento são canceladas.
  await bindings.DB.batch([
    bindings.DB.prepare("UPDATE contact_channels SET opted_in=0,opted_out_at=?,consent_changed_at=? WHERE id='cc-a'").bind(now, now),
    bindings.DB.prepare("UPDATE flow_runs SET status='cancelled',wait_until=NULL,error=NULL,updated_at=? WHERE id=?").bind(now, pending),
  ])
  await dispatchSequences(bindings, now + 1000)
  expect(await subscription()).toBeNull()
  now += 10 * 60000
  await dispatchSequences(bindings, now)
  expect((await sequenceRuns()).results).toHaveLength(1)
  expect(create).toHaveBeenCalledTimes(1)
})

it('pausa de automações pula só o passo cancelado: o contato continua inscrito e a sequência segue no próximo passo', async () => {
  const pending = await firstStepRun()
  // O executor cancela o passo que começa com a automação pausada para o contato (flow/workflow.ts, paused-cancel).
  await bindings.DB.prepare("UPDATE flow_runs SET status='cancelled',error='automation_paused',wait_until=NULL,updated_at=? WHERE id=?").bind(now + 5000, pending).run()
  await dispatchSequences(bindings, now + 6000)
  expect(await subscription()).toMatchObject({ pending_run_id: null, next_step: 2, next_at: now + 5000 + 120000 })
  now += 5000 + 120000
  await dispatchSequences(bindings, now)
  expect((await sequenceRuns()).results).toHaveLength(2)
  expect(await subscription()).toMatchObject({ pending_step_id: 'step-2' })
})

it('passo parado pela trava de segurança (sem retomada) não prende a inscrição: fica sem próximo envio, como numa falha', async () => {
  const pending = await firstStepRun()
  await bindings.DB.prepare("UPDATE flow_runs SET status='waiting_delay',error='consecutive_block_limit',wait_until=NULL,updated_at=? WHERE id=?").bind(now, pending).run()
  await dispatchSequences(bindings, now + 1000)
  expect(await subscription()).toMatchObject({ pending_run_id: null, next_at: null })
})

it.each([['done', null], ['failed', 'flow_execution_failed'], ['cancelled', null], ['cancelled', 'automation_paused'], ['waiting_delay', 'consecutive_block_limit']])(
  'nenhuma inscrição fica apontando para execução terminal (%s, %s)', async (status, error) => {
    const pending = await firstStepRun()
    if (status === 'cancelled' && error === null) await bindings.DB.prepare("UPDATE contact_channels SET opted_in=0 WHERE id='cc-a'").run()
    await bindings.DB.prepare('UPDATE flow_runs SET status=?,error=?,updated_at=? WHERE id=?').bind(status, error, now, pending).run()
    await dispatchSequences(bindings, now + 1000)
    expect((await subscription())?.pending_run_id ?? null).not.toBe(pending)
  })

it('quem saiu da conexão antes do passo vencer sai da sequência sem execução nova', async () => {
  await actions(bindings, origin, add, 1)
  await bindings.DB.prepare("UPDATE contact_channels SET opted_in=0,opted_out_at=? WHERE id='cc-a'").bind(now).run()
  now += 60000
  await dispatchSequences(bindings, now)
  expect(await subscription()).toBeNull()
  expect((await sequenceRuns()).results).toHaveLength(0)
  expect(create).not.toHaveBeenCalled()
})

it('conexão com token recusado, restrita ou fora do ar não planeja o passo; consertada, o passo sai', async () => {
  await actions(bindings, origin, add, 1)
  now += 60000
  for (const state of ['error', 'restricted', 'disconnected', 'connecting']) {
    await bindings.DB.prepare("UPDATE channels SET connection_state=? WHERE id='ch-a'").bind(state).run()
    await dispatchSequences(bindings, now)
    expect((await sequenceRuns()).results).toHaveLength(0)
    expect(await subscription()).toMatchObject({ pending_run_id: null, next_at: now })
  }
  // Token novo colado numa conexão de webhook manual: ela fica pendente até o primeiro webhook, e já envia.
  await bindings.DB.prepare("UPDATE channels SET connection_state='pending' WHERE id='ch-a'").run()
  await dispatchSequences(bindings, now)
  expect((await sequenceRuns()).results).toHaveLength(1)
  expect(create).toHaveBeenCalledTimes(1)
})
