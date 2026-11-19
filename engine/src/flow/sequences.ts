import { NonRetryableError } from 'cloudflare:workflows'
import { ensureWorkflow } from './dispatch'
import { stableId, type FlowEnv, type Run } from './types'
import { enrollmentConnectionReadySql, runnableAutomationSql } from './sequence-state'
import { inlineMemo } from './inline-timing'

type SequenceStep = {
  id: string; automation_id?: string | null; position: number; delay_seconds: number; send_type: string;
  from_hour: number | null; to_hour: number | null; weekdays: string;
}
type Subscription = {
  workspace_id: string; sequence_id: string; contact_id: string; channel_id: string;
  enrollment_id: string; next_step: number; next_at: number | null;
  pending_run_id: string | null; pending_step_id: string | null; timezone: string;
}

/** Kept in the same D1 batch as the action receipt, including mixed add/remove actions. */
export async function sequenceAction(env: FlowEnv, run: Run, sequenceId: string, subscribe: boolean, stepIndex: number): Promise<D1PreparedStatement> {
  const sequence = await env.DB.prepare('SELECT id FROM sequences WHERE workspace_id=? AND id=?')
    .bind(run.workspace_id, sequenceId).first()
  if (!sequence) throw new NonRetryableError('Sequence not found in workspace')
  const pending = 'NOT EXISTS (SELECT 1 FROM timeline_action_receipts WHERE run_id=? AND step_index=?)'
  if (!subscribe) return env.DB.prepare(`DELETE FROM sequence_subscriptions
    WHERE workspace_id=? AND sequence_id=? AND contact_id=? AND ${pending}`)
    .bind(run.workspace_id, sequenceId, run.contact_id, run.id, stepIndex)
  const first = await env.DB.prepare(`SELECT position,delay_seconds FROM sequence_steps
    WHERE workspace_id=? AND sequence_id=? AND status='live' ORDER BY position LIMIT 1`)
    .bind(run.workspace_id, sequenceId).first<{ position: number; delay_seconds: number }>()
  const now = Date.now()
  return env.DB.prepare(`INSERT INTO sequence_subscriptions
    (workspace_id,sequence_id,contact_id,channel_id,enrollment_id,next_step,next_at,created_at)
    SELECT ?,?,?,?,?,?,?,? WHERE ${pending} ON CONFLICT(sequence_id,contact_id) DO NOTHING`)
    .bind(run.workspace_id, sequenceId, run.contact_id, run.channel_id, crypto.randomUUID(), first?.position ?? 0,
      first ? now + first.delay_seconds * 1000 : null, now, run.id, stepIndex)
}

/** Also works for ordinary runs, which have no sequence origin. Always read live state. */
export async function sequenceRunActive(env: FlowEnv, runId: string): Promise<boolean> {
  const origin = await inlineMemo(`v:sequence:${runId}`, () => env.DB.prepare(`SELECT s.enrollment_id FROM sequence_flow_runs r
    LEFT JOIN sequence_subscriptions s ON s.workspace_id=r.workspace_id AND s.sequence_id=r.sequence_id
      AND s.contact_id=r.contact_id AND s.enrollment_id=r.enrollment_id
    WHERE r.run_id=?`).bind(runId).first<{ enrollment_id: string | null }>())
  return !origin || origin.enrollment_id !== null
}

