import { RepositoryError } from '../db/shared'
import { localDate } from '../time-zone'

/** Operações da ação Definir campo. Sem `operation`, vale `set` (contrato antigo). */
export const fieldOperations = ['set', 'clear', 'add', 'subtract', 'add_days', 'set_now'] as const
export type FieldOperation = typeof fieldOperations[number]

/** Quais operações cada tipo de campo aceita (o painel mostra a mesma lista). */
export const operationsByFieldType: Record<string, readonly FieldOperation[]> = {
  number: ['set', 'add', 'subtract'],
  text: ['set', 'clear'],
  date: ['set', 'add_days', 'set_now'],
  datetime: ['set', 'add_days', 'set_now'],
  boolean: ['set'],
  array: ['set'],
}
const needsValue = (operation: FieldOperation) => operation !== 'clear' && operation !== 'set_now'
const dayMs = 86400000
/** O texto traz variável ({{campo:ID|padrão}}, {primeiro_nome}, {sobrenome}) resolvida só na execução. */
export const hasVariable = (text: string) => /\{\{|\{(primeiro_nome|sobrenome)\}/.test(text)
/** Número de um operando ou valor guardado: número finito, ou texto numérico (espaços nas pontas não contam). Vazio e o resto: undefined. */
export const numericValue = (value: unknown): number | undefined => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(number) ? number : undefined
}

export function assertFieldOperation(fieldType: string, operation: FieldOperation, value: unknown) {
  if (!(operationsByFieldType[fieldType] ?? ['set']).includes(operation)) {
    throw new RepositoryError('Essa operação não existe para o tipo do campo.', 400)
  }
  if (!needsValue(operation)) return
  if (operation === 'add_days') {
    if (typeof value === 'number' ? !Number.isInteger(value) : typeof value !== 'string' || !value.trim()) throw new RepositoryError('Informe a quantidade de dias.', 400)
  } else if (operation !== 'set' && (typeof value === 'number' ? !Number.isFinite(value) : typeof value !== 'string' || !value.trim())) {
    throw new RepositoryError('Informe o valor da operação.', 400)
  } else if ((operation === 'add' || operation === 'subtract') && typeof value === 'string' && numericValue(value) === undefined && !hasVariable(value)) {
    throw new RepositoryError('Para somar ou subtrair, informe um número ou uma variável.', 400)
  }
}

export type OperationResult = { kind: 'skip' } | { kind: 'clear' } | { kind: 'value'; value: unknown }
/**
 * Calcula o novo valor. `operand` já vem com as variáveis resolvidas (valor padrão aplicado).
 * Campo vazio vale zero (número) ou agora (data); operando que não vira número/dia inteiro deixa o campo como está.
 */
export function applyFieldOperation(fieldType: string, operation: FieldOperation, operand: unknown, current: unknown, now: number, timeZone = 'UTC'): OperationResult {
  if (operation === 'clear') return { kind: 'clear' }
  if (operation === 'set_now') return { kind: 'value', value: fieldType === 'date' ? localDate(now, timeZone) : new Date(now).toISOString() }
  if (operation === 'add' || operation === 'subtract') {
    const amount = numericValue(operand)
    if (amount === undefined) return { kind: 'skip' }
    // Vazio vale zero; texto numérico é convertido; qualquer outra coisa (texto que não é número, lista...) deixa o campo como está.
    const base = current === null || current === undefined || current === '' ? 0 : numericValue(current)
    if (base === undefined) return { kind: 'skip' }
    return { kind: 'value', value: operation === 'add' ? base + amount : base - amount }
  }
  if (operation === 'add_days') {
    const days = typeof operand === 'number' ? operand : typeof operand === 'string' && operand.trim() ? Number(operand) : NaN
    if (!Number.isInteger(days)) return { kind: 'skip' }
    const parsed = typeof current === 'string' ? Date.parse(current) : NaN
    const start = Number.isNaN(parsed) ? fieldType === 'date' ? Date.parse(localDate(now, timeZone)) : now : parsed
    const shifted = new Date(start + days * dayMs)
    return { kind: 'value', value: fieldType === 'date' ? shifted.toISOString().slice(0, 10) : shifted.toISOString() }
  }
  return { kind: 'value', value: operand }
}
