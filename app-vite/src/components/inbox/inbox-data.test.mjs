import assert from "node:assert/strict"
import { test } from "node:test"
import { registerHooks } from "node:module"
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
  return nextResolve(specifier, context)
} })
const {
  assignInboxConversation,
  getInboxConversation,
  inboxMessageWindow,
  listInbox,
  sendInboxMessage,
  setInboxStatus,
  setInboxUnread,
} = await import("../../data/inbox.ts")

test("a caixa combina pasta, canal, situação, não lidas, busca e ordenação", async () => {
  const overview = await listInbox("demo")
  assert.equal(overview.rows.length, 6)
  // As pastas contam só as conversas abertas (a lista abre em "abertas"): das 6, uma está encerrada.
  assert.equal(overview.counts.all, 5)
  assert.equal(overview.counts.mine, 2)
  assert.equal(overview.counts.unassigned, 1)
  const mine = await listInbox("demo", { folder: "mine", status: "open", channel: "whatsapp", search: "Pedro" })
  assert.equal(mine.rows.length, 1)
  assert.equal(mine.rows[0].contact.name, "Pedro Henrique")
  assert.equal((await listInbox("demo", { unread: true })).total, 2)
  assert.equal((await listInbox("demo", { folder: "reminders" })).total, 1)
  // Equipe › Todos: conversas atribuídas a qualquer pessoa (o complemento de "Não atribuído").
  assert.equal((await listInbox("demo", { folder: "assigned", status: "open" })).total, overview.counts.all - overview.counts.unassigned)
  assert.equal((await listInbox("demo", { status: "closed" })).total, 1)
  assert.equal((await listInbox("demo", { search: "não-existe" })).total, 0)
  const oldest = await listInbox("demo", { sort: "oldest" })
  assert.equal(oldest.rows[0].id, overview.rows.at(-1).id)
})

test("workspace diferente não lê nem altera conversas de demo", async () => {
  const id = (await listInbox("demo")).rows[0].id
  const other = await listInbox("outro-espaco")
  assert.equal(other.total, 0)
  assert.deepEqual(other.members, [])
  assert.equal(other.current_member_id, null)
  await assert.rejects(getInboxConversation("outro-espaco", id), /neste espaço/)
  await assert.rejects(assignInboxConversation("outro-espaco", id, null), /neste espaço/)
  await assert.rejects(setInboxStatus("outro-espaco", id, "closed"), /neste espaço/)
  await assert.rejects(setInboxUnread("outro-espaco", id, true), /neste espaço/)
  await assert.rejects(sendInboxMessage("outro-espaco", id, { kind: "note", body: "Não deve gravar" }), /neste espaço/)
})

test("resultados são cópias; o consumidor não altera a base em memória", async () => {
  const overview = await listInbox("demo")
  const row = overview.rows[0]
  const originalName = row.contact.name
  row.contact.name = "Alterado fora da camada"
  overview.members[0].name = "Membro alterado"
  assert.equal((await getInboxConversation("demo", row.id)).contact.name, originalName)
  assert.notEqual((await listInbox("demo")).members[0].name, "Membro alterado")
})

test("a janela usa a ficha recebida e respeita limites de 24h, 7 dias e conexão sem janela", () => {
  const now = Date.parse("2026-10-23T12:00:00Z")
  const inbound = (hours) => new Date(now - hours * 3_600_000).toISOString()
  assert.equal(inboxMessageWindow({ channel: "whatsapp", demo_window: { standardHours: 24 }, last_inbound_at: inbound(23.99) }, now).state, "open")
  assert.equal(inboxMessageWindow({ channel: "whatsapp", demo_window: { standardHours: 24 }, last_inbound_at: inbound(24) }, now).can_reply, false)
  assert.equal(inboxMessageWindow({ channel: "instagram", demo_window: { standardHours: 24, humanAgentDays: 7 }, last_inbound_at: inbound(24) }, now).state, "manual_only")
  assert.equal(inboxMessageWindow({ channel: "messenger", demo_window: { standardHours: 24, humanAgentDays: 7 }, last_inbound_at: inbound(167.99) }, now).can_reply, true)
  assert.equal(inboxMessageWindow({ channel: "messenger", demo_window: { standardHours: 24, humanAgentDays: 7 }, last_inbound_at: inbound(168) }, now).state, "closed")
  assert.equal(inboxMessageWindow({ channel: "telegram", last_inbound_at: inbound(600) }, now).state, "unlimited")
  assert.equal(inboxMessageWindow({ connection_profile: { window: { standardHours: 24 } }, channel: "whatsapp", last_inbound_at: inbound(23.99) }, now).state, "open")
  assert.equal(inboxMessageWindow({ connection_profile: { window: { standardHours: 24 } }, channel: "whatsapp", last_inbound_at: inbound(24) }, now).can_reply, false)
  assert.equal(inboxMessageWindow({ connection_profile: { window: { standardHours: 24, humanAgentDays: 7 } }, channel: "instagram", last_inbound_at: inbound(24) }, now).state, "manual_only")
  assert.equal(inboxMessageWindow({ connection_profile: { window: { standardHours: 24, humanAgentDays: 7 } }, channel: "messenger", last_inbound_at: inbound(167.99) }, now).can_reply, true)
  assert.equal(inboxMessageWindow({ connection_profile: { window: { standardHours: 24, humanAgentDays: 7 } }, channel: "messenger", last_inbound_at: inbound(168) }, now).state, "closed")
  assert.equal(inboxMessageWindow({ connection_profile: { window: null }, channel: "telegram", last_inbound_at: inbound(600) }, now).state, "unlimited")
})

