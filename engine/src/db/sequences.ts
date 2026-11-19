import { z } from 'zod'
import { assertWorkspace, RepositoryError, requireRow } from './shared'
import { rescheduleSequenceSubscriptions } from '../flow/sequences'

const id = z.string().min(1).max(128)
const hour = z.string().regex(/^(?:[01]\d|2[0-3]):00$|^24:00$/)
export const sequenceWindowSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('all') }).strict(),
  z.object({ type: z.literal('timelimit'), from: hour, to: hour,
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  }).strict().refine(w => w.from < w.to && new Set(w.weekdays).size === w.weekdays.length,
    { message: 'Escolha dias distintos e uma janela que termine depois do início.' }),
])
export const sequenceInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  steps: z.array(z.object({
    id, delay_seconds: z.number().int().min(0).max(99999 * 86400),
    sending_time_settings: sequenceWindowSchema, status: z.enum(['live', 'draft']), automation_id: id.nullable(),
  }).strict()).max(100),
}).strict().refine(input => new Set(input.steps.map(step => step.id)).size === input.steps.length,
  { message: 'Cada passo precisa de um identificador diferente.', path: ['steps'] })

export type SequenceInput = z.infer<typeof sequenceInputSchema>
type SequenceCounts = { sent: number; delivered: number; read: number; clicked: number }
export type SequenceStats = SequenceCounts & { open_rate: number; ctr: number }
export type Sequence = Omit<SequenceInput, 'steps'> & {
  id: string; workspace_id: string; subscribers: number; status: 'active'; stats: SequenceStats;
  steps: (SequenceInput['steps'][number] & { stats: SequenceStats })[];
}
type StoredStep = { id: string; delay_seconds: number; status: 'live' | 'draft'; automation_id: string | null;
  send_type: 'all' | 'timelimit'; from_hour: number | null; to_hour: number | null; weekdays: string }

const emptyCounts = (): SequenceCounts => ({ sent: 0, delivered: 0, read: 0, clicked: 0 })
const rates = (counts: SequenceCounts): SequenceStats => ({ ...counts,
  open_rate: counts.delivered ? 100 * counts.read / counts.delivered : 0,
  ctr: counts.delivered ? 100 * counts.clicked / counts.delivered : 0,
})

/** Sequências (uma ou todas) numa ida só: sequência+assinantes, passos e métricas viajam juntos num batch. */
async function loadSequences(db: D1Database, workspaceId: string, sequenceId: string | null): Promise<Sequence[]> {
  // The same message node can receive several button events or provider receipts. Count it once
  // per execution, including child automations carrying the sequence origin. A read proves
  // delivery; successful sends alone never prove delivery or opening.
  const [rows, steps, metrics] = await db.batch<unknown>([
    db.prepare(`SELECT s.id,s.workspace_id,s.name,
      (SELECT count(*) FROM sequence_subscriptions sub WHERE sub.workspace_id=s.workspace_id AND sub.sequence_id=s.id) AS subscribers
      FROM sequences s WHERE s.workspace_id=? AND (?2 IS NULL OR s.id=?2) ORDER BY s.created_at,s.id`).bind(workspaceId, sequenceId),
    db.prepare('SELECT * FROM sequence_steps WHERE workspace_id=?1 AND (?2 IS NULL OR sequence_id=?2) ORDER BY position,id').bind(workspaceId, sequenceId),
    db.prepare(`WITH message_metrics AS (
      SELECT origin.sequence_id,origin.step_id,event.flow_run_id,event.node_id,
        max(event.type='sent') AS sent,max(event.type IN ('delivered','read')) AS delivered,
        max(event.type='read') AS read,max(event.type='clicked') AS clicked
      FROM sequence_flow_runs origin JOIN node_events event
        ON event.workspace_id=origin.workspace_id AND event.flow_run_id=origin.run_id
      WHERE origin.workspace_id=?1 AND (?2 IS NULL OR origin.sequence_id=?2) AND event.type IN ('sent','delivered','read','clicked')
      GROUP BY origin.sequence_id,origin.step_id,event.flow_run_id,event.node_id
    ) SELECT sequence_id,step_id,sum(sent) AS sent,sum(delivered) AS delivered,sum(read) AS read,sum(clicked) AS clicked
      FROM message_metrics GROUP BY sequence_id,step_id`).bind(workspaceId, sequenceId),
  ])
  const stepRows = (steps!.results as (StoredStep & { sequence_id: string })[])
  const metricRows = metrics!.results as (SequenceCounts & { sequence_id: string; step_id: string })[]
  const time = (value: number) => `${String(value).padStart(2, '0')}:00`
  return (rows!.results as { id: string; workspace_id: string; name: string; subscribers: number }[]).map(row => {
    const mine = metricRows.filter(metric => metric.sequence_id === row.id)
    const byStep = new Map(mine.map(({ sequence_id: _, step_id, ...counts }) => [step_id, rates(counts)]))
    const total = mine.reduce((sum, metric) => ({ sent: sum.sent + metric.sent,
      delivered: sum.delivered + metric.delivered, read: sum.read + metric.read, clicked: sum.clicked + metric.clicked }), emptyCounts())
    return { ...row, status: 'active' as const, stats: rates(total), steps: stepRows.filter(step => step.sequence_id === row.id).map(step => ({
      id: step.id, delay_seconds: step.delay_seconds, status: step.status, automation_id: step.automation_id,
      stats: byStep.get(step.id) ?? rates(emptyCounts()),
      sending_time_settings: step.send_type === 'all' ? { type: 'all' as const } : {
        type: 'timelimit' as const, from: time(step.from_hour!), to: time(step.to_hour!), weekdays: JSON.parse(step.weekdays) as number[],
      },
    })) }
  })
}

