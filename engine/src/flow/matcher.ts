import { z } from 'zod'
export type KeywordRule = { rule: string; words: string | string[]; case_sensitive: number | boolean }

/** O polegar para cima sozinho (com ou sem tom de pele e seletor de emoji). O like do Messenger chega ao motor já como esse emoji. */
const thumbsUpOnly = /^\s*\u{1F44D}[\u{1F3FB}-\u{1F3FF}]?\uFE0F?\s*$/u
export const isThumbsUp = (text: string) => thumbsUpOnly.test(text)

/** Negative rules require every excluded word to be absent; positive rules use any word. */
export function matchesKeyword(text: string, keyword: KeywordRule): boolean {
  if (keyword.rule === 'thumbs_up') return isThumbsUp(text)
  const raw = z.array(z.string()).parse(typeof keyword.words === 'string' ? JSON.parse(keyword.words) : keyword.words)
  const normalize = (value: string) => {
    const plain = value.normalize('NFD').replace(/\p{M}/gu, '')
    return keyword.case_sensitive ? plain : plain.toLocaleLowerCase('pt-BR')
  }
  const input = normalize(text)
  const words = raw.map(normalize)
  if (keyword.rule === 'any') return true
  if (!words.length) return false
  if (keyword.rule === 'is') return words.some(word => input.trim() === word.trim())
  if (keyword.rule === 'contains') return words.some(word => input.includes(word))
  if (keyword.rule === 'starts_with') return words.some(word => input.startsWith(word))
  if (keyword.rule === 'does_not_contain') return words.every(word => !input.includes(word))
  if (keyword.rule === 'word_match') return words.some(word => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, 'u').test(input)
  })
  return false // Messenger reactions are not Telegram DM rules.
}

export type KeyedKeyword = KeywordRule & { id: string; parent_id: string | null; trigger_id: string; trigger_created_at: number; priority?: number }
const compareId = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

/** Como no ManyChat, vale a palavra-chave mais acima na lista da página Palavras-chave (menor `priority`).
 * Prioridades iguais (ou ausentes) desempatam pelo gatilho mais antigo, depois pelo ID do gatilho e da palavra. */
export function firstKeywordMatch<K extends KeyedKeyword>(keywords: K[], triggerIds: Set<string>, text: string): K | undefined {
  const matches = keywords.filter(k => !k.parent_id && triggerIds.has(k.trigger_id)).filter(keyword => {
    const rules = keyword.rule === 'group' ? keywords.filter(child => child.parent_id === keyword.id) : [keyword]
    return rules.length > 0 && rules.every(rule => matchesKeyword(text, rule))
  })
  matches.sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0)
    || left.trigger_created_at - right.trigger_created_at
    || compareId(left.trigger_id, right.trigger_id) || compareId(left.id, right.id))
  return matches[0]
}
