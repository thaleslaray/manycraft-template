import { autoAssign } from './assignment'
import { applyAutoLabels } from './labels'
import { queueInboundAlerts } from '../team-alerts'
import { compileContactFilter } from '../db/contact-filter'
import { humanReplyPolicy } from '../channels/core/reply-policy'
import { effectiveProfile } from '../channels/core/profile-merge'
import type { ChannelKind, ChannelProfile, ProfilePatch, StoredProvider } from '../channels/contract'
import { HTTPException } from 'hono/http-exception'
import type { Env } from '../env'
import { mediaFailureNotice, type SettledMedia } from '../channels/core/inbound-media'
import type { MessageMedia, MessageRich } from './inbound-content'

export type { MessageMedia, MessageRich } from './inbound-content'

export type InboxEnv = Pick<Env, 'DB' | 'INBOX_HUB'>
export type InboxSystemEvent =
  | { kind: 'tag_added' | 'tag_removed'; tag_id: string; tag_name: string }
  | { kind: 'field_changed'; field_id: string; field_name: string; previous_value: unknown; value: unknown }
  | { kind: 'field_skipped'; field_id: string; field_name: string; operation: string; reason: 'operand' | 'current' }
  | { kind: 'delay_started'; automation_id: string; automation_name: string; ends_at: string }
  | { kind: 'trigger'; automation_id: string; automation_name: string; trigger_kind: string }
  | { kind: 'status_changed'; previous_status: 'open' | 'closed'; status: 'open' | 'closed' }
  | { kind: 'automation_paused'; until: string }
export type Message = {
  id: string; conversation_id: string; direction: 'in' | 'out';
  sender: 'contact' | 'automation' | 'human' | 'note' | 'system'; text: string; email_subject?: string; template?: { id: string; params: Record<string, string> }; event?: InboxSystemEvent; sequence?: number;
  buttons?: { id: string; title: string }[]; created_at: string;
  status: 'sent' | 'delivered' | 'failed'; error?: string;
  /** What the contact sent besides text. `media.url` opens the stored file (a path on this API, served to workspace members only). */
  media?: Omit<MessageMedia, 'id' | 'error'> & { url?: string; error?: string }
  location?: MessageRich['location']; shared_contacts?: MessageRich['shared_contacts']; order?: MessageRich['order']; unsupported?: MessageRich['unsupported']
  /** The contact's reaction to this message. */
  reaction?: MessageRich['reaction']
}
export type Conversation = {
  id: string; contact: { id: string; name: string; avatar_initials: string; avatar_url?: string; email?: string }; channel_type: string;
  connection_name: string | null; connection_id: string; connection_profile: ChannelProfile; opted_in: boolean;
  last_message: { text: string; at: string; direction: 'in' | 'out' };
  unread_count: number; status: 'open' | 'closed'; assignee_id: string | null;
  reply_policy: Awaited<ReturnType<typeof humanReplyPolicy>>;
  window_expires_at: string | null; automation_paused_until: string | null;
  reminder_at: string | null; reminder_note: string | null; labels: { id: string; name: string; color: string }[];
}
type StoredMessage = { id: string; conversation_id: string; direction: 'in' | 'out'; source: Message['sender']; content: string; created_at: number; sequence?: number }
type ConversationRow = {
  workspace_id: string; channel_id: string; human_window_expires_at: number | null; last_inbound_at: number | null; provider: StoredProvider; capabilities_override: string | null; opted_in: number;
  id: string; contact_id: string; first_name: string | null; last_name: string | null; profile_pic_url: string | null; channel_type: string;
  connection_name: string | null; external_user_id: string;
  unread_count: number; status: 'open' | 'closed'; assignee_id: string | null; window_expires_at: number | null; reminder_at: number | null; reminder_note: string | null;
  automation_paused_until: number | null; last_message_at: number; last_content: string | null; last_direction: 'in' | 'out' | null;
}
const iso = (value: number | null) => value === null ? null : new Date(value).toISOString()
const selectConversation = `SELECT v.*,c.id AS contact_id,c.first_name,c.last_name,c.profile_pic_url,c.automation_paused_until,
  h.type AS channel_type,h.provider,h.capabilities_override,h.display_name AS connection_name,cc.channel_id,cc.opted_in,cc.external_user_id,cc.window_expires_at,cc.human_window_expires_at,cc.last_inbound_at,
  (SELECT content FROM messages WHERE workspace_id=v.workspace_id AND conversation_id=v.id AND coalesce(json_extract(content,'$.sender'),'') NOT IN ('system','note') ORDER BY created_at DESC,rowid DESC LIMIT 1) AS last_content,
  (SELECT direction FROM messages WHERE workspace_id=v.workspace_id AND conversation_id=v.id AND coalesce(json_extract(content,'$.sender'),'') NOT IN ('system','note') ORDER BY created_at DESC,rowid DESC LIMIT 1) AS last_direction
  FROM conversations v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id
  JOIN contacts c ON c.workspace_id=cc.workspace_id AND c.id=cc.contact_id
  JOIN channels h ON h.workspace_id=cc.workspace_id AND h.id=cc.channel_id`
