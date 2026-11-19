import { messageVariable } from '../../schemas/message-variables'

const pattern = /\{\{\s*([^{}|]+?)\s*(?:\|([^{}]*))?\}\}/g
const fallbackOf = (filters: string | undefined) => /fallback\s*:\s*(?:"([^"]*)"|'([^']*)')/.exec(filters ?? '')
export type VarHooks = { field(id: string): { id: string }; warn(code: string, message: string): void }

/** `{{cuf_123}}` vira a nossa variável de campo; nomes de sistema conhecidos viram os nossos; o resto fica como está e é avisado. */
export function translateVariables(text: string, hooks: VarHooks): string {
  return text.replace(pattern, (whole, key: string, filters: string | undefined) => {
    const fallback = fallbackOf(filters), fb = fallback?.[1] ?? fallback?.[2] ?? ''
    const cuf = /^cuf_(\d+)$/.exec(key)
    if (cuf) return messageVariable(`campo:${hooks.field(cuf[1]).id}`, fb)
    if (key === 'first_name') return messageVariable('primeiro_nome', fb)
    if (key === 'last_name') return messageVariable('sobrenome', fb)
    if (key === 'full_name') return messageVariable('nome_completo', fb)
    const system: Record<string, string> = { email: 'email', phone: 'telefone', gender: 'genero', locale: 'idioma', language: 'idioma', timezone: 'fuso',
      last_input_text: 'ultima_mensagem', user_id: 'contato_id', subscribed: 'inscrito_em', last_interaction: 'ultima_interacao' }
    if (system[key]) return messageVariable(system[key], fb)
    hooks.warn('variable', `Variável sem equivalente: ${key}.`)
    return whole
  })
}
