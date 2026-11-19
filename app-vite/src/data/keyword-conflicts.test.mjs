import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
  return nextResolve(specifier, context)
} })
const { findKeywordConflicts, shadowingRule, ruleMatches, conflictMessage, shadowMessage, conditionFromEngineRule } = await import('./keyword-conflicts.ts')
const { matchesKeyword, firstKeywordMatch } = await import('../../../engine/src/flow/matcher.ts')

const row = (id, name, rules, extra = {}) => ({ id, name, channel: 'instagram', active: true, audience: 'direct', connection_id: 'ig-1', rules, ...extra })
const antiga = row('k-antiga', 'Teste automação', [{ condition: 'contains', words: ['teste'] }])

test('o caso do bug: "teste1234" é pego pela regra antiga "contém teste", que vem antes', () => {
  const nova = row('k-nova', 'Nova', [{ condition: 'contains', words: ['teste1234'] }])
  const conflicts = findKeywordConflicts(nova, [antiga, nova])
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].other.id, 'k-antiga')
  assert.equal(conflicts[0].sample, 'teste1234')
  assert.equal(conflicts[0].otherWins, true)
  assert.equal(conflictMessage(conflicts[0]), 'A regra “Teste automação” (contém “teste”) também pega “teste1234” e vem antes, então ela responde no lugar desta.')
  assert.equal(shadowMessage(shadowingRule([antiga, nova], 'k-nova')), 'Encoberta: a regra “Teste automação”, acima, também pega “teste1234” e responde antes desta.')
  assert.equal(shadowingRule([antiga, nova], 'k-antiga'), undefined)
})

test('regra nova (fora da lista) entra no fim; com maiúscula e acento ainda casa', () => {
  const nova = row('novo', 'Nova', [{ condition: 'equals', words: ['TÉSTE1234'] }])
  const [c] = findKeywordConflicts(nova, [antiga])
  assert.equal(c.otherWins, true)
})

test('quando esta vem antes, o aviso é o leve', () => {
  const nova = row('k-nova', 'Nova', [{ condition: 'contains', words: ['teste1234'] }])
  const [c] = findKeywordConflicts(nova, [nova, antiga])
  assert.equal(c.otherWins, false)
  assert.match(conflictMessage(c), /esta vem antes e passa na frente dela/)
})

test('a outra é testada com as palavras dela também: "teste" aqui pega o "teste1234" da outra', () => {
  const outra = row('k-outra', 'Outra', [{ condition: 'equals', words: ['teste1234'] }])
  const larga = row('k-larga', 'Larga', [{ condition: 'contains', words: ['teste'] }])
  const [c] = findKeywordConflicts(larga, [outra, larga])
  assert.equal(c.sample, 'teste1234')
})

test('sem conflito: palavra exata, outra conexão, outro canal, pausada, grupo', () => {
  const exata = row('k-exata', 'Exata', [{ condition: 'word', words: ['teste'] }])
  const nova = row('k-nova', 'Nova', [{ condition: 'contains', words: ['teste1234'] }])
  assert.deepEqual(findKeywordConflicts(nova, [exata, nova]), [])
  assert.deepEqual(findKeywordConflicts(nova, [{ ...antiga, connection_id: 'ig-2' }, nova]), [])
  assert.deepEqual(findKeywordConflicts(nova, [{ ...antiga, channel: 'telegram' }, nova]), [])
  assert.deepEqual(findKeywordConflicts(nova, [{ ...antiga, active: false }, nova]), [])
  assert.deepEqual(findKeywordConflicts(nova, [{ ...antiga, audience: 'group' }, nova]), [])
  // Gatilho sem conexão vale para todas as conexões do canal.
  assert.equal(findKeywordConflicts(nova, [{ ...antiga, connection_id: null }, nova]).length, 1)
})

test('condição composta e "não contém" respeitam o E do motor', () => {
  const composta = row('k-c', 'Guia', [{ condition: 'contains', words: ['guia'] }, { condition: 'not_contains', words: ['cancelar'] }])
  assert.equal(findKeywordConflicts(row('k-n', 'N', [{ condition: 'starts', words: ['guia grátis'] }]), [composta]).length, 1)
  assert.equal(findKeywordConflicts(row('k-n', 'N', [{ condition: 'contains', words: ['cancelar guia'] }]), [composta]).length, 0)
  const qualquer = row('k-any', 'Qualquer', [{ condition: 'any', words: [] }])
  assert.equal(findKeywordConflicts(row('k-n', 'N', [{ condition: 'contains', words: ['oi'] }]), [qualquer]).length, 1)
  const curtir = row('k-like', 'Curtir', [{ condition: 'thumbs_up', words: [] }])
  assert.equal(findKeywordConflicts(row('k-n', 'N', [{ condition: 'thumbs_up', words: [] }]), [curtir]).length, 1)
})

test('equivalência com o motor: ruleMatches == matchesKeyword em todos os modos', () => {
  const texts = ['Teste1234', 'teste', ' teste ', 'TESTE automação', 'um teste aqui', 'testeira', 'Ação', 'acao', 'oi, tudo?', '', '👍', '👍🏽', 'quero o guia', 'olá Mundo', 'a.b', 'aXb']
  const wordsList = [['teste'], ['teste1234'], ['ação'], ['Olá'], ['a.b'], ['guia', 'material'], [' teste '], []]
  for (const [engineRule, condition] of Object.entries(conditionFromEngineRule)) {
    for (const words of wordsList) for (const text of texts) for (const cs of [false, true]) {
      const expected = matchesKeyword(text, { rule: engineRule, words, case_sensitive: cs })
      assert.equal(ruleMatches(text, { condition, words }, cs), expected, `${engineRule} ${JSON.stringify(words)} ${JSON.stringify(text)} cs=${cs}`)
    }
  }
})

test('equivalência com o motor: quem vence é o mesmo de firstKeywordMatch', () => {
  const engine = [
    { id: 'a', parent_id: null, trigger_id: 't1', trigger_created_at: 1, priority: 0, rule: 'contains', words: ['teste'], case_sensitive: 0 },
    { id: 'b', parent_id: null, trigger_id: 't2', trigger_created_at: 2, priority: 1, rule: 'contains', words: ['teste1234'], case_sensitive: 0 },
  ]
  assert.equal(firstKeywordMatch(engine, new Set(['t1', 't2']), 'Teste1234').id, 'a')
  const nova = row('b', 'Nova', [{ condition: 'contains', words: ['teste1234'] }])
  assert.equal(findKeywordConflicts(nova, [{ ...antiga, id: 'a' }, nova])[0].otherWins, true)
})
