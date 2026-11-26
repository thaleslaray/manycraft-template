import type { ContactQueryFilter } from "../../../shared/contact-filter"
import { getInboxContext, listInboxMentions } from "./inbox-team"
import { apiRequest, getWorkspace, isFakeMode, signedOut } from "./api"
import type { Id, Iso } from "./types"

export type InboxChannel = "instagram" | "whatsapp" | "messenger" | "telegram" | "email"
export type InboxFolder = "all" | "assigned" | "unassigned" | "mine" | "mentions" | "reminders" | `member:${string}`
export type InboxMessageSource = "contact" | "automation" | "human" | "note" | "system"
export type InboxSystemEvent =
  | { kind: "tag_added" | "tag_removed"; tag_id: string; tag_name: string }
  | { kind: "field_changed"; field_id: string; field_name: string; previous_value: unknown; value: unknown }
  | { kind: "field_skipped"; field_id: string; field_name: string; operation: string; reason: "operand" | "current" }
  | { kind: "delay_started"; automation_id: string; automation_name: string; ends_at: Iso }
  | { kind: "trigger"; automation_id: string; automation_name: string; trigger_kind: string }
  | { kind: "status_changed"; previous_status: "open" | "closed"; status: "open" | "closed" }
  | { kind: "automation_paused"; until: Iso | null }
export type InboxMember = { id: Id; name: string }
/** O que o contato mandou além de texto. `url` abre o arquivo guardado (caminho da API; o navegador manda a sessão). */
export type InboxMedia = { kind: "image" | "audio" | "video" | "file" | "sticker"; status: "pending" | "stored" | "failed"; url?: string; mime?: string; name?: string; size?: number; voice?: boolean; animated?: boolean; error?: string; caption?: string }
export type InboxRich = {
  media?: InboxMedia
  location?: { latitude: number; longitude: number; name?: string; address?: string; url?: string }
  shared_contacts?: { name: string; company?: string; phones: string[]; emails: string[] }[]
  order?: { catalogId: string; text?: string; items: { productId: string; quantity: number; price: number; currency: string }[] }
  unsupported?: { type?: string }
  reaction?: { emoji: string }
}
export type InboxMessage = InboxRich & {
  id: Id
  source: InboxMessageSource
  template?: { id: string; params: Record<string, string> }
  author: string
  body: string
  email_subject?: string
  created_at: Iso
  status?: "sent" | "delivered" | "failed"
  error?: string
  buttons?: { id: string; title: string }[]
  event?: InboxSystemEvent
  sequence?: number
}
export type InboxConnectionProfile = { email?: { unsubscribe: "marketing" }; media?: Partial<Record<"image" | "video" | "audio" | "file", { maxBytes: number; mime: string[] }>>; window: { standardHours: number; humanAgentDays?: number; outside?: string } | null }
export type InboxReplyPolicy = { can_reply: boolean; expires_at: Iso | null; mode?: "human_agent"; human_expires_at?: Iso | null; template_connection_id?: string }
export type InboxConversation = {
  id: Id
  workspace_id: Id
  contact: {
    id: Id
    name: string
    avatar_url?: string
    username: string
    email: string
    timezone: string
    tags: string[]
    fields: { name: string; value: string }[]
  }
  channel: InboxChannel
  connection_name?: string | null
  connection_id?: string
  connection_profile?: InboxConnectionProfile
  opted_in?: boolean
  status: "open" | "closed"
  unread: boolean
  assignee_id: Id | null
  reminder_at: Iso | null
  reminder_note?: string | null
  labels?: { id: string; name: string; color: string }[]
  last_inbound_at: Iso
  updated_at: Iso
  automation_paused_until: Iso | null
  demo_window?: { standardHours: number; humanAgentDays?: number } | null
  reply_policy?: InboxReplyPolicy
  window_expires_at?: Iso | null
  messages: InboxMessage[]
}
export type InboxRow = Omit<InboxConversation, "messages"> & { preview: string }
export type InboxFilter = {
  /** Só conversas com esta etiqueta da caixa de entrada. */
  label_id?: string
  /** Filtro personalizado: as mesmas condições da lista de contatos, aplicadas pelo motor ao contato da conversa. */
  contact_filter?: ContactQueryFilter
  folder?: InboxFolder
  status?: "all" | "open" | "closed"
  unread?: boolean
  /** Um tipo de canal, ou uma conta conectada específica (`conn:<id da conexão>`). */
  channel?: InboxChannel | "all" | `conn:${string}`
  search?: string
  sort?: "newest" | "oldest"
}
export type InboxOverview = {
  rows: InboxRow[]
  total: number
  members: InboxMember[]
  current_member_id: Id | null
  counts: { open?: number; mentions?: number; all: number; unassigned: number; mine: number; reminders: number; members: Record<Id, number> }
}
export type InboxWindow = { state: "open" | "manual_only" | "closed" | "unlimited"; can_reply: boolean; expires_at: Iso | null }