/** Editing wakes eligible new/live steps without replaying any already planned step identity. */
export async function rescheduleSequenceSubscriptions(db: D1Database, workspaceId: string, sequenceId: string): Promise<void> {
  const subscriptions = await db.prepare(`SELECT s.contact_id,s.enrollment_id,s.created_at,t.position,t.delay_seconds,
    (SELECT max(ne.created_at) FROM node_events ne JOIN sequence_flow_runs r ON r.run_id=ne.flow_run_id
      WHERE r.workspace_id=s.workspace_id AND r.sequence_id=s.sequence_id AND r.contact_id=s.contact_id
      AND r.enrollment_id=s.enrollment_id AND ne.type='sent') AS sent_at
    FROM sequence_subscriptions s LEFT JOIN sequence_steps t ON t.workspace_id=s.workspace_id AND t.sequence_id=s.sequence_id
      AND t.id=(SELECT candidate.id FROM sequence_steps candidate
        WHERE candidate.workspace_id=s.workspace_id AND candidate.sequence_id=s.sequence_id AND candidate.status='live'
        AND NOT EXISTS (SELECT 1 FROM sequence_flow_runs history WHERE history.workspace_id=s.workspace_id
          AND history.sequence_id=s.sequence_id AND history.contact_id=s.contact_id
          AND history.enrollment_id=s.enrollment_id AND history.step_id=candidate.id)
        ORDER BY candidate.position LIMIT 1)
    WHERE s.workspace_id=? AND s.sequence_id=? AND s.pending_run_id IS NULL`)
    .bind(workspaceId, sequenceId).all<{
      contact_id: string; enrollment_id: string; created_at: number;
      position: number | null; delay_seconds: number | null; sent_at: number | null;
    }>()
  const updates = subscriptions.results.map(s => db.prepare(`UPDATE sequence_subscriptions
    SET next_step=coalesce(?,next_step),next_at=? WHERE workspace_id=? AND sequence_id=? AND contact_id=?
    AND enrollment_id=? AND pending_run_id IS NULL`)
    .bind(s.position, s.position === null ? null : (s.sent_at ?? s.created_at) + s.delay_seconds! * 1000,
      workspaceId, sequenceId, s.contact_id, s.enrollment_id))
  // Stay below the D1 statement/bind limit for large enrollments.
  for (let offset = 0; offset < updates.length; offset += 50) await db.batch(updates.slice(offset, offset + 50))
}

/** A bounded minute scan handles IANA zones and DST transitions without fixed UTC offsets. */
export function nextSequenceWindow(step: SequenceStep, at: number, timezone: string): number {
  if (step.send_type === 'all') return at
  let formatter: Intl.DateTimeFormat
  try { formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) }
  catch { formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) }
  const weekdays: number[] = JSON.parse(step.weekdays)
  const days: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const allowed = (time: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(time).map(p => [p.type, p.value]))
    const hour = Number(parts.hour) + Number(parts.minute) / 60
    return weekdays.includes(days[parts.weekday]) && hour >= step.from_hour! && hour < step.to_hour!
  }
  if (allowed(at)) return at
  let candidate = Math.floor(at / 60000) * 60000 + 60000
  for (let minute = 0; minute < 8 * 1440; minute++, candidate += 60000) if (allowed(candidate)) return candidate
  throw new Error('Sequence has no available sending window')
}

/** The safety pause stops a run for good (it never resumes): for the enrollment it is as final as a failure. */
const safetyPaused = (r: string) => `(${r}.status='waiting_delay' AND ${r}.error='consecutive_block_limit')`
/** The contact left the subscription's connection: STOP, unsubscribed or deleted. */
const left = (s: string) => `(NOT EXISTS (SELECT 1 FROM contacts WHERE workspace_id=${s}.workspace_id AND id=${s}.contact_id AND status='subscribed')
  OR NOT EXISTS (SELECT 1 FROM contact_channels WHERE workspace_id=${s}.workspace_id AND contact_id=${s}.contact_id AND channel_id=${s}.channel_id AND opted_in=1))`
/** A step is planned only on a connection that can send it: a refused token, a number that is off or pairing, and a restricted number
 * (which may not start conversations) wait, and the step goes out once the connection is fixed. A pending connection (credentials pasted
 * again, first webhook still to come) sends. The send itself is checked again in core/delivery. */
const sendable = enrollmentConnectionReadySql

/** Whoever left the connection leaves the sequence, like a manual cancel. Atomic, so a contact who came back meanwhile stays. */
async function leaveIfGone(env: FlowEnv, s: Subscription): Promise<boolean> {
  const gone = await env.DB.prepare(`DELETE FROM sequence_subscriptions AS s WHERE s.workspace_id=? AND s.sequence_id=? AND s.contact_id=? AND s.enrollment_id=?
    AND s.pending_run_id IS ? AND ${left('s')}`)
    .bind(s.workspace_id, s.sequence_id, s.contact_id, s.enrollment_id, s.pending_run_id).run()
  return gone.meta.changes > 0
}

