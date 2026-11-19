import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { seed, graph } from './fixtures'
import { actions } from '../src/flow/nodes'
import { dispatchSequences } from '../src/flow/sequences'
import { sequenceEnrollmentState } from '../src/flow/sequence-state'
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


// Máquina de estados da inscrição (flow/sequence-state.ts): nenhuma combinação inválida fica gravada e nenhuma inscrição trava.
it('passo com a automação parada é pulado: segue para o passo seguinte em vez de ficar na frente da fila do cron para sempre', async () => {
  await actions(bindings, origin, add, 1)
  await bindings.DB.prepare("UPDATE automations SET status='stopped' WHERE id='auto-a'").run()
  now += 60000
  expect(await dispatchSequences(bindings, now)).toEqual({ failed: 0 })
  expect(create).not.toHaveBeenCalled()
  expect(await subscription()).toMatchObject({ pending_run_id: null, next_step: 2, next_at: now + 120000 })
  // O último passo também não roda: a inscrição termina (sem próximo envio), sem voltar ao scan.
  now += 120000
  await dispatchSequences(bindings, now)
  expect(await subscription()).toMatchObject({ pending_run_id: null, next_at: null })
  expect(sequenceEnrollmentState(await subscription())).toBe('finished')
})

it('execução do passo apagada (automação excluída de vez) não deixa passo órfão: a inscrição volta a agendada no passo seguinte', async () => {
  await actions(bindings, origin, add, 1)
  now += 60000
  await dispatchSequences(bindings, now)
  const planned = await subscription()
  expect(planned).toMatchObject({ pending_step_id: 'step-1', next_step: 0 })
  expect(sequenceEnrollmentState(planned)).toBe('running')
  const deletedAt = new Date().getTime()
  await bindings.DB.prepare('DELETE FROM flow_runs WHERE id=?').bind(planned.pending_run_id).run()
  const after = await subscription()
  // Segue para o próximo passo publicado (o rascunho fica de fora), com a espera dele contada de agora, como o `skip` (antes: next_at vencido).
  expect(after).toMatchObject({ pending_run_id: null, pending_step_id: null, next_step: 2 })
  expect(Math.abs(after.next_at - (deletedAt + 120000))).toBeLessThan(30000)
  expect(sequenceEnrollmentState(after)).toBe('scheduled')
  now = after.next_at
  await dispatchSequences(bindings, now)
  expect((await sequenceRuns()).results.map(r => r.id)).not.toContain(planned.pending_run_id)
  expect(await subscription()).toMatchObject({ pending_step_id: 'step-2' })
})

it('execução do último passo apagada: a inscrição termina, como o `skip` sem passo seguinte', async () => {
  await actions(bindings, origin, add, 1)
  now += 60000
  await dispatchSequences(bindings, now)
  await bindings.DB.prepare("UPDATE sequence_steps SET status='draft' WHERE id='step-2'").run()
  await bindings.DB.prepare('DELETE FROM flow_runs WHERE id=?').bind((await subscription()).pending_run_id).run()
  const after = await subscription()
  expect(after).toMatchObject({ pending_run_id: null, pending_step_id: null, next_at: null })
  expect(sequenceEnrollmentState(after)).toBe('finished')
})
