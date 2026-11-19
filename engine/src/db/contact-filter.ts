import { z } from 'zod'
import type { ContactQueryFilter, FilterOperator } from '../../../shared/contact-filter'
import type { ChannelKind, ProfilePatch, StoredProvider } from '../channels/contract'
import { effectiveProfile } from '../channels/core/profile-merge'
import { channelKinds } from '../channels/types'
import type { Contact, ContactPage } from '../contracts'
import { validateFieldValue } from './fields'
import { assertWorkspace, decode, RepositoryError, requireRow, type Row } from './shared'
import { withTagsAndFields } from './contacts'
import { contactTextFields, type ContactTextField } from '../schemas/system-fields'
import { textFieldClause } from './system-text-clause'

const id = z.string().min(1).max(128)
const operator = z.enum(['equals','not_equals','contains','not_contains','starts_with','is_set','is_not_set','gt','gte','lt','lte','within_last_days'])
export const contactQueryFilterSchema = z.object({ match: z.enum(['all','any']), rules: z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('tag'), tag_id: id, operator: z.enum(['has','not_has']) }).strict(),
  z.object({ type: z.literal('field'), field_id: id, operator, value: z.unknown().optional(), case_sensitive: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('system'), field: z.enum(['first_name','last_name','status','gender','subscribed_at','last_interaction_at','phone','locale','timezone','last_input_text','contact_id']), operator, value: z.unknown().optional(), case_sensitive: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('connection'), connection_id: id, operator: z.enum(['in_connection','not_in_connection']) }).strict(),
  z.object({ type: z.literal('window24'), connection_id: id, operator: z.enum(['inside','outside','follow_up_eligible','outside_24_plus_1']) }).strict(),
  z.object({ type: z.literal('channel'), channel: z.enum(channelKinds), operator: z.enum(['subscribed','not_subscribed']) }).strict(),
  z.object({ type: z.literal('entry_trigger'), trigger_id: id, operator: z.enum(['entered_by','not_entered_by']) }).strict(),
])).max(30) }).strict()
export type SqlFilter = { sql: string; values: (string | number | null)[] }
type ConnectionRow = { id: string; label: string; type: ChannelKind; provider: StoredProvider; capabilities_override: string | null }
function isWindow24(row: ConnectionRow) {
  const patch = row.capabilities_override ? JSON.parse(row.capabilities_override) as ProfilePatch : undefined
  return effectiveProfile(row.type, row.provider, patch).window?.standardHours === 24
}
/** Todas as contas conectadas do espaço (as arquivadas ficam de fora), com o tipo do canal, para o filtro "Conta conectada". */
export async function filterAccounts(db: D1Database, workspace: string) {
  const rows = await db.prepare('SELECT id,coalesce(display_name,id) AS label,type AS channel FROM channels WHERE workspace_id=? AND archived_at IS NULL ORDER BY type,label,id')
    .bind(workspace).all<{ id: string; label: string; channel: string }>()
  return rows.results
}
export async function filterConnections(db: D1Database, workspace: string) {
  const rows = await db.prepare("SELECT id,coalesce(display_name,id) AS label,type,provider,capabilities_override FROM channels WHERE workspace_id=? AND status='connected' ORDER BY label,id")
    .bind(workspace).all<ConnectionRow>()
  return rows.results.filter(isWindow24).map(({ id, label }) => ({ id, label }))
}

function comparison(expression: string, type: string, op: FilterOperator, value: unknown, now: number, caseSensitive = false): SqlFilter {
  const permitted: string[] = ['equals','not_equals','is_set','is_not_set', ...(type === 'text' || type === 'array' ? ['contains','not_contains'] : []),
    ...(['number','date','datetime'].includes(type) ? ['gt','gte','lt','lte'] : []), ...(['date','datetime'].includes(type) ? ['within_last_days'] : [])]
  if (!permitted.includes(op)) throw new RepositoryError('A comparação não é compatível com o tipo do campo.', 400)
  if (op === 'starts_with') throw new RepositoryError('A comparação não é compatível com o tipo do campo.', 400)
  if (op === 'is_set' || op === 'is_not_set') return { sql: `${expression} IS ${op === 'is_set' ? 'NOT ' : ''}NULL`, values: [] }
  if (op === 'within_last_days') {
    const days = z.number().int().min(1).max(36500).parse(value)
    return { sql: `${expression} >= ? AND ${expression} <= ?`, values: [now - days * 86400000, now] }
  }
  // Lista: contém / não contém um item (o valor é um item da lista, não a lista).
  if (type === 'array' && (op === 'contains' || op === 'not_contains')) {
    const item = z.union([z.string().max(1000), z.number().finite()]).parse(value)
    return { sql: `${op === 'not_contains' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM json_each(${expression.replace(/json_extract\(([^,]+),'\$'\)/, '$1')}) j WHERE j.value = ?)`, values: [item] }
  }
  if (type === 'text' && op === 'not_contains') {
    const text = z.string().max(1000).parse(value)
    return caseSensitive ? { sql: `instr(coalesce(${expression},''),?) = 0`, values: [text] } : { sql: `instr(lower(coalesce(${expression},'')),lower(?)) = 0`, values: [text] }
  }
  // Texto ignora maiúsculas por padrão (como o construtor da ManyChat); a opção diferencia.
  if (type === 'text' && !caseSensitive && (op === 'contains' || op === 'equals' || op === 'not_equals')) {
    const text = z.string().max(1000).parse(value)
    return op === 'contains' ? { sql: `instr(lower(${expression}),lower(?)) > 0`, values: [text] } : { sql: `lower(${expression}) ${op === 'equals' ? '=' : '<>'} lower(?)`, values: [text] }
  }
  validateFieldValue(type, value)
  const scalar = type === 'date' || type === 'datetime' ? Date.parse(value as string)
    : typeof value === 'boolean' ? Number(value) : type === 'array' ? JSON.stringify(value) : value as string | number
  if (op === 'contains') return { sql: `instr(${expression},?) > 0`, values: [scalar] }
  if (op === 'not_contains') return { sql: `instr(coalesce(${expression},''),?) = 0`, values: [scalar] }
  const operators = { equals: '=', not_equals: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }
  return { sql: `${expression} ${operators[op]} ?`, values: [scalar] }
}

