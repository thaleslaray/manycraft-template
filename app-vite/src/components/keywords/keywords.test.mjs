import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'

// O projeto usa imports TS sem extensão; o hook mantém os testes sem dependência extra.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
    return nextResolve(`${specifier}.ts`, context)
  }
  return nextResolve(specifier, context)
} })
const data = await import('../../data/index.ts')

async function workspace(id) {
  const automation = await data.createAutomation(id, 'Resposta de teste')
  await data.saveDraft(automation.id, { nodes: [...automation.draft_graph.nodes, { id: 'message', type: 'message', position: { x: 0, y: 0 }, config: {} }], edges: [] })
  await data.publishAutomation(automation.id)
  return automation.id
}
const input = (automation_id, condition, words) => ({ name: 'Regra de teste', active: true, automation_id, channel: 'instagram', rules: [{ condition, words }] })

test('as cinco condições respeitam maiúsculas, palavras inteiras e negação de qualquer termo', async () => {
  const cases = [
    ['contains', ['café', 'manual'], 'Quero o CAFE completo', 'outro assunto'],
    ['equals', ['preco'], 'PREÇO', 'preço pessoa'],
    ['word', ['acao', 'guia'], 'Essa AÇÃO!', 'reação'],
    ['starts', ['promoção'], 'PROMOCAO nova', 'a promoção'],
    ['not_contains', ['não', 'cancelar'], 'quero continuar', 'quero NAO'],
  ]
  for (const [condition, words, yes, no] of cases) {
    const ws = `condition-${condition}`
    const automation = await workspace(ws)
    const saved = await data.saveKeyword(ws, input(automation, condition, words))
    assert.equal((await data.matchKeyword(ws, 'instagram', yes))?.id, saved.id)
    assert.equal(await data.matchKeyword(ws, 'instagram', no), null)
    assert.equal(await data.matchKeyword(ws, 'telegram', yes), null)
  }
})

test('a condição Curtir não pede palavras e reconhece só o polegar para cima', async () => {
  const ws = 'condition-thumbs-up'
  const automation = await workspace(ws)
  const saved = await data.saveKeyword(ws, input(automation, 'thumbs_up', ['ignorada']))
  assert.deepEqual(saved.rules, [{ condition: 'thumbs_up', words: [] }])
  for (const yes of ['👍', '👍🏽', ' 👍\uFE0F ']) assert.equal((await data.matchKeyword(ws, 'instagram', yes))?.id, saved.id)
  for (const no of ['oi', '👍 valeu', '👎', '👍👍']) assert.equal(await data.matchKeyword(ws, 'instagram', no), null)
  await assert.rejects(data.saveKeyword(ws, input(automation, 'contains', [])))
})

test('condições compostas usam E e a prioridade muda por reordenação', async () => {
  const ws = 'keyword-priority'
  const automation = await workspace(ws)
  const first = await data.saveKeyword(ws, { ...input(automation, 'contains', ['guia']), rules: [{ condition: 'contains', words: ['guia'] }, { condition: 'not_contains', words: ['pago'] }] })
  const second = await data.saveKeyword(ws, input(automation, 'contains', ['guia']))
  assert.equal((await data.matchKeyword(ws, 'instagram', 'guia pago'))?.id, second.id)
  assert.equal((await data.matchKeyword(ws, 'instagram', 'guia grátis'))?.id, first.id)
  await data.moveKeyword(ws, second.id, 0)
  assert.equal((await data.matchKeyword(ws, 'instagram', 'guia grátis'))?.id, second.id)
  await data.setKeywordActive(ws, second.id, false)
  assert.equal((await data.matchKeyword(ws, 'instagram', 'guia grátis'))?.id, first.id)
  const copy = await data.listKeywords(ws)
  copy[0].rules[0].words.push('mutação indevida')
  assert.deepEqual((await data.listKeywords(ws))[0].rules[0].words, ['guia'])
  assert.deepEqual(await data.listKeywords('outro-workspace'), [])
})

test('edição persiste, valida limite/palavras/conteúdo publicado e sinaliza reservadas', async () => {
  const ws = 'keyword-validation'
  const automation = await workspace(ws)
  const saved = await data.saveKeyword(ws, input(automation, 'equals', ['teste']))
  await data.saveKeyword(ws, { ...input(automation, 'starts', ['novo']), name: 'Nome alterado' }, saved.id)
  assert.equal((await data.listKeywords(ws))[0].name, 'Nome alterado')
  await assert.rejects(data.saveKeyword(ws, input(automation, 'equals', [])))
  await assert.rejects(data.saveKeyword(ws, input(automation, 'equals', Array.from({ length: 11 }, (_, n) => `w${n}`))))
  await assert.rejects(data.saveKeyword(ws, input('missing-flow', 'equals', ['teste'])))
  await assert.rejects(data.saveKeyword(ws, { ...input(automation, 'contains', ['a']), rules: Array.from({ length: 3 }, () => ({ condition: 'contains', words: ['a'] })) }))
  await assert.rejects(data.moveKeyword(ws, saved.id, -1))
  assert.deepEqual(data.reservedKeywordWords([{ condition: 'equals', words: ['START', 'material', 'Parar'] }]), ['START', 'Parar'])
})

test('criar uma resposta guarda a regra pausada, liga o editor e exige publicação para ativar', async () => {
  const ws = 'keyword-create-response'
  const rule = { name: 'Preço do catálogo', channel: 'telegram', rules: [{ condition: 'contains', words: ['preco'] }] }
  const created = await data.createKeywordAutomation(ws, rule)
  assert.equal(created.active, false)
  const detail = await data.getAutomation(ws, created.automation_id)
  assert.equal(detail.automation.status, 'draft')
  assert.equal(detail.triggers.length, 1)
  assert.equal(detail.triggers[0].name, rule.name)
  assert.equal(detail.automation.draft_graph.nodes[0].config.trigger_id, detail.triggers[0].id)
  await assert.rejects(data.setKeywordActive(ws, created.id, true), /publi/i)
  const replacement = await data.createKeywordAutomation(ws, { ...rule, name: 'Outra resposta' }, created.id)
  assert.equal(replacement.id, created.id)
  assert.notEqual(replacement.automation_id, created.automation_id)
  const before = await data.listAutomations(ws)
  await assert.rejects(data.createKeywordAutomation(ws, { ...rule, rules: [] }))
  assert.deepEqual(await data.listAutomations(ws), before)
})

test('a conexão da demonstração expõe sua ficha efetiva para escolher a entrada da regra', async () => {
  const ws = 'keyword-connection-profile'
  const { connection } = await data.createConnection({ kind: 'telegram', displayName: 'Catálogo de demonstração', credentials: { botToken: '123456:fake_catalogo' } }, ws)
  assert.equal(connection.profile?.inbound?.message, true)
  assert.equal((await data.listConnections(ws))[0].profile?.inbound?.message, true)
})