export async function getSequence(db: D1Database, workspaceId: string, sequenceId: string): Promise<Sequence | null> {
  assertWorkspace(workspaceId)
  id.parse(sequenceId)
  return (await loadSequences(db, workspaceId, sequenceId))[0] ?? null
}

export async function listSequences(db: D1Database, workspaceId: string): Promise<Sequence[]> {
  assertWorkspace(workspaceId)
  return loadSequences(db, workspaceId, null)
}

export async function listSequenceFlows(db: D1Database, workspaceId: string) {
  assertWorkspace(workspaceId)
  const rows = await db.prepare(`SELECT id,name,status,published_version_id FROM automations
    WHERE workspace_id=? AND deleted_at IS NULL ORDER BY name,id`).bind(workspaceId)
    .all<{ id: string; name: string; status: string; published_version_id: string | null }>()
  return rows.results.map(row => ({ id: row.id, name: row.name, published: row.status === 'live' && row.published_version_id !== null }))
}

export async function saveSequence(db: D1Database, workspaceId: string, value: SequenceInput, sequenceId?: string): Promise<Sequence> {
  assertWorkspace(workspaceId)
  const input = sequenceInputSchema.parse(value)
  if (sequenceId) requireRow(await getSequence(db, workspaceId, sequenceId))
  const sequence = sequenceId ?? crypto.randomUUID()
  for (const step of input.steps) {
    const previous = await db.prepare('SELECT workspace_id,sequence_id FROM sequence_steps WHERE id=?').bind(step.id)
      .first<{ workspace_id: string; sequence_id: string }>()
    if (previous && (previous.workspace_id !== workspaceId || previous.sequence_id !== sequence)) throw new RepositoryError()
    if (step.status === 'live' && !step.automation_id) throw new RepositoryError('Vincule uma automação publicada ao passo ativo.', 400)
    if (step.automation_id) {
      const automation = requireRow(await db.prepare(`SELECT status,published_version_id FROM automations
        WHERE workspace_id=? AND id=? AND deleted_at IS NULL`).bind(workspaceId, step.automation_id)
        .first<{ status: string; published_version_id: string | null }>())
      if (step.status === 'live' && (automation.status !== 'live' || !automation.published_version_id)) {
        throw new RepositoryError('Publique a automação antes de ativar o passo.', 400)
      }
    }
  }
  const now = Date.now()
  const statements = [sequenceId
    ? db.prepare('UPDATE sequences SET name=?,updated_at=? WHERE workspace_id=? AND id=?').bind(input.name, now, workspaceId, sequence)
    : db.prepare('INSERT INTO sequences(id,workspace_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').bind(sequence, workspaceId, input.name, now, now)]
  // Replacing the ordered set in one transaction also permits position swaps under its unique constraint.
  statements.push(db.prepare('DELETE FROM sequence_steps WHERE workspace_id=? AND sequence_id=?').bind(workspaceId, sequence))
  for (const [position, step] of input.steps.entries()) {
    const window = step.sending_time_settings
    statements.push(db.prepare(`INSERT INTO sequence_steps(id,workspace_id,sequence_id,automation_id,position,delay_seconds,status,
      send_type,from_hour,to_hour,weekdays,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(step.id, workspaceId, sequence, step.automation_id, position, step.delay_seconds, step.status, window.type,
        window.type === 'all' ? null : Number(window.from.slice(0, 2)), window.type === 'all' ? null : Number(window.to.slice(0, 2)),
        JSON.stringify(window.type === 'all' ? [] : window.weekdays), now, now))
  }
  await db.batch(statements)
  await rescheduleSequenceSubscriptions(db, workspaceId, sequence)
  return requireRow(await getSequence(db, workspaceId, sequence))
}

export async function deleteSequence(db: D1Database, workspaceId: string, sequenceId: string): Promise<{ ok: true }> {
  assertWorkspace(workspaceId)
  id.parse(sequenceId)
  const result = await db.prepare('DELETE FROM sequences WHERE workspace_id=? AND id=?').bind(workspaceId, sequenceId).run()
  if (!result.meta.changes) throw new RepositoryError()
  return { ok: true }
}