const HOUR = 3_600_000
const TEXT_LIMIT = 4_000
const currentMemberId = "inbox-julia"
const seedNow = Date.now()
const ago = (hours: number) => new Date(seedNow - hours * HOUR).toISOString()
const members: InboxMember[] = [
  { id: currentMemberId, name: "Júlia Martins (você)" },
  { id: "inbox-rafael", name: "Rafael Souza" },
  { id: "inbox-luiza", name: "Luiza Tavares" },
]
const contacts = [
  { name: "Marina Oliveira", username: "@marina.oliveira", email: "marina@example.com", channel: "instagram", demo_window: { standardHours: 24, humanAgentDays: 7 }, assignee: null, age: 0.15, unread: true, status: "open", preview: "Quero saber se o encontro também fica gravado." },
  { name: "Pedro Henrique", username: "+55 11 90000-0002", email: "pedro@example.com", channel: "whatsapp", demo_window: { standardHours: 24 }, assignee: currentMemberId, age: 28, unread: false, status: "open", preview: "Posso continuar a inscrição amanhã?" },
  { name: "Ana Carolina de Albuquerque Vasconcelos e Silva Costa Medeiros", username: "@anacarolina.estudio", email: "ana@example.com", channel: "messenger", demo_window: { standardHours: 24, humanAgentDays: 7 }, assignee: "inbox-rafael", age: 2, unread: true, status: "open", preview: "Obrigada! Tenho uma dúvida sobre o material de apoio." },
  { name: "Caio Mendes", username: "@caiomendes", email: "caio@example.com", channel: "telegram", demo_window: null, assignee: currentMemberId, age: 4, unread: false, status: "open", preview: "O link funcionou, podemos falar sobre o próximo passo?" },
  { name: "Beatriz Nunes", username: "@bia.nunes", email: "bia@example.com", channel: "instagram", demo_window: { standardHours: 24, humanAgentDays: 7 }, assignee: "inbox-luiza", age: 52, unread: false, status: "open", preview: "Você consegue me orientar sobre a turma da noite?" },
  { name: "Lucas Carvalho", username: "@lucas.carvalho", email: "lucas@example.com", channel: "messenger", demo_window: { standardHours: 24, humanAgentDays: 7 }, assignee: currentMemberId, age: 195, unread: false, status: "closed", preview: "Tudo resolvido. Obrigado pelo cuidado!" },
] satisfies { name: string; username: string; email: string; channel: InboxChannel; demo_window: { standardHours: number; humanAgentDays?: number } | null; assignee: string | null; age: number; unread: boolean; status: "open" | "closed"; preview: string }[]

const conversations: InboxConversation[] = contacts.map((contact, index) => ({
  id: `inbox-conversation-${index + 1}`,
  workspace_id: "demo",
  contact: {
    id: `inbox-contact-${index + 1}`, name: contact.name, username: contact.username, email: contact.email,
    timezone: "America/Sao_Paulo", tags: index % 2 ? ["Inscrição", "Acompanhamento"] : ["Interesse no curso"],
    fields: [{ name: "Assunto", value: index % 2 ? "Inscrição na próxima turma" : "Material e encontros" }, { name: "Origem", value: "Conversa no canal" }],
  },
  channel: contact.channel,
  connection_profile: { window: [{ standardHours: 24, humanAgentDays: 7 }, { standardHours: 24 }, { standardHours: 24, humanAgentDays: 7 }, null, { standardHours: 24, humanAgentDays: 7 }, { standardHours: 24, humanAgentDays: 7 }][index] },
  status: contact.status,
  unread: contact.unread,
  demo_window: contact.demo_window,
  assignee_id: contact.assignee,
  reminder_at: index === 3 ? new Date(seedNow + 2 * HOUR).toISOString() : null,
  last_inbound_at: ago(contact.age),
  updated_at: ago(contact.age),
  automation_paused_until: null,
  messages: [
    { id: `inbox-${index}-1`, source: "contact", author: contact.name, body: "Olá! Gostaria de conhecer os encontros do curso.", created_at: ago(contact.age + 0.7) },
    { id: `inbox-${index}-2`, source: "automation", author: "Boas-vindas do curso", body: "Que bom receber você. Vou reunir as informações para nossa equipe continuar por aqui.", created_at: ago(contact.age + 0.65) },
    { id: `inbox-${index}-3`, source: "human", author: "Júlia Martins", body: "Olá! Sou a Júlia. Qual ponto você gostaria de entender primeiro?", created_at: ago(contact.age + 0.4) },
    { id: `inbox-${index}-4`, source: "note", author: "Rafael Souza", body: "Pessoa interessada na próxima turma. Conferir a disponibilidade antes de responder.", created_at: ago(contact.age + 0.2) },
    { id: `inbox-${index}-5`, source: "contact", author: contact.name, body: contact.preview, created_at: ago(contact.age) },
  ],
}))

