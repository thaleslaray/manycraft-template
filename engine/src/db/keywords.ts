import { z } from "zod"
import { channelKinds } from "../channels/types"
import { connectionColumns, connectionFromRow, type ConnectionRow } from "../channels/core/connection"
import { assertWorkspace, decode, RepositoryError, requireRow, type Row } from "./shared"
import { effectiveStateSql } from "../channels/core/connection-state"

const keywordInputSchema = z.object({
  id: z.string().min(1).optional(), trigger_id: z.string().min(1), parent_id: z.string().min(1).nullable().optional(),
  rule: z.enum(["is", "contains", "starts_with", "word_match", "does_not_contain", "group", "thumbs_up", "any"]),
  words: z.array(z.string().trim().min(1).max(500)).max(10), status: z.enum(["live", "draft"]).optional(),
  case_sensitive: z.boolean().optional(), is_reserved: z.boolean().optional(), priority: z.number().int(),
}).refine(input => ["group", "thumbs_up", "any"].includes(input.rule) || input.words.length > 0,
  { message: "A regra exige ao menos uma palavra.", path: ["words"] })
export type KeywordInput = z.infer<typeof keywordInputSchema>
export type Keyword = Omit<KeywordInput, "id" | "parent_id" | "status" | "case_sensitive" | "is_reserved"> & {
  id: string; workspace_id: string; parent_id: string | null; status: "live" | "draft";
  case_sensitive: boolean; is_reserved: boolean; created_at: string; updated_at: string
}

export async function listKeywords(db: D1Database, workspaceId: string): Promise<Keyword[]> {
  assertWorkspace(workspaceId)
  const rows = await db.prepare("SELECT * FROM keywords WHERE workspace_id = ? ORDER BY priority, id").bind(workspaceId).all<Row>()
  return rows.results.map(row => decode<Keyword>(row))
}

export async function getKeyword(db: D1Database, workspaceId: string, id: string): Promise<Keyword | null> {
  assertWorkspace(workspaceId)
  const row = await db.prepare("SELECT * FROM keywords WHERE workspace_id = ? AND id = ?").bind(workspaceId, id).first<Row>()
  return row ? decode<Keyword>(row) : null
}

