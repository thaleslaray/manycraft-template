import type { Env } from '../env'
import { localParts } from '../time-zone'
import { ZodError } from 'zod'
import { RepositoryError } from '../db/shared'
import { stableId } from '../flow/types'
import { ensureWorkflow, hasFlow } from '../flow/dispatch'
import { ruleConfigSchema, type RuleConfig } from './schema'
import { validateReferences } from './repository'
import { stateInSql } from '../channels/core/connection-state'

type Event = { id: string; workspace_id: string; contact_id: string; type: string; resource_id: string | null; value: string | null; created_at: number; attempts: number }
type ActiveRule = { id: string; workspace_id: string; published: string; published_at: number }
type Execution = { id: string; workspace_id: string; contact_id: string; config: string; actions_applied_at: number | null; completed_at: number | null; skipped_at: number | null }
const combine = (match: 'all'|'any', values: boolean[]) => match === 'all' ? values.every(Boolean) : values.some(Boolean)
class RuleSkip extends Error {
  constructor(readonly reason: string) { super(reason) }
}
function skipReason(error: unknown): string | null {
  return error instanceof RuleSkip ? error.reason
    : error instanceof RepositoryError && error.status<500 ? 'invalid_reference'
    : error instanceof ZodError || error instanceof SyntaxError ? 'invalid_configuration' : null
}

