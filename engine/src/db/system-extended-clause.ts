import { HTTPException } from 'hono/http-exception'
import { contactFilterFields, channelProfileFields, optInFields, windowFields, type ContactFilterField, type ChannelProfileField } from '../schemas/system-fields'
import { compileContactFilter } from './contact-filter'

type Values = (string | number | null)[]
const bad = (message: string) => new HTTPException(400, { message })
export const isExtendedSystemField = (field: string) => Object.hasOwn(channelProfileFields, field) || (contactFilterFields as readonly string[]).includes(field)
  || Object.hasOwn(optInFields, field) || (windowFields as readonly string[]).includes(field)

const booleanOperators = ['equals', 'not_equals', 'is_set', 'is_not_set']
const numberOperators = ['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'is_set', 'is_not_set']
const textOperators = ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'is_set', 'is_not_set']
/** Operadores que a Condição oferece para cada tipo de dado de perfil do canal. */
export const channelProfileOperators = { boolean: booleanOperators, number: numberOperators, text: textOperators } as const

/** Dado de perfil do canal: vale quando algum vínculo do contato guarda o dado (o provedor informou). Contato sem o dado: a regra é falsa. */
function channelProfileClause(field: ChannelProfileField, operator: string, value: unknown, values: Values): string {
  const { kind, key } = channelProfileFields[field]
  if (!(channelProfileOperators[kind] as readonly string[]).includes(operator)) throw bad('A comparação não é compatível com este dado de perfil do canal.')
  const expression = kind === 'text' ? "NULLIF(cc.username,'')" : `json_extract(cc.channel_fields,'$.${key}')`
  const row = (condition: string) => `EXISTS (SELECT 1 FROM contact_channels cc WHERE cc.workspace_id=c.workspace_id AND cc.contact_id=c.id AND ${condition})`
  // "Não tem valor" só vale quando o provedor já informou o perfil do contato; sem perfil nenhum, a regra é falsa.
  if (operator === 'is_set') return row(`${expression} IS NOT NULL`)
  if (operator === 'is_not_set') return row(`cc.channel_fields IS NOT NULL AND ${expression} IS NULL`)
  if (kind === 'boolean') {
    if (typeof value !== 'boolean') throw bad('Informe sim ou não para comparar.')
    values.push(Number(value)); return row(`${expression} IS NOT NULL AND ${expression} ${operator === 'equals' ? '=' : '<>'} ?`)
  }
  if (kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw bad('Informe um número para comparar.')
    values.push(value)
    return row(`typeof(${expression}) IN ('integer','real') AND ${expression} ${{ equals: '=', not_equals: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[operator as 'equals']} ?`)
  }
  if (typeof value !== 'string' || !value.trim() || value.length > 1000) throw bad('Informe o valor da comparação.')
  const text = value.trim().replace(/^@/, '')
  const left = `lower(${expression})`
  if (operator === 'starts_with') { values.push(text, text); return row(`${expression} IS NOT NULL AND substr(${left},1,length(?))=lower(?)`) }
  values.push(text)
  return row(`${expression} IS NOT NULL AND ${operator === 'equals' ? `${left}=lower(?)` : operator === 'not_equals' ? `${left}<>lower(?)` : operator === 'contains' ? `instr(${left},lower(?))>0` : `instr(${left},lower(?))=0`}`)
}

function booleanValue(operator: string, value: unknown): boolean {
  if ((operator !== 'equals' && operator !== 'not_equals') || typeof value !== 'boolean') throw bad('Escolha sim ou não.')
  return operator === 'equals' ? value : !value
}

/** SQL do dado "estendido" da Condição (perfil do canal, nome, status, janela, autorizou). Valores sempre por parâmetro. */
export async function extendedSystemClause(db: D1Database, workspace: string, field: string, operator: string, value: unknown, values: Values): Promise<string> {
  if (Object.hasOwn(channelProfileFields, field)) return channelProfileClause(field as ChannelProfileField, operator, value, values)
  if (Object.hasOwn(optInFields, field)) {
    // Mesma regra do filtro de contatos: inscrito e autorizado em alguma conexão do canal.
    const compiled = await compileContactFilter(db, workspace, { match: 'all', rules: [{ type: 'channel', channel: optInFields[field] as never, operator: booleanValue(operator, value) ? 'subscribed' : 'not_subscribed' }] })
    values.push(...compiled.values); return compiled.sql
  }
  if ((windowFields as readonly string[]).includes(field)) {
    const open = booleanValue(operator, value)
    values.push(Date.now())
    return `${open ? '' : 'NOT '}EXISTS (SELECT 1 FROM contact_channels cc WHERE cc.workspace_id=c.workspace_id AND cc.contact_id=c.id AND cc.window_expires_at > ?)`
  }
  // Nome, sobrenome, status, gênero e última interação: o filtro de contatos já cuida dos operadores e valores.
  const compiled = await compileContactFilter(db, workspace, { match: 'all', rules: [{ type: 'system', field: field as ContactFilterField, operator: operator === 'within_days' ? 'within_last_days' : operator, value }] })
  values.push(...compiled.values); return compiled.sql
}