export async function saveKeyword(db: D1Database, workspaceId: string, value: KeywordInput): Promise<Keyword> {
  assertWorkspace(workspaceId)
  const input = keywordInputSchema.parse(value)
  if (input.id) requireRow(await getKeyword(db, workspaceId, input.id))
  // Join the automation and channel as well: a child must never be used to
  // bridge tenant boundaries, even when presented with a known foreign ID.
  const trigger = await db.prepare(`SELECT t.id FROM triggers t JOIN automations a ON a.workspace_id = t.workspace_id AND a.id = t.automation_id
    LEFT JOIN channels c ON c.workspace_id = t.workspace_id AND c.id = t.channel_id
    WHERE t.workspace_id = ? AND t.id = ? AND a.deleted_at IS NULL AND (t.channel_id IS NULL OR c.id IS NOT NULL)`)
    .bind(workspaceId, input.trigger_id).first<Row>()
  requireRow(trigger)
  if (input.parent_id) {
    const parent = requireRow(await getKeyword(db, workspaceId, input.parent_id))
    if (parent.trigger_id !== input.trigger_id || parent.rule !== "group" || parent.parent_id || parent.id === input.id || input.rule === "group") {
      throw new RepositoryError("Grupo de palavras inválido.", 400)
    }
  }
  const id = input.id ?? crypto.randomUUID()
  const now = Date.now()
  const args = [input.trigger_id, input.parent_id ?? null, input.rule, JSON.stringify(input.words), input.status ?? "draft",
    Number(input.case_sensitive ?? false), Number(input.is_reserved ?? false), input.priority, now]
  const row = input.id
    ? await db.prepare(`UPDATE keywords SET trigger_id = ?, parent_id = ?, rule = ?, words = ?, status = ?, case_sensitive = ?,
        is_reserved = ?, priority = ?, updated_at = ? WHERE workspace_id = ? AND id = ? RETURNING *`)
      .bind(...args, workspaceId, id).first<Row>()
    : await db.prepare(`INSERT INTO keywords (trigger_id, parent_id, rule, words, status, case_sensitive, is_reserved, priority,
        updated_at, workspace_id, id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
      .bind(...args, workspaceId, id, now).first<Row>()
  return decode<Keyword>(requireRow(row))
}

export async function deleteKeyword(db: D1Database, workspaceId: string, id: string): Promise<{ ok: true }> {
  assertWorkspace(workspaceId)
  const result = await db.prepare("DELETE FROM keywords WHERE workspace_id = ? AND id = ?").bind(workspaceId, id).run()
  if (!result.meta.changes) throw new RepositoryError()
  return { ok: true }
}

const conditions = {
  contains: 'contains', equals: 'is', word: 'word_match', starts: 'starts_with', not_contains: 'does_not_contain', thumbs_up: 'thumbs_up',
} as const
type KeywordCondition = keyof typeof conditions
const conditionFor = Object.fromEntries(Object.entries(conditions).map(([condition, rule]) => [rule, condition])) as Record<string, KeywordCondition>
const keywordRuleSchema = z.object({
  condition: z.enum(['contains', 'equals', 'word', 'starts', 'not_contains', 'thumbs_up']),
  words: z.array(z.string().trim().min(1).max(500)).max(10),
}).strict().superRefine((rule, ctx) => {
  // Curtir não usa palavras; as demais exigem ao menos uma.
  if (rule.condition !== 'thumbs_up' && !rule.words.length) ctx.addIssue({ code: 'custom', path: ['words'], message: 'A regra exige ao menos uma palavra.' })
})
const keywordRuleFields = z.object({
  name: z.string().trim().min(1).max(200),
  channel: z.enum(channelKinds).exclude(['email']),
  automation_id: z.string().min(1).max(128), active: z.boolean(),
  rules: z.array(keywordRuleSchema).max(2),
  priority: z.number().int().nonnegative().optional(),
  // Group triggers (F6): the connection the group belongs to, "palavra" or "mencionado", and optionally one group (none = every group of the connection).
  audience: z.enum(['direct', 'group']).optional(),
  group_match: z.enum(['keyword', 'mention']).nullish(),
  connection_id: z.string().min(1).max(128).nullish(),
  group_thread_id: z.string().min(1).max(128).nullish(),
}).strict()
function validateKeywordRules(input: z.infer<typeof keywordRuleFields>, ctx: z.RefinementCtx) {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message })
  if (input.audience === 'group') {
    if (!input.group_match) issue('group_match', 'Escolha palavra ou só quando mencionado.')
    if (!input.connection_id) issue('connection_id', 'Escolha a conexão do grupo.')
  } else if (input.audience === 'direct' && (input.group_match || input.group_thread_id)) issue('audience', 'Modo e grupo só valem para gatilho de grupo.')
  // Only "mentioned" may go without words: any message that mentions the account then fires.
  if (!input.rules.length && !(input.audience === 'group' && input.group_match === 'mention')) issue('rules', 'Informe ao menos uma regra.')
}
export const keywordRuleInputSchema = keywordRuleFields.superRefine(validateKeywordRules)
export const keywordAutomationInputSchema = keywordRuleFields.omit({ automation_id: true, active: true })
  .extend({ keyword_id: z.string().min(1).max(128).optional() })
  .superRefine((input, ctx) => validateKeywordRules({ ...input, automation_id: 'new', active: false }, ctx))
export const keywordPrioritySchema = z.object({ target: z.number().int().nonnegative() }).strict()
export const keywordActiveSchema = z.object({ active: z.boolean() }).strict()
/** Só para a documentação: PATCH /keywords/:id aceita `{ active }` ou a regra inteira; o handler tenta um e depois o outro. */
export const keywordPatchSchema = z.union([keywordActiveSchema, keywordRuleInputSchema])
export type KeywordAutomationInput = z.infer<typeof keywordAutomationInputSchema>
export type KeywordRuleInput = z.infer<typeof keywordRuleInputSchema>
export type ManagedKeyword = Omit<KeywordRuleInput, 'priority' | 'audience' | 'group_match' | 'connection_id' | 'group_thread_id'> & { id: string; priority: number
  audience: 'direct' | 'group'; group_match: 'keyword' | 'mention' | null; connection_id: string | null; group_thread_id: string | null }

/** The panel edits the same rows consumed by flow/dispatch; groups require all children. */
async function managedKeywordRows(db: D1Database, workspaceId: string, id?: string) {
  assertWorkspace(workspaceId)
  return db.prepare(`SELECT k.*,t.name,t.channel_id,t.audience,t.group_match,t.group_thread_id,t.automation_id,t.status AS trigger_status,
      t.config AS trigger_config,c.type AS channel FROM keywords k
    JOIN triggers t ON t.workspace_id=k.workspace_id AND t.id=k.trigger_id
    JOIN automations a ON a.workspace_id=t.workspace_id AND a.id=t.automation_id
    LEFT JOIN channels c ON c.workspace_id=t.workspace_id AND c.id=t.channel_id
    WHERE k.workspace_id=? AND k.parent_id IS NULL AND t.kind='keyword' AND a.deleted_at IS NULL
      ${id === undefined ? '' : 'AND k.id=?'} ORDER BY k.priority,t.created_at,t.id,k.id`)
    .bind(workspaceId, ...(id === undefined ? [] : [id])).all<Row>()
}

async function presentKeywordRule(db: D1Database, workspaceId: string, row: Row): Promise<ManagedKeyword> {
  const children = row.rule === 'group' ? (await db.prepare(`SELECT * FROM keywords
    WHERE workspace_id=? AND parent_id=? AND trigger_id=? ORDER BY priority,id`)
    .bind(workspaceId, row.id, row.trigger_id).all<Row>()).results : [row]
  return {
    id: String(row.id), name: String(row.name), channel: String(row.channel) as ManagedKeyword['channel'],
    automation_id: String(row.automation_id), priority: Number(row.priority),
    active: row.status === 'live' && row.trigger_status === 'active',
    rules: children.filter(child => child.rule !== 'any').map(child => ({ condition: conditionFor[String(child.rule)], words: JSON.parse(String(child.words)) as string[] })),
    audience: row.audience === 'group' ? 'group' : 'direct', group_match: (row.group_match as 'keyword' | 'mention' | null) ?? null,
    connection_id: row.channel_id as string | null, group_thread_id: (row.group_thread_id as string | null) ?? null,
  }
}

export async function listKeywordRules(db: D1Database, workspaceId: string): Promise<ManagedKeyword[]> {
  const rows = await managedKeywordRows(db, workspaceId)
  return Promise.all(rows.results.map(row => presentKeywordRule(db, workspaceId, row)))
}

export async function getKeywordRule(db: D1Database, workspaceId: string, id: string): Promise<ManagedKeyword | null> {
  const row = (await managedKeywordRows(db, workspaceId, id)).results[0]
  return row ? presentKeywordRule(db, workspaceId, row) : null
}

export async function saveKeywordRule(db: D1Database, workspaceId: string, value: KeywordRuleInput, id?: string): Promise<ManagedKeyword> {
  return writeKeywordRule(db, workspaceId, value, id)
}

/** The draft and its paused rule are committed together; a failed validation leaves neither behind. */
export async function createKeywordAutomation(db: D1Database, workspaceId: string, value: KeywordAutomationInput): Promise<ManagedKeyword> {
  const { keyword_id, ...input } = keywordAutomationInputSchema.parse(value)
  return writeKeywordRule(db, workspaceId, { ...input, automation_id: crypto.randomUUID(), active: false }, keyword_id, true)
}

async function writeKeywordRule(db: D1Database, workspaceId: string, value: KeywordRuleInput, id?: string, createAutomation = false): Promise<ManagedKeyword> {
  assertWorkspace(workspaceId)
  const input = keywordRuleInputSchema.parse(value)
  const existing = id ? requireRow((await managedKeywordRows(db, workspaceId, id)).results[0] ?? null) : null
  if (existing?.is_reserved) throw new RepositoryError('Esta palavra é reservada para o canal.', 400)
  const automation = createAutomation ? { id: input.automation_id } : requireRow(await db.prepare(`SELECT a.id FROM automations a
    LEFT JOIN automation_versions v ON v.workspace_id=a.workspace_id AND v.automation_id=a.id AND v.id=a.published_version_id
    WHERE a.workspace_id=? AND a.id=? AND a.deleted_at IS NULL AND (v.id IS NOT NULL OR ?=0)`)
    .bind(workspaceId, input.automation_id, Number(input.active)).first<Row>())
  // A group trigger inherits what the edit leaves out; a direct one never carries group fields.
  const audience = input.audience ?? (existing?.audience === 'group' ? 'group' : 'direct')
  const inherit = input.audience === undefined && audience === 'group'
  const groupMatch = audience === 'group' ? input.group_match ?? (inherit ? existing?.group_match as 'keyword' | 'mention' | null : null) : null
  const connectionId = input.connection_id ?? (existing && input.channel === existing.channel ? existing.channel_id as string : null)
  let groupThreadId = audience === 'group' ? input.group_thread_id === undefined && inherit ? existing?.group_thread_id as string | null : input.group_thread_id ?? null : null
  if (audience === 'group' && (!groupMatch || !connectionId)) throw new RepositoryError('Escolha o modo e a conexão do grupo.', 400)
  if (audience === 'group' && !input.rules.length && groupMatch !== 'mention') throw new RepositoryError('Informe ao menos uma regra.', 400)
  const channel = connectionId
    ? await db.prepare(`SELECT ${connectionColumns} FROM channels WHERE workspace_id=? AND id=? AND type=? AND archived_at IS NULL`).bind(workspaceId, connectionId, input.channel).first<ConnectionRow>()
    : (await db.prepare(`SELECT ${connectionColumns} FROM channels WHERE workspace_id=? AND type=? AND archived_at IS NULL
    ORDER BY CASE WHEN ${effectiveStateSql()}='connected' THEN 0 ELSE 1 END,id`)
    .bind(workspaceId, input.channel).all<ConnectionRow>()).results.find(row => connectionFromRow(row).profile.inbound.message)
  if (connectionId && !channel) throw new RepositoryError('Conexão não encontrada.', 404)
  if (!channel) throw new RepositoryError('Conecte este canal antes de criar a palavra-chave.', 400)
  if (!connectionFromRow(channel as ConnectionRow).profile.inbound.message) throw new RepositoryError('Esta conexão não recebe mensagens.', 400)
  if (audience === 'group' && !connectionFromRow(channel as ConnectionRow).profile.groups?.reply) throw new RepositoryError('Esta conexão não responde em grupos.', 400)
  if (groupThreadId) requireRow(await db.prepare('SELECT id FROM group_threads WHERE workspace_id=? AND id=? AND channel_id=?').bind(workspaceId, groupThreadId, connectionId).first<Row>())
  // Never rewrite a sibling rule's trigger when importing an existing grouped trigger.
  const sibling = existing ? await db.prepare(`SELECT id FROM keywords WHERE workspace_id=?
    AND trigger_id=? AND parent_id IS NULL AND id<>? LIMIT 1`)
    .bind(workspaceId, existing.trigger_id, existing.id).first<Row>() : null
  const triggerId = existing && !sibling ? String(existing.trigger_id) : crypto.randomUUID()
  const keywordId = id ?? crypto.randomUUID()
  const priority = existing ? Number(existing.priority) : Number(await db.prepare(`SELECT coalesce(max(priority),-1)+1 AS priority
    FROM keywords WHERE workspace_id=? AND parent_id IS NULL`).bind(workspaceId).first('priority'))
  const now = Date.now()
  const statements: D1PreparedStatement[] = []
  if (createAutomation) {
    const graph = { nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 80 }, config: { trigger_id: triggerId } }], edges: [] }
    statements.push(db.prepare('INSERT INTO automations (id,workspace_id,name,draft_graph) VALUES (?,?,?,?)')
      .bind(automation.id, workspaceId, `Resposta a ${input.name}`, JSON.stringify(graph)))
  }
  const config = existing ? JSON.parse(String(existing.trigger_config)) as Record<string, unknown> : {}
  if (existing && existing.automation_id !== input.automation_id) delete config.node_id
  if (createAutomation) config.node_id = 'trigger'
  if (existing && !sibling) {
    statements.push(db.prepare(`UPDATE triggers SET automation_id=?,channel_id=?,name=?,status=?,config=?,updated_at=?,audience=?,group_match=?,group_thread_id=?
      WHERE workspace_id=? AND id=?`).bind(automation.id, channel.id, input.name, input.active ? 'active' : 'inactive',
      JSON.stringify(config), now, audience, groupMatch, groupThreadId, workspaceId, triggerId))
  } else {
    statements.push(db.prepare(`INSERT INTO triggers
      (id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config,created_at,updated_at,audience,group_match,group_thread_id)
      VALUES (?,?,?,?,?,'keyword',?,'every_time',?,?,?,?,?,?)`)
      .bind(triggerId, workspaceId, automation.id, channel.id, input.name, input.active ? 'active' : 'inactive', JSON.stringify(config), now, now, audience, groupMatch, groupThreadId))
  }
  const grouped = input.rules.length > 1
  const rule = grouped ? 'group' : input.rules[0] ? conditions[input.rules[0].condition] : 'any'
  const words = JSON.stringify(grouped || !input.rules[0] || input.rules[0].condition === 'thumbs_up' ? [] : [...new Set(input.rules[0].words)])
  const status = input.active ? 'live' : 'draft'
  if (existing) {
    statements.push(db.prepare('DELETE FROM keywords WHERE workspace_id=? AND parent_id=?').bind(workspaceId, keywordId))
    statements.push(db.prepare(`UPDATE keywords SET trigger_id=?,rule=?,words=?,status=?,updated_at=?
      WHERE workspace_id=? AND id=?`).bind(triggerId, rule, words, status, now, workspaceId, keywordId))
  } else {
    statements.push(db.prepare(`INSERT INTO keywords
      (id,workspace_id,trigger_id,rule,words,status,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(keywordId, workspaceId, triggerId, rule, words, status, priority, now, now))
  }
  if (grouped) for (const [index, child] of input.rules.entries()) {
    statements.push(db.prepare(`INSERT INTO keywords
      (id,workspace_id,trigger_id,parent_id,rule,words,status,case_sensitive,priority,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), workspaceId, triggerId, keywordId, conditions[child.condition],
      JSON.stringify(child.condition === 'thumbs_up' ? [] : [...new Set(child.words)]), status, Number(existing?.case_sensitive ?? false), index, now, now))
  }
  await db.batch(statements)
  return requireRow(await getKeywordRule(db, workspaceId, keywordId))
}

export async function setKeywordRuleActive(db: D1Database, workspaceId: string, id: string, active: boolean): Promise<ManagedKeyword> {
  z.boolean().parse(active)
  const row = requireRow((await managedKeywordRows(db, workspaceId, id)).results[0] ?? null)
  if (row.is_reserved) throw new RepositoryError('Esta palavra é reservada para o canal.', 400)
  if (active && !await db.prepare(`SELECT v.id FROM automations a JOIN automation_versions v
    ON v.workspace_id=a.workspace_id AND v.automation_id=a.id AND v.id=a.published_version_id
    WHERE a.workspace_id=? AND a.id=? AND a.deleted_at IS NULL`).bind(workspaceId, row.automation_id).first()) {
    throw new RepositoryError('Publique a automação antes de ativar a regra.', 409)
  }
  await db.batch([
    db.prepare(`UPDATE keywords SET status=?,updated_at=? WHERE workspace_id=? AND (id=? OR parent_id=?)`)
      .bind(active ? 'live' : 'draft', Date.now(), workspaceId, id, id),
    // Disabling one rule never disables another rule sharing its trigger.
    db.prepare(`UPDATE triggers SET status=CASE WHEN EXISTS(SELECT 1 FROM keywords
      WHERE workspace_id=? AND trigger_id=? AND parent_id IS NULL AND status='live') THEN 'active' ELSE 'inactive' END,
      updated_at=? WHERE workspace_id=? AND id=?`)
      .bind(workspaceId, row.trigger_id, Date.now(), workspaceId, row.trigger_id),
  ])
  return requireRow(await getKeywordRule(db, workspaceId, id))
}

export async function moveKeywordRule(db: D1Database, workspaceId: string, id: string, target: number): Promise<ManagedKeyword[]> {
  z.number().int().nonnegative().parse(target)
  const rows = await listKeywordRules(db, workspaceId)
  const index = rows.findIndex(row => row.id === id)
  if (index < 0) throw new RepositoryError()
  if (target >= rows.length) throw new RepositoryError('Prioridade fora da lista.', 400)
  rows.splice(target, 0, rows.splice(index, 1)[0]!)
  await db.batch(rows.map((row, priority) => db.prepare('UPDATE keywords SET priority=?,updated_at=? WHERE workspace_id=? AND id=?')
    .bind(priority, Date.now(), workspaceId, row.id)))
  return listKeywordRules(db, workspaceId)
}

export async function deleteKeywordRule(db: D1Database, workspaceId: string, id: string): Promise<{ ok: true }> {
  const row = requireRow((await managedKeywordRows(db, workspaceId, id)).results[0] ?? null)
  if (row.is_reserved) throw new RepositoryError('Esta palavra é reservada para o canal.', 400)
  await db.batch([
    db.prepare('DELETE FROM keywords WHERE workspace_id=? AND id=?').bind(workspaceId, id),
    db.prepare(`UPDATE triggers SET status='inactive',updated_at=? WHERE workspace_id=? AND id=?
      AND NOT EXISTS(SELECT 1 FROM keywords WHERE workspace_id=? AND trigger_id=? AND status='live')`)
      .bind(Date.now(), workspaceId, row.trigger_id, workspaceId, row.trigger_id),
  ])
  return { ok: true }
}
