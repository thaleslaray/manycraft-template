import { HTTPException } from 'hono/http-exception'

const common = ['equals', 'not_equals', 'is_set', 'is_not_set']
/** Comparações que cada tipo de campo do bot aceita na Condição. */
export const botFieldOperators: Record<string, readonly string[]> = {
  text: [...common, 'contains', 'not_contains', 'starts_with'], number: [...common, 'gt', 'gte', 'lt', 'lte'],
  boolean: common, date: [...common, 'gt', 'gte', 'lt', 'lte'], datetime: [...common, 'gt', 'gte', 'lt', 'lte'],
}
const bad = (message: string) => new HTTPException(400, { message })

/** Confere o operador e o valor da regra contra o tipo do campo. Usado ao publicar e ao avaliar. */
export function assertBotRule(type: string, operator: string, value: unknown) {
  if (!(botFieldOperators[type] ?? []).includes(operator)) throw bad('A comparação não é compatível com o tipo do campo do bot.')
  if (operator === 'is_set' || operator === 'is_not_set') return
  const ok = type === 'number' ? typeof value === 'number' && Number.isFinite(value) : type === 'boolean' ? typeof value === 'boolean'
    : typeof value === 'string' && (type === 'text' ? value.length <= 1000 : Number.isFinite(Date.parse(value)))
  if (!ok) throw bad('Informe um valor compatível com o tipo do campo do bot.')
}

/** Avalia a regra contra o valor global guardado (JSON). Valor ausente nunca casa, exceto em "não tem valor". */
export function matchesBotValue(type: string, stored: string | null, operator: string, value: unknown): boolean {
  assertBotRule(type, operator, value)
  const current: unknown = stored == null ? null : JSON.parse(stored)
  if (operator === 'is_set') return current !== null
  if (operator === 'is_not_set') return current === null
  if (current === null) return false
  if (type === 'text') {
    const left = String(current).toLowerCase(), right = String(value).toLowerCase()
    return operator === 'equals' ? left === right : operator === 'not_equals' ? left !== right : operator === 'contains' ? left.includes(right)
      : operator === 'not_contains' ? !left.includes(right) : left.startsWith(right)
  }
  const left = type === 'date' || type === 'datetime' ? Date.parse(String(current)) : current as number | boolean
  const right = type === 'date' || type === 'datetime' ? Date.parse(String(value)) : value as number | boolean
  if (typeof left === 'number' && Number.isNaN(left)) return false
  return operator === 'equals' ? left === right : operator === 'not_equals' ? left !== right
    : operator === 'gt' ? left > right : operator === 'gte' ? left >= right : operator === 'lt' ? left < right : left <= right
}
