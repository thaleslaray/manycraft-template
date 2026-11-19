import { z } from 'zod'
import { connectionColumns, connectionFromRow, type ConnectionRow } from '../channels/core/connection'
import { RepositoryError, requireRow, type Row } from './shared'
import { getAutomation, STORY_REPLY_WIDGET } from './automations'
import type { ChannelType, TriggerConfig } from '../contracts'

const id = z.string().min(1).max(128)
const words = z.array(z.string().trim().min(1).max(500)).max(10)
const snapshot = z.object({ id: z.string(), caption: z.string().optional(), mediaType: z.string().optional(), mediaUrl: z.string().optional(), thumbnailUrl: z.string().optional(), permalink: z.string().optional(), publishedAt: z.number().optional() }).passthrough()
const repeat = z.enum(['once', 'every_time', 'once_per_24_hours'])
const state = z.enum(['active', 'draft', 'initial'])

/** Reply to a story: any story or one chosen story, and any message, one that contains the words, or exactly one of them. */
export const storyReplyConfig = z.object({
  target: z.enum(['all', 'specific']), post_id: z.string().min(1).max(512).optional(), post_snapshot: snapshot.optional(),
  rule: z.enum(['any', 'contains', 'is']).default('any'), words: words.default([]),
  delay_seconds: z.union([z.literal(0), z.literal(30), z.literal(60), z.literal(300), z.literal(600)]).default(0), heart: z.boolean().default(false),
}).strict().superRefine((c, ctx) => {
  if (c.target === 'specific' && !c.post_id) ctx.addIssue({ code: 'custom', path: ['post_id'], message: 'Escolha um story.' })
  if (c.rule !== 'any' && !c.words.length) ctx.addIssue({ code: 'custom', path: ['words'], message: 'Informe ao menos uma palavra.' })
})
/** Mention of the account in someone's story: the pause before the first reply (up to 10 minutes) and the heart reaction. */
export const storyMentionConfig = z.object({ delay_seconds: z.union([z.literal(0), z.literal(30), z.literal(60), z.literal(300), z.literal(600)]).default(0), heart: z.boolean().default(false) }).strict()

const base = { name: z.string().trim().min(1).max(100), connection_id: id, node_id: id, enabled: z.boolean().default(false) }
export const createStorySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ig_story_reply'), ...base, config: storyReplyConfig.default({ target: 'all', rule: 'any', words: [], delay_seconds: 0, heart: false }) }).strict(),
  z.object({ type: z.literal('ig_story_mention'), ...base, config: storyMentionConfig.default({ delay_seconds: 0, heart: false }) }).strict(),
])
const patchBase = { connection_id: id.optional(), enabled: z.boolean().optional(), state: state.optional() }
export const patchStoryReplySchema = z.object({ ...patchBase, config: storyReplyConfig.optional(), repeat_mode: repeat.optional() }).strict()
export const patchStoryMentionSchema = z.object({ ...patchBase, config: storyMentionConfig.optional(), repeat_mode: z.enum(['every_time', 'once_per_24_hours']).optional() }).strict()

const isReply = (row: Row) => row.kind === 'widget' && row.widget_type === STORY_REPLY_WIDGET
export const storyWhere = `((t.kind='widget' AND t.widget_type='${STORY_REPLY_WIDGET}') OR t.kind='story_mention_reply')`