/** Produces a bounded, parameterized predicate over contacts alias c. No contact list is materialized. */
export async function compileContactFilter(db: D1Database, workspace: string, raw: unknown, now = Date.now()): Promise<SqlFilter> {
  assertWorkspace(workspace)
  const filter: ContactQueryFilter = contactQueryFilterSchema.parse(raw)
  // As conferências de existência (tag, campo, conexão, gatilho) saem todas juntas: uma ida só, qualquer que seja o número de regras.
  const parts: SqlFilter[] = await Promise.all(filter.rules.map(async (rule): Promise<SqlFilter> => {
    if (rule.type === 'tag') {
      requireRow(await db.prepare('SELECT id FROM tags WHERE workspace_id=? AND id=?').bind(workspace, rule.tag_id).first())
      return ({ sql: `${rule.operator === 'not_has' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.workspace_id=c.workspace_id AND ct.contact_id=c.id AND ct.tag_id=?)`, values: [rule.tag_id] })
    } else if (rule.type === 'field') {
      const field = requireRow(await db.prepare("SELECT type FROM custom_fields WHERE workspace_id=? AND id=? AND scope='contact'")
        .bind(workspace, rule.field_id).first<{ type: string }>())
      const value = ['date','datetime'].includes(field.type) ? "unixepoch(json_extract(v.value,'$'),'subsec')*1000" : "json_extract(v.value,'$')"
      const negated = rule.operator === 'not_equals' || (rule.operator === 'not_contains')
      const clause = comparison(value, field.type, rule.operator === 'not_equals' ? 'equals' : rule.operator === 'not_contains' ? 'contains' : rule.operator, rule.value, now, rule.case_sensitive)
      const missing = rule.operator === 'is_not_set' || negated
      // Missing fields also satisfy "different", matching the condition engine's null semantics.
      return ({ sql: `${missing ? 'NOT ' : ''}EXISTS (SELECT 1 FROM contact_field_values v WHERE v.workspace_id=c.workspace_id AND v.contact_id=c.id AND v.field_id=? AND (${rule.operator === 'is_not_set' ? `${value} IS NOT NULL` : clause.sql}))`, values: [rule.field_id, ...clause.values] })
    } else if (rule.type === 'system' && rule.field in contactTextFields) {
      // Mesma regra do passo Condição do fluxo.
      const values: (string | number | null)[] = []
      return ({ sql: textFieldClause(rule.field as ContactTextField, rule.operator, rule.value, values), values })
    } else if (rule.type === 'system') {
      if (rule.field === 'status') {
        z.enum(['equals','not_equals']).parse(rule.operator)
        z.enum(['subscribed','unsubscribed']).parse(rule.value)
      }
      // Gênero só compara "é" (a ManyChat não oferece "não é"); sem valor também vale.
      if (rule.field === 'gender') z.enum(['equals','is_set','is_not_set']).parse(rule.operator)
      const type = rule.field.endsWith('_at') ? 'datetime' : 'text'
      const clause = comparison(`c.${rule.field}`, type, rule.operator, rule.value, now, rule.case_sensitive)
      return (rule.operator === 'not_equals' ? { sql: `(c.${rule.field} IS NULL OR (${clause.sql}))`, values: clause.values } : clause)
    } else if (rule.type === 'entry_trigger') {
      requireRow(await db.prepare('SELECT id FROM triggers WHERE workspace_id=? AND id=?').bind(workspace, rule.trigger_id).first())
      return ({ sql: `${rule.operator === 'not_entered_by' ? 'coalesce(c.optin_source,\'\') <> ?' : 'c.optin_source = ?'}`, values: [`trigger:${rule.trigger_id}`] })
    } else if (rule.type === 'connection') {
      // Quem tem conversa nesta conta conectada, inscrito ou não: o mesmo canal pode ter várias contas no espaço.
      requireRow(await db.prepare('SELECT id FROM channels WHERE workspace_id=? AND id=?').bind(workspace, rule.connection_id).first())
      return ({ sql: `${rule.operator === 'not_in_connection' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM contact_channels cc WHERE cc.workspace_id=c.workspace_id AND cc.contact_id=c.id AND cc.channel_id=?)`, values: [rule.connection_id] })
    } else if (rule.type === 'channel') {
      return ({ sql: `${rule.operator === 'not_subscribed' ? 'NOT ' : ''}(c.status='subscribed' AND EXISTS (SELECT 1 FROM contact_channels cc JOIN channels ch ON ch.workspace_id=cc.workspace_id AND ch.id=cc.channel_id
        WHERE cc.workspace_id=c.workspace_id AND cc.contact_id=c.id AND cc.opted_in=1 AND ch.type=? AND ch.archived_at IS NULL))`, values: [rule.channel] })
    } else {
      const row = requireRow(await db.prepare("SELECT id,id AS label,type,provider,capabilities_override FROM channels WHERE workspace_id=? AND id=? AND status='connected'")
        .bind(workspace, rule.connection_id).first<ConnectionRow>())
      if (!isWindow24(row)) throw new RepositoryError('Esta conexão não possui janela de 24 horas.', 400)
      // Segmentos especiais da janela: "pode receber follow-up" = janela fechou há menos de 24 h (a mensagem +1); "fora do 24+1" = fechou há mais.
      const window = rule.operator === 'inside' ? { sql: 'cc.window_expires_at > ?', values: [now] }
        : rule.operator === 'outside' ? { sql: '(cc.window_expires_at IS NULL OR cc.window_expires_at <= ?)', values: [now] }
        : rule.operator === 'follow_up_eligible' ? { sql: 'cc.window_expires_at <= ? AND cc.window_expires_at > ?', values: [now, now - 86400000] }
        : { sql: '(cc.window_expires_at IS NULL OR cc.window_expires_at <= ?)', values: [now - 86400000] }
      return ({ sql: `EXISTS (SELECT 1 FROM contact_channels cc WHERE cc.workspace_id=c.workspace_id AND cc.contact_id=c.id AND cc.channel_id=? AND ${window.sql})`, values: [rule.connection_id, ...window.values] })
    }
  }))
  return { sql: parts.length ? `(${parts.map(part => `(${part.sql})`).join(filter.match === 'all' ? ' AND ' : ' OR ')})` : filter.match === 'all' ? '1' : '0', values: parts.flatMap(part => part.values) }
}

