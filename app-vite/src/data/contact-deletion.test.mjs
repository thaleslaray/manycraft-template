import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
  return nextResolve(specifier, context)
} })
const data = await import('./index.ts')
const { configureDataMode } = await import('./api.ts')
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; configureDataMode(undefined) })
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

test('exclusão real usa workspace do engine, id codificado e lote; 403 é propagado', async () => {
  configureDataMode('real')
  const calls = []
  globalThis.fetch = async (url, init) => {
    if (url === '/api/session/workspace') return json({ workspace_id: 'real-workspace', name: 'Teste' })
    calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body) })
    assert.equal(init.headers.get('x-workspace'), 'real-workspace')
    if (url.endsWith('/forbidden')) return json({ error: 'Sem permissão de edição.' }, 403)
    return json({ deleted_ids: ['contact/1'], conversation_ids: ['conversation/1'] })
  }
  assert.deepEqual(await data.deleteContact('demo', 'contact/1'), { deleted_ids: ['contact/1'], conversation_ids: ['conversation/1'] })
  await data.bulkDeleteContacts('demo', ['contact/1', 'contact/1'])
  assert.deepEqual(calls.slice(0, 2), [
    { url: '/api/contacts/contact%2F1', method: 'DELETE', body: undefined },
    { url: '/api/contacts/bulk-delete', method: 'POST', body: { ids: ['contact/1'] } },
  ])
  await assert.rejects(data.deleteContact('demo', 'forbidden'), /Sem permissão/)
})

test('limites e validação integral do lote não deixam exclusão parcial no mock', async () => {
  const first = (await data.listContacts('demo', null)).rows[0]
  await assert.rejects(data.bulkDeleteContacts('demo', []), /1 a 100/)
  await assert.rejects(data.bulkDeleteContacts('demo', Array(101).fill(first.id)), /1 a 100/)
  await assert.rejects(data.bulkDeleteContacts('demo', [first.id, 'inexistente']), /neste espaço/)
  await assert.rejects(data.deleteContact('outro-workspace', first.id), /neste espaço/)
  assert.equal((await data.getContact(first.id)).contact.status, first.status)
})

test('mock anonimiza PII, canais, tags e campos, preservando tombstone e estatística', async () => {
  const first = (await data.listContacts('demo', null)).rows[0]
  const automation = (await data.listAutomations('demo'))[0]
  const stats = await data.automationStats(automation.id)
  const deletion = await data.deleteContact('demo', first.id)
  assert.deepEqual(deletion.deleted_ids, [first.id])
  const detail = await data.getContact(first.id)
  assert.equal(detail.contact.status, 'deleted')
  for (const key of ['first_name', 'last_name', 'gender', 'locale', 'timezone', 'profile_pic_url', 'optin_source', 'last_input_text', 'last_interaction_at', 'automation_paused_until']) {
    assert.equal(detail.contact[key], null, key)
  }
  assert.deepEqual(detail.channels, [])
  assert.deepEqual(detail.tags, [])
  assert.deepEqual(detail.field_values, [])
  assert.deepEqual(await data.automationStats(automation.id), stats)
  const rest = (await data.listContacts('demo', null)).rows.filter(c => c.status !== 'deleted').slice(0, 2)
  assert.deepEqual((await data.bulkDeleteContacts('demo', rest.map(c => c.id))).deleted_ids, rest.map(c => c.id))
  for (const contact of rest) assert.equal((await data.getContact(contact.id)).contact.status, 'deleted')
})

test('exclusão no mock purga conversas/histórico, notifica assinante e limpa assinatura', async () => {
  const conversation = (await data.listInbox('demo', { channel: 'telegram' })).rows[0]
  const events = []
  const stop = data.subscribeInbox(event => events.push(event), () => {})
  const deletion = await data.deleteContact('demo', conversation.contact.id)
  assert.deepEqual(deletion.conversation_ids, [conversation.id])
  assert.deepEqual(events, [{ type: 'contact_deleted', contact_id: conversation.contact.id, conversation_ids: [conversation.id] }])
  assert.equal((await data.listInbox('demo')).rows.some(row => row.id === conversation.id), false)
  await assert.rejects(data.getInboxConversation('demo', conversation.id), /não está disponível/)
  stop()
  const next = (await data.listInbox('demo')).rows[0]
  await data.deleteContact('demo', next.contact.id)
  assert.equal(events.length, 1)
})

test('retomar no mock apaga pausa e rejeita outro espaço', async () => {
  const conversation = (await data.listInbox('demo', { channel: 'messenger', status: 'open' })).rows[0]
  const paused = await data.sendInboxMessage('demo', conversation.id, { kind: 'reply', body: 'Vou ajudar.' })
  assert.ok(paused.automation_paused_until)
  await assert.rejects(data.resumeInboxAutomations('outro', conversation.id), /neste espaço/)
  assert.equal((await data.resumeInboxAutomations('demo', conversation.id)).automation_paused_until, null)
  assert.equal((await data.getInboxConversation('demo', conversation.id)).automation_paused_until, null)
})
