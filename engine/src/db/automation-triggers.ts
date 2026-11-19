import { commentTriggerRows } from './comment-triggers'
import { storyTriggerRows } from './story-triggers'
import { refTriggerRows } from './ref-links'
import { externalTriggerRows } from './external-triggers'
import { z } from 'zod'
import type { AutomationTriggerRow, ChannelType } from '../contracts'
import { assertWorkspace, decode, nextKeywordPrioritySql, RepositoryError, requireRow, type Row } from './shared'
import type { Keyword } from './keywords'
import { connectionColumns, connectionFromRow, type ConnectionRow } from '../channels/core/connection'

const idSchema = z.string().min(1).max(128)
const editableRuleSchema = z.enum(['is', 'contains', 'starts_with', 'word_match', 'does_not_contain', 'thumbs_up', 'any'])
export const triggerPatchSchema = z.object({
  enabled: z.boolean().optional(),
  state: z.enum(['active', 'draft', 'initial']).optional(),
  repeat_mode: z.enum(['once', 'every_time', 'once_per_24_hours']).optional(),
  keyword_id: idSchema.optional(),
  words: z.array(z.string().trim().min(1).max(500)).max(10).optional(),
  rule: editableRuleSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (input.enabled !== undefined && input.state !== undefined && input.enabled !== (input.state === 'active')) ctx.addIssue({ code: 'custom', message: 'Estado e ativação incompatíveis.' })
  const changesKeyword = input.words !== undefined || input.rule !== undefined
  if (input.enabled === undefined && input.state === undefined && input.repeat_mode === undefined && !changesKeyword) ctx.addIssue({ code: 'custom', message: 'Informe uma alteração.' })
  if (changesKeyword && !input.keyword_id) ctx.addIssue({ code: 'custom', path: ['keyword_id'], message: 'Informe a regra a editar.' })
  if (input.keyword_id && !changesKeyword) ctx.addIssue({ code: 'custom', path: ['keyword_id'], message: 'Informe palavras ou regra.' })
})
export type TriggerPatch = z.infer<typeof triggerPatchSchema>
export type AutomationKeywordTrigger = {
  id: string; workspace_id: string; automation_id: string; channel_id: string | null;
  channel_type: ChannelType | null; node_id: string | null; name: string; type: 'dm_keyword'; enabled: boolean;
  state: 'active' | 'draft' | 'initial'; repeat_mode: 'once' | 'every_time' | 'once_per_24_hours';
  keywords: Keyword[]; created_at: string; updated_at: string
  audience: 'direct' | 'group'; group_match: 'keyword' | 'mention' | null; group_thread_id: string | null; group_subject: string | null
}

async function triggerRows(db: D1Database, workspaceId: string, automationId: string, triggerId?: string) {
  return db.prepare(`SELECT t.*, a.draft_graph AS automation_graph, c.type AS channel_type, g.subject AS group_subject FROM triggers t
    JOIN automations a ON a.workspace_id=t.workspace_id AND a.id=t.automation_id
    LEFT JOIN channels c ON c.workspace_id=t.workspace_id AND c.id=t.channel_id
    LEFT JOIN group_threads g ON g.workspace_id=t.workspace_id AND g.id=t.group_thread_id
    WHERE t.workspace_id=? AND t.automation_id=? AND t.kind='keyword' AND t.status<>'disabled' AND a.deleted_at IS NULL
      ${triggerId === undefined ? '' : 'AND t.id=?'} ORDER BY t.created_at,t.id`)
    .bind(workspaceId, automationId, ...(triggerId === undefined ? [] : [triggerId])).all<Row>()
}

function present(row: Row, keywords: Keyword[]): AutomationKeywordTrigger {
  const config = JSON.parse(String(row.config)) as Record<string, unknown>
  const graph = JSON.parse(String(row.automation_graph)) as { nodes: { id: string; type: string }[] }
  return {
    id: String(row.id), workspace_id: String(row.workspace_id), automation_id: String(row.automation_id),
    channel_id: row.channel_id as string | null, channel_type: row.channel_type as ChannelType | null,
    node_id: typeof config.node_id === 'string' ? config.node_id : graph.nodes.find(node => ['trigger', 'starting_step'].includes(node.type))?.id ?? null,
    name: String(row.name), type: 'dm_keyword', enabled: row.status === 'active', keywords,
    state: row.status === 'active' ? 'active' : row.status === 'initial' ? 'initial' : 'draft',
    repeat_mode: row.repeat_mode as AutomationKeywordTrigger['repeat_mode'],
    created_at: new Date(Number(row.created_at)).toISOString(), updated_at: new Date(Number(row.updated_at)).toISOString(),
    audience: row.audience === 'group' ? 'group' : 'direct', group_match: (row.group_match as 'keyword' | 'mention' | null) ?? null,
    group_thread_id: (row.group_thread_id as string | null) ?? null, group_subject: (row.group_subject as string | null) ?? null,
  }
}

