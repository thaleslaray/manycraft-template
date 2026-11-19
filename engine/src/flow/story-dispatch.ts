import type { InboundEvent } from '../integrations'
import type { InboundEvent as ChannelEvent } from '../channels/types'
import type { ConnectionRuntime } from '../channels/core/runtime'
import { STORY_REPLY_WIDGET } from '../db/automations'
import { ensureConversation, isAutomationPaused, recordMessage } from '../inbox/service'
import { stableId, type FlowEnv } from './types'

/** Frozen on the run: what the workflow needs to react to the mention and to wait before the first reply. */
export type StoryContext = { kind: 'mention' | 'reply'; messageId: string; externalUserId: string; storyUrl?: string; delaySeconds: number; heart: boolean; heartResult?: string }

export type StoryTrigger = { id: string; automation_id: string; published_version_id: string; repeat_mode: string; config: string }
type ReplyRow = StoryTrigger & { post_scope: string | null; target_post_id: string | null; created_at: number; delay_seconds: number | null; story_auto_like: number | null; widget_type: string }
const normalize = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR').trim()

/** The story-reply trigger a message answers, or undefined: the specific story wins over "any story", then the oldest trigger.
 * Nothing here names a channel: the connection's effective profile says whether story replies exist at all. */
export async function matchStoryReply(env: FlowEnv, workspaceId: string, channelId: string, rt: ConnectionRuntime,
  message: Extract<ChannelEvent, { kind: 'message' }>): Promise<StoryTrigger | undefined> {
  if (!message.storyReply || !rt.connection.profile.inbound.storyReply || !rt.connection.profile.stories?.reply) return undefined
  const rows = await env.DB.prepare(`SELECT t.*,a.published_version_id FROM triggers t JOIN automations a ON a.workspace_id=t.workspace_id AND a.id=t.automation_id
    WHERE t.workspace_id=? AND t.channel_id=? AND t.status='active' AND t.kind='widget' AND t.widget_type='${STORY_REPLY_WIDGET}'
    AND a.status='live' AND a.deleted_at IS NULL AND a.published_version_id IS NOT NULL
    ORDER BY CASE t.post_scope WHEN 'specific' THEN 0 ELSE 1 END,t.created_at,t.id`).bind(workspaceId, channelId).all<ReplyRow>()
  const input = normalize(message.text ?? '')
  return rows.results.find(trigger => {
    if (trigger.post_scope === 'specific' && trigger.target_post_id !== message.storyId) return false
    const config = JSON.parse(trigger.config) as { rule?: string; words?: string[] }
    if (!config.rule || config.rule === 'any') return true
    if (message.text === undefined || !config.words?.length) return false
    return config.words.some(word => config.rule === 'is' ? input === normalize(word) : input.includes(normalize(word)))
  })
}

/** A story mention is a private interaction (the contact opened the conversation) that starts at most one run, after the trigger's pause.
 * Contact, consent and window were booked by the provider sync; here the inbox gets the line and the trigger its firing. */
