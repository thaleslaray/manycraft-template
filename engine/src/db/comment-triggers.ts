import { z } from 'zod'
import { connectionColumns, connectionFromRow, type ConnectionRow } from '../channels/core/connection'
import { RepositoryError, requireRow, type Row } from './shared'
import { getAutomation, LIVE_COMMENT_WIDGET } from './automations'
import type { ChannelType, TriggerConfig } from '../contracts'

const id = z.string().min(1).max(128)
const postSnapshot = z.object({ id: z.string(), caption: z.string().optional(), mediaType: z.string().optional(), mediaUrl: z.string().optional(), thumbnailUrl: z.string().optional(), permalink: z.string().optional(), publishedAt: z.number().optional() }).passthrough()
export const commentConfig = z.object({
  target: z.enum(['all', 'specific', 'next', 'live']), post_id: z.string().min(1).max(512).optional(),
  // Comentário em Live: qualquer texto, igual, contém, palavra inteira ou começa com.
  rule: z.enum(['any', 'is', 'contains', 'word', 'begins']).optional(), words: z.array(z.string().trim().min(1).max(500)).max(10).optional(),
  include: z.array(z.string().trim().min(1).max(500)).max(10), exclude: z.array(z.string().trim().min(1).max(500)).max(10),
  public_replies: z.array(z.string().trim().min(1).max(140)).max(8), like_comment: z.boolean().optional(),
  post_snapshot: postSnapshot.optional(),
  // Gravado pelo motor ao prender a "próxima publicação" (flow/comment-dispatch.ts): a publicação que era a mais recente antes. Volta no PATCH do painel.
  last_post_snapshot: postSnapshot.nullable().optional(),
}).strict().refine(c => c.target !== 'specific' || !!c.post_id, 'Escolha uma publicação.')
  .refine(c => c.target !== 'live' || !c.rule || c.rule === 'any' || !!c.words?.length, 'Informe ao menos uma palavra.')
export const createCommentSchema = z.object({ type: z.enum(['ig_comment', 'ig_live_comment']), name: z.string().trim().min(1).max(100), connection_id: id, node_id: id, config: commentConfig, enabled: z.boolean().default(false) }).strict()
export const patchCommentSchema = z.object({ connection_id: id.optional(), config: commentConfig.optional(), enabled: z.boolean().optional(), state: z.enum(['active','draft','initial']).optional(), repeat_mode: z.enum(['once','every_time','once_per_24_hours']).optional() }).strict()