export async function queryFilteredContacts(db: D1Database, workspace: string, raw: unknown, cursor?: string | null, search?: string, pageSize = 40): Promise<ContactPage> {
  const clause = await compileContactFilter(db, workspace, raw)
  const where = ["c.workspace_id=?", "c.status<>'deleted'", clause.sql]
  const values: SqlFilter['values'] = [workspace, ...clause.values]
  if (search?.trim()) {
    where.push("instr(lower(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')||' '||coalesce(c.email,'')||' '||coalesce(c.phone,'')),lower(?))>0")
    values.push(search.trim())
  }
  const count = db.prepare(`SELECT count(*) AS total FROM contacts c WHERE ${where.join(' AND ')}`).bind(...values)
  if (cursor) {
    let key: { workspace: string; time: number; id: string }
    try { key = z.object({ workspace: z.literal(workspace), time: z.number().finite(), id: z.string() }).parse(JSON.parse(atob(cursor))) }
    catch { throw new RepositoryError('Cursor inválido.', 400) }
    where.push('(c.subscribed_at < ? OR (c.subscribed_at = ? AND c.id < ?))')
    values.push(key.time, key.time, key.id)
  }
  const [total, page] = await Promise.all([count.first<{ total: number }>(), db.prepare(`SELECT c.* FROM contacts c WHERE ${where.join(' AND ')} ORDER BY c.subscribed_at DESC,c.id DESC LIMIT ${pageSize + 1}`).bind(...values).all<Row>()])
  const rows = page.results.slice(0, pageSize), last = rows.at(-1)
  return { rows: await withTagsAndFields(db, workspace, rows.map(row => decode<Contact>(row))), total: total?.total ?? 0,
    next_cursor: page.results.length > pageSize && last ? btoa(JSON.stringify({ workspace, time: last.subscribed_at, id: last.id })) : null }
}