/** Cron only plans durable FlowRun executions; all provider policy checks remain in that executor. */
export async function dispatchSequences(env: FlowEnv, now = Date.now()): Promise<{ failed: number }> {
  const rows = await env.DB.prepare(`SELECT s.*,coalesce(c.timezone,w.timezone,'UTC') AS timezone
    FROM sequence_subscriptions s JOIN contacts c ON c.workspace_id=s.workspace_id AND c.id=s.contact_id
    JOIN workspaces w ON w.id=s.workspace_id
    LEFT JOIN flow_runs r ON r.workspace_id=s.workspace_id AND r.id=s.pending_run_id
    LEFT JOIN channels ch ON ch.workspace_id=s.workspace_id AND ch.id=s.channel_id
    WHERE s.channel_id IS NOT NULL AND (
      (s.pending_run_id IS NOT NULL AND (r.workflow_created_at IS NULL OR r.status IN ('done','failed','cancelled') OR ${safetyPaused('r')}))
      OR (s.pending_run_id IS NULL AND s.next_at<=? AND (${left('s')} OR ${sendable('ch')})))
    ORDER BY coalesce(s.next_at,0),s.sequence_id,s.contact_id LIMIT 250`).bind(now).all<Subscription>()
  let failed = 0
  for (const subscription of rows.results) {
    try { await dispatchSubscription(env, subscription, now) }
    catch { failed++ } // Keep the durable plan for retry; never log contact/provider data.
  }
  return { failed }
}

