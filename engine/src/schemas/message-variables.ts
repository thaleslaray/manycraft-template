/** Shared editor/engine syntax. IDs survive field renames; URI encoding keeps delimiters in reserves literal. */
export type MessageVariable = { raw: string; field: string; fallback: string }
// Published email snapshots retain these legacy system-field aliases.
const systemAliases: Record<string, string> = { first_name: 'primeiro_nome', last_name: 'sobrenome', page_name: 'nome_da_pagina' }
const pattern = () => /\{\{([^{}]*)\}\}|\{(primeiro_nome|sobrenome)\}/g

export function messageVariable(field: string, fallback: string): string {
  return `{{${field.startsWith('campo:') ? `campo:${encodeURIComponent(field.slice(6))}` : field.startsWith('bot:') ? `bot:${encodeURIComponent(field.slice(4))}` : field}|${encodeURIComponent(fallback)}}}`
}
export function messageVariables(text: string): MessageVariable[] {
  return Array.from(text.matchAll(pattern()), match => {
    const body = match[1] ?? match[2], split = body.indexOf('|')
    const rawKey = (split < 0 ? body : body.slice(0, split)).trim()
    const key = systemAliases[rawKey] ?? rawKey
    try {
      return { raw: match[0], field: key.startsWith('campo:') ? `campo:${decodeURIComponent(key.slice(6))}` : key.startsWith('bot:') ? `bot:${decodeURIComponent(key.slice(4))}` : key,
        fallback: decodeURIComponent(split < 0 ? '' : body.slice(split + 1)) }
    } catch { return { raw: match[0], field: '', fallback: '' } }
  })
}
/** Variables that read the contact's ad origin; empty until the contact arrives through an ad. */
export const adVariables = { anuncio_titulo: 'ad_headline', anuncio_id: 'ad_source_id', anuncio_clique: 'ad_click_id' } as const
/** Campos de sistema do contato que só existem como variável (e condição): variável -> coluna de contacts. nome_completo junta nome e sobrenome. */
export const systemVariables = { email: 'email', telefone: 'phone', genero: 'gender', idioma: 'locale', fuso: 'timezone',
  ultima_mensagem: 'last_input_text', contato_id: 'id', inscrito_em: 'subscribed_at', ultima_interacao: 'last_interaction_at', ultimo_carrinho: 'last_cart' } as const
/** Dados de perfil que o canal informa (vínculo do contato com o canal): variável -> chave guardada. Vazia, a variável cai no texto reserva. */
export const channelVariables = { canal_usuario: 'username', canal_seguidores: 'follower_count', canal_segue_conta: 'follows_business', canal_verificado: 'verified' } as const
/** Campos do bot (globais do espaço) entram como {{bot:ID|reserva}}; `botIds` vazio recusa todos. */
export function variableErrors(text: string, fieldIds: ReadonlySet<string>, botIds: ReadonlySet<string> = new Set()): string[] {
  const errors = messageVariables(text).filter(v => !['primeiro_nome', 'sobrenome', 'nome_completo', 'nome_da_pagina', ...Object.keys(adVariables), ...Object.keys(systemVariables), ...Object.keys(channelVariables)].includes(v.field)
    && !(v.field.startsWith('campo:') && fieldIds.has(v.field.slice(6))) && !(v.field.startsWith('bot:') && botIds.has(v.field.slice(4))))
    .map(v => `Variável de campo inexistente ou indisponível: ${v.field || v.raw}.`)
  if (/\{\{|\}\}/.test(text.replace(pattern(), ''))) errors.push('Variável incompleta. Insira novamente pelo seletor de campos.')
  return [...new Set(errors)]
}
export function renderVariables(text: string, valueOf: (field: string) => unknown, encode: (value: string) => string = value => value): string {
  const variables = messageVariables(text)
  let index = 0
  return text.replace(pattern(), () => {
    const v = variables[index++], value = valueOf(v.field)
    if (value == null || typeof value === 'string' && !value.trim()) return encode(v.fallback)
    return encode(typeof value === 'object' ? JSON.stringify(value) : String(value))
  })
}
