import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context)
  return next(specifier, context)
} })
const { useCases, casesFor, availability, eligibleConnections } = await import('./use-cases.ts')

const telegram = { id: 't1', status: 'connected', profile: { inbound: { message: true } } }
const instagram = { id: 'i1', status: 'connected', profile: { inbound: { message: true, comment: true }, comments: { privateReply: { textMaxLength: 1000, urlButtonsMax: 1 } }, stories: { mention: true } } }
const caiu = { ...instagram, id: 'i2', status: 'disconnected' }
const byId = id => useCases.find(c => c.id === id)

test('cada objetivo do questionário tem ao menos um caso pronto', () => {
  for (const objective of ['leads', 'sales', 'support', 'engagement']) assert.ok(casesFor(objective).length >= 1, objective)
})

test('só Telegram: casos por palavra ficam disponíveis; comentário e story ficam desabilitados com motivo', () => {
  assert.deepEqual(availability(byId('keyword-coupon'), [telegram]), { ok: true })
  const comment = availability(byId('comment-gift'), [telegram])
  assert.equal(comment.ok, false)
  assert.match(comment.reason, /Instagram/)
  assert.equal(availability(byId('story-thanks'), [telegram]).ok, false)
})

test('Instagram conectado libera comentário e story; desconectado não conta', () => {
  assert.deepEqual(availability(byId('comment-gift'), [instagram]), { ok: true })
  assert.deepEqual(availability(byId('story-thanks'), [instagram]), { ok: true })
  assert.equal(availability(byId('comment-gift'), [caiu]).ok, false)
  assert.deepEqual(eligibleConnections('comment', [telegram, instagram]).map(c => c.id), ['i1'])
})

test('sem nenhuma conexão, todo caso fica desabilitado', () => {
  for (const c of useCases) assert.equal(availability(c, []).ok, false, c.id)
})

test('casos de palavra trazem palavras sugeridas e mensagem; story não precisa de palavra', () => {
  for (const c of useCases) { assert.ok(c.message.length > 0 && c.message.length <= 1000); if (c.goal !== 'story_mention') assert.ok(c.words.length > 0, c.id) }
  assert.ok(byId('keyword-coupon').buttonLabel.length <= 20)
})
