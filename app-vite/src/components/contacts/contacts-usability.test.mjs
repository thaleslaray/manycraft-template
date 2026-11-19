import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context)
} })
const { genderLabel, genderOptions } = await import('./gender')
const { tagOptions, moveTagActive } = await import('./tag-combobox-logic')
const { validationMessage } = await import('../../lib/validation-messages')

test('gênero aparece em pt-BR, qualquer que seja a forma gravada', () => {
  for (const [raw, label] of [['female', 'Feminino'], ['f', 'Feminino'], ['Female', 'Feminino'], ['male', 'Masculino'], ['m', 'Masculino'], ['other', 'Outro'], ['non_binary', 'Outro']]) assert.equal(genderLabel(raw), label)
  assert.equal(genderLabel(null), '')
  assert.equal(genderLabel('Agênero'), 'Agênero')
  assert.deepEqual(genderOptions.map(o => o.name), ['Feminino', 'Masculino', 'Outro'])
})

test('combobox de tag: filtra sem acento, oferece criar com o nome digitado e esconde as que o contato já tem', () => {
  const tags = [{ id: '1', name: 'Black Friday' }, { id: '2', name: 'Cliente VIP' }, { id: '3', name: 'Promoção' }]
  assert.deepEqual(tagOptions(tags, ['3'], '').map(o => o.label), ['Black Friday', 'Cliente VIP'])
  assert.deepEqual(tagOptions(tags, [], 'promocao').map(o => o.label), ['Promoção'])
  assert.deepEqual(tagOptions(tags, [], 'vip x').map(o => [o.kind, o.label]), [['create', 'Criar tag «vip x»']])
  // nome igual a uma tag existente: não oferece criar duplicada
  assert.deepEqual(tagOptions(tags, [], 'cliente vip').map(o => o.kind), ['existing'])
  assert.equal(moveTagActive(0, 3, 'ArrowDown'), 1)
  assert.equal(moveTagActive(2, 3, 'ArrowDown'), 2)
})

test('mensagens de validação do navegador em pt-BR', () => {
  assert.equal(validationMessage({ valueMissing: true }, { type: 'text' }), 'Preencha este campo.')
  assert.equal(validationMessage({ valueMissing: true }, { type: 'file' }), 'Escolha um arquivo.')
  assert.equal(validationMessage({ valueMissing: true }, { type: 'checkbox' }), 'Marque esta opção para continuar.')
  assert.equal(validationMessage({ typeMismatch: true }, { type: 'email' }), 'Digite um e-mail válido, como nome@exemplo.com.')
  assert.equal(validationMessage({ typeMismatch: true }, { type: 'url' }), 'Digite um endereço válido, começando com https://.')
  assert.equal(validationMessage({ patternMismatch: true }, { type: 'tel' }), 'Use o formato pedido neste campo.')
  assert.equal(validationMessage({ patternMismatch: true }, { type: 'tel', title: 'Só números' }), 'Só números')
  assert.equal(validationMessage({ tooShort: true }, { minLength: 3 }), 'Use pelo menos 3 caracteres.')
  assert.equal(validationMessage({ rangeUnderflow: true }, { min: '5' }), 'Use um valor maior ou igual a 5.')
  assert.equal(validationMessage({ rangeOverflow: true }, { max: '9' }), 'Use um valor menor ou igual a 9.')
  assert.equal(validationMessage({ badInput: true }, {}), 'Valor inválido neste campo.')
  assert.equal(validationMessage({}, {}), '')
})