async function matches(db: D1Database, event: Event, config: RuleConfig) {
  const filter = config.event_filter
  const wanted = filter.tag_id ?? filter.field_id ?? filter.sequence_id ?? filter.system_field
  if (wanted && event.resource_id !== wanted) return false
  if (filter.operator) {
    const actual: unknown = event.value === null ? null : JSON.parse(event.value)
    if (filter.operator === 'equals' ? JSON.stringify(actual) !== JSON.stringify(filter.value)
      : typeof actual !== 'string' || typeof filter.value !== 'string' || !actual.includes(filter.value)) return false
  }
  if (!config.condition) return true
  const groups: boolean[] = []
  for (const group of config.condition.groups) {
    const values: boolean[] = []
    for (const predicate of group.rules) {
      if (predicate.type === 'tag') {
        const found = !!await db.prepare('SELECT tag_id FROM contact_tags WHERE workspace_id=? AND contact_id=? AND tag_id=?')
          .bind(event.workspace_id,event.contact_id,predicate.tag_id).first()
        values.push(predicate.operator === 'has' ? found : !found)
      } else {
        const field = await db.prepare('SELECT value FROM contact_field_values WHERE workspace_id=? AND contact_id=? AND field_id=?')
          .bind(event.workspace_id,event.contact_id,predicate.field_id).first<{ value: string }>()
        const actual: unknown = field ? JSON.parse(field.value) : null
        const equal = JSON.stringify(actual) === JSON.stringify(predicate.value)
        values.push(predicate.operator === 'is_set' ? !!field : predicate.operator === 'is_not_set' ? !field
          : predicate.operator === 'equals' ? equal : predicate.operator === 'not_equals' ? !equal
          : predicate.operator === 'contains' ? typeof actual === 'string' && typeof predicate.value === 'string' && actual.includes(predicate.value)
          : typeof actual === 'number' && typeof predicate.value === 'number' && (predicate.operator === 'gt' ? actual > predicate.value
            : predicate.operator === 'gte' ? actual >= predicate.value : predicate.operator === 'lt' ? actual < predicate.value : actual <= predicate.value))
      }
    }
    groups.push(combine(group.match,values))
  }
  return combine(config.condition.match,groups)
}
async function execute(env: Env, execution: Execution, now: number) {
  if (execution.completed_at !== null || execution.skipped_at !== null) return
  const config = ruleConfigSchema.parse(JSON.parse(execution.config)), workspace = execution.workspace_id, contact = execution.contact_id
  if (execution.actions_applied_at !== null) {
    for (const [index,action] of config.actions.entries()) if (action.type === 'start_automation') {
      if (!hasFlow(env)) throw new Error('Executor indisponível.')
      await ensureWorkflow(env,`rule-${await stableId(execution.id,String(index))}`)
    }
    await env.DB.prepare('UPDATE rule_executions SET completed_at=? WHERE id=? AND completed_at IS NULL').bind(now,execution.id).run()
    return
  }
  await validateReferences(env.DB,workspace,config)
  const needsConnection = config.actions.some(a => a.type === 'add_to_sequence' || a.type === 'start_automation')
  const channel = needsConnection ? await env.DB.prepare(`SELECT cc.channel_id FROM contact_channels cc
    JOIN contacts c ON c.workspace_id=cc.workspace_id AND c.id=cc.contact_id
    JOIN channels ch ON ch.workspace_id=cc.workspace_id AND ch.id=cc.channel_id
    WHERE cc.workspace_id=? AND cc.contact_id=? AND c.status='subscribed' AND cc.opted_in=1
    AND ch.archived_at IS NULL AND ${stateInSql(['connected'], 'ch')}
    ORDER BY coalesce((SELECT max(m.created_at) FROM messages m JOIN conversations v ON v.workspace_id=m.workspace_id AND v.id=m.conversation_id
      WHERE v.workspace_id=cc.workspace_id AND v.contact_channel_id=cc.id AND m.direction='in'),cc.last_inbound_at,cc.created_at) DESC,cc.id LIMIT 1`)
    .bind(workspace,contact).first<{ channel_id: string }>() : null
  if (needsConnection && !channel) throw new RuleSkip('no_eligible_connection')
  const statements: D1PreparedStatement[] = [], runs: string[] = []
  const pending = 'EXISTS(SELECT 1 FROM rule_executions WHERE id=? AND actions_applied_at IS NULL)'
  for (const [index,action] of config.actions.entries()) {
    if (action.type === 'add_tag') statements.push(env.DB.prepare(`INSERT INTO contact_tags(workspace_id,contact_id,tag_id) SELECT ?,?,? WHERE ${pending} ON CONFLICT DO NOTHING`).bind(workspace,contact,action.tag_id,execution.id))
    else if (action.type === 'remove_tag') statements.push(env.DB.prepare(`DELETE FROM contact_tags WHERE workspace_id=? AND contact_id=? AND tag_id=? AND ${pending}`).bind(workspace,contact,action.tag_id,execution.id))
    else if (action.type === 'set_custom_field_value') statements.push(env.DB.prepare(`INSERT INTO contact_field_values(workspace_id,contact_id,field_id,value,updated_at) SELECT ?,?,?,?,? WHERE ${pending}
      ON CONFLICT(contact_id,field_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(workspace,contact,action.field_id,JSON.stringify(action.value),now,execution.id))
    else if (action.type === 'unset_custom_field_value') statements.push(env.DB.prepare(`DELETE FROM contact_field_values WHERE workspace_id=? AND contact_id=? AND field_id=? AND ${pending}`).bind(workspace,contact,action.field_id,execution.id))
    else if (action.type === 'remove_from_sequence') statements.push(env.DB.prepare(`DELETE FROM sequence_subscriptions WHERE workspace_id=? AND contact_id=? AND sequence_id=? AND ${pending}`).bind(workspace,contact,action.sequence_id,execution.id))
    else if (action.type === 'add_to_sequence') {
      const first = await env.DB.prepare("SELECT position,delay_seconds FROM sequence_steps WHERE workspace_id=? AND sequence_id=? AND status='live' ORDER BY position LIMIT 1")
        .bind(workspace,action.sequence_id).first<{ position: number; delay_seconds: number }>()
      statements.push(env.DB.prepare(`INSERT INTO sequence_subscriptions(workspace_id,sequence_id,contact_id,channel_id,enrollment_id,next_step,next_at,created_at)
        SELECT ?,?,?,?,?,?,?,? WHERE ${pending} ON CONFLICT(sequence_id,contact_id) DO NOTHING`).bind(workspace,action.sequence_id,contact,channel!.channel_id,
          `${execution.id}-${index}`,first?.position ?? 0,first ? now+first.delay_seconds*1000 : null,now,execution.id))
    } else if (action.type === 'start_automation') {
      if (!hasFlow(env)) throw new Error('Executor indisponível.')
      const runId = `rule-${await stableId(execution.id,String(index))}`
      statements.push(env.DB.prepare(`INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,channel_id)
        SELECT ?,?,?,a.published_version_id,? FROM automations a WHERE a.workspace_id=? AND a.id=? AND a.status='live'
        AND a.deleted_at IS NULL AND a.published_version_id IS NOT NULL AND ${pending} ON CONFLICT DO NOTHING`)
        .bind(runId,workspace,contact,channel!.channel_id,workspace,action.automation_id,execution.id))
      runs.push(runId)
    }
  }
  // A separate durable receipt prevents mutations from replaying while workflow creation recovers.
  statements.push(env.DB.prepare('UPDATE rule_executions SET actions_applied_at=? WHERE id=? AND actions_applied_at IS NULL').bind(now,execution.id))
  if (!runs.length) statements.push(env.DB.prepare('UPDATE rule_executions SET completed_at=? WHERE id=? AND completed_at IS NULL').bind(now,execution.id))
  await env.DB.batch(statements)
  if (hasFlow(env)) for (const run of runs) await ensureWorkflow(env,run)
  if (runs.length) await env.DB.prepare('UPDATE rule_executions SET completed_at=? WHERE id=? AND completed_at IS NULL').bind(now,execution.id).run()
}
async function attemptExecution(env: Env, execution: Execution, now: number) {
  try { await execute(env,execution,now) }
  catch (error) {
    const reason = skipReason(error)
    if (!reason) throw error
    await env.DB.prepare('UPDATE rule_executions SET skipped_at=?,skip_reason=? WHERE id=? AND completed_at IS NULL')
      .bind(now,reason,execution.id).run()
  }
}
async function fire(env: Env, rule: ActiveRule, event: Event, now: number) {
  const config = ruleConfigSchema.parse(JSON.parse(rule.published))
  const executionId = `rule-execution-${await stableId(rule.id,event.id)}`
  const previous = await env.DB.prepare('SELECT * FROM rule_executions WHERE id=?').bind(executionId).first<Execution>()
  if (previous) { await attemptExecution(env,previous,now); return }
  if (rule.published_at>event.created_at) return
  if (config.trigger.type !== event.type || !await matches(env.DB,event,config)) return
  // D1 serializes this INSERT ... SELECT: competing requests cannot pass the frequency/lock gate together.
  await env.DB.prepare(`INSERT INTO rule_executions(id,workspace_id,rule_id,contact_id,event_id,config,created_at)
    SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM rule_executions WHERE rule_id=? AND contact_id=? AND skipped_at IS NULL AND (?='once' OR created_at>?))
    ON CONFLICT(rule_id,event_id) DO NOTHING`).bind(executionId,event.workspace_id,rule.id,event.contact_id,event.id,rule.published,now,rule.id,event.contact_id,config.frequency,now-30000).run()
  const execution = await env.DB.prepare('SELECT * FROM rule_executions WHERE id=?').bind(executionId).first<Execution>()
  if (execution) await attemptExecution(env,execution,now)
}
async function dates(env: Env, rule: ActiveRule, now: number) {
  const config = ruleConfigSchema.parse(JSON.parse(rule.published))
  if (config.trigger.type !== 'date') return 0
  const contacts = await env.DB.prepare(`SELECT c.id,v.value,coalesce(c.timezone,w.timezone,'UTC') AS timezone FROM contacts c
    JOIN workspaces w ON w.id=c.workspace_id JOIN contact_field_values v ON v.workspace_id=c.workspace_id AND v.contact_id=c.id
    WHERE c.workspace_id=? AND c.status<>'deleted' AND v.field_id=?`).bind(rule.workspace_id,config.trigger.field_id!).all<{ id: string; value: string; timezone: string }>()
  let failed = 0
  for (const contact of contacts.results) {
    try {
      const value: unknown = JSON.parse(contact.value)
      if (typeof value !== 'string') continue
      const local = localParts(now-(config.trigger.offset_seconds ?? 0)*1000,contact.timezone)
      const date = `${local.year}-${local.month}-${local.day}`, time = `${local.hour}:${local.minute}`
      const source = value.length>10 ? localParts(Date.parse(value),contact.timezone) : null
      const targetDate = source ? `${source.year}-${source.month}-${source.day}` : value.slice(0,10)
      const targetTime = config.trigger.at_time ?? (source ? `${source.hour}:${source.minute}` : '00:00')
      const due = config.trigger.repeat_yearly ? targetDate.slice(5) === date.slice(5) : targetDate === date
      if (!due || time<targetTime) continue
      await fire(env,rule,{ id: `date:${rule.id}:${contact.id}:${date}`,workspace_id:rule.workspace_id,contact_id:contact.id,type:'date',resource_id:config.trigger.field_id!,value:contact.value,created_at:now,attempts:0 },now)
    } catch { failed++ }
  }
  return failed
}
/** Durable repository events cover every writer (HTTP, automation and webhook), including direct D1 batches.
 * Failures stay pending for the next cron. No provider request is made by this scanner. */
export async function dispatchRules(env: Env, now = Date.now(), workspace?: string, options: { dates?: boolean } = {}): Promise<{ failed: number }> {
  await env.DB.prepare("UPDATE rule_events SET processed_at=? WHERE processed_at IS NULL AND EXISTS(SELECT 1 FROM contacts c WHERE c.id=rule_events.contact_id AND c.status='deleted')").bind(now).run()
  const rules = (await env.DB.prepare(`SELECT id,workspace_id,published,published_at FROM rules WHERE active=1 AND published IS NOT NULL ${workspace ? 'AND workspace_id=?' : ''}`)
    .bind(...(workspace ? [workspace] : [])).all<ActiveRule>()).results
  let failed = 0
  if (options.dates) {
    // A date execution owns its original occurrence. Recover it even after its local day ended.
    const pending = await env.DB.prepare(`SELECT e.* FROM rule_executions e JOIN rules r ON r.workspace_id=e.workspace_id AND r.id=e.rule_id
      JOIN contacts c ON c.workspace_id=e.workspace_id AND c.id=e.contact_id
      WHERE r.active=1 AND c.status<>'deleted' AND e.completed_at IS NULL AND e.skipped_at IS NULL
      AND json_extract(e.config,'$.trigger.type')='date' ${workspace ? 'AND e.workspace_id=?' : ''}`)
      .bind(...(workspace ? [workspace] : [])).all<Execution>()
    for (const execution of pending.results) { try { await attemptExecution(env,execution,now) } catch { failed++ } }
    for (const rule of rules) { try { failed += await dates(env,rule,now) } catch { failed++ } }
  }
  // Drain chains within a bounded budget; remaining events are handled by the next minute tick.
  for (let round=0;round<10;round++) {
    const events = (await env.DB.prepare(`SELECT e.* FROM rule_events e JOIN contacts c ON c.workspace_id=e.workspace_id AND c.id=e.contact_id
      WHERE e.processed_at IS NULL AND coalesce(e.retry_at,0)<=? AND c.status<>'deleted' ${workspace ? 'AND e.workspace_id=?' : ''} ORDER BY e.created_at,e.id LIMIT 100`)
      .bind(now,...(workspace ? [workspace] : [])).all<Event>()).results
    if (!events.length) break
    let progressed = false
    for (const event of events) {
      try {
        let ignored: string | null = null
        for (const rule of rules.filter(r => r.workspace_id === event.workspace_id)) {
          try { await fire(env,rule,event,now) }
          catch (error) {
            const reason = skipReason(error)
            if (!reason) throw error
            ignored = reason
          }
        }
        await env.DB.prepare('UPDATE rule_events SET processed_at=?,last_error=? WHERE id=?').bind(now,ignored,event.id).run()
        progressed = true
      } catch {
        // Deferral releases the first page immediately, so a poison batch cannot starve later events.
        const delay = Math.min(3600000,30000 * 2 ** Math.min(event.attempts,7))
        await env.DB.prepare("UPDATE rule_events SET attempts=attempts+1,retry_at=?,last_error='temporarily_unavailable' WHERE id=?")
          .bind(now+delay,event.id).run()
        progressed = true
        failed++
      }
    }
    if (!progressed) break
  }
  return { failed }
}