const out = <T>(value: T): T => structuredClone(value)
const tick = async () => { await Promise.resolve() }

function mustConversation(workspaceId: Id, id: Id) {
  const conversation = conversations.find((item) => item.id === id && item.workspace_id === workspaceId)
  if (!conversation) throw new Error("Esta conversa não está disponível neste espaço.")
  return conversation
}

function matchesFolder(conversation: InboxConversation, folder: InboxFolder) {
  if (folder === "assigned") return conversation.assignee_id !== null
  if (folder === "unassigned") return conversation.assignee_id === null
  if (folder === "mine") return conversation.assignee_id === currentMemberId
  if (folder === "mentions") return false
  if (folder === "reminders") return conversation.reminder_at !== null
  if (folder.startsWith("member:")) return conversation.assignee_id === folder.slice(7)
  return true
}

/** Contratos assíncronos substituíveis por API. Todas as leituras e mutações exigem workspace. */
export async function listInbox(workspaceId: Id, filter: InboxFilter = {}): Promise<InboxOverview> {
  if (!isFakeMode()) return realListInbox(filter)
  await tick()
  const workspaceRows = conversations.filter((item) => item.workspace_id === workspaceId)
  const q = filter.search?.trim().toLocaleLowerCase("pt-BR")
  const rows = workspaceRows
    .filter((item) => matchesFolder(item, filter.folder ?? "all"))
    .filter((item) => !filter.status || filter.status === "all" || item.status === filter.status)
    .filter((item) => !filter.unread || item.unread)
    .filter((item) => !filter.channel || filter.channel === "all" || (filter.channel.startsWith("conn:") ? (item as { connection_id?: string }).connection_id === filter.channel.slice(5) : item.channel === filter.channel))
    .filter((item) => !q || `${item.contact.name} ${item.contact.username} ${item.contact.email}`.toLocaleLowerCase("pt-BR").includes(q))
    .sort((a, b) => (filter.sort === "oldest" ? 1 : -1) * a.updated_at.localeCompare(b.updated_at))
    .map(({ messages, ...item }) => ({ ...item, preview: messages.at(-1)?.body ?? "Conversa sem mensagens" }))
  const workspaceMembers = workspaceId === "demo" ? members : []
  const openRows = workspaceRows.filter((item) => item.status === "open")
  return out({
    rows, total: rows.length, members: workspaceMembers, current_member_id: workspaceId === "demo" ? currentMemberId : null,
    counts: {
      all: openRows.length,
      unassigned: openRows.filter((item) => item.assignee_id === null).length,
      mine: openRows.filter((item) => item.assignee_id === currentMemberId).length,
      reminders: openRows.filter((item) => item.reminder_at !== null).length,
      members: Object.fromEntries(workspaceMembers.map((member) => [member.id, openRows.filter((item) => item.assignee_id === member.id).length])),
    },
  })
}

export async function getInboxConversation(workspaceId: Id, id: Id): Promise<InboxConversation> {
  if (!isFakeMode()) return realGetConversation(id)
  await tick()
  return out(mustConversation(workspaceId, id))
}

