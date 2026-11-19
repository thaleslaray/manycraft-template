import { NonRetryableError } from 'cloudflare:workflows'
import { validateActionReference, optActionTypes, type FlowAction } from '../schemas/actions'
import { notifyConversation, notifyTimeline } from '../inbox/service'
import { milliseconds } from './nodes'
import { drainMemberAlerts, queueFlowAlert } from '../team-alerts'
import type { FlowEnv, Run } from './types'
import { changeConsent } from '../channels/core/consent'

/** Every statement shares the step's receipt predicate and commits with that receipt. */
export async function editorActionStatements(env: FlowEnv, run: Run, action: FlowAction, step: number, index: number): Promise<D1PreparedStatement[] | null> {
  try { await validateActionReference(env.DB, run.workspace_id, action) }
  catch { throw new NonRetryableError('Action reference not found or unavailable in workspace') }
  const pending = 'NOT EXISTS (SELECT 1 FROM timeline_action_receipts WHERE run_id=? AND step_index=?)'
  if (action.type === 'assign_conversation' || action.type === 'open_conversation' || action.type === 'close_conversation') {
    const identity = await env.DB.prepare('SELECT id FROM contact_channels WHERE workspace_id=? AND contact_id=? AND channel_id=?')
      .bind(run.workspace_id, run.contact_id, run.channel_id).first<{ id: string }>()
    if (!identity) throw new NonRetryableError('Contact connection not found in workspace')
    return [
      env.DB.prepare(`INSERT INTO conversations (id,workspace_id,contact_channel_id,unread) SELECT ?,?,?,0 WHERE ${pending} ON CONFLICT(contact_channel_id) DO NOTHING`)
        .bind(`inbox-${identity.id}`, run.workspace_id, identity.id, run.id, step),
      action.type === 'assign_conversation'
        ? env.DB.prepare(`UPDATE conversations SET assignee_id=? WHERE workspace_id=? AND contact_channel_id=? AND ${pending}`)
          .bind(action.assignee_id, run.workspace_id, identity.id, run.id, step)
        : env.DB.prepare(`UPDATE conversations SET status=? WHERE workspace_id=? AND contact_channel_id=? AND ${pending}`)
          .bind(action.type === 'open_conversation' ? 'open' : 'closed', run.workspace_id, identity.id, run.id, step),
    ]
  }
  // Com automação escolhida, só ela fica pausada para o contato; com escopo, só as iniciadas por regras ou por sequências; sem nada, todas.
  if (action.type === 'pause_automations' && (action.automation_id || action.scope)) return [env.DB.prepare(`INSERT INTO contact_automation_pauses (workspace_id,contact_id,automation_id,paused_until)
    SELECT ?,?,?,? WHERE ${pending} ON CONFLICT(contact_id,automation_id) DO UPDATE SET paused_until=excluded.paused_until`)
    .bind(run.workspace_id, run.contact_id, action.automation_id ?? `scope:${action.scope}`, Date.now() + milliseconds(action.duration), run.id, step)]
  if (action.type === 'pause_automations') return [env.DB.prepare(`UPDATE contacts SET automation_paused_until=?,updated_at=? WHERE workspace_id=? AND id=? AND ${pending}`)
    .bind(Date.now() + milliseconds(action.duration), Date.now(), run.workspace_id, run.contact_id, run.id, step)]
  if (action.type === 'subscribe_to_account' || action.type === 'unsubscribe_to_account') {
    if (!await env.DB.prepare('SELECT id FROM contact_channels WHERE workspace_id=? AND contact_id=? AND channel_id=?')
      .bind(run.workspace_id, run.contact_id, action.connection_id).first()) throw new NonRetryableError('Contact connection not found in workspace')
    // Like a STOP/START word, the change records when it happened: an older word delivered later does not undo it.
    const optedIn = action.type === 'subscribe_to_account'
    return [changeConsent(env.DB, { optedIn, also: { sql: 'broadcast_opt_in=max(broadcast_opt_in,?)', binds: [optedIn ? 1 : 0] },
      where: { sql: `workspace_id=? AND contact_id=? AND channel_id=? AND ${pending}`, binds: [run.workspace_id, run.contact_id, action.connection_id, run.id, step] } })]
  }
  const opt = /^set_([a-z]+)_opt_(in|out)$/.exec(action.type)
  if (opt && (optActionTypes as readonly string[]).includes(action.type)) {
    // Sem identidade do contato nesse canal não há o que alterar: a ManyChat também ignora.
    return [changeConsent(env.DB, { optedIn: opt[2] === 'in', also: { sql: 'broadcast_opt_in=max(broadcast_opt_in,?)', binds: [opt[2] === 'in' ? 1 : 0] },
      where: { sql: `workspace_id=? AND contact_id=? AND ${pending} AND channel_id IN (SELECT id FROM channels WHERE workspace_id=? AND type=?)`,
        binds: [run.workspace_id, run.contact_id, run.id, step, run.workspace_id, opt[1]] } })]
  }
  const id = `action-${run.id}-${step}-${index}`
  if (action.type === 'notify_admin') {
    const via = [...new Set(action.via ?? [])]
    return [env.DB.prepare(`INSERT INTO team_notifications (id,workspace_id,contact_id,run_id,recipient_id,message,via,alerted)
    SELECT ?,?,?,?,?,?,?,? WHERE ${pending} ON CONFLICT(id) DO NOTHING`)
    .bind(id, run.workspace_id, run.contact_id, run.id, action.recipient_id ?? null, action.message, JSON.stringify(via), via.length ? 0 : 1, run.id, step)]
  }
  if (action.type === 'fire_custom_event') return [env.DB.prepare(`INSERT INTO conversion_events (id,workspace_id,contact_id,automation_id,run_id,event_name,value,currency)
    SELECT ?,?,?,?,?,?,?,? WHERE ${pending} ON CONFLICT(id) DO NOTHING`)
    .bind(id, run.workspace_id, run.contact_id, run.automation_id, run.id, action.event_name, action.value ?? null, action.currency ?? 'BRL', run.id, step)]
  return null
}

