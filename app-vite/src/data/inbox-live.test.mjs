import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
  return nextResolve(specifier, context)
} })
const { configureDataMode } = await import('./api.ts')
const inbox = await import('./inbox.ts')
const originalFetch = globalThis.fetch
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
const at = '2026-10-23T14:00:00.000Z'
const conversation = (id = 'c1') => ({ id, contact: { id: 'contact', name: 'Ana '.repeat(15), avatar_initials: 'AA' }, channel_type: 'telegram', last_message: { text: 'Olá', at, direction: 'in' }, unread_count: 1, status: 'open', assignee_id: null, window_expires_at: null, automation_paused_until: null })
const message = (id = 'm1', extra = {}) => ({ id, conversation_id: 'c1', direction: 'in', sender: 'contact', text: 'Olá', created_at: at, status: 'delivered', ...extra })
afterEach(() => { globalThis.fetch = originalFetch; configureDataMode(undefined) })
function transport(handler, ws = 'w1') {
  configureDataMode('real')
  globalThis.fetch = async (url, init) => {
    if (url === '/api/session/workspace') return json({ workspace_id: ws, name: 'Teste' })
    assert.equal(init.headers.get('x-workspace'), ws)
    return handler(url, init)
  }
}
const flush = async () => { await new Promise(resolve => setImmediate(resolve)) }

test('lista percorre cursores do contrato, aplica filtros e usa equipe real', async () => {
  const urls = []
  transport(url => {
    urls.push(url)
    if (url === '/api/inbox/context') return json({ current_member_id: 'owner', members: [{ id: 'owner', name: 'Pessoa' }], counts: { open: 1, mine: 0, mentions: 0 } })
    if (url === '/api/inbox/mentions') return json([])
    return url.includes('cursor=') ? json({ rows: [{ ...conversation('c2'), status: 'closed', assignee_id: 'owner' }], next_cursor: null }) : json({ rows: [conversation()], next_cursor: 'cursor + opaco' })
  })
  const result = await inbox.listInbox('demo', { status: 'closed', folder: 'member:owner' })
  assert.deepEqual(result.rows.map(row => row.id), ['c2'])
  assert.equal(result.counts.all, 1)   // só as abertas contam nas pastas
  assert.equal(result.members[0].id, 'owner')
  assert.equal(result.rows[0].workspace_id, 'w1')
  assert.ok(urls.some(url => url.includes('cursor=cursor%20%2B%20opaco')))
})

test('histórico deduplica mensagens, preserva botões/erro e carrega páginas anteriores', async () => {
  transport(url => {
    if (url.includes('/messages?before=')) return json({ rows: [message('old', { created_at: '2026-10-22T14:00:00Z' })], next_before: null })
    if (url.endsWith('/messages')) return json({ rows: [message(), message('m2', { sender: 'automation', status: 'failed', error: 'Canal indisponível', buttons: [{ id: 'b1', title: 'Continuar' }] })], next_before: 'old cursor' })
    return json({ rows: [conversation()], next_cursor: null })
  }, 'history')
  const first = await inbox.getInboxConversation('demo', 'c1')
  assert.equal(first.messages[1].error, 'Canal indisponível')
  assert.equal(first.messages[1].buttons[0].title, 'Continuar')
  assert.equal(inbox.hasOlderInboxMessages('c1'), true)
  await inbox.getInboxConversation('demo', 'c1')
  const older = await inbox.loadOlderInboxMessages('demo', 'c1')
  assert.deepEqual(older.messages.map(row => row.id), ['old', 'm1', 'm2'])
  assert.equal(inbox.hasOlderInboxMessages('c1'), false)
})