async function dispatchSubscription(env: FlowEnv, subscription: Subscription, now: number): Promise<void> {
    if (subscription.pending_run_id) {
      const run = await env.DB.prepare(`SELECT status,error,updated_at,
        (SELECT max(created_at) FROM node_events WHERE flow_run_id=flow_runs.id AND type='sent') AS sent_at
        FROM flow_runs WHERE workspace_id=? AND id=?`)
        .bind(subscription.workspace_id, subscription.pending_run_id).first<{ status: string; error: string | null; updated_at: number; sent_at: number | null }>()
      if (run && !['done', 'failed', 'cancelled'].includes(run.status) && !(run.status === 'waiting_delay' && run.error === 'consecutive_block_limit')) {
        await ensureWorkflow(env, subscription.pending_run_id)
        return
      }
      if (await leaveIfGone(env, subscription)) return
      // A cancelled step (automations paused for the contact, automation moved to the trash) is skipped and the sequence goes on;
      // a failed step or one stopped by the safety pause, which never resumes, leaves the enrollment without a next send.
      const next = run?.status === 'done' || run?.status === 'cancelled' ? await env.DB.prepare(`SELECT position,delay_seconds FROM sequence_steps
        WHERE workspace_id=? AND sequence_id=? AND position>coalesce((SELECT position FROM sequence_steps WHERE workspace_id=?1 AND sequence_id=?2 AND id=?3),?4)
        AND status='live' ORDER BY position LIMIT 1`)
        .bind(subscription.workspace_id, subscription.sequence_id, subscription.pending_step_id, subscription.next_step)
        .first<{ position: number; delay_seconds: number }>() : null
      await env.DB.prepare(`UPDATE sequence_subscriptions SET next_step=?,next_at=?,pending_run_id=NULL,pending_step_id=NULL
        WHERE workspace_id=? AND sequence_id=? AND contact_id=? AND enrollment_id=? AND pending_run_id=?`)
        .bind(next?.position ?? subscription.next_step + 1, next ? (run!.sent_at ?? run!.updated_at) + next.delay_seconds * 1000 : null,
          subscription.workspace_id, subscription.sequence_id, subscription.contact_id, subscription.enrollment_id, subscription.pending_run_id).run()
      if (!next) return
      subscription.next_step = next.position
      subscription.next_at = (run!.sent_at ?? run!.updated_at) + next.delay_seconds * 1000
      subscription.pending_run_id = null
      if (subscription.next_at > now) return
    } else if (await leaveIfGone(env, subscription)) return
    const step = await env.DB.prepare(`SELECT * FROM sequence_steps WHERE workspace_id=? AND sequence_id=?
      AND position>=? AND status='live' ORDER BY position LIMIT 1`)
      .bind(subscription.workspace_id, subscription.sequence_id, subscription.next_step).first<SequenceStep>()
    if (!step) {
      // exhaust: scheduled → finished (só a agendada; uma execução planejada no meio continua a sua).
      await env.DB.prepare(`UPDATE sequence_subscriptions SET next_at=NULL WHERE workspace_id=? AND sequence_id=? AND contact_id=? AND enrollment_id=? AND pending_run_id IS NULL`)
        .bind(subscription.workspace_id, subscription.sequence_id, subscription.contact_id, subscription.enrollment_id).run()
      return
    }
    // skip: a automação do passo não roda (parada, na lixeira, apagada, sem versão publicada). O INSERT abaixo não criaria execução e a
    // inscrição ficaria agendada no passado para sempre, ocupando a frente da fila do cron; ela segue para o passo seguinte, como um passo cancelado.
    const runnable = step.automation_id ? await env.DB.prepare(`SELECT 1 FROM automations a WHERE a.workspace_id=? AND a.id=? AND ${runnableAutomationSql('a')}`)
      .bind(subscription.workspace_id, step.automation_id).first() : null
    if (!runnable) {
      const next = await env.DB.prepare(`SELECT position,delay_seconds FROM sequence_steps WHERE workspace_id=? AND sequence_id=? AND position>? AND status='live' ORDER BY position LIMIT 1`)
        .bind(subscription.workspace_id, subscription.sequence_id, step.position).first<{ position: number; delay_seconds: number }>()
      await env.DB.prepare(`UPDATE sequence_subscriptions SET next_step=?,next_at=? WHERE workspace_id=? AND sequence_id=? AND contact_id=? AND enrollment_id=? AND pending_run_id IS NULL`)
        .bind(next?.position ?? step.position + 1, next ? subscription.next_at! + next.delay_seconds * 1000 : null,
          subscription.workspace_id, subscription.sequence_id, subscription.contact_id, subscription.enrollment_id).run()
      return
    }
    const allowedAt = nextSequenceWindow(step, Math.max(subscription.next_at!, now), subscription.timezone)
    if (allowedAt > now) {
      await env.DB.prepare(`UPDATE sequence_subscriptions SET next_at=? WHERE workspace_id=? AND sequence_id=? AND contact_id=? AND enrollment_id=? AND pending_run_id IS NULL`)
        .bind(allowedAt, subscription.workspace_id, subscription.sequence_id, subscription.contact_id, subscription.enrollment_id).run()
      return
    }
    const id = `sequence-${await stableId(subscription.workspace_id, subscription.sequence_id, subscription.contact_id, subscription.enrollment_id, step.id)}`
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO flow_runs (id,workspace_id,contact_id,automation_version_id,channel_id)
        SELECT ?,s.workspace_id,s.contact_id,a.published_version_id,s.channel_id FROM sequence_subscriptions s
        JOIN sequence_steps t ON t.workspace_id=s.workspace_id AND t.sequence_id=s.sequence_id AND t.id=? AND t.status='live'
        JOIN automations a ON a.workspace_id=t.workspace_id AND a.id=t.automation_id AND a.status='live' AND a.deleted_at IS NULL
        JOIN channels ch ON ch.workspace_id=s.workspace_id AND ch.id=s.channel_id AND ${sendable('ch')}
        WHERE s.workspace_id=? AND s.sequence_id=? AND s.contact_id=? AND s.enrollment_id=? AND s.pending_run_id IS NULL
        AND s.next_at<=? AND a.published_version_id IS NOT NULL ON CONFLICT(id) DO NOTHING`)
        .bind(id, step.id, subscription.workspace_id, subscription.sequence_id, subscription.contact_id, subscription.enrollment_id, now),
      env.DB.prepare(`INSERT INTO sequence_flow_runs (run_id,workspace_id,sequence_id,step_id,contact_id,enrollment_id)
        SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM flow_runs WHERE id=?) ON CONFLICT DO NOTHING`)
        .bind(id, subscription.workspace_id, subscription.sequence_id, step.id, subscription.contact_id, subscription.enrollment_id, id),
      env.DB.prepare(`UPDATE sequence_subscriptions SET pending_run_id=?,pending_step_id=?,next_step=?
        WHERE workspace_id=? AND sequence_id=? AND contact_id=? AND enrollment_id=? AND pending_run_id IS NULL
        AND EXISTS (SELECT 1 FROM sequence_flow_runs WHERE run_id=?)`)
        .bind(id, step.id, step.position, subscription.workspace_id, subscription.sequence_id, subscription.contact_id, subscription.enrollment_id, id),
    ])
    if (await env.DB.prepare('SELECT id FROM flow_runs WHERE id=?').bind(id).first()) await ensureWorkflow(env, id)
}