export async function commentTriggerRows(db: D1Database, ws: string, automation: string) {
  const rows = await db.prepare(`SELECT t.*,ch.type AS channel_type FROM triggers t LEFT JOIN channels ch ON ch.workspace_id=t.workspace_id AND ch.id=t.channel_id WHERE t.workspace_id=? AND t.automation_id=? AND t.kind='widget' AND t.widget_type IN ('feed_comment','feed_comment_trigger','${LIVE_COMMENT_WIDGET}') ORDER BY t.created_at,t.id`).bind(ws, automation).all<Row>()
  return rows.results.map(row => {
    const config = JSON.parse(String(row.config))
    return { id: String(row.id), workspace_id: ws, automation_id: automation, channel_id: row.channel_id as string, channel_type: row.channel_type as ChannelType | null,
      name: String(row.name), type: row.widget_type === LIVE_COMMENT_WIDGET ? 'ig_live_comment' as const : 'ig_comment' as const, node_id: config.node_id as string,
      config: { ...Object.fromEntries(Object.entries(config).filter(([key]) => !['node_id','next_after'].includes(key))), target: row.widget_type === LIVE_COMMENT_WIDGET ? 'live' : row.post_scope ?? 'all', post_id: row.post_scope === 'specific' ? row.target_post_id ?? undefined : undefined, public_replies: JSON.parse(String(row.public_replies)), like_comment: !!row.like_comment } as TriggerConfig,
      enabled: row.status === 'active', active: row.status === 'active', state: row.status === 'active' ? 'active' as const : row.status === 'initial' ? 'initial' as const : 'draft' as const,
      repeat_mode: row.repeat_mode as 'once' | 'every_time' | 'once_per_24_hours', keywords: [],
      created_at: new Date(Number(row.created_at)).toISOString(), updated_at: new Date(Number(row.updated_at)).toISOString() }
  })
}
async function validateConnection(db: D1Database, ws: string, connectionId: string, config: z.infer<typeof commentConfig>) {
  const row = requireRow(await db.prepare(`SELECT ${connectionColumns} FROM channels WHERE workspace_id=? AND id=? AND archived_at IS NULL`).bind(ws, connectionId).first<ConnectionRow>())
  const connection = connectionFromRow(row), caps = connection.profile.comments
  if (connection.status !== 'connected' || !connection.profile.inbound.comment || !caps?.privateReply) throw new RepositoryError('Esta conexão não aceita entradas por comentário.', 400)
  if (config.target === 'next' && !caps.posts) throw new RepositoryError('Esta conexão não consegue localizar a próxima publicação.', 400)
  if (config.like_comment && !caps.like || config.public_replies.length && !caps.publicReply) throw new RepositoryError('Esta conexão não aceita curtir ou responder publicamente.', 400)
}
export async function saveCommentTrigger(db: D1Database, ws: string, automation: string, input: unknown, triggerId?: string) {
  const detail = requireRow(await getAutomation(db, ws, automation))
  const old = triggerId ? requireRow((await db.prepare(`SELECT * FROM triggers WHERE workspace_id=? AND automation_id=? AND id=? AND kind='widget' AND widget_type IN ('feed_comment','feed_comment_trigger','${LIVE_COMMENT_WIDGET}')`).bind(ws, automation, triggerId).first<Row>())) : null
  const parsed = triggerId ? patchCommentSchema.parse(input) : createCommentSchema.parse(input)
  const previous = old ? JSON.parse(String(old.config)) : {}
  const live = 'type' in parsed ? parsed.type === 'ig_live_comment' : old?.widget_type === LIVE_COMMENT_WIDGET
  const config = commentConfig.parse(parsed.config ? { ...parsed.config, ...(live ? { target: 'live' } : {}) } : { ...Object.fromEntries(Object.entries(previous).filter(([key]) => !['node_id','next_after'].includes(key))), target: old?.post_scope ?? 'all', post_id: old?.target_post_id ?? undefined, public_replies: JSON.parse(String(old?.public_replies ?? '[]')) })
  if (!live && config.target === 'live') throw new RepositoryError('Só o gatilho de comentário em Live usa a Live como alvo.', 400)
  const connectionId = parsed.connection_id ?? String(old!.channel_id)
  await validateConnection(db, ws, connectionId, config)
  const nodeId = 'node_id' in parsed ? parsed.node_id : previous.node_id
  if (!detail.automation.draft_graph.nodes.some(n => n.id === nodeId && n.type === 'trigger')) throw new RepositoryError('Escolha um passo de gatilho desta automação.', 400)
  const status = !old && parsed.enabled === false ? 'initial' : 'state' in parsed && parsed.state ? parsed.state : parsed.enabled === undefined ? String(old?.status ?? 'initial') : parsed.enabled ? 'active' : 'draft'
  if (status === 'active' && !detail.published_version) throw new RepositoryError('Publique a automação antes de ativar este gatilho.', 409)
  if (status === 'active' && detail.published_version && !detail.published_version.graph.nodes.some(node => node.id === nodeId)) {
    throw new RepositoryError('Publique o rascunho antes de ativar este gatilho.', 409)
  }
  const nextAfter = config.target === 'next' && old?.post_scope === 'next' && old.channel_id === connectionId && (old.status === 'active' || status !== 'active' || old.target_post_id) ? previous.next_after : Date.now()
  const stored = { ...config, node_id: nodeId, ...(config.target === 'next' ? { next_after: nextAfter } : {}) }
  const targetId = config.target === 'specific' ? config.post_id! : config.target === 'next' && old?.post_scope === 'next' && old.channel_id === connectionId ? old.target_post_id : null
  if (config.target === 'next' && status === 'active') {
    const competing = await db.prepare("SELECT id FROM triggers WHERE workspace_id=? AND channel_id=? AND post_scope='next' AND status='active' AND id<>?").bind(ws, connectionId, triggerId ?? '').first()
    if (competing) throw new RepositoryError('Já existe um gatilho ativo para a próxima publicação nesta conexão.', 409)
  }
  // A Live não tem publicação alvo: guardamos o escopo 'all' e o tipo vem do widget.
  const scope = live ? 'all' : config.target
  const key = triggerId ?? crypto.randomUUID(), now = Date.now()
  try {
  if (old) await db.prepare(`UPDATE triggers SET channel_id=?,config=?,post_scope=?,target_post_id=?,public_replies=?,like_comment=?,status=?,repeat_mode=?,updated_at=? WHERE workspace_id=? AND id=?`)
    .bind(connectionId, JSON.stringify(stored), scope, targetId ?? null, JSON.stringify(config.public_replies), config.like_comment ? 1 : 0, status, 'repeat_mode' in parsed ? parsed.repeat_mode ?? old.repeat_mode : old.repeat_mode, now, ws, key).run()
  else await db.prepare(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status,repeat_mode,post_scope,target_post_id,public_replies,like_comment,config) VALUES (?,?,?,?,?,'widget',?,?,'every_time',?,?,?,?,?)`)
    .bind(key, ws, automation, connectionId, 'name' in parsed ? parsed.name : 'Comentário', live ? LIVE_COMMENT_WIDGET : 'feed_comment', status, scope, targetId ?? null, JSON.stringify(config.public_replies), config.like_comment ? 1 : 0, JSON.stringify(stored)).run()
  } catch (error) {
    if (config.target === 'next' && /UNIQUE/i.test(String(error))) throw new RepositoryError('Já existe um gatilho ativo para a próxima publicação nesta conexão.', 409)
    throw error
  }
  return requireRow((await commentTriggerRows(db, ws, automation)).find(t => t.id === key) ?? null)
}