/** Instagram e Messenger permitem resposta humana até 7 dias; WhatsApp exige modelo após 24h. A ficha efetiva da conexão incorpora ajustes do provedor e da conexão. */
export function inboxMessageWindow(conversation: Pick<InboxConversation, "last_inbound_at" | "channel" | "window_expires_at" | "reply_policy" | "demo_window" | "connection_profile">, now = Date.now()): InboxWindow {
  if ('reply_policy' in conversation && conversation.reply_policy) {
    const policy = conversation.reply_policy as InboxReplyPolicy
    const humanOpen = policy.can_reply && !!policy.human_expires_at && Date.parse(policy.human_expires_at) > now
    const standardOpen = policy.can_reply && (!policy.expires_at || Date.parse(policy.expires_at) > now)
    const manualOnly = humanOpen && (policy.mode === "human_agent" || !standardOpen)
    const allowed = standardOpen || humanOpen
    return { state: allowed ? manualOnly ? "manual_only" : policy.expires_at ? "open" : "unlimited" : "closed", can_reply: allowed, expires_at: manualOnly ? policy.human_expires_at! : policy.expires_at }
  }
  // O modo de demonstração usa a ficha base; o modo real recebe a ficha efetiva do motor.
  const profile = conversation.connection_profile
  const window = profile ? profile.window : conversation.demo_window
  if (profile === undefined && window === undefined) return { state: "unlimited", can_reply: true, expires_at: null }
  if (!window) return { state: "unlimited", can_reply: true, expires_at: null }
  const inbound = Date.parse(conversation.last_inbound_at)
  const freeExpires = conversation.window_expires_at ? Date.parse(conversation.window_expires_at) : inbound + window.standardHours * HOUR
  if (now < freeExpires) return { state: "open", can_reply: true, expires_at: new Date(freeExpires).toISOString() }
  const humanExpires = window.humanAgentDays ? inbound + window.humanAgentDays * 24 * HOUR : freeExpires
  if (now < humanExpires) return { state: "manual_only", can_reply: true, expires_at: new Date(humanExpires).toISOString() }
  return { state: "closed", can_reply: false, expires_at: new Date(humanExpires).toISOString() }
}

export async function assignInboxConversation(workspaceId: Id, id: Id, memberId: Id | null): Promise<InboxConversation> {
  if (!isFakeMode()) return realMutation(id, "assign", { member_id: memberId })
  await tick()
  const conversation = mustConversation(workspaceId, id)
  if (memberId !== null && (workspaceId !== "demo" || !members.some((member) => member.id === memberId))) {
    throw new Error("Escolha uma pessoa com acesso a este espaço.")
  }
  conversation.assignee_id = memberId
  return out(conversation)
}

/** Lembrete da conversa: horário futuro e nota; null tira. */
export async function setInboxReminder(workspaceId: Id, id: Id, at: Iso | null, note?: string): Promise<InboxConversation> {
  if (!isFakeMode()) return realMutation(id, "reminder", { at, ...(note ? { note } : {}) })
  await tick()
  const conversation = mustConversation(workspaceId, id)
  conversation.reminder_at = at
  conversation.reminder_note = at ? note ?? null : null
  return out(conversation)
}
export async function setInboxStatus(workspaceId: Id, id: Id, status: "open" | "closed"): Promise<InboxConversation> {
  if (!isFakeMode()) return realMutation(id, "status", { status })
  await tick()
  const conversation = mustConversation(workspaceId, id)
  if (status !== "open" && status !== "closed") throw new Error("Estado de conversa inválido.")
  conversation.status = status
  return out(conversation)
}

const localLiveListeners = new Set<(event: InboxLiveEvent) => void>()
export function fakeInboxContactExists(workspaceId: Id, contactId: Id) {
  return conversations.some(item => item.workspace_id === workspaceId && item.contact.id === contactId)
}

/** O mesmo descarte atende a resposta HTTP e o evento ao vivo, incluindo eventos da linha do tempo. */
export function forgetInboxContact(workspaceId: Id, contactId: Id, knownIds: Id[] = [], notify = true): Id[] {
  const removed = new Set(knownIds)
  for (const [id, conversation] of realConversations) {
    if (conversation.workspace_id === cacheWorkspace && (conversation.contact.id === contactId || removed.has(id))) {
      realConversations.delete(id)
      messageCursors.delete(id)
      removed.add(id)
    }
  }
  for (const id of removed) { messageCursors.delete(id); deletedConversationIds.add(id) }
  if (isFakeMode()) {
    for (let index = conversations.length - 1; index >= 0; index--) {
      const conversation = conversations[index]
      if (conversation.workspace_id === workspaceId && conversation.contact.id === contactId) {
        removed.add(conversation.id)
        conversations.splice(index, 1)
      }
    }
  }
  if (notify) {
    const event: ContactDeletedEvent = { type: "contact_deleted", contact_id: contactId, conversation_ids: [...removed] }
    localLiveListeners.forEach(listener => listener(event))
  }
  return [...removed]
}

export async function resumeInboxAutomations(workspaceId: Id, id: Id): Promise<InboxConversation> {
  if (!isFakeMode()) {
    await ensureWorkspace()
    const row = await apiRequest<InboxWireConversation>(`/inbox/conversations/${encodeURIComponent(id)}/resume-automations`, { method: "POST" })
    if (deletedConversationIds.has(id)) throw new Error("Esta conversa não está disponível neste espaço.")
    return out(upsertConversation(row))
  }
  await tick()
  const conversation = mustConversation(workspaceId, id)
  conversation.automation_paused_until = null
  return out(conversation)
}