test('histórico preserva eventos e sequência causal no mesmo instante, inclusive entre páginas', async () => {
  const system = (id, sequence, event) => message(id, { sequence, sender: 'system', direction: 'out', text: '', status: 'sent', event })
  const first = system('z-trigger', 1, { kind: 'trigger', automation_id: 'a', automation_name: 'Guia', trigger_kind: 'dm_keyword' })
  const delay = system('b-delay', 4, { kind: 'delay_started', automation_id: 'a', automation_name: 'Guia', ends_at: '2026-10-23T14:05:00Z' })
  const tag = system('a-tag', 6, { kind: 'tag_added', tag_id: 't', tag_name: 'Interesse' })
  transport(url => {
    if (url.includes('/messages?before=')) return json({ rows: [first, message('y-message', { sequence: 2, sender: 'automation' }), message('x-click', { sequence: 3, text: 'Quero meu guia' })], next_before: null })
    if (url.endsWith('/messages')) return json({ rows: [tag, delay, message('c-message', { sequence: 5, sender: 'automation' })], next_before: 'previous' })
    return json({ rows: [conversation()], next_cursor: null })
  }, 'system-history')
  const initial = await inbox.getInboxConversation('demo', 'c1')
  assert.deepEqual(initial.messages.map(row => row.id), ['b-delay', 'c-message', 'a-tag'])
  const full = await inbox.loadOlderInboxMessages('demo', 'c1')
  assert.deepEqual(full.messages.map(row => row.id), ['z-trigger', 'y-message', 'x-click', 'b-delay', 'c-message', 'a-tag'])
  assert.equal(full.messages[0].source, 'system')
  assert.deepEqual(full.messages[0].event, first.event)
  assert.deepEqual(full.messages[3].event, delay.event)
  assert.equal(full.messages[2].source, 'contact')
  assert.equal(full.messages[2].body, 'Quero meu guia')
})

test('resposta e nota usam text/kind; ações usam rotas e body exatos', async () => {
  const posts = []
  transport((url, init) => {
    if (init.method === 'POST') {
      const body = init.body ? JSON.parse(init.body) : undefined
      posts.push({ url, body })
      if (url.endsWith('/messages')) return json(message('out', { sender: body.kind === 'note' ? 'note' : 'human', direction: 'out', text: body.text, status: 'sent' }))
      return json({ ok: true })
    }
    if (url.endsWith('/messages')) return json({ rows: [], next_before: null })
    return json({ rows: [conversation()], next_cursor: null })
  }, 'writes')
  await inbox.getInboxConversation('demo', 'c1')
  await inbox.sendInboxMessage('demo', 'c1', { body: ' Resposta ', kind: 'reply' })
  await inbox.sendInboxMessage('demo', 'c1', { body: 'Contexto', kind: 'note' })
  await inbox.assignInboxConversation('demo', 'c1', 'owner')
  await inbox.setInboxStatus('demo', 'c1', 'closed')
  await inbox.setInboxUnread('demo', 'c1', false)
  assert.deepEqual(posts.map(post => post.body), [{ text: 'Resposta', kind: 'reply' }, { text: 'Contexto', kind: 'note' }, { member_id: 'owner' }, { status: 'closed' }, undefined])
  assert.match(posts.at(-1).url, /\/read$/)
  await inbox.setInboxUnread('demo', 'c1', true)
  assert.match(posts.at(-1).url, /\/unread$/)
})

