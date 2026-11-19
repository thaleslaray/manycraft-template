import type { CommentPost } from '../channels/contract'
import type { InboundEvent } from '../integrations'
import type { InboundEvent as ChannelEvent } from '../channels/types'
import type { ConnectionRuntime } from '../channels/core/runtime'
import { stableId, type FlowEnv } from './types'
import { isAutomationPaused } from '../inbox/service'
import { LIVE_COMMENT_WIDGET } from '../db/automations'

export type CommentContext = { commentId: string; createdAt: number; postId: string; postSnapshot: unknown; publicReply?: string; like: boolean }
type Trigger = { id: string; automation_id: string; published_version_id: string; repeat_mode: string; config: string; post_scope: string; target_post_id: string | null; public_replies: string; like_comment: number; created_at: number }
const normalize = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR')
const liveMatch = (rule: string, input: string, word: string) => rule === 'is' ? input === word : rule === 'begins' ? input.startsWith(word)
  : rule === 'word' ? input.split(/[^\p{L}\p{N}]+/u).includes(word) : input.includes(word)

/** Comments are a distinct entry: create an identity without opting it in or opening a direct-message window. */
export async function planCommentRun(env: FlowEnv, rt: ConnectionRuntime, event: InboundEvent, inboundId: string, comment: Extract<ChannelEvent, { kind: 'comment' }>) {
  const ws = event.workspaceId, now = Date.now()
  const receipt = await env.DB.prepare('SELECT planned_at FROM inbound_events WHERE workspace_id=? AND id=?').bind(ws, inboundId).first<{ planned_at: number | null }>()
  if (!receipt || receipt.planned_at !== null || !rt.connection.profile.inbound.comment || !rt.connection.profile.comments?.privateReply) return
  const contactId = `comment-${await stableId(ws, event.channelId, comment.externalUserId, inboundId)}`
  const identityId = `comment-${await stableId(event.channelId, comment.externalUserId, inboundId)}`
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO contacts(id,workspace_id,optin_source) SELECT ?,?,'comment' WHERE NOT EXISTS (SELECT 1 FROM contact_channels WHERE workspace_id=? AND channel_id=? AND external_user_id=?) ON CONFLICT DO NOTHING`).bind(contactId, ws, ws, event.channelId, comment.externalUserId),
    env.DB.prepare(`INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES (?,?,coalesce((SELECT contact_id FROM contact_channels WHERE workspace_id=? AND channel_id=? AND external_user_id=?),?),?,?,0) ON CONFLICT(channel_id,external_user_id) DO NOTHING`).bind(identityId, ws, ws, event.channelId, comment.externalUserId, contactId, event.channelId, comment.externalUserId),
  ])
  const contact = await env.DB.prepare(`SELECT c.id,c.status FROM contacts c JOIN contact_channels cc ON cc.workspace_id=c.workspace_id AND cc.contact_id=c.id WHERE c.workspace_id=? AND cc.channel_id=? AND cc.external_user_id=?`).bind(ws, event.channelId, comment.externalUserId).first<{ id: string; status: string }>()
  if (!contact) throw new Error('Comment contact missing')
  const rows = await env.DB.prepare(`SELECT t.*,a.published_version_id FROM triggers t JOIN automations a ON a.workspace_id=t.workspace_id AND a.id=t.automation_id WHERE t.workspace_id=? AND t.channel_id=? AND t.status='active' AND t.kind='widget' AND t.widget_type IN (${comment.live ? `'${LIVE_COMMENT_WIDGET}'` : "'feed_comment','feed_comment_trigger'"}) AND a.status='live' AND a.deleted_at IS NULL AND a.published_version_id IS NOT NULL ORDER BY CASE t.post_scope WHEN 'specific' THEN 0 WHEN 'next' THEN 1 ELSE 2 END,t.created_at,t.id`).bind(ws, event.channelId).all<Trigger>()
  const statements: D1PreparedStatement[] = []
  if (contact.status === 'subscribed' && !await isAutomationPaused(env, ws, contact.id)) for (const trigger of rows.results) {
    const config = JSON.parse(trigger.config) as { include?: string[]; exclude?: string[]; node_id?: string; next_after?: number; post_snapshot?: unknown; rule?: string; words?: string[] }
    const input = normalize(comment.text)
    // Comentário em Live: só a regra do texto (a Live não tem publicação alvo); um disparo por comentário.
    if (comment.live && config.rule && config.rule !== 'any' && !(config.words ?? []).some(word => liveMatch(config.rule!, input.trim(), normalize(word).trim()))) continue
    if (config.include?.length && !config.include.some(w => input.includes(normalize(w))) || config.exclude?.some(w => input.includes(normalize(w)))) continue
    if (trigger.post_scope === 'specific' && trigger.target_post_id !== comment.postId) continue
    let snapshot = config.post_snapshot ?? { id: comment.postId }
    if (trigger.post_scope === 'next') {
      if (!trigger.target_post_id) {
        if (!rt.provider?.comments || !rt.connection.profile.comments.posts) continue
        const candidates: CommentPost[] = [], cursors = new Set<string>()
        let previous: CommentPost | undefined
        let after: string | undefined
        do {
          const page = await rt.provider.comments.listPosts({ connection: rt.connection, credentials: await rt.credentials(), fetch: rt.fetch, env }, { limit: 100, ...(after ? { after } : {}) })
          candidates.push(...page.posts.filter(p => p.publishedAt !== undefined && p.publishedAt >= (config.next_after ?? trigger.created_at)))
          after = page.nextCursor ?? undefined
          if (after && cursors.has(after)) throw new Error('Repeated publications cursor')
          if (after) cursors.add(after)
          previous ??= page.posts.find(p => p.publishedAt !== undefined && p.publishedAt < (config.next_after ?? trigger.created_at))
          if (previous) break
        } while (after)
        const next = candidates.sort((a,b) => a.publishedAt! - b.publishedAt! || a.id.localeCompare(b.id))[0]
        if (!next) continue
        // Guarda também a última publicação conhecida antes da ativação (a que não conta), como a original faz.
        await env.DB.prepare("UPDATE triggers SET target_post_id=?,config=json_set(config,'$.post_snapshot',json(?),'$.last_post_snapshot',json(?)) WHERE workspace_id=? AND id=? AND target_post_id IS NULL").bind(next.id, JSON.stringify(next), JSON.stringify(previous ?? null), ws, trigger.id).run()
        const reserved = (await env.DB.prepare('SELECT target_post_id,config FROM triggers WHERE workspace_id=? AND id=?').bind(ws, trigger.id).first<{ target_post_id: string; config: string }>())!
        trigger.target_post_id = reserved.target_post_id
        snapshot = JSON.parse(reserved.config).post_snapshot
      }
      if (trigger.target_post_id !== comment.postId) continue
    }
    const replies = JSON.parse(trigger.public_replies) as string[]
    const context: CommentContext = { commentId: comment.commentId, createdAt: comment.createdAt, postId: comment.postId, postSnapshot: snapshot, like: !!trigger.like_comment }
    const run = `flow-${await stableId(inboundId, trigger.id)}`, dedupe = trigger.repeat_mode === 'once' ? 'once' : inboundId
    statements.push(env.DB.prepare(`INSERT INTO trigger_firings(workspace_id,trigger_id,contact_id,external_event_id,dedupe_key,fired_at) SELECT ?,?,?,?,?,? WHERE ?<>'once_per_24_hours' OR NOT EXISTS (SELECT 1 FROM trigger_firings WHERE workspace_id=? AND trigger_id=? AND contact_id=? AND fired_at>?) ON CONFLICT DO NOTHING`).bind(ws, trigger.id, contact.id, inboundId, dedupe, now, trigger.repeat_mode, ws, trigger.id, contact.id, now - 86400000))
    statements.push(env.DB.prepare(`INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,trigger_id,inbound_event_id,channel_id,start_node_id,comment_context) SELECT ?,?,?,?,?,?,?,?,? FROM trigger_firings WHERE workspace_id=? AND trigger_id=? AND contact_id=? AND dedupe_key=? AND external_event_id=? ON CONFLICT DO NOTHING`).bind(run, ws, contact.id, trigger.published_version_id, trigger.id, inboundId, event.channelId, config.node_id ?? null, JSON.stringify(context), ws, trigger.id, contact.id, dedupe, inboundId))
    if (replies.length) statements.push(env.DB.prepare(`UPDATE flow_runs SET comment_context=json_set(comment_context,'$.publicReply',json_extract(?, '$[' || (((SELECT count(*) FROM trigger_firings WHERE workspace_id=? AND trigger_id=?)-1) % json_array_length(?)) || ']')) WHERE workspace_id=? AND id=? AND json_type(comment_context,'$.publicReply') IS NULL`).bind(trigger.public_replies, ws, trigger.id, trigger.public_replies, ws, run))
    break
  }
  statements.push(env.DB.prepare('UPDATE inbound_events SET planned_at=? WHERE workspace_id=? AND id=? AND planned_at IS NULL').bind(now, ws, inboundId))
  await env.DB.batch(statements)
}