export async function setInboxUnread(workspaceId: Id, id: Id, unread: boolean): Promise<InboxConversation> {
  if (!isFakeMode()) return realMutation(id, unread ? "unread" : "read")
  await tick()
  const conversation = mustConversation(workspaceId, id)
  conversation.unread = unread
  return out(conversation)
}

/** No modo real, respostas são enviadas pelo engine ao canal; notas ficam internas. */
export async function sendInboxMessage(workspaceId: Id, id: Id, input: { body: string; kind: "reply" | "note"; mention_member_ids?: string[] }): Promise<InboxConversation> {
  if (!isFakeMode()) return realSendMessage(id, input)
  await tick()
  const conversation = mustConversation(workspaceId, id)
  if (input.kind !== "reply" && input.kind !== "note") throw new Error("Tipo de mensagem inválido.")
  const body = input.body.trim()
  if (!body) throw new Error("Escreva uma mensagem antes de continuar.")
  if (body.length > TEXT_LIMIT) throw new Error(`Use até ${TEXT_LIMIT.toLocaleString("pt-BR")} caracteres por mensagem.`)
  const now = Date.now()
  if (input.kind === "reply") {
    if (!inboxMessageWindow(conversation, now).can_reply) throw new Error("A janela deste canal terminou. Aguarde uma nova mensagem do contato.")
    if (conversation.status === "closed") throw new Error("Reabra a conversa antes de responder.")
    conversation.automation_paused_until = new Date(now + HOUR / 2).toISOString()
    conversation.unread = false
  }
  const createdAt = new Date(now).toISOString()
  conversation.messages.push({ id: crypto.randomUUID(), source: input.kind === "note" ? "note" : "human", author: "Júlia Martins", body, created_at: createdAt })
  conversation.updated_at = createdAt
  return out(conversation)
}