test('WebSocket adapta contexto, atualiza cache sem duplicatas e reconecta com backoff cancelável', async () => {
  transport(() => json({ rows: [conversation()], next_cursor: null }), 'live')
  const sockets = [], states = [], events = [], delays = []
  let scheduled, cancelled = false
  const stop = inbox.subscribeInbox(event => events.push(event), state => states.push(state), {
    origin: 'https://painel.example',
    createSocket: url => { const socket = { url, close() { this.closed = true } }; sockets.push(socket); return socket },
    schedule: (callback, delay) => { scheduled = callback; delays.push(delay); return 99 },
    cancel: id => { assert.equal(id, 99); cancelled = true },
  })
  await flush()
  assert.equal(sockets[0].url, 'wss://painel.example/api/inbox/live?workspace=live')
  sockets[0].onopen()
  const event = { type: 'message', conversation: conversation(), message: message() }
  sockets[0].onmessage({ data: JSON.stringify(event) })
  sockets[0].onmessage({ data: JSON.stringify(event) })
  sockets[0].onmessage({ data: '{inválido' })
  sockets[0].onmessage({ data: JSON.stringify({ ...event, message: message('bad', { conversation_id: 'other' }) }) })
  assert.equal(events.length, 2)
  assert.equal(inbox.cachedInboxConversation('c1').messages.length, 1)
  const systemEvent = { type: 'message', conversation: conversation(), message: message('pause', { sequence: 2, sender: 'system', direction: 'out', text: '', event: { kind: 'automation_paused', until: '2026-10-23T14:30:00Z' } }) }
  sockets[0].onmessage({ data: JSON.stringify(systemEvent) })
  sockets[0].onmessage({ data: JSON.stringify(systemEvent) })
  const cached = inbox.cachedInboxConversation('c1')
  assert.equal(cached.messages.length, 2)
  assert.equal(cached.messages[1].source, 'system')
  assert.deepEqual(cached.messages[1].event, systemEvent.message.event)
  assert.equal(cached.messages[1].sequence, 2)
  sockets[0].onclose()
  assert.deepEqual(delays, [1000])
  scheduled(); await flush()
  sockets[1].onclose()
  assert.deepEqual(delays, [1000, 2000])
  stop()
  assert.equal(cancelled, true)
  assert.equal(sockets[1].closed, true)
  scheduled(); await flush()
  assert.equal(sockets.length, 2)
  assert.ok(states.includes('connected'))
  assert.ok(states.includes('reconnecting'))
})

test('falha HTTP é visível e não substitui dados por demonstração', async () => {
  transport(() => new Response(JSON.stringify({ error: 'Sem acesso' }), { status: 403 }), 'error')
  await assert.rejects(inbox.listInbox('demo'), /Sem acesso/)
})

test('WebSocket exclui histórico em cache e rejeita evento de exclusão malformado', async () => {
  transport(url => url.endsWith('/messages') ? json({ rows: [message(), message('system-private', { sender: 'system', text: '', event: { kind: 'field_changed', field_id: 'phone', field_name: 'Telefone', previous_value: null, value: '+5511999990000' } })], next_before: 'older' }) : json({ rows: [conversation()], next_cursor: null }), 'deletion-live')
  await inbox.getInboxConversation('demo', 'c1')
  const events = [], sockets = []
  const stop = inbox.subscribeInbox(event => events.push(event), () => {}, {
    origin: 'https://painel.example', createSocket: () => { const socket = { close() {} }; sockets.push(socket); return socket },
  })
  await flush()
  const valid = { type: 'contact_deleted', contact_id: 'contact', conversation_ids: ['c1'] }
  sockets[0].onmessage({ data: JSON.stringify({ ...valid, conversation_ids: [null] }) })
  assert.ok(inbox.cachedInboxConversation('c1'))
  sockets[0].onmessage({ data: JSON.stringify(valid) })
  assert.deepEqual(events, [valid])
  assert.equal(inbox.cachedInboxConversation('c1'), undefined)
  assert.equal(inbox.hasOlderInboxMessages('c1'), false)
  sockets[0].onmessage({ data: JSON.stringify({ type: 'message', message: message(), conversation: conversation() }) })
  assert.equal(inbox.cachedInboxConversation('c1'), undefined, 'frame atrasado não recupera dados excluídos')
  await assert.rejects(inbox.getInboxConversation('demo', 'c1'), /não está disponível/)
  assert.equal(events.length, 1)
  stop()
})

test('retomar usa resposta direta da rota e preserva histórico em cache', async () => {
  const calls = []
  transport((url, init) => {
    if (init.method === 'POST') { calls.push({ url, body: init.body }); return json(conversation()) }
    if (url.endsWith('/messages')) return json({ rows: [message()], next_before: null })
    return json({ rows: [{ ...conversation(), automation_paused_until: '2099-01-01T00:00:00Z' }], next_cursor: null })
  }, 'resume')
  await inbox.getInboxConversation('demo', 'c1')
  const resumed = await inbox.resumeInboxAutomations('demo', 'c1')
  assert.equal(resumed.automation_paused_until, null)
  assert.equal(resumed.messages.length, 1)
  assert.deepEqual(calls, [{ url: '/api/inbox/conversations/c1/resume-automations', body: undefined }])
})