export async function planStoryMention(env: FlowEnv, rt: ConnectionRuntime, event: InboundEvent, inboundId: string,
  mention: Extract<ChannelEvent, { kind: 'story_mention' }>): Promise<void> {
  const ws = event.workspaceId, now = Date.now()
  const receipt = await env.DB.prepare('SELECT planned_at FROM inbound_events WHERE workspace_id=? AND id=?').bind(ws, inboundId).first<{ planned_at: number | null }>()
  if (!receipt || receipt.planned_at !== null) return
  const settle = () => env.DB.prepare('UPDATE inbound_events SET planned_at=? WHERE workspace_id=? AND id=? AND planned_at IS NULL').bind(now, ws, inboundId)
  const contact = await env.DB.prepare(`SELECT c.id,c.status FROM contacts c JOIN contact_channels cc ON cc.workspace_id=c.workspace_id AND cc.contact_id=c.id
    WHERE c.workspace_id=? AND cc.channel_id=? AND cc.external_user_id=?`).bind(ws, event.channelId, mention.externalUserId).first<{ id: string; status: string }>()
  if (!contact) throw new Error('Story mention contact missing')
  const conversationId = await ensureConversation(env, ws, contact.id, event.channelId)
  await recordMessage(env, { id: `in-${await stableId(inboundId)}`, workspaceId: ws, conversationId, direction: 'in', sender: 'contact',
    text: '[Mencionou você em um story]', status: 'delivered', externalMessageId: `${rt.connection.kind}:${event.channelId}:${mention.externalUserId}:${mention.externalMessageId}`, connectionId: event.channelId })
  if (!rt.connection.profile.stories?.mention) return void await settle().run()
  const statements: D1PreparedStatement[] = []
  if (contact.status === 'subscribed' && !await isAutomationPaused(env, ws, contact.id)) {
    const trigger = await env.DB.prepare(`SELECT t.*,a.published_version_id FROM triggers t JOIN automations a ON a.workspace_id=t.workspace_id AND a.id=t.automation_id
      WHERE t.workspace_id=? AND t.channel_id=? AND t.status='active' AND t.kind='story_mention_reply'
      AND a.status='live' AND a.deleted_at IS NULL AND a.published_version_id IS NOT NULL ORDER BY t.created_at,t.id LIMIT 1`)
      .bind(ws, event.channelId).first<StoryTrigger & { delay_seconds: number; story_auto_like: number }>()
    if (trigger) {
      const config = JSON.parse(trigger.config) as { node_id?: string }
      const context: StoryContext = { kind: 'mention', messageId: mention.externalMessageId, externalUserId: mention.externalUserId,
        ...(mention.storyUrl ? { storyUrl: mention.storyUrl } : {}), delaySeconds: trigger.delay_seconds ?? 0,
        heart: !!trigger.story_auto_like && !!rt.connection.profile.stories.heart }
      const run = `flow-${await stableId(inboundId, trigger.id)}`
      statements.push(env.DB.prepare(`INSERT INTO trigger_firings(workspace_id,trigger_id,contact_id,external_event_id,dedupe_key,fired_at)
        SELECT ?,?,?,?,?,? WHERE ?<>'once_per_24_hours' OR NOT EXISTS (SELECT 1 FROM trigger_firings WHERE workspace_id=? AND trigger_id=? AND contact_id=? AND fired_at>?)
        ON CONFLICT DO NOTHING`).bind(ws, trigger.id, contact.id, inboundId, inboundId, now, trigger.repeat_mode, ws, trigger.id, contact.id, now - 86400000))
      statements.push(env.DB.prepare(`INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,trigger_id,inbound_event_id,channel_id,start_node_id,story_context)
        SELECT ?,?,?,?,?,?,?,?,? FROM trigger_firings WHERE workspace_id=? AND trigger_id=? AND contact_id=? AND dedupe_key=? AND external_event_id=? ON CONFLICT DO NOTHING`)
        .bind(run, ws, contact.id, trigger.published_version_id, trigger.id, inboundId, event.channelId, config.node_id ?? null, JSON.stringify(context),
          ws, trigger.id, contact.id, inboundId, inboundId))
    }
  }
  statements.push(settle())
  await env.DB.batch(statements)
}

/** Resposta a story com pausa ou coração: o mesmo prelúdio da menção, congelado no run. Sem nenhum dos dois, nada muda. */
export function storyReplyContext(trigger: { widget_type?: string | null; delay_seconds?: number | null; story_auto_like?: number | null }, rt: ConnectionRuntime,
  message: Extract<ChannelEvent, { kind: 'message' }>): string | null {
  if (trigger.widget_type !== STORY_REPLY_WIDGET || !message.storyReply) return null
  const heart = !!trigger.story_auto_like && !!rt.connection.profile.stories?.heart, delaySeconds = Number(trigger.delay_seconds ?? 0)
  if (!heart && !delaySeconds) return null
  const context: StoryContext = { kind: 'reply', messageId: message.externalMessageId, externalUserId: message.externalUserId, delaySeconds, heart }
  return JSON.stringify(context)
}