export async function listAutomationTriggers(db: D1Database, workspaceId: string, automationId: string): Promise<{ rows: AutomationTriggerRow[] }> {
  assertWorkspace(workspaceId)
  // Checagem da automação e as cinco famílias de gatilho saem numa onda só; a checagem continua barrando antes de qualquer linha sair.
  const exists = db.prepare('SELECT id FROM automations WHERE workspace_id=? AND id=? AND deleted_at IS NULL').bind(workspaceId, automationId).first<Row>()
  const loaded = Promise.all([
    triggerRows(db, workspaceId, automationId),
    db.prepare(`SELECT k.* FROM keywords k JOIN triggers t ON t.workspace_id=k.workspace_id AND t.id=k.trigger_id
      WHERE k.workspace_id=? AND t.automation_id=? AND t.kind='keyword' ORDER BY k.priority,k.id`)
      .bind(workspaceId, automationId).all<Row>(),
    commentTriggerRows(db, workspaceId, automationId), storyTriggerRows(db, workspaceId, automationId),
    refTriggerRows(db, workspaceId, automationId), externalTriggerRows(db, workspaceId, automationId),
  ])
  loaded.catch(() => undefined)
  requireRow(await exists)
  const [triggers, keywords, comments, stories, refs, externals] = await loaded
  return { rows: [...triggers.results.map(row => present(row, keywords.results
    .filter(keyword => keyword.trigger_id === row.id).map(keyword => decode<Keyword>(keyword)))), ...comments, ...stories, ...refs, ...externals] }
}

export async function updateAutomationTrigger(db: D1Database, workspaceId: string, automationId: string,
  triggerId: string, value: TriggerPatch): Promise<AutomationKeywordTrigger> {
  assertWorkspace(workspaceId)
  const input = triggerPatchSchema.parse(value)
  const trigger = requireRow((await triggerRows(db, workspaceId, automationId, triggerId)).results[0] ?? null)
  const now = Date.now()
  const statements: D1PreparedStatement[] = []
  if (input.keyword_id) {
    const keyword = requireRow(await db.prepare('SELECT * FROM keywords WHERE workspace_id=? AND trigger_id=? AND id=?')
      .bind(workspaceId, triggerId, input.keyword_id).first<Row>())
    const rule = input.rule ?? keyword.rule
    const words = input.words ?? JSON.parse(String(keyword.words)) as string[]
    if (keyword.parent_id || keyword.rule === 'group') {
      throw new RepositoryError('Esta regra não pode ser editada neste painel.', 400)
    }
    editableRuleSchema.parse(rule)
    if (rule !== 'any' && rule !== 'thumbs_up' && words.length === 0) throw new RepositoryError('A regra exige ao menos uma palavra.', 400)
    statements.push(db.prepare(`UPDATE keywords SET words=?,rule=?,updated_at=? WHERE workspace_id=? AND trigger_id=? AND id=?`)
      .bind(JSON.stringify(rule === 'thumbs_up' ? [] : words), rule, now, workspaceId, triggerId, input.keyword_id))
  }
  const state = input.state ?? (input.enabled === undefined ? null : input.enabled ? 'active' : 'draft')
  // Restoring/duplicating an automation intentionally leaves its keyword rules as drafts.
  // Explicitly enabling its trigger is the user's opt-in to making those rules live again.
  if (state === 'active') statements.push(db.prepare(`UPDATE keywords SET status='live',updated_at=?
    WHERE workspace_id=? AND trigger_id=? AND EXISTS (SELECT 1 FROM triggers t JOIN automations a
      ON a.workspace_id=t.workspace_id AND a.id=t.automation_id WHERE t.workspace_id=keywords.workspace_id
      AND t.id=keywords.trigger_id AND t.status<>'active' AND a.deleted_at IS NULL)`).bind(now, workspaceId, triggerId))
  if (state === 'active') {
    const config = JSON.parse(String(trigger.config)) as Record<string, unknown>
    const published = await db.prepare(`SELECT v.graph FROM automations a JOIN automation_versions v
      ON v.workspace_id=a.workspace_id AND v.automation_id=a.id AND v.id=a.published_version_id
      WHERE a.workspace_id=? AND a.id=? AND a.deleted_at IS NULL`)
      .bind(workspaceId, automationId).first<{ graph: string }>()
    // A trigger on a never-published automation would be "active" yet run nothing.
    if (!published) throw new RepositoryError('Publique a automação antes de ativar este gatilho.', 409)
    if (typeof config.node_id === 'string' && !(JSON.parse(published.graph) as { nodes: { id: string }[] }).nodes.some(node => node.id === config.node_id)) {
      throw new RepositoryError('Publique o rascunho antes de ativar este gatilho.', 409)
    }
  }
  statements.push(db.prepare(`UPDATE triggers SET status=coalesce(?,status),repeat_mode=coalesce(?,repeat_mode),
    updated_at=? WHERE workspace_id=? AND automation_id=? AND id=? AND EXISTS (
      SELECT 1 FROM automations a WHERE a.workspace_id=triggers.workspace_id AND a.id=triggers.automation_id AND a.deleted_at IS NULL)`)
    .bind(state, input.repeat_mode ?? null, now, workspaceId, automationId, triggerId))
  await db.batch(statements)
  return requireRow((await listAutomationTriggers(db, workspaceId, automationId)).rows.find((row): row is AutomationKeywordTrigger => row.type === 'dm_keyword' && row.id === triggerId) ?? null)
}