test('resposta HTTP de exclusão remove mensagens e eventos mesmo sem eco WebSocket', async () => {
  const { deleteContact } = await import('./index.ts')
  transport(url => {
    if (url === '/api/contacts/contact') return json({ deleted_ids: ['contact'], conversation_ids: ['c1'] })
    if (url.endsWith('/messages')) return json({ rows: [message('event', { sender: 'system', text: '', event: { kind: 'tag_added', tag_id: 'tag', tag_name: 'Dados privados' } })], next_before: 'older' })
    return json({ rows: [conversation()], next_cursor: null })
  }, 'deletion-http')
  const initial = await inbox.getInboxConversation('demo', 'c1')
  assert.equal(initial.messages[0].event.tag_name, 'Dados privados')
  const events = []
  const stop = inbox.subscribeInbox(event => events.push(event), () => {}, { origin: 'https://painel.example', createSocket: () => ({ close() {} }) })
  await flush()
  await deleteContact('demo', 'contact')
  assert.equal(inbox.cachedInboxConversation('c1'), undefined)
  assert.equal(inbox.hasOlderInboxMessages('c1'), false)
  assert.deepEqual(events, [{ type: 'contact_deleted', contact_id: 'contact', conversation_ids: ['c1'] }])
  stop()
})

test('modelo confirmado não vira falha de envio quando a atualização do histórico falha', async () => {
  let confirmed = false, sends = 0
  const template = { id: 'approved', params: { '1': 'Nara' } }
  transport((url, init) => {
    if (init.method === 'POST') {
      sends++
      assert.deepEqual(JSON.parse(init.body), { kind: 'template', template })
      confirmed = true
      return json(message('model-out', { sender: 'human', direction: 'out', text: 'Olá Nara.', template, status: 'sent' }))
    }
    if (confirmed) return new Response('{}', { status: 503 })
    if (url.endsWith('/messages')) return json({ rows: [], next_before: null })
    return json({ rows: [conversation()], next_cursor: null })
  }, 'template-confirmed')
  await inbox.getInboxConversation('demo', 'c1')
  const result = await inbox.sendInboxTemplate('demo', 'c1', template)
  assert.equal(sends, 1)
  assert.equal(result.messages.at(-1).body, 'Olá Nara.')
  assert.deepEqual(result.messages.at(-1).template, template)
})

test('histórico preserva arquivo, localização, contatos, pedido e reação que o contato mandou', async () => {
  const media = { kind: 'image', status: 'stored', url: '/api/inbox/media/abc', mime: 'image/png', caption: 'foto' }
  const location = { latitude: -23.56, longitude: -46.65, name: 'Paulista' }
  const reaction = { emoji: '👍' }
  transport(url => url.endsWith('/messages') ? json({ rows: [message('m1', { text: 'foto', media, reaction }), message('m2', { location, shared_contacts: [{ name: 'Ana', phones: ['1'], emails: [] }], order: { catalogId: 'c', items: [] }, unsupported: { type: 'edit' } })], next_before: null }) : json({ rows: [conversation()], next_cursor: null }), 'rich')
  const result = await inbox.getInboxConversation('demo', 'c1')
  assert.deepEqual(result.messages[0].media, media)
  assert.deepEqual(result.messages[0].reaction, reaction)
  assert.deepEqual(result.messages[1].location, location)
  assert.equal(result.messages[1].shared_contacts[0].name, 'Ana')
  assert.equal(result.messages[1].order.catalogId, 'c')
  assert.equal(result.messages[1].unsupported.type, 'edit')
  assert.equal('media' in result.messages[1], false)
})