async function conversationFrom(env: InboxEnv, row: ConversationRow): Promise<Conversation> {
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || 'Contato sem nome'
  const profile = effectiveProfile(row.channel_type as ChannelKind, row.provider, row.capabilities_override ? JSON.parse(row.capabilities_override) as ProfilePatch : undefined)
  // Política de resposta e etiquetas saem juntas (uma onda por conversa).
  const [reply_policy, labels] = await Promise.all([
    humanReplyPolicy(env, { workspaceId: row.workspace_id, contactId: row.contact_id, connectionId: row.channel_id, profile, windowExpiresAt: row.window_expires_at, humanWindowExpiresAt: row.human_window_expires_at, lastInboundAt: row.last_inbound_at, optedIn: !!row.opted_in }),
    env.DB.prepare('SELECT l.id,l.name,l.color FROM conversation_labels cl JOIN inbox_labels l ON l.id=cl.label_id WHERE cl.conversation_id=? ORDER BY l.name')
      .bind(row.id).all<{ id: string; name: string; color: string }>(),
  ])
  return { reply_policy, id: row.id, contact: { id: row.contact_id, name, avatar_initials: name.split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase(),
      ...(row.profile_pic_url ? { avatar_url: row.profile_pic_url } : {}), ...(profile.email ? { email: row.external_user_id } : {}) },
    connection_name: row.connection_name, connection_id: row.channel_id, connection_profile: profile, opted_in: !!row.opted_in,
    channel_type: row.channel_type, last_message: { text: row.last_content ? JSON.parse(row.last_content).text ?? '' : '',
      at: iso(row.last_message_at)!, direction: row.last_direction ?? 'in' }, unread_count: row.unread_count,
    status: row.status, assignee_id: row.assignee_id, window_expires_at: iso(row.window_expires_at),
    automation_paused_until: iso(row.automation_paused_until), reminder_at: iso(row.reminder_at), reminder_note: row.reminder_note ?? null,
    labels: labels.results }
}