/** Contrato HTTP W1 ↔ W2. A adaptação mantém as assinaturas usadas pelas telas. */
export type InboxWireConversation = {
  id: string
  contact: { id: string; name: string; avatar_initials: string; avatar_url?: string; email?: string }
  connection_name?: string | null
  connection_id?: string
  connection_profile?: InboxConnectionProfile
  opted_in?: boolean
  channel_type: InboxChannel
  last_message: { text: string; at: string; direction: "in" | "out" }
  unread_count: number
  reminder_at?: string | null
  reminder_note?: string | null
  labels?: { id: string; name: string; color: string }[]
  status: "open" | "closed"
  assignee_id: string | null
  reply_policy?: InboxReplyPolicy
  window_expires_at: string | null
  automation_paused_until: string | null
}
export type InboxWireMessage = InboxRich & {
  id: string; conversation_id: string; direction: "in" | "out"; sender: InboxMessageSource | "broadcast"
  template?: InboxMessage["template"]
  text: string; email_subject?: string; buttons?: { id: string; title: string }[]; created_at: string
  status: "sent" | "delivered" | "failed"; error?: string
  event?: InboxSystemEvent
  sequence?: number
}
export type ContactDeletedEvent = { type: "contact_deleted"; contact_id: Id; conversation_ids: Id[] }
export type InboxLiveEvent = ContactDeletedEvent | { type: "message"; message: InboxWireMessage; conversation: InboxWireConversation } | { type: "conversation"; conversation: InboxWireConversation }
export type InboxConnectionState = "connecting" | "connected" | "reconnecting" | "offline" | "fake"
const realConversations = new Map<string, InboxConversation>()
const deletedConversationIds = new Set<string>()
let cacheWorkspace = ""
async function ensureWorkspace() {
  const workspace = await getWorkspace()
  if (cacheWorkspace !== workspace.workspace_id) { realConversations.clear(); messageCursors.clear(); deletedConversationIds.clear(); cacheWorkspace = workspace.workspace_id }
  return workspace
}
function mapMessage(message: InboxWireMessage): InboxMessage {
  return { id: message.id, source: message.sender === "broadcast" ? "automation" : message.sender, author: ({ contact: "Contato", human: "Equipe", automation: "Automação", note: "Equipe", system: "Sistema", broadcast: "Transmissão" } as Record<string, string>)[message.sender] ?? "", body: message.text, template: message.template, email_subject: message.email_subject, created_at: message.created_at, status: message.status, error: message.error, buttons: message.buttons, event: message.event, sequence: message.sequence,
    ...(message.media ? { media: message.media } : {}), ...(message.location ? { location: message.location } : {}), ...(message.shared_contacts ? { shared_contacts: message.shared_contacts } : {}),
    ...(message.order ? { order: message.order } : {}), ...(message.unsupported ? { unsupported: message.unsupported } : {}), ...(message.reaction ? { reaction: message.reaction } : {}) }
}
function mergeMessages(...groups: InboxMessage[][]) {
  return [...new Map(groups.flat().map(message => [message.id, message])).values()]
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || (a.sequence !== undefined && b.sequence !== undefined ? a.sequence - b.sequence : a.id.localeCompare(b.id)))
}
function upsertConversation(row: InboxWireConversation) {
  const previous = realConversations.get(row.id)
  const next: InboxConversation = {
    id: row.id, workspace_id: cacheWorkspace,
    contact: { id: row.contact.id, name: row.contact.name, avatar_url: row.contact.avatar_url, username: "Não informado", email: row.contact.email ?? "Não informado", timezone: "Não informado", tags: [], fields: [] },
    channel: row.channel_type, connection_name: row.connection_name, connection_id: row.connection_id, connection_profile: row.connection_profile, opted_in: row.opted_in, status: row.status, unread: row.unread_count > 0, assignee_id: row.assignee_id,
    reminder_at: row.reminder_at ?? null, reminder_note: row.reminder_note ?? null, labels: row.labels ?? [], last_inbound_at: row.last_message.direction === "in" ? row.last_message.at : previous?.last_inbound_at ?? row.last_message.at,
    updated_at: row.last_message.at, reply_policy: row.reply_policy, window_expires_at: row.window_expires_at,
    automation_paused_until: row.automation_paused_until, messages: previous?.messages ?? [],
  }
  realConversations.set(row.id, next)
  return next
}
async function fetchConversations(contactFilter?: ContactQueryFilter) {
  const filterParam = contactFilter?.rules.length ? `&contact_filter=${encodeURIComponent(JSON.stringify(contactFilter))}` : ""
  await ensureWorkspace()
  const rows: InboxWireConversation[] = []
  const cursors = new Set<string>()
  let cursor: string | null = null
  do {
    const page: { rows: InboxWireConversation[]; next_cursor: string | null } = await apiRequest(`/inbox/conversations?status=all${filterParam}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
    rows.push(...page.rows.filter(row => !deletedConversationIds.has(row.id)))
    cursor = page.next_cursor
    if (cursor && cursors.has(cursor)) throw new Error("Não foi possível avançar a lista de conversas.")
    if (cursor) cursors.add(cursor)
  } while (cursor)
  const current = rows.filter(row => !deletedConversationIds.has(row.id))
  current.forEach(upsertConversation)
  return current
}
async function realListInbox(filter: InboxFilter): Promise<InboxOverview> {
  // Em paralelo: o pedido de menções sai junto com o da tela e os dois viram um só (junção de GETs em voo).
  const [wireRows, context, mentions] = await Promise.all([fetchConversations(filter.contact_filter), getInboxContext(), listInboxMentions()])
  const realMembers = context.members
  const allRows = wireRows.filter(wire => realConversations.has(wire.id) && !deletedConversationIds.has(wire.id)).map(wire => ({ ...realConversations.get(wire.id)!, preview: wire.last_message.text }))
  // As pastas contam só as conversas abertas, que é o que a lista mostra por padrão.
  const openRows = allRows.filter(row => row.status === "open")
  const q = filter.search?.trim().toLocaleLowerCase("pt-BR")
  const rows = allRows.filter(row => {
    if (filter.folder === "assigned" && row.assignee_id === null) return false
    if (filter.folder === "unassigned" && row.assignee_id !== null) return false
    if (filter.folder === "mine" && (row.assignee_id !== context.current_member_id || row.status !== "open")) return false
    if (filter.folder === "mentions" && !mentions.some(m => m.conversation_id === row.id)) return false
    if (filter.folder === "reminders" && !row.reminder_at) return false
    if (filter.folder?.startsWith("member:") && row.assignee_id !== filter.folder.slice(7)) return false
    if (filter.status && filter.status !== "all" && row.status !== filter.status) return false
    if (filter.unread && !row.unread) return false
    if (filter.channel && filter.channel !== "all" && (filter.channel.startsWith("conn:") ? row.connection_id !== filter.channel.slice(5) : row.channel !== filter.channel)) return false
    if (filter.label_id && !row.labels?.some(l => l.id === filter.label_id)) return false
    return !q || row.contact.name.toLocaleLowerCase("pt-BR").includes(q)
  }).map(({ messages: _messages, ...row }) => row)
    .sort((a,b) => (filter.sort === "oldest" ? 1 : -1) * a.updated_at.localeCompare(b.updated_at))
  return out({ rows, total: rows.length, members: realMembers, current_member_id: context.current_member_id, counts: { open: context.counts.open, mentions: context.counts.mentions, all: openRows.length, unassigned: openRows.filter(row => row.assignee_id === null).length, mine: context.counts.mine, reminders: openRows.filter(row => row.reminder_at).length, members: Object.fromEntries(realMembers.map(member => [member.id, openRows.filter(row => row.assignee_id === member.id).length])) } })
}
async function realGetConversation(id: string): Promise<InboxConversation> {
  await ensureWorkspace()
  await fetchConversations()
  const conversation = realConversations.get(id)
  if (!conversation) throw new Error("Esta conversa não está disponível neste espaço.")
  const page = await apiRequest<{ rows: InboxWireMessage[]; next_before: string | null }>(`/inbox/conversations/${encodeURIComponent(id)}/messages`)
  const current = realConversations.get(id)
  if (!current || deletedConversationIds.has(id)) throw new Error("Esta conversa não está disponível neste espaço.")
  current.messages = mergeMessages(current.messages, page.rows.map(mapMessage))
  messageCursors.set(id, page.next_before)
  return out(current)
}
const messageCursors = new Map<string, string | null>()
export function hasOlderInboxMessages(id: string) { return Boolean(messageCursors.get(id)) }
export async function loadOlderInboxMessages(workspace: string, id: string) {
  if (isFakeMode()) return getInboxConversation(workspace, id)
  const before = messageCursors.get(id)
  if (!before) return realGetConversation(id)
  const page = await apiRequest<{ rows: InboxWireMessage[]; next_before: string | null }>(`/inbox/conversations/${encodeURIComponent(id)}/messages?before=${encodeURIComponent(before)}`)
  const current = realConversations.get(id)
  if (!current || deletedConversationIds.has(id)) throw new Error("Esta conversa não está disponível neste espaço.")
  current.messages = mergeMessages(page.rows.map(mapMessage), current.messages)
  messageCursors.set(id, page.next_before)
  return out(current)
}
async function realMutation(id: string, path: string, body?: unknown) {
  await apiRequest(`/inbox/conversations/${encodeURIComponent(id)}/${path}`, { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return realGetConversation(id)
}
async function realSendMessage(id: string, input: { body: string; kind: "reply" | "note"; mention_member_ids?: string[] }) {
  if (input.kind !== "reply" && input.kind !== "note") throw new Error("Tipo de mensagem inválido.")
  const text = input.body.trim()
  if (!text) throw new Error("Escreva uma mensagem antes de continuar.")
  if (text.length > TEXT_LIMIT) throw new Error("Use até 4.000 caracteres por mensagem.")
  await ensureWorkspace()
  const message = await apiRequest<InboxWireMessage>(`/inbox/conversations/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify({ text, kind: input.kind, ...(input.mention_member_ids?.length ? { mention_member_ids: input.mention_member_ids } : {}) }) })
  const current = realConversations.get(id)
  if (current) current.messages = mergeMessages(current.messages, [mapMessage(message)])
  return realGetConversation(id)
}
/** First contact with a number that never wrote, after the operator confirms consent: an approved template or free text, whichever the connection's ficha allows. */
export async function startInboxConversation(input: { connection_id: string; phone: string; name?: string; consent: true; template?: { id: string; params: Record<string, string> }; text?: string }): Promise<{ conversation: { id: Id } }> {
  if (isFakeMode()) throw new Error("Iniciar conversa precisa do servidor real.")
  await ensureWorkspace()
  return apiRequest("/inbox/conversations", { method: "POST", body: JSON.stringify(input) })
}
export async function sendInboxTemplate(_workspaceId: Id, id: Id, template: { id: string; params: Record<string, string> }): Promise<InboxConversation> {
  await ensureWorkspace()
  const current = realConversations.get(id) ?? await realGetConversation(id)
  const message = await apiRequest<InboxWireMessage>(`/inbox/conversations/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify({ kind: "template", template }) })
  current.messages = mergeMessages(current.messages, [mapMessage(message)])
  // The POST confirmed the send. A later read failure must never invite a duplicate send.
  try { return await realGetConversation(id) } catch { return out(current) }
}

/** Uploads the picked file through the same route the flow editor uses (the connection's own limits apply there), then sends it as a media message of the conversation. */
export async function sendInboxAttachment(_workspaceId: Id, id: Id, input: { file: File; kind: "image" | "file" | "audio" | "video"; connection_id: string }): Promise<InboxConversation> {
  if (isFakeMode()) throw new Error("Enviar anexos precisa do servidor real.")
  await ensureWorkspace()
  const name = input.file.name.slice(0, 255)
  const saved = await apiRequest<{ id: string }>(`/media?connection_id=${encodeURIComponent(input.connection_id)}&media=${input.kind}&name=${encodeURIComponent(name)}`, { method: "POST", headers: { "Content-Type": input.file.type }, body: input.file })
  const message = await apiRequest<InboxWireMessage>(`/inbox/conversations/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify({ kind: "media", media: input.kind, media_id: saved.id, name }) })
  const current = realConversations.get(id) ?? await realGetConversation(id)
  current.messages = mergeMessages(current.messages, [mapMessage(message)])
  // The POST confirmed the send. A later read failure must never invite a duplicate send.
  try { return await realGetConversation(id) } catch { return out(current) }
}

