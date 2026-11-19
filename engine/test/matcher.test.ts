import { expect, it } from 'vitest'
import { firstKeywordMatch, type KeyedKeyword } from '../src/flow/matcher'

const keyword = (id: string, rule: string, words: string[], created = 100): KeyedKeyword => ({
  id: `keyword-${id}`, trigger_id: id, parent_id: null as string | null, rule, words,
  case_sensitive: false, trigger_created_at: created,
})
const match = (rules: KeyedKeyword[], text: string) =>
  firstKeywordMatch(rules, new Set(rules.map(rule => rule.trigger_id)), text)?.trigger_id

it('vale a palavra-chave mais acima na lista, mesmo que outra seja mais específica ou mais longa', () => {
  const broad = { ...keyword('broad', 'contains', ['guia'], 200), priority: 0 }
  const exact = { ...keyword('exact', 'is', ['guia'], 100), priority: 1 }
  expect(match([exact, broad], 'GUIA')).toBe('broad')
  expect(match([{ ...exact, priority: 0 }, { ...broad, priority: 1 }], 'GUIA')).toBe('exact')
  const short = { ...keyword('short', 'contains', ['guia']), priority: 0 }
  const long = { ...keyword('long', 'contains', ['guia completo']), priority: 1 }
  expect(match([long, short], 'quero guia completo')).toBe('short')
})

it('uma palavra-chave de cima que não casa não bloqueia a de baixo', () => {
  const first = { ...keyword('first', 'is', ['preço']), priority: 0 }
  const second = { ...keyword('second', 'contains', ['guia']), priority: 1 }
  expect(match([first, second], 'quero o guia')).toBe('second')
})

it('mantém o E das regras compostas; a prioridade do grupo é a da regra pai', () => {
  const group = keyword('group', 'group', [], 200)
  const contains = { ...keyword('group', 'contains', ['guia']), id: 'child-1', parent_id: group.id }
  const excludes = { ...keyword('group', 'does_not_contain', ['cancelar']), id: 'child-2', parent_id: group.id }
  const rules = [{ ...keyword('simple', 'contains', ['guia']), priority: 1 }, { ...group, priority: 0 }, contains, excludes]
  expect(match(rules, 'guia')).toBe('group')
  expect(match(rules, 'cancelar guia')).toBe('simple')
})

it('sem prioridade gravada ou com prioridade igual, desempata pelo gatilho mais antigo, depois seu id', () => {
  const recent = keyword('a-recent', 'contains', ['guia'], 200)
  const oldest = keyword('z-oldest', 'contains', ['guia'], 100)
  expect(match([recent, oldest], 'guia')).toBe('z-oldest')
  const sameDate = { ...keyword('a-tie', 'contains', ['guia'], 100), id: 'z-keyword' }
  expect(match([oldest, sameDate], 'guia')).toBe('a-tie')
})

it('Curtir: só o polegar para cima, com ou sem tom de pele e seletor de emoji', () => {
  const like = [keyword('like', 'thumbs_up', [])]
  for (const text of ['👍', '👍🏽', '👍🏿', '👍\uFE0F', ' 👍 ', '👍🏻\uFE0F']) expect(match(like, text), text).toBe('like')
  for (const text of ['', 'oi', '👎', '👍 obrigado', 'ok 👍', '👍👍', '❤️']) expect(match(like, text), text).toBeUndefined()
})

it('Curtir respeita a ordem da lista junto das outras regras', () => {
  const like = { ...keyword('like', 'thumbs_up', [], 200), priority: 1 }
  const any = { ...keyword('any', 'any', [], 100), priority: 0 }
  expect(match([like, any], '👍')).toBe('any')
  expect(match([{ ...like, priority: 0 }, { ...any, priority: 1 }], '👍')).toBe('like')
  expect(match([{ ...like, priority: 0 }, { ...any, priority: 1 }], 'oi')).toBe('any')
})
