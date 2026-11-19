import { HTTPException } from 'hono/http-exception'
import { contactTextFields, textFieldOperators, type ContactTextField } from '../schemas/system-fields'

/** Dados de texto da própria linha do contato (telefone, idioma, fuso, última mensagem, ID). Operadores e valores validados aqui. */
export function textFieldClause(field: ContactTextField, operator: string, value: unknown, values: (string | number | null)[]): string {
  if (!textFieldOperators[field].includes(operator)) throw new HTTPException(400, { message: 'A comparação não é compatível com este dado do contato.' })
  const column = `c.${contactTextFields[field]}`
  if (operator === 'is_set' || operator === 'is_not_set') return `${column} IS ${operator === 'is_set' ? 'NOT ' : ''}NULL`
  if (typeof value !== 'string' || !(field === 'phone' ? value.replace(/\D/g, '') : value.trim()) || value.length > 1000) throw new HTTPException(400, { message: 'Informe o valor da comparação.' })
  const text = field === 'phone' ? value.replace(/\D/g, '') : value
  // O ID é exato; telefone são dígitos; o resto ignora maiúsculas e minúsculas.
  const exact = field === 'contact_id' || field === 'phone'
  const left = exact ? column : `lower(coalesce(${column},''))`, right = exact ? '?' : 'lower(?)'
  if (operator === 'starts_with') { values.push(text, text); return `(${column} IS NOT NULL AND substr(${column},1,length(?))=?)` }
  values.push(text)
  if (operator === 'equals') return exact ? `${column} IS ?` : `(${column} IS NOT NULL AND ${left}=${right})`
  if (operator === 'not_equals') return exact ? `${column} IS NOT ?` : `(${column} IS NULL OR ${left}<>${right})`
  return `instr(${left},${right})${operator === 'not_contains' ? '=0' : '>0'}`
}