export function cachedInboxConversation(id: string) {
  const value = realConversations.get(id)
  return value ? out(value) : undefined
}

/**
 * Uma conexão por montagem; a limpeza também cancela as tentativas de reconexão.
 * O navegador não mostra o motivo da recusa de um WebSocket: quando ele fecha sem ter aberto, uma consulta à sessão separa
 * queda de rede (segue tentando) de sessão vencida (para e vai para o login), em vez de tentar para sempre.
 */
export function subscribeInbox(
  onEvent: (event: InboxLiveEvent) => void,
  onState: (state: InboxConnectionState) => void,
  options: { createSocket?: (url: string) => WebSocket; schedule?: typeof setTimeout; cancel?: typeof clearTimeout; origin?: string } = {},
): () => void {
  localLiveListeners.add(onEvent)
  if (isFakeMode()) { onState("fake"); return () => { localLiveListeners.delete(onEvent) } }
  const schedule = options.schedule ?? setTimeout
  const cancel = options.cancel ?? clearTimeout
  let stopped = false
  let socket: WebSocket | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  async function connect() {
    if (stopped) return
    onState(attempt ? "reconnecting" : "connecting")
    try {
      const { workspace_id } = await ensureWorkspace()
      if (stopped) return
      const url = new URL("/api/inbox/live", options.origin ?? window.location.origin)
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      url.searchParams.set("workspace", workspace_id)
      socket = options.createSocket ? options.createSocket(url.toString()) : new WebSocket(url.toString())
      let opened = false
      socket.onopen = () => { opened = true; if (!stopped) { attempt = 0; onState("connected") } }
      socket.onmessage = event => {
        if (stopped) return
        try {
          const data = JSON.parse(String(event.data)) as InboxLiveEvent
          if (data.type === "contact_deleted") {
            if (typeof data.contact_id !== "string" || !data.contact_id || !Array.isArray(data.conversation_ids) || data.conversation_ids.some(id => typeof id !== "string" || !id)) return
            forgetInboxContact(cacheWorkspace, data.contact_id, data.conversation_ids, false)
            onEvent(data)
            return
          }
          if ((data.type !== "message" && data.type !== "conversation") || !data.conversation?.id) return
          if (data.type === "message" && (!data.message?.id || data.message.conversation_id !== data.conversation.id)) return
          if (deletedConversationIds.has(data.conversation.id)) return
          const current = upsertConversation(data.conversation)
          if (data.type === "message") current.messages = mergeMessages(current.messages, [mapMessage(data.message)])
          onEvent(data)
        } catch { /* Um evento inválido não interrompe o acompanhamento ao vivo. */ }
      }
      socket.onclose = () => { reconnect(); if (!opened) void giveUpIfSignedOut() }
      socket.onerror = () => socket?.close()
    } catch { reconnect(); void giveUpIfSignedOut() }
  }
  async function giveUpIfSignedOut() {
    if (stopped || !(await signedOut()) || stopped) return
    stopped = true
    if (timer !== undefined) { cancel(timer); timer = undefined }
    onState("offline")
  }
  function reconnect() {
    if (stopped || timer !== undefined) return
    onState("reconnecting")
    const delay = Math.min(30_000, 1_000 * 2 ** attempt++)
    timer = schedule(() => { timer = undefined; void connect() }, delay)
  }
  void connect()
  return () => {
    stopped = true
    localLiveListeners.delete(onEvent)
    if (timer !== undefined) cancel(timer)
    if (socket) { socket.onclose = null; socket.onerror = null; socket.onmessage = null; socket.onopen = null; socket.close() }
  }
}