/** Lembretes vencidos: a conversa reabre, fica não lida e o histórico mostra a nota. Roda a cada minuto. */
export async function fireDueReminders(env: InboxEnv, now = Date.now()) {
  const due = await env.DB.prepare('SELECT workspace_id,id,reminder_note FROM conversations WHERE reminder_at IS NOT NULL AND reminder_at<=? LIMIT 200')
    .bind(now).all<{ workspace_id: string; id: string; reminder_note: string | null }>()
  for (const row of due.results) {
    const claimed = await env.DB.prepare(`UPDATE conversations SET reminder_at=NULL,reminder_note=NULL,status='open',unread=1,unread_count=unread_count+1
      WHERE workspace_id=? AND id=? AND reminder_at IS NOT NULL AND reminder_at<=? RETURNING id`).bind(row.workspace_id, row.id, now).first()
    if (!claimed) continue
    await recordMessage(env, { id: `reminder-${row.id}-${now}`, workspaceId: row.workspace_id, conversationId: row.id, direction: 'out', sender: 'system',
      text: row.reminder_note ? `Lembrete: ${row.reminder_note}` : 'Lembrete desta conversa.' })
    await notifyConversation(env, row.workspace_id, row.id)
  }
  return due.results.length
}
function wireMedia({ id, error, ...media }: MessageMedia): NonNullable<Message['media']> {
  return { ...media, ...(media.status === 'stored' && id ? { url: `/api/inbox/media/${id}` } : {}), ...(media.status === 'failed' ? { error: mediaFailureNotice(error) } : {}) }
}
export function messageFrom(row: StoredMessage): Message {
  const content = JSON.parse(row.content)
  return { id: row.id, conversation_id: row.conversation_id, direction: row.direction,
    sender: content.sender ?? row.source, text: content.text ?? '', created_at: iso(row.created_at)!,
    status: content.status ?? 'sent', ...(content.email_subject ? { email_subject: content.email_subject } : {}), ...(content.template ? { template: content.template } : {}), ...(content.buttons ? { buttons: content.buttons } : {}),
    ...(content.error ? { error: content.error } : {}), ...(content.event ? { event: content.event } : {}),
    ...(content.media ? { media: wireMedia(content.media) } : {}), ...(content.location ? { location: content.location } : {}),
    ...(content.shared_contacts ? { shared_contacts: content.shared_contacts } : {}), ...(content.order ? { order: content.order } : {}),
    ...(content.unsupported ? { unsupported: content.unsupported } : {}), ...(content.reaction ? { reaction: content.reaction } : {}),
    ...(row.sequence === undefined ? {} : { sequence: row.sequence }) }
}
/** Só a existência (404 igual ao de `getConversation`), com os mesmos joins, sem montar a conversa: uma consulta, nada de política de resposta nem etiquetas. */
export async function assertConversation(env: InboxEnv, workspaceId: string, id: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT 1 AS ok FROM conversations v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id
    JOIN contacts c ON c.workspace_id=cc.workspace_id AND c.id=cc.contact_id JOIN channels h ON h.workspace_id=cc.workspace_id AND h.id=cc.channel_id
    WHERE v.workspace_id=? AND v.id=?`).bind(workspaceId, id).first()
  if (!row) throw new HTTPException(404, { message: 'Conversa não encontrada.' })
}
export async function getConversation(env: InboxEnv, workspaceId: string, id: string): Promise<Conversation> {
  const row = await env.DB.prepare(`${selectConversation} WHERE v.workspace_id=? AND v.id=?`).bind(workspaceId, id).first<ConversationRow>()
  if (!row) throw new HTTPException(404, { message: 'Conversa não encontrada.' })
  return conversationFrom(env, row)
}
/** `contactFilter` é o mesmo filtro da lista de contatos (tags, campos, canal...): o filtro personalizado da caixa de entrada. */
export async function listConversations(env: InboxEnv, workspaceId: string, status: string, cursor?: [number, string], contactFilter?: unknown) {
  const filter = contactFilter === undefined ? null : await compileContactFilter(env.DB, workspaceId, contactFilter)
  const rows = await env.DB.prepare(`${selectConversation} WHERE v.workspace_id=?
    AND (?='all' OR v.status=?) AND (? IS NULL OR (v.last_message_at,v.id)<(?,?))${filter ? ` AND ${filter.sql}` : ''}
    ORDER BY v.last_message_at DESC,v.id DESC LIMIT 51`)
    .bind(workspaceId, status, status, cursor?.[0] ?? null, cursor?.[0] ?? null, cursor?.[1] ?? null, ...(filter?.values ?? [])).all<ConversationRow>()
  const page = rows.results.slice(0, 50), last = page.at(-1)
  return { rows: await Promise.all(page.map(row => conversationFrom(env, row))), next_cursor: rows.results.length > 50 && last ? encodeCursor(last.last_message_at, last.id) : null }
}
export function encodeCursor(at: number, id: string): string { return btoa(JSON.stringify([at, id])) }
export async function listMessages(env: InboxEnv, workspaceId: string, id: string, before?: [number, string]) {
  // A conversa (404 se não existe) e a página de mensagens saem na mesma onda.
  const [, result] = await Promise.all([assertConversation(env, workspaceId, id), env.DB.prepare(`SELECT rowid AS sequence,* FROM messages WHERE workspace_id=? AND conversation_id=?
    AND (? IS NULL OR (created_at,rowid)<(?,coalesce((SELECT rowid FROM messages WHERE workspace_id=? AND conversation_id=? AND id=?),0)))
    ORDER BY created_at DESC,rowid DESC LIMIT 51`)
    .bind(workspaceId, id, before?.[0] ?? null, before?.[0] ?? null, workspaceId, id, before?.[1] ?? null).all<StoredMessage>()])
  const page = result.results.slice(0, 50), oldest = page.at(-1)
  return { rows: page.reverse().map(messageFrom), next_before: result.results.length > 50 && oldest ? encodeCursor(oldest.created_at, oldest.id) : null }
}
export async function ensureConversation(env: InboxEnv, workspaceId: string, contactId: string, channelId: string): Promise<string> {
  // Uma ida só: cria a conversa a partir do vínculo (se faltar) e lê o id. Sem vínculo, nada é criado e a leitura volta vazia.
  const [, found] = await env.DB.batch<{ id: string }>([
    env.DB.prepare(`INSERT INTO conversations (id,workspace_id,contact_channel_id,unread) SELECT 'inbox-'||id,workspace_id,id,0 FROM contact_channels
      WHERE workspace_id=? AND contact_id=? AND channel_id=? ON CONFLICT(contact_channel_id) DO NOTHING`).bind(workspaceId, contactId, channelId),
    env.DB.prepare(`SELECT v.id FROM conversations v JOIN contact_channels cc ON cc.id=v.contact_channel_id
      WHERE cc.workspace_id=? AND cc.contact_id=? AND cc.channel_id=? AND v.workspace_id=?`).bind(workspaceId, contactId, channelId, workspaceId),
  ])
  const id = found?.results[0]?.id
  if (!id) throw new Error('Contact channel missing')
  return id
}
export async function isAutomationPaused(env: InboxEnv, workspaceId: string, contactId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT automation_paused_until FROM contacts WHERE workspace_id=? AND id=?')
    .bind(workspaceId, contactId).first<{ automation_paused_until: number | null }>()
  return !!row?.automation_paused_until && row.automation_paused_until > Date.now()
}
export async function notifyConversation(env: InboxEnv, workspaceId: string, id: string): Promise<Conversation> {
  await notifyTimeline(env, workspaceId)
  const conversation = await getConversation(env, workspaceId, id)
  await env.INBOX_HUB?.get(env.INBOX_HUB.idFromName(workspaceId)).notify({ type: 'conversation', conversation })
  return conversation
}
export type RecordMessageInput = {
  id?: string; workspaceId: string; conversationId: string; direction: Message['direction']; sender: Message['sender'];
  text: string; email_subject?: string; template?: Message['template']; buttons?: Message['buttons']; status?: Message['status']; error?: string; externalMessageId?: string;
  mentionMemberIds?: string[]; createdAt?: number; rich?: MessageRich;
  connectionId?: string; deliveryStatus?: 'sent' | 'delivered' | 'read' | 'failed';
}
export async function recordMessage(env: InboxEnv, input: RecordMessageInput): Promise<Message> {
  return publishRecordedMessage(env, input, await insertMessage(env, input))
}
/** Só grava (idempotente pelo id): o caminho rápido publica no inbox depois do primeiro envio (publishRecordedMessage). */
export async function insertMessage(env: InboxEnv, input: RecordMessageInput): Promise<string> {
  const id = input.id ?? crypto.randomUUID()
  // Persist before publishing. Deterministic inbound/flow IDs make retry safe.
  const insert = env.DB.prepare(`INSERT INTO messages (id,workspace_id,conversation_id,direction,source,external_message_id,content,connection_id,delivery_status,delivery_error${input.createdAt === undefined ? '' : ',created_at'})
    VALUES (?,?,?,?,?,?,?,?,?,?${input.createdAt === undefined ? '' : ',?'}) ON CONFLICT(id) DO NOTHING`).bind(id, input.workspaceId, input.conversationId,
      input.direction, ['note', 'system'].includes(input.sender) ? 'human' : input.sender, input.externalMessageId ?? null,
      JSON.stringify({ sender: input.sender, text: input.text, ...(input.template ? { template: input.template } : {}), status: input.status ?? 'sent',
        ...(input.email_subject ? { email_subject: input.email_subject } : {}), ...(input.buttons ? { buttons: input.buttons } : {}), ...(input.error ? { error: input.error } : {}), ...input.rich }),
      input.connectionId ?? null, input.deliveryStatus ?? null, input.error ?? null, ...(input.createdAt === undefined ? [] : [input.createdAt]))
  await env.DB.batch([insert, ...(input.mentionMemberIds ?? []).map(member => env.DB.prepare(`INSERT INTO inbox_mentions(id,workspace_id,message_id,member_id) VALUES (?,?,?,?) ON CONFLICT(message_id,member_id) DO NOTHING`)
    .bind(crypto.randomUUID(), input.workspaceId, id, member))])
  return id
}
/** O que vem depois da gravação: atribuição, avisos, etiquetas automáticas e a publicação em tempo real. */
export async function publishRecordedMessage(env: InboxEnv, input: RecordMessageInput, id: string): Promise<Message> {
  const stored = await env.DB.prepare('SELECT rowid AS sequence,* FROM messages WHERE workspace_id=? AND conversation_id=? AND id=?')
    .bind(input.workspaceId, input.conversationId, id).first<StoredMessage>()
  if (!stored) throw new Error('Message unavailable')
  // Mensagem do contato em conversa sem responsável: atribuição automática, quando ligada (nunca derruba o recebimento).
  if (input.direction === 'in') {
    const assigned = await autoAssign(env, input.workspaceId, input.conversationId).catch(() => null)
    if (input.sender === 'contact') await queueInboundAlerts(env, input.workspaceId, input.conversationId, input.text, assigned).catch(() => null)
    await applyAutoLabels(env, input.workspaceId, input.conversationId).catch(() => null)
  }
  await notifyTimeline(env, input.workspaceId)
  const message = messageFrom(stored)
  const conversation = await getConversation(env, input.workspaceId, input.conversationId)
  await env.INBOX_HUB?.get(env.INBOX_HUB.idFromName(input.workspaceId)).notify({ type: 'message', message, conversation })
  return message
}

/** Durable event outbox: HTTP remains authoritative; failed notifications are retried on the next mutation.
 * A successful frame may replay if the marker write fails. Consumers deduplicate message IDs.
 */
export async function notifyTimeline(env: InboxEnv, workspaceId: string): Promise<void> {
  if (!env.INBOX_HUB) return
  const rows = await env.DB.prepare(`SELECT rowid AS sequence,* FROM messages
    WHERE workspace_id=? AND timeline_notified=0 AND json_extract(content,'$.sender')='system'
    ORDER BY created_at,rowid`).bind(workspaceId).all<StoredMessage>()
  for (const row of rows.results) {
    const conversation = await getConversation(env, workspaceId, row.conversation_id)
    await env.INBOX_HUB.get(env.INBOX_HUB.idFromName(workspaceId)).notify({ type: 'message', message: messageFrom(row), conversation })
    await env.DB.prepare('UPDATE messages SET timeline_notified=1 WHERE workspace_id=? AND id=?').bind(workspaceId, row.id).run()
  }
}

async function publishMessage(env: InboxEnv, workspaceId: string, conversationId: string, id: string): Promise<void> {
  const stored = await env.DB.prepare('SELECT rowid AS sequence,* FROM messages WHERE workspace_id=? AND conversation_id=? AND id=?').bind(workspaceId, conversationId, id).first<StoredMessage>()
  if (!stored) return
  const conversation = await getConversation(env, workspaceId, conversationId)
  await env.INBOX_HUB?.get(env.INBOX_HUB.idFromName(workspaceId)).notify({ type: 'message', message: messageFrom(stored), conversation })
}

/** The file of an inbound message arrived (or was given up on): the message already in the inbox gets its final state. */
export async function settleMessageMedia(env: InboxEnv, workspaceId: string, conversationId: string, id: string, settled: SettledMedia): Promise<void> {
  const patch = settled.status === 'stored' ? { status: 'stored', id: settled.id, mime: settled.mime, size: settled.size } : { status: 'failed', error: settled.error }
  await env.DB.prepare('UPDATE messages SET content=json_patch(content,json(?)) WHERE workspace_id=? AND id=?').bind(JSON.stringify({ media: patch }), workspaceId, id).run()
  await publishMessage(env, workspaceId, conversationId, id)
}

/** The contact reacted to a message: the reaction hangs on that message. Returns false when the message is not in the inbox (the caller records a line instead). */
export async function setMessageReaction(env: InboxEnv, workspaceId: string, connectionId: string, externalMessageId: string, emoji: string | undefined): Promise<boolean> {
  const target = await env.DB.prepare('SELECT id,conversation_id FROM messages WHERE workspace_id=? AND connection_id=? AND external_message_id=?')
    .bind(workspaceId, connectionId, externalMessageId).first<{ id: string; conversation_id: string }>()
  if (!target) return false
  await env.DB.prepare(emoji === undefined ? "UPDATE messages SET content=json_remove(content,'$.reaction') WHERE workspace_id=? AND id=?"
    : "UPDATE messages SET content=json_set(content,'$.reaction',json(?)) WHERE workspace_id=? AND id=?")
    .bind(...(emoji === undefined ? [] : [JSON.stringify({ emoji })]), workspaceId, target.id).run()
  await publishMessage(env, workspaceId, target.conversation_id, target.id)
  return true
}
