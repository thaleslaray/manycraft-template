import { tagContacts } from '../db/tags'
import { startAutomation } from '../flow/nodes'
import type { FlowEnv, Run } from '../flow/types'
import type { EmailContent, EmailInteraction } from '../channels/types'
import type { StoredEmail } from './service'
import type { EmailEnv } from './store'
import { matchesContact } from './filters'
import { notifyTimeline } from '../inbox/service'

/** Reuse the generic start-automation executor: publication, tenant, depth and Workflow guards stay there. */
export async function startEmailAutomation(
  env: EmailEnv,
  ws: string,
  contactId: string,
  channelId: string,
  automationId: string,
  eventKey: string,
  depth = 0,
) {
  if (!env.FLOW_RUN) return
  const target = await env.DB.prepare(
    "SELECT published_version_id FROM automations WHERE workspace_id=? AND id=? AND status='live' AND deleted_at IS NULL AND published_version_id IS NOT NULL",
  )
    .bind(ws, automationId)
    .first<{ published_version_id: string }>()
  if (!target) return
  const parent: Run = {
    id: eventKey,
    workspace_id: ws,
    contact_id: contactId,
    channel_id: channelId,
    channel_type: 'email',
    automation_id: automationId,
    automation_version_id: target.published_version_id,
    graph: '{}',
    start_node_id: null,
    depth,
    external_user_id: '',
  }
  await startAutomation(env as FlowEnv, parent, 0, {
    automation_id: automationId,
  })
}
async function interaction(env: EmailEnv, mail: StoredEmail, config: EmailInteraction, eventKey: string) {
  for (const action of config.actions ?? [])
    await tagContacts(
      env.DB,
      mail.workspace_id,
      [mail.contact_id],
      action.tag_id,
      action.type === 'add_tag' ? 'add' : 'remove',
      false,
    )
  if (config.automationId) {
    const parent = await env.DB.prepare(
      'SELECT r.depth FROM flow_outbound o JOIN flow_runs r ON r.id=o.run_id WHERE r.workspace_id=? AND o.external_message_id IN (?,?) LIMIT 1',
    )
      .bind(mail.workspace_id, mail.message_id, mail.provider_message_id)
      .first<{ depth: number }>()
    await startEmailAutomation(
      env,
      mail.workspace_id,
      mail.contact_id,
      mail.connection_id,
      config.automationId,
      eventKey,
      parent?.depth ?? 0,
    )
  }
  await notifyTimeline(env, mail.workspace_id)
}
export async function runEmailInteraction(
  env: EmailEnv,
  mail: StoredEmail,
  type: 'opened' | 'clicked',
  eventId: string,
  url?: string,
) {
  await runEmailRules(env, mail.workspace_id, mail.contact_id, mail.connection_id, type === 'opened' ? 'email_opened' : 'email_clicked', { messageId: mail.id, url })
  const config: EmailContent = mail.metadata ? JSON.parse(mail.metadata) : {}
  if (type === 'opened' && config.onOpen) {
    const opens = await env.DB.prepare(
      "SELECT id FROM email_events WHERE message_id=? AND type='opened' ORDER BY created_at,rowid LIMIT 1",
    )
      .bind(mail.id)
      .first<{ id: string }>()
    if (config.onOpen.mode === 'every' || opens?.id === eventId)
      await interaction(
        env,
        mail,
        config.onOpen,
        `email-open-${mail.id}-${config.onOpen.mode === 'once' ? 'once' : eventId}`,
      )
  }
  if (type === 'clicked')
    for (const action of config.linkActions ?? [])
      if (action.url === url) await interaction(env, mail, action, `email-click-${mail.id}-${eventId}`)
}
export type EmailRuleEvent = 'email_defined' | 'email_opened' | 'email_clicked' | 'contact_created'
/** Every source is an individual event. Import/bulk writes deliberately never invoke this function. */
export async function runEmailRules(env: EmailEnv, ws: string, contactId: string, channelId: string, event: EmailRuleEvent,
  data: { previous?: string | null; value?: string; messageId?: string; url?: string } = {}) {
  if (!env.FLOW_RUN) return
  const rules = await env.DB.prepare("SELECT id,event_type,event_config,contact_filter,frequency,automation_id FROM rules WHERE workspace_id=? AND status='active' AND action_type='start_flow'").bind(ws).all<{
    id: string; event_type: string; event_config: string; contact_filter: string; frequency: string; automation_id: string
  }>()
  for (const rule of rules.results) {
    const config = JSON.parse(rule.event_config)
    const type = config.email_event ?? (rule.event_type === 'change_system_field_value' && (config.field ?? config.field_name ?? config.system_field) === 'email' ? 'email_defined' : rule.event_type === 'user_created' ? 'contact_created' : undefined)
    if (type !== event) continue
    const eventFilter = config.filter ?? {}
    if (event === 'email_defined' && (config.condition ?? eventFilter.condition) === 'is_set' && data.previous) continue
    if (eventFilter.messageId && eventFilter.messageId !== data.messageId) continue
    if (eventFilter.url && eventFilter.url !== data.url) continue
    if (!await matchesContact(env.DB, ws, contactId, JSON.parse(rule.contact_filter))) continue
    if (!await env.DB.prepare("SELECT id FROM automations WHERE workspace_id=? AND id=? AND status='live' AND deleted_at IS NULL AND published_version_id IS NOT NULL").bind(ws, rule.automation_id).first()) continue
    const now = Date.now(), key = `email-rule:${ws}:${rule.id}:${contactId}`
    const permit = await env.DB.prepare('INSERT INTO request_limits(key,count,reset_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1,reset_at=excluded.reset_at WHERE request_limits.reset_at<=? RETURNING count')
      .bind(key, rule.frequency === 'once' ? Number.MAX_SAFE_INTEGER : now + 30000, now).first()
    if (!permit) continue
    await startEmailAutomation(env, ws, contactId, channelId, rule.automation_id, `${key}:${rule.frequency === 'once' ? 'once' : now}`)
  }
}
export async function runEmailFieldRules(env: EmailEnv, ws: string, contactId: string, channelId: string, previous: string | null, value: string) {
  if (previous !== value) await runEmailRules(env, ws, contactId, channelId, 'email_defined', { previous, value })
}
