import { dateSourceSchema, type FlowCondition } from '../../schemas/temporal'
import type { J, RefResolver } from './types'

type Leaf = Extract<FlowCondition['rules'][number], { type: string }>
type LeafResult = { leaf: Leaf } | { unsupported: string }
const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const numeric: Record<string, 'gt' | 'gte' | 'lt' | 'lte'> = { GREATER_THAN: 'gt', GREATER_THAN_OR_EQUAL: 'gte', LESS_THAN: 'lt', LESS_THAN_OR_EQUAL: 'lte' }

function leaf(item: J, refs: RefResolver): LeafResult {
  const op = String(item.operator), no = (why: string) => ({ unsupported: why })
  if (item.is_formula === true || (typeof item.value === 'string' && item.value.includes('{{'))) return no(`${item.type}:valor com fórmula ou variável`)
  if (item.type === 'tag' && (op === 'IS' || op === 'IS_NOT')) {
    return { leaf: { type: 'tag', tag_id: refs.tag(String(item.value)), operator: op === 'IS' ? 'has' : 'not_has' } }
  }
  if (item.type === 'cuf') {
    const id = /^cuf_(\d+)$/.exec(String(item.field))?.[1]
    if (!id) return no('cuf:campo ilegível')
    const field = refs.field(id)
    if (op === 'HAS_VALUE') return { leaf: { type: 'field', field_id: field.id, operator: 'is_set' } }
    if (op === 'IS_UNKNOWN') return { leaf: { type: 'field', field_id: field.id, operator: 'is_not_set' } }
    if (op === 'TRUE' || op === 'FALSE') return { leaf: { type: 'field', field_id: field.id, operator: 'equals', value: op === 'TRUE' } }
    if (op in numeric) {
      const value = Number(item.value)
      return Number.isFinite(value) && item.value !== '' ? { leaf: { type: 'field', field_id: field.id, operator: numeric[op], value } } : no(`cuf:${op} com valor não numérico`)
    }
    if (op === 'ON' || op === 'BEFORE' || op === 'AFTER') {
      const compare = { kind: 'specific' as const, at: String(item.value) }
      if (!dateSourceSchema.safeParse(compare).success) return no(`cuf:${op} com data inválida`)
      return { leaf: { type: 'date', field_id: field.id, operator: op === 'ON' ? 'equals' : op === 'BEFORE' ? 'before' : 'after', compare } }
    }
    if (op === 'IS' || op === 'IS_NOT') {
      const value = field.type === 'number' ? Number(item.value) : field.type === 'boolean' ? ['true', 'on', '1', 'yes'].includes(String(item.value).toLowerCase()) : String(item.value ?? '')
      if (typeof value === 'number' && !Number.isFinite(value)) return no(`cuf:${op} com valor não numérico`)
      return { leaf: { type: 'field', field_id: field.id, operator: op === 'IS' ? 'equals' : 'not_equals', value } }
    }
    if (op === 'CONTAINS') return { leaf: { type: 'field', field_id: field.id, operator: 'contains', value: String(item.value ?? '') } }
    return no(`cuf:${op}`)
  }
  if (item.type === 'suf' && item.field === 'email') {
    if (op === 'HAS_VALUE') return { leaf: { type: 'system_field', field: 'email', operator: 'is_set' } }
    if (op === 'IS_UNKNOWN') return { leaf: { type: 'system_field', field: 'email', operator: 'is_not_set' } }
    if (op === 'CONTAINS') return { leaf: { type: 'system_field', field: 'email', operator: 'contains', value: String(item.value ?? '') } }
  }
  if (item.type === 'system_current_datetime' && op === 'BETWEEN' && item.value?.from?.time && item.value?.to?.time) {
    const days = ((item.value.weekdays ?? []) as string[]).map(d => weekdays.indexOf(d)).filter(d => d >= 0)
    const from = String(item.value.from.time), to = String(item.value.to.time)
    if (days.length && /^\d{2}:\d{2}$/.test(from) && /^\d{2}:\d{2}$/.test(to) && from !== to) return { leaf: { type: 'current_time', window: { from, to, days } } }
  }
  return no(item.type === 'suf' ? `suf:${item.field}:${op}` : String(item.type))
}

/** Filtro da ManyChat (grupos AND/OR) -> condição nossa. Se um critério não tem equivalente, a condição inteira não entra: tirar um item de um OR mudaria o resultado. */
export function translateFilter(filter: J | null | undefined, refs: RefResolver): { condition: FlowCondition } | { unsupported: string[] } {
  const groups = ((filter?.groups ?? []) as J[]).map(group => ({ match: group.operator === 'OR' ? 'any' as const : 'all' as const, results: ((group.items ?? []) as J[]).map(item => leaf(item, refs)) }))
  const bad = groups.flatMap(g => g.results.flatMap(r => 'unsupported' in r ? [r.unsupported] : []))
  if (bad.length) return { unsupported: [...new Set(bad)] }
  const built = groups.map(g => ({ match: g.match, leaves: g.results.flatMap(r => 'leaf' in r ? [r.leaf] : []) })).filter(g => g.leaves.length)
  const top = filter?.operator === 'OR' ? 'any' as const : 'all' as const
  const total = built.reduce((sum, g) => sum + g.leaves.length, 0)
  if (total > 30) return { unsupported: ['mais de 30 critérios'] }
  if (built.length === 1) return { condition: { match: built[0].match, rules: built[0].leaves } }
  return { condition: { match: top, rules: built.map(g => g.leaves.length === 1 ? g.leaves[0] : { match: g.match, rules: g.leaves }) } }
}