test("resposta expirada é recusada, mas uma nota interna é salva sem reabrir a janela", async () => {
  const row = (await listInbox("demo", { channel: "whatsapp" })).rows[0]
  const before = await getInboxConversation("demo", row.id)
  await assert.rejects(sendInboxMessage("demo", row.id, { kind: "reply", body: "Mensagem proibida" }), /janela/)
  const after = await sendInboxMessage("demo", row.id, { kind: "note", body: "  Aguardar nova interação.  " })
  assert.equal(after.messages.length, before.messages.length + 1)
  assert.equal(after.messages.at(-1).source, "note")
  assert.equal(after.messages.at(-1).body, "Aguardar nova interação.")
  assert.equal(after.last_inbound_at, before.last_inbound_at)
  assert.equal(after.automation_paused_until, null)
  assert.equal(inboxMessageWindow(after).can_reply, false)
})

test("atribuição, encerramento, reabertura e leitura persistem nas consultas", async () => {
  const row = (await listInbox("demo", { folder: "unassigned" })).rows[0]
  const overview = await listInbox("demo")
  await assignInboxConversation("demo", row.id, overview.current_member_id)
  assert.equal((await listInbox("demo", { folder: "mine" })).rows.some((item) => item.id === row.id), true)
  assert.equal((await listInbox("demo", { folder: "unassigned" })).total, 0)
  await assert.rejects(assignInboxConversation("demo", row.id, "pessoa-de-outro-espaco"), /acesso/)
  await setInboxStatus("demo", row.id, "closed")
  await assert.rejects(sendInboxMessage("demo", row.id, { kind: "reply", body: "Precisa reabrir" }), /Reabra/)
  await setInboxStatus("demo", row.id, "open")
  await setInboxUnread("demo", row.id, false)
  assert.equal((await getInboxConversation("demo", row.id)).unread, false)
  await setInboxUnread("demo", row.id, true)
  assert.equal((await listInbox("demo", { unread: true })).rows.some((item) => item.id === row.id), true)
  await assignInboxConversation("demo", row.id, null)
})

test("uma resposta humana mantém a janela e pausa as automações por 30 minutos", async () => {
  const row = (await listInbox("demo", { channel: "telegram" })).rows[0]
  const before = await getInboxConversation("demo", row.id)
  const startedAt = Date.now()
  const after = await sendInboxMessage("demo", row.id, { kind: "reply", body: "Vamos continuar por aqui." })
  assert.equal(after.messages.at(-1).source, "human")
  assert.equal(after.messages.at(-1).body, "Vamos continuar por aqui.")
  assert.equal(after.last_inbound_at, before.last_inbound_at)
  assert.equal(after.unread, false)
  assert.ok(Date.parse(after.automation_paused_until) >= startedAt + 30 * 60_000)
})

test("mensagens vazias, extensas e tipos inválidos não são gravados", async () => {
  const row = (await listInbox("demo", { channel: "telegram" })).rows[0]
  const count = (await getInboxConversation("demo", row.id)).messages.length
  await assert.rejects(sendInboxMessage("demo", row.id, { kind: "reply", body: "   " }), /Escreva/)
  await assert.rejects(sendInboxMessage("demo", row.id, { kind: "note", body: "a".repeat(4001) }), /4.000/)
  await assert.rejects(sendInboxMessage("demo", row.id, { kind: "automation", body: "Tipo inesperado" }), /Tipo/)
  assert.equal((await getInboxConversation("demo", row.id)).messages.length, count)
})

test('duas conexões do mesmo canal seguem a ficha efetiva e o vencimento recebido', () => {
  const now = Date.parse('2026-10-24T12:00:00Z')
  const base = { channel: 'whatsapp', last_inbound_at: '2026-10-20T00:00:00Z' }
  assert.equal(inboxMessageWindow({ ...base, reply_policy: { can_reply: true, expires_at: null } }, now).state, 'unlimited')
  assert.equal(inboxMessageWindow({ ...base, reply_policy: { can_reply: false, expires_at: '2026-10-21T00:00:00Z' } }, now).can_reply, false)
  assert.equal(inboxMessageWindow({ ...base, reply_policy: { can_reply: true, expires_at: '2026-10-24T12:00:01Z' } }, now + 1000).can_reply, false)
})

test("janela usa ficha efetiva da conexão inclusive e-mail sem prazo e restrição de provedor", () => {
  const base = { channel: "instagram", last_inbound_at: new Date(Date.now() - 10 * 24 * 3600000).toISOString(), window_expires_at: null }
  assert.equal(inboxMessageWindow({ ...base, connection_profile: { window: null } }).state, "unlimited")
  assert.equal(inboxMessageWindow({ ...base, channel: "telegram", connection_profile: { window: { standardHours: 24, humanAgent: null } } }).can_reply, false)
})

test('composer passa da janela livre à humana e encerra sem depender do nome do canal', () => {
  const now = Date.parse('2026-10-24T12:00:00Z')
  const row = { channel: 'whatsapp', last_inbound_at: '2026-10-23T12:00:00Z', reply_policy: { can_reply: true, expires_at: '2026-10-24T12:00:01Z', human_expires_at: '2026-10-30T12:00:00Z' } }
  assert.equal(inboxMessageWindow(row, now).state, 'open')
  assert.equal(inboxMessageWindow(row, now + 1000).state, 'manual_only')
  assert.equal(inboxMessageWindow(row, Date.parse('2026-10-30T12:00:00Z')).can_reply, false)
})