export function presentStory(row: Row, ws: string, automation: string) {
  const config = JSON.parse(String(row.config))
  const reply = isReply(row)
  return { id: String(row.id), workspace_id: ws, automation_id: automation, channel_id: row.channel_id as string, channel_type: row.channel_type as ChannelType | null,
    name: String(row.name), type: reply ? 'ig_story_reply' as const : 'ig_story_mention' as const, node_id: config.node_id as string,
    config: reply
      ? { target: (row.post_scope ?? 'all') as 'all' | 'specific', post_id: row.post_scope === 'specific' ? row.target_post_id ?? undefined : undefined,
          post_snapshot: config.story_snapshot, rule: config.rule ?? 'any', words: config.words ?? [], delay_seconds: Number(row.delay_seconds ?? 0), heart: !!row.story_auto_like, include: [] as string[], exclude: [] as string[], public_replies: [] as string[] } as TriggerConfig
      : { target: 'all' as const, delay_seconds: Number(row.delay_seconds ?? 0), heart: !!row.story_auto_like, include: [] as string[], exclude: [] as string[], public_replies: [] as string[] } as TriggerConfig,
    enabled: row.status === 'active', active: row.status === 'active',
    state: row.status === 'active' ? 'active' as const : row.status === 'initial' ? 'initial' as const : 'draft' as const,
    repeat_mode: row.repeat_mode as 'once' | 'every_time' | 'once_per_24_hours', keywords: [],
    created_at: new Date(Number(row.created_at)).toISOString(), updated_at: new Date(Number(row.updated_at)).toISOString() }
}

export async function storyTriggerRows(db: D1Database, ws: string, automation: string) {
  const rows = await db.prepare(`SELECT t.*,ch.type AS channel_type FROM triggers t LEFT JOIN channels ch ON ch.workspace_id=t.workspace_id AND ch.id=t.channel_id
    WHERE t.workspace_id=? AND t.automation_id=? AND ${storyWhere} ORDER BY t.created_at,t.id`).bind(ws, automation).all<Row>()
  return rows.results.map(row => presentStory(row, ws, automation))
}

async function validateConnection(db: D1Database, ws: string, connectionId: string, type: 'ig_story_reply' | 'ig_story_mention', config: { heart?: boolean; target?: string }) {
  const row = requireRow(await db.prepare(`SELECT ${connectionColumns} FROM channels WHERE workspace_id=? AND id=? AND archived_at IS NULL`).bind(ws, connectionId).first<ConnectionRow>())
  const connection = connectionFromRow(row), stories = connection.profile.stories
  if (connection.status !== 'connected' || !(type === 'ig_story_reply' ? stories?.reply && connection.profile.inbound.storyReply : stories?.mention))
    throw new RepositoryError(type === 'ig_story_reply' ? 'Esta conexão não recebe respostas a story.' : 'Esta conexão não recebe menções em story.', 400)
  if (config.target === 'specific' && !stories?.list) throw new RepositoryError('Esta conexão não lista os stories ativos.', 400)
  if (config.heart && !stories?.heart) throw new RepositoryError('Esta conexão não envia a reação de coração.', 400)
}

