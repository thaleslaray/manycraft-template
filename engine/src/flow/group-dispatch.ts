import type { InboundEvent } from '../integrations'
import type { InboundEvent as ChannelInboundEvent } from '../channels'
import type { ConnectionRuntime } from '../channels/core/runtime'
import { firstKeywordMatch, type KeyedKeyword } from './matcher'
import { object, stableId, type FlowEnv } from './types'
import { z } from 'zod'

type GroupTrigger = { id: string; automation_id: string; published_version_id: string; repeat_mode: string; config: string; group_match: 'keyword' | 'mention' }

/** A message written in a group: picks the group trigger it satisfies and plans its run. It never touches `conversations`, never needs the
 * author's consent for a direct message (the answer goes to the group) and never fires a trigger meant for private conversations.
 * "keyword" fires on the words; "mention" also needs the message to mention the connected account (words, if any, still have to match). */
export async function planGroupRun(env: FlowEnv, rt: ConnectionRuntime, event: InboundEvent, inboundId: string,
  message: Extract<ChannelInboundEvent, { kind: 'message' }>, group: NonNullable<Extract<ChannelInboundEvent, { kind: 'message' }>['group']>): Promise<void> {
  const planned = await env.DB.prepare('SELECT planned_at FROM inbound_events WHERE id=? AND workspace_id=?')
    .bind(inboundId, event.workspaceId).first<{ planned_at: number | null }>()
  if (!planned) throw new Error('Inbound missing')
  if (planned.planned_at !== null) return
  const ws = event.workspaceId, now = Date.now()
  const statements: D1PreparedStatement[] = []
  const thread = await env.DB.prepare('SELECT id,status FROM group_threads WHERE workspace_id=? AND channel_id=? AND external_group_id=?')
    .bind(ws, event.channelId, group.externalGroupId).first<{ id: string; status: string }>()
  const contact = await env.DB.prepare(`SELECT c.id,c.status FROM contacts c JOIN contact_channels cc ON cc.workspace_id=c.workspace_id AND cc.contact_id=c.id
    WHERE c.workspace_id=? AND cc.channel_id=? AND cc.external_user_id=?`).bind(ws, event.channelId, message.externalUserId).first<{ id: string; status: string }>()
  if (!thread || !contact) throw new Error('Group message was not synced')
  let trigger: GroupTrigger | undefined
  if (rt.connection.profile.groups?.reply && thread.status === 'active' && contact.status === 'subscribed' && message.text !== undefined) {
    const rows = await env.DB.prepare(`SELECT t.*,a.published_version_id FROM triggers t
      JOIN automations a ON a.workspace_id=t.workspace_id AND a.id=t.automation_id
      WHERE t.workspace_id=? AND (t.channel_id=? OR t.channel_id IS NULL) AND t.status='active' AND t.kind='keyword' AND t.audience='group'
      AND (t.group_thread_id IS NULL OR t.group_thread_id=?)
      AND a.status='live' AND a.deleted_at IS NULL AND a.published_version_id IS NOT NULL ORDER BY t.id`)
      .bind(ws, event.channelId, thread.id).all<GroupTrigger>()
    const eligible = rows.results.filter(t => t.group_match === 'keyword' || group.mentionsMe)
    if (eligible.length) {
      const keywords = await env.DB.prepare(`SELECT k.*,t.created_at AS trigger_created_at FROM keywords k JOIN triggers t ON t.workspace_id=k.workspace_id AND t.id=k.trigger_id
        WHERE k.workspace_id=? AND k.status='live' AND k.trigger_id IN (${eligible.map(() => '?').join(',')}) ORDER BY k.priority,k.id`)
        .bind(ws, ...eligible.map(t => t.id)).all<KeyedKeyword>()
      const match = firstKeywordMatch(keywords.results, new Set(eligible.map(t => t.id)), message.text)
      trigger = eligible.find(t => t.id === match?.trigger_id)
    }
  }
  if (trigger) {
    const dedupe = trigger.repeat_mode === 'once' ? 'once' : inboundId
    const runId = `flow-${await stableId(inboundId, trigger.id)}`
    const config = object(JSON.parse(trigger.config))
    const start = config.node_id === undefined ? null : z.string().min(1).parse(config.node_id)
    statements.push(env.DB.prepare(`INSERT INTO trigger_firings (workspace_id,trigger_id,contact_id,external_event_id,dedupe_key,fired_at) SELECT ?,?,?,?,?,? FROM triggers t
      JOIN automations a ON a.workspace_id=t.workspace_id AND a.id=t.automation_id
      WHERE t.workspace_id=? AND t.id=? AND t.status='active' AND a.status='live' AND a.deleted_at IS NULL
      AND (?<>'once_per_24_hours' OR NOT EXISTS (SELECT 1 FROM trigger_firings WHERE workspace_id=? AND trigger_id=? AND contact_id=? AND fired_at>?))
      ON CONFLICT(trigger_id,contact_id,dedupe_key) DO NOTHING`)
      .bind(ws, trigger.id, contact.id, inboundId, dedupe, now, ws, trigger.id, trigger.repeat_mode, ws, trigger.id, contact.id, now - 86400000))
    statements.push(env.DB.prepare(`INSERT INTO flow_runs (id,workspace_id,contact_id,automation_version_id,trigger_id,inbound_event_id,channel_id,start_node_id,reply_group_thread_id,trigger_opt_in)
      SELECT ?,?,?,?,?,?,?,?,?,0 FROM trigger_firings WHERE workspace_id=? AND trigger_id=? AND contact_id=? AND dedupe_key=? AND external_event_id=? AND EXISTS (SELECT 1 FROM triggers t
        JOIN automations a ON a.workspace_id=t.workspace_id AND a.id=t.automation_id
        WHERE t.workspace_id=trigger_firings.workspace_id AND t.id=trigger_firings.trigger_id
        AND t.status='active' AND a.status='live' AND a.deleted_at IS NULL) ON CONFLICT(id) DO NOTHING`)
      .bind(runId, ws, contact.id, trigger.published_version_id, trigger.id, inboundId, event.channelId, start, thread.id, ws, trigger.id, contact.id, dedupe, inboundId))
  }
  statements.push(env.DB.prepare('UPDATE inbound_events SET planned_at=? WHERE id=? AND planned_at IS NULL').bind(now, inboundId))
  await env.DB.batch(statements)
}