export async function notifyActionEffects(env: FlowEnv, run: Run): Promise<void> {
  await notifyTimeline(env, run.workspace_id)
  const conversation = await env.DB.prepare(`SELECT v.id FROM conversations v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id
    WHERE cc.workspace_id=? AND cc.contact_id=? AND cc.channel_id=?`).bind(run.workspace_id, run.contact_id, run.channel_id).first<{ id: string }>()
  if (conversation) await notifyConversation(env, run.workspace_id, conversation.id)
  // E-mail e chat da ação: entram na fila uma vez (alerted=1) e saem pelo mesmo caminho dos demais avisos.
  const toAlert = await env.DB.prepare('SELECT id,recipient_id,message,via FROM team_notifications WHERE workspace_id=? AND alerted=0 ORDER BY created_at,id')
    .bind(run.workspace_id).all<{ id: string; recipient_id: string | null; message: string; via: string }>()
  for (const n of toAlert.results) {
    await queueFlowAlert(env, run.workspace_id, run.contact_id, run.channel_id, n.recipient_id, n.message, JSON.parse(n.via))
    await env.DB.prepare('UPDATE team_notifications SET alerted=1 WHERE workspace_id=? AND id=?').bind(run.workspace_id, n.id).run()
  }
  if (toAlert.results.length) await drainMemberAlerts(env).catch(() => null)
  if (!env.INBOX_HUB) return
  const pending = await env.DB.prepare('SELECT id,recipient_id FROM team_notifications WHERE workspace_id=? AND notified=0 ORDER BY created_at,id')
    .bind(run.workspace_id).all<{ id: string; recipient_id: string | null }>()
  for (const notification of pending.results) {
    // The workspace Hub gets only a refresh hint; notification contents require a recipient-scoped HTTP read.
    await env.INBOX_HUB.get(env.INBOX_HUB.idFromName(run.workspace_id)).notify({ type: 'team_notification', notification_id: notification.id, recipient_id: notification.recipient_id })
    await env.DB.prepare('UPDATE team_notifications SET notified=1 WHERE workspace_id=? AND id=?').bind(run.workspace_id, notification.id).run()
  }
}