/** Creates (no triggerId) or edits a story trigger. The type follows the stored row on edit, so a reply is never saved as a mention. */
export async function saveStoryTrigger(db: D1Database, ws: string, automation: string, input: unknown, triggerId?: string) {
  const detail = requireRow(await getAutomation(db, ws, automation))
  const old = triggerId ? requireRow(await db.prepare(`SELECT t.* FROM triggers t WHERE t.workspace_id=? AND t.automation_id=? AND t.id=? AND ${storyWhere}`).bind(ws, automation, triggerId).first<Row>()) : null
  const create = old ? null : createStorySchema.parse(input)
  const type = create ? create.type : isReply(old!) ? 'ig_story_reply' : 'ig_story_mention'
  const patch = old ? (type === 'ig_story_reply' ? patchStoryReplySchema : patchStoryMentionSchema).parse(input) : null
  const previous = old ? JSON.parse(String(old.config)) as Record<string, unknown> : {}
  const connectionId = create?.connection_id ?? patch?.connection_id ?? String(old!.channel_id)
  const nodeId = create ? create.node_id : String(previous.node_id)
  if (!detail.automation.draft_graph.nodes.some(n => n.id === nodeId && n.type === 'trigger')) throw new RepositoryError('Escolha um passo de gatilho desta automação.', 400)
  const status = create ? (create.enabled ? 'active' : 'initial') : patch!.state ?? (patch!.enabled === undefined ? String(old!.status) : patch!.enabled ? 'active' : 'draft')
  if (status === 'active' && !detail.published_version) throw new RepositoryError('Publique a automação antes de ativar este gatilho.', 409)
  if (status === 'active' && detail.published_version && !detail.published_version.graph.nodes.some(node => node.id === nodeId)) throw new RepositoryError('Publique o rascunho antes de ativar este gatilho.', 409)
  const now = Date.now(), key = triggerId ?? crypto.randomUUID()
  if (type === 'ig_story_mention') {
    const config = storyMentionConfig.parse(create ? create.config : (patch!.config ?? { delay_seconds: Number(old!.delay_seconds ?? 0), heart: !!old!.story_auto_like }))
    await validateConnection(db, ws, connectionId, type, config)
    if (status === 'active') {
      const competing = await db.prepare("SELECT id FROM triggers t WHERE t.workspace_id=? AND t.channel_id=? AND t.kind='story_mention_reply' AND t.status='active' AND t.id<>?").bind(ws, connectionId, key).first()
      if (competing) throw new RepositoryError('Já existe um gatilho de menção em story ativo nesta conexão.', 409)
    }
    const mode = create ? 'every_time' : (patch as z.infer<typeof patchStoryMentionSchema>).repeat_mode ?? String(old!.repeat_mode)
    if (old) await db.prepare('UPDATE triggers SET channel_id=?,config=?,delay_seconds=?,story_auto_like=?,status=?,repeat_mode=?,updated_at=? WHERE workspace_id=? AND id=?')
      .bind(connectionId, JSON.stringify({ ...previous, node_id: nodeId }), config.delay_seconds, config.heart ? 1 : 0, status, mode, now, ws, key).run()
    else await db.prepare(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,story_auto_like,delay_seconds,config) VALUES (?,?,?,?,?,'story_mention_reply',?,?,?,?,?)`)
      .bind(key, ws, automation, connectionId, create!.name, status, mode, config.heart ? 1 : 0, config.delay_seconds, JSON.stringify({ node_id: nodeId })).run()
  } else {
    const fallback = { target: String(old?.post_scope ?? 'all'), post_id: old?.target_post_id ?? undefined, post_snapshot: previous.story_snapshot, rule: previous.rule ?? 'any', words: previous.words ?? [], delay_seconds: Number(old?.delay_seconds ?? 0), heart: !!old?.story_auto_like }
    const config = storyReplyConfig.parse(create ? create.config : (patch!.config ?? fallback))
    await validateConnection(db, ws, connectionId, type, config)
    const stored = { node_id: nodeId, rule: config.rule, words: [...new Set(config.words)], ...(config.target === 'specific' && config.post_snapshot ? { story_snapshot: config.post_snapshot } : {}) }
    const mode = create ? 'every_time' : (patch as z.infer<typeof patchStoryReplySchema>).repeat_mode ?? String(old!.repeat_mode)
    const target = config.target === 'specific' ? config.post_id! : null
    if (old) await db.prepare('UPDATE triggers SET channel_id=?,config=?,post_scope=?,target_post_id=?,status=?,repeat_mode=?,delay_seconds=?,story_auto_like=?,updated_at=? WHERE workspace_id=? AND id=?')
      .bind(connectionId, JSON.stringify(stored), config.target, target, status, mode, config.delay_seconds, config.heart ? 1 : 0, now, ws, key).run()
    else await db.prepare(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status,repeat_mode,post_scope,target_post_id,delay_seconds,story_auto_like,config) VALUES (?,?,?,?,?,'widget','${STORY_REPLY_WIDGET}',?,?,?,?,?,?,?)`)
      .bind(key, ws, automation, connectionId, create!.name, status, mode, config.target, target, config.delay_seconds, config.heart ? 1 : 0, JSON.stringify(stored)).run()
  }
  return requireRow((await storyTriggerRows(db, ws, automation)).find(t => t.id === key) ?? null)
}
