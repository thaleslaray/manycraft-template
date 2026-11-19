import { z } from 'zod'
import { HTTPException } from 'hono/http-exception'
import { contactTextFields, emailFilters, emailSystemFields, systemConditionFields, systemConditionOperators, type ContactTextField } from '../schemas/system-fields'
import { textFieldClause } from '../db/system-text-clause'
import { compileContactFilter, contactQueryFilterSchema } from '../db/contact-filter'
import { extendedSystemClause, isExtendedSystemField } from '../db/system-extended-clause'

export const emailFilterSchema = z.enum(emailFilters)
const operators = z.enum(systemConditionOperators)
export { emailFilters, emailSystemFields }
const leaf = z.discriminatedUnion('type', [
  z.object({ type: z.literal('email'), filter: emailFilterSchema }),
  z.object({ type: z.literal('system_field'), field: z.enum(systemConditionFields), operator: operators, value: z.unknown().optional() }),
  z.object({ type: z.literal('tag'), tag_id: z.string().min(1), operator: z.enum(['has', 'not_has']) }),
  z.object({ type: z.literal('field'), field_id: z.string().min(1), operator: operators, value: z.unknown().optional() }),
  z.object({ type: z.literal('segment'), segment_id: z.string().min(1), operator: z.enum(['has', 'not_has', 'in', 'not_in']) }),
  z.object({ type: z.literal('topic'), topic_id: z.string().min(1), operator: z.enum(['has', 'not_has']) }),
])
export const contactFilterSchema = z.object({ match: z.enum(['all', 'any']), rules: z.array(z.union([leaf, z.object({ match: z.enum(['all', 'any']), rules: z.array(leaf).min(1).max(30) })])).max(30) }).refine(filter => filter.rules.reduce((sum, rule) => sum + ('rules' in rule ? rule.rules.length : 1), 0) <= 30, { message: 'Use até 30 condições por filtro.' })
export type ContactConditionFilter = z.infer<typeof contactFilterSchema>
const identity = (alias: string) => `SELECT cc.* FROM contact_channels cc JOIN channels ch ON ch.workspace_id=cc.workspace_id AND ch.id=cc.channel_id WHERE cc.workspace_id=${alias}.workspace_id AND cc.contact_id=${alias}.id AND ch.type='email'`
/** Fixed SQL fragments only: user values never become identifiers or SQL. Shared by audiences and global filters. */
export function emailFilterSql(input: string, alias = 'c'): string {
  const filter = emailFilterSchema.parse(input), address = `EXISTS (${identity(alias)})`
  const opened = `EXISTS (SELECT 1 FROM email_events e WHERE e.workspace_id=${alias}.workspace_id AND e.contact_id=${alias}.id AND e.type='opened')`
  const clicked = `EXISTS (SELECT 1 FROM email_events e WHERE e.workspace_id=${alias}.workspace_id AND e.contact_id=${alias}.id AND e.type='clicked')`
  return filter === 'defined' ? address : filter === 'undefined' ? `NOT ${address}`
    : filter === 'opened' ? opened : filter === 'clicked' ? clicked
    : filter === 'opened_clicked' ? `(${opened} AND ${clicked})`
    : filter === 'opened_not_clicked' ? `(${opened} AND NOT ${clicked})`
    : filter === 'not_opened' ? `(${address} AND NOT ${opened})`
    : filter === 'subscribed' ? `EXISTS (${identity(alias)} AND cc.opted_in=1)`
    : `(${address} AND NOT EXISTS (${identity(alias)} AND cc.opted_in=1))`
}
function systemValue(field: string) {
  if (field in contactTextFields) return `c.${contactTextFields[field as ContactTextField]}`   // fixed map above: never user text
  if (field.startsWith('ad_')) return `c.${field}`   // fixed list above: never user text
  if (field === 'email') return `(SELECT cc.external_user_id FROM (${identity('c')}) cc LIMIT 1)`
  if (field === 'email_opted_in') return `(SELECT coalesce(max(cc.opted_in),0) FROM (${identity('c')}) cc)`
  const type = field.includes('clicked') || field === 'email_clicks' ? 'clicked' : 'opened'
  return `(SELECT ${field.endsWith('_at') ? 'max(created_at)' : 'count(*)'} FROM email_events WHERE workspace_id=c.workspace_id AND contact_id=c.id AND type='${type}')`
}
export async function contactFilterSql(db: D1Database, ws: string, input: unknown, visited: string[] = []): Promise<{ sql: string; values: (string | number | null)[] }> {
  const filter = contactFilterSchema.parse(input), values: (string | number | null)[] = []
  const compile = async (group: ContactConditionFilter): Promise<string> => {
    const clauses: string[] = []
    for (const rule of group.rules) {
      if ('rules' in rule) { clauses.push(await compile(rule)); continue }
      if (rule.type === 'email') { clauses.push(emailFilterSql(rule.filter)); continue }
      if (rule.type === 'tag') {
        clauses.push(`${rule.operator === 'not_has' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM contact_tags WHERE workspace_id=c.workspace_id AND contact_id=c.id AND tag_id=?)`); values.push(rule.tag_id); continue
      }
      if (rule.type === 'topic') {
        clauses.push(`${rule.operator === 'not_has' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM topic_subscriptions WHERE workspace_id=c.workspace_id AND contact_id=c.id AND topic_id=? AND status='subscribed' AND expires_at>?)`)
        values.push(rule.topic_id, Date.now()); continue
      }
      if (rule.type === 'segment') {
        if (visited.includes(rule.segment_id) || visited.length >= 8) throw new HTTPException(400, { message: 'Segmentos não podem formar ciclos.' })
        const nested = await savedSegmentSql(db, ws, rule.segment_id, [...visited, rule.segment_id])
        clauses.push(`${rule.operator === 'not_has' || rule.operator === 'not_in' ? 'NOT ' : ''}(${nested.sql})`); values.push(...nested.values); continue
      }
      if (rule.type === 'system_field' && isExtendedSystemField(rule.field)) { clauses.push(await extendedSystemClause(db, ws, rule.field, rule.operator, rule.value, values)); continue }
      if (rule.type === 'system_field' && rule.field in contactTextFields) { clauses.push(textFieldClause(rule.field as ContactTextField, rule.operator, rule.value, values)); continue }
      let expression: string
      if (rule.type === 'system_field') expression = systemValue(rule.field)
      else {
        expression = '(SELECT json_extract(value,\'$\') FROM contact_field_values WHERE workspace_id=c.workspace_id AND contact_id=c.id AND field_id=?)'; values.push(rule.field_id)
      }
      if (rule.operator === 'is_set' || rule.operator === 'is_not_set') {
        clauses.push(rule.type === 'field' ? `${rule.operator === 'is_not_set' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM contact_field_values WHERE workspace_id=c.workspace_id AND contact_id=c.id AND field_id=?)` : `${expression} IS ${rule.operator === 'is_set' ? 'NOT ' : ''}NULL`); continue
      }
      if (rule.operator === 'within_days') {
        if (rule.type !== 'system_field' || !rule.field.endsWith('_at') || typeof rule.value !== 'number' || !Number.isInteger(rule.value) || rule.value <= 0 || rule.value > 36500) throw new HTTPException(400, { message: 'Informe um período válido em dias.' })
        clauses.push(`${expression}>=?`); values.push(Date.now() - rule.value * 86400000); continue
      }
      if (rule.operator === 'not_contains' || rule.operator === 'starts_with') throw new HTTPException(400, { message: 'A comparação não é compatível com este dado.' })
      const numeric = ['gt', 'gte', 'lt', 'lte'].includes(rule.operator)
      if ((numeric && typeof rule.value !== 'number') || (!numeric && !['string', 'number', 'boolean'].includes(typeof rule.value) && rule.value !== null)) throw new HTTPException(400, { message: 'Valor incompatível com o operador do filtro.' })
      if (rule.operator === 'contains') {
        if (typeof rule.value !== 'string') { if (rule.type === 'field') values.pop(); clauses.push('0'); continue }
        clauses.push(`(SELECT typeof(fieldValue)='text' AND instr(fieldValue,?)>0 FROM (SELECT ${expression} AS fieldValue))`); if (rule.type === 'field') { values.pop(); values.push(String(rule.value), rule.field_id) } else values.push(String(rule.value)); continue }
      const op = { equals: 'IS', not_equals: 'IS NOT', gt: '>', gte: '>=', lt: '<', lte: '<=' }[rule.operator]
      clauses.push(numeric ? `(SELECT typeof(fieldValue) IN ('integer','real') AND fieldValue${op}? FROM (SELECT ${expression} AS fieldValue))` : `${expression} ${op} ?`);
      if (numeric && rule.type === 'field') { values.pop(); values.push(rule.value as number, rule.field_id); continue }
      values.push(typeof rule.value === 'boolean' ? Number(rule.value) : rule.value as string | number | null)
    }
    return clauses.length ? `(${clauses.join(group.match === 'all' ? ' AND ' : ' OR ')})` : '1'
  }
  const sql = await compile(filter)
  if (values.length > 80) throw new HTTPException(400, { message: 'O filtro combina condições demais.' })
  return { sql, values }
}
/** Segments can be stored in two filter dialects (contact filters and e-mail conditions); both compile to a predicate over contacts alias c. */
export async function compileAnyContactFilter(db: D1Database, ws: string, raw: unknown, visited: string[] = []) {
  return contactQueryFilterSchema.safeParse(raw).success ? compileContactFilter(db, ws, raw) : contactFilterSql(db, ws, raw, visited)
}
export async function savedSegmentSql(db: D1Database, ws: string, id: string, visited: string[] = [id]): Promise<{ sql: string; values: (string | number | null)[] }> {
  const row = await db.prepare('SELECT filter FROM segments WHERE workspace_id=? AND id=?').bind(ws, id).first<{ filter: string }>()
  if (!row) throw new HTTPException(404, { message: 'Segmento não encontrado neste espaço.' })
  const clause = await compileAnyContactFilter(db, ws, JSON.parse(row.filter), visited)
  return { sql: `(c.status<>'deleted' AND (${clause.sql}))`, values: clause.values }
}
export async function matchesContact(db: D1Database, ws: string, contactId: string, filter: unknown) {
  if (filter && typeof filter === 'object' && !Object.keys(filter).length) return true
  const compiled = await contactFilterSql(db, ws, filter)
  return !!await db.prepare(`SELECT id FROM contacts c WHERE c.workspace_id=? AND c.id=? AND c.status<>'deleted' AND ${compiled.sql}`).bind(ws, contactId, ...compiled.values).first()
}