export const triggerCreateSchema = z.object({
  name: z.string().trim().min(1).max(100), connection_id: idSchema, node_id: idSchema,
  words: z.array(z.string().trim().min(1).max(500)).max(10), rule: editableRuleSchema,
}).strict().refine(input => input.rule === 'any' || input.rule === 'thumbs_up' || input.words.length > 0,
  { message: 'A regra exige ao menos uma palavra.', path: ['words'] })
export type TriggerCreate = z.infer<typeof triggerCreateSchema>

export async function createAutomationTrigger(db: D1Database, workspaceId: string, automationId: string,
  value: TriggerCreate): Promise<AutomationKeywordTrigger> {
  assertWorkspace(workspaceId)
  const input = triggerCreateSchema.parse(value)
  const automation = requireRow(await db.prepare('SELECT draft_graph FROM automations WHERE workspace_id=? AND id=? AND deleted_at IS NULL')
    .bind(workspaceId, automationId).first<{ draft_graph: string }>())
  const graph = JSON.parse(automation.draft_graph) as { nodes: { id: string; type: string }[] }
  if (!graph.nodes.some(node => node.id === input.node_id && node.type === 'trigger')) throw new RepositoryError('Escolha um passo de gatilho desta automação.', 400)
  const row = requireRow(await db.prepare(`SELECT ${connectionColumns} FROM channels WHERE workspace_id=? AND id=? AND archived_at IS NULL`)
    .bind(workspaceId, input.connection_id).first<ConnectionRow>())
  const connection = connectionFromRow(row)
  if (connection.status !== 'connected' || !connection.profile.inbound.message) throw new RepositoryError('Esta conexão não aceita gatilhos de mensagem ou está desconectada.', 400)
  const id = crypto.randomUUID(), now = Date.now()
  await db.batch([
    db.prepare(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config,created_at,updated_at)
      VALUES (?,?,?,?,?,'keyword','initial','every_time',?,?,?)`)
      .bind(id, workspaceId, automationId, input.connection_id, input.name, JSON.stringify({ node_id: input.node_id }), now, now),
    // The trigger state is the switch. The keyword is ready when that trigger is activated.
    db.prepare(`INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority,created_at,updated_at)
      VALUES (?,?,?,?,?,'live',${nextKeywordPrioritySql},?,?)`)
      .bind(crypto.randomUUID(), workspaceId, id, input.rule, JSON.stringify(input.rule === 'thumbs_up' ? [] : [...new Set(input.words)]), workspaceId, now, now),
  ])
  return requireRow((await listAutomationTriggers(db, workspaceId, automationId)).rows.find((trigger): trigger is AutomationKeywordTrigger => trigger.type === 'dm_keyword' && trigger.id === id) ?? null)
}
