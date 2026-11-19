import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
  return nextResolve(specifier, context)
} })
const { conditionPhrase, rulesBoundTo } = await import('./keyword-phrase.ts')

test('cada condição vira uma frase que precede as palavras em etiquetas', () => {
  assert.equal(conditionPhrase('contains'), 'contém estas palavras-chave:')
  assert.equal(conditionPhrase('not_contains'), 'não contém estas palavras-chave:')
  assert.equal(conditionPhrase('equals'), 'é igual a uma destas palavras-chave:')
  assert.equal(conditionPhrase('starts'), 'começa com uma destas palavras-chave:')
  assert.equal(conditionPhrase('word'), 'contém uma destas palavras inteiras:')
  assert.equal(conditionPhrase('thumbs_up'), 'é só o polegar para cima')
})

test('condição desconhecida cai na frase genérica', () => {
  assert.equal(conditionPhrase('xyz'), 'combina com:')
})

test('regras ligadas a uma automação: só as dela, na ordem da lista', () => {
  const rows = [{ id: 'a', name: 'Preço', automation_id: 'x' }, { id: 'b', name: 'Outra', automation_id: 'y' }, { id: 'c', name: 'Frete', automation_id: 'x' }]
  assert.deepEqual(rulesBoundTo(rows, 'x').map(r => r.name), ['Preço', 'Frete'])
  assert.deepEqual(rulesBoundTo(rows, 'z'), [])
})
