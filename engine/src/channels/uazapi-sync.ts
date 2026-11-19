import { humanPauseUntil } from '../inbox/team'
import type { InboundEvent as QueuedEvent, IntegrationEnv } from '../integrations'
import { stableId } from '../flow/types'
import { ensureConversation, notifyConversation, recordMessage } from '../inbox/service'
import type { InboundEventV2, SyncContext } from './contract'
import { recordGroupMessage, upsertGroupThread } from './core/groups'
import { claimNumber, isPhone, registerNumber } from './core/whatsapp-numbers'
import { instanceApi, isDirectJid, optionOf, phoneOfJid, uazapi } from './uazapi'
import { moveConnection } from './core/connection-state'
import { firstInboundOptIn } from './core/consent'

/** The bookkeeping UAZAPI deliveries need once they left the queue: the contact behind a message, receipts, the account owner writing from
 * their own phone ("assumir pelo celular"), the connection's state, and the per-connection options. It is the provider's `syncDelivery` hook. */
/** What the helpers below need of the connection: the contract's sync context, with the credentials already opened. */
type Rt = { connection: SyncContext['connection']; credentials: () => Promise<SyncContext['credentials']>; fetch: SyncContext['fetch'] }

export async function syncUazapi(ctx: SyncContext): Promise<void> {
  const { env, event } = ctx
  const rt: Rt = { connection: ctx.connection, credentials: async () => ctx.credentials, fetch: ctx.fetch }
  const payload = event.payload
  if (payload.EventType === 'call') return handleCall(env, rt, event)
  const events = uazapi.parseInbound(payload, rt.connection)
  for (const item of events) {
    if (item.kind === 'connection') await updateState(env, event, item)
    else if (item.kind === 'receipt') await recordReceipt(env, event, item)
    else if (item.kind === 'own_message') await takeOver(env, rt, event, item)
    else if (item.kind === 'message' && item.thread.kind === 'group') await syncGroupMessage(env, event, item, item.thread)
    else if (item.kind === 'message' || item.kind === 'click') {
      await syncContact(env, event, item)
      if (item.kind === 'message') await markRead(rt, item.externalMessageId)
    } else if (item.kind === 'ignored' && item.why === 'Message could not be opened') await answerUnopened(env, rt, event)
  }
}

// ---- connection state -----------------------------------------------------------------------------------------------------------
async function updateState(env: IntegrationEnv, event: QueuedEvent, item: Extract<InboundEventV2, { kind: 'connection' }>) {
  // Conexão desativada pela equipe não volta por evento; evento mais velho que a última mudança (ex.: "Atualizar conexão") não vale.
  await moveConnection(env.DB, { id: event.channelId, workspaceId: event.workspaceId, event: 'provider_event', to: item.status, at: event.receivedAt,
    detail: item.status === 'connected' ? null : item.detail ?? 'O número foi desconectado do WhatsApp.',
    also: { sql: "sync_cursor=CASE WHEN ?='connected' THEN coalesce(sync_cursor,?) ELSE sync_cursor END", binds: [item.status, event.receivedAt] } })
}

// ---- contacts ------------------------------------------------------------------------------------------------------------------
type Contacted = Extract<InboundEventV2, { kind: 'message' | 'click' }>
async function syncContact(env: IntegrationEnv, event: QueuedEvent, item: Contacted, options: { group?: boolean } = {}): Promise<string | undefined> {
  const ws = event.workspaceId, ch = event.channelId, jid = item.from.externalUserId
  const find = () => env.DB.prepare('SELECT id,contact_id,phone_e164 FROM contact_channels WHERE workspace_id=? AND channel_id=? AND external_user_id=?')
    .bind(ws, ch, jid).first<{ id: string; contact_id: string; phone_e164: string | null }>()
  let row = await find()
  const phone = item.from.phoneE164
  if (!row && item.kind === 'message') {
    const candidate = `wa-${await stableId(ws, ch, jid, event.eventId)}`
    const name = item.from.profile?.firstName ?? null
    const contactId = phone ? await claimNumber(env.DB, ws, phone, candidate, ch, name) : candidate
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO contacts (id,workspace_id,first_name,optin_source) SELECT ?,?,?,'whatsapp'
        WHERE NOT EXISTS (SELECT 1 FROM contacts WHERE workspace_id=? AND id=?) ON CONFLICT(id) DO NOTHING`).bind(contactId, ws, name, ws, contactId),
      env.DB.prepare(`INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,identity_kind,address_kind,phone_e164)
        SELECT ?,?,c.id,?,?,'provider_id',?,? FROM contacts c WHERE c.workspace_id=? AND c.id=? AND c.status<>'deleted'
        ON CONFLICT(channel_id,external_user_id) DO NOTHING`)
        .bind(`cc-${await stableId(ch, jid)}`, ws, ch, jid, item.from.addressKind, isPhone(phone) ? phone : null, ws, contactId),
    ])
    row = await find()
  }
  if (!row) return undefined
  if (isPhone(phone) && !row.phone_e164) {
    await env.DB.prepare('UPDATE contact_channels SET phone_e164=? WHERE workspace_id=? AND id=?').bind(phone, ws, row.id).run()
    await registerNumber(env.DB, ws, phone, row.contact_id, ch)
  }
  // Provider time, capped at reception: a retry cannot make a message look newer than it is.
  const at = Math.min(item.occurredAt ?? event.receivedAt, event.receivedAt)
  if (options.group) return row.contact_id
  await env.DB.batch([
    // Whoever writes first consents to replies; a later opt-out is never undone by a new message.
    env.DB.prepare(`UPDATE contact_channels SET ${firstInboundOptIn(item.kind === 'message', at).sql},
      last_inbound_at=max(coalesce(last_inbound_at,0),?), first_inbound_id=coalesce(first_inbound_id,?) WHERE workspace_id=? AND id=?`)
      .bind(...firstInboundOptIn(item.kind === 'message', at).binds, at, JSON.stringify([event.provider, ch, event.eventId]), ws, row.id),
    env.DB.prepare(`UPDATE contacts SET last_input_text=CASE WHEN coalesce(last_interaction_at,0)<=? THEN coalesce(?,last_input_text) ELSE last_input_text END,
      last_interaction_at=max(coalesce(last_interaction_at,0),?) WHERE workspace_id=? AND id=? AND status<>'deleted'`)
      .bind(at, item.kind === 'message' ? item.text ?? null : null, at, ws, row.contact_id),
  ])
  return row.contact_id
}

// ---- groups --------------------------------------------------------------------------------------------------------------------
/** A message written in a group: the group is a thread of its own, the author becomes a contact, and nothing opens a private conversation.
 * The author's row keeps opted_in=0 and no first inbound: writing in a group is neither consent nor a window for a direct message. */
async function syncGroupMessage(env: IntegrationEnv, event: QueuedEvent, item: Extract<InboundEventV2, { kind: 'message' }>, thread: { externalGroupId: string; subject?: string }) {
  const ws = event.workspaceId, ch = event.channelId
  const at = Math.min(item.occurredAt ?? event.receivedAt, event.receivedAt)
  const contactId = await syncContact(env, event, item, { group: true })
  const threadId = await upsertGroupThread(env, ws, ch, thread.externalGroupId, thread.subject, at)
  await recordGroupMessage(env, { workspaceId: ws, threadId, direction: 'in', externalMessageId: item.externalMessageId, authorContactId: contactId ?? null,
    mentionsMe: item.mentionsMe === true, text: item.text ?? '', at })
}

// ---- assuming from the phone ---------------------------------------------------------------------------------------------------
/** The owner answered from their own phone: the message joins the conversation as a human reply and the automation of that contact pauses,
 * exactly as a reply from the inbox does. It is never an inbound message of the contact, so it fires no trigger. */
async function takeOver(env: IntegrationEnv, rt: Rt, event: QueuedEvent, item: Extract<InboundEventV2, { kind: 'own_message' }>) {
  if (item.sentByApi) return
  const ws = event.workspaceId, ch = event.channelId, jid = item.to.externalUserId
  const target = await env.DB.prepare('SELECT contact_id FROM contact_channels WHERE workspace_id=? AND channel_id=? AND external_user_id=?')
    .bind(ws, ch, jid).first<{ contact_id: string }>()
  if (!target) return                                   // a chat of the owner that never wrote to us is not a contact
  // The layer's own sends are recognised by the message id they were stored with, and never recorded twice.
  const known = await env.DB.prepare(`SELECT 1 AS found FROM messages WHERE workspace_id=? AND connection_id=? AND external_message_id=?`)
    .bind(ws, ch, `${rt.connection.kind}:${ch}:${jid}:${item.externalMessageId}`).first()
  if (known) return
  const conversationId = await ensureConversation(env, ws, target.contact_id, ch)
  const until = await humanPauseUntil(env, ws)
  await env.DB.batch([
    env.DB.prepare('UPDATE contacts SET automation_paused_until=max(coalesce(automation_paused_until,0),?) WHERE workspace_id=? AND id=?').bind(until, ws, target.contact_id),
    env.DB.prepare('UPDATE conversations SET unread=0,unread_count=0 WHERE workspace_id=? AND id=?').bind(ws, conversationId),
  ])
  await recordMessage(env, { id: `own-${await stableId(ws, ch, item.externalMessageId)}`, workspaceId: ws, conversationId, direction: 'out', sender: 'human',
    text: item.text ?? '[Mensagem sem texto]', status: 'sent', connectionId: ch, deliveryStatus: 'sent',
    externalMessageId: `${rt.connection.kind}:${ch}:${jid}:${item.externalMessageId}` })
  await notifyConversation(env, ws, conversationId)
}

// ---- receipts ------------------------------------------------------------------------------------------------------------------
const RANK: Record<string, number> = { sent: 0, failed: 1, delivered: 2, read: 3 }
const STALE_RECEIPT_MS = 10 * 60_000
/** Delivery news for a message of this connection. Found by the provider's message id; a late 'delivered' never takes a 'read' back. */
async function recordReceipt(env: IntegrationEnv, event: QueuedEvent, item: Extract<InboundEventV2, { kind: 'receipt' }>) {
  const ws = event.workspaceId, ch = event.channelId
  const row = await env.DB.prepare(`SELECT m.id,m.conversation_id,m.delivery_status,json_extract(m.content,'$.uazapi.runId') AS run_id,
    json_extract(m.content,'$.uazapi.nodeId') AS node_id FROM messages m
    WHERE m.workspace_id=? AND m.connection_id=? AND m.direction='out' AND substr(m.external_message_id,-?)=?`)
    .bind(ws, ch, item.externalMessageId.length + 1, `:${item.externalMessageId}`)
    .first<{ id: string; conversation_id: string; delivery_status: string | null; run_id: string | null; node_id: string | null }>()
  if (!row) {
    // The webhook can overtake the HTTP confirmation: keep it pending for a retry, but never forever (receipts for messages sent elsewhere).
    if (event.receivedAt > Date.now() - STALE_RECEIPT_MS) throw new Error('UAZAPI receipt is not yet correlated')
    return
  }
  const status = (RANK[row.delivery_status ?? 'sent'] ?? 0) > RANK[item.status] ? row.delivery_status! : item.status
  const statements: D1PreparedStatement[] = []
  if (row.run_id && row.node_id) {
    const run = await env.DB.prepare(`SELECT r.contact_id,v.automation_id FROM flow_runs r JOIN automation_versions v ON v.workspace_id=r.workspace_id AND v.id=r.automation_version_id
      WHERE r.workspace_id=? AND r.id=?`).bind(ws, row.run_id).first<{ contact_id: string; automation_id: string }>()
    if (run) for (const type of item.status === 'read' ? ['delivered', 'read'] : [item.status]) statements.push(env.DB.prepare(
      `INSERT INTO node_events (workspace_id,automation_id,node_id,contact_id,flow_run_id,type,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
      .bind(ws, run.automation_id, row.node_id, run.contact_id, row.run_id, type, item.occurredAt ?? event.receivedAt))
  }
  statements.push(env.DB.prepare(`UPDATE messages SET content=json_set(content,'$.status',?),delivery_status=? WHERE workspace_id=? AND id=?
    AND CASE coalesce(delivery_status,'sent') WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'failed' THEN 1 ELSE 0 END <= ?`)
    .bind(status === 'read' ? 'delivered' : status, status, ws, row.id, RANK[status]))
  await env.DB.batch(statements)
  await notifyConversation(env, ws, row.conversation_id)
}

// ---- options of the connection (off by default) ----------------------------------------------------------------------------------
const apiOf = (rt: Rt, credentials: Record<string, string>) => ({ connection: rt.connection, credentials, fetch: rt.fetch })
const on = (rt: Rt, key: string) => optionOf(rt.connection, key) === true
const text = (rt: Rt, key: string) => { const v = optionOf(rt.connection, key); return typeof v === 'string' && v.trim() ? v.trim() : undefined }

/** Option "marcar como lida ao receber". Best effort: a failure here must not make the queue retry the event. */
async function markRead(rt: Rt, messageId: string) {
  if (!on(rt, 'markRead')) return
  try { await instanceApi.markRead(apiOf(rt, await rt.credentials()), [messageId]) } catch { /* cosmetic */ }
}

/** Sends an automatic text and, when the person already has a conversation, records it there. */
async function autoReply(env: IntegrationEnv, rt: Rt, event: QueuedEvent, jid: string, body: string, key: string) {
  if (!isDirectJid(jid)) return
  const ws = event.workspaceId, ch = event.channelId
  const id = `auto-${await stableId(ws, ch, key)}`
  if (await env.DB.prepare('SELECT 1 AS found FROM messages WHERE workspace_id=? AND id=?').bind(ws, id).first()) return   // a retry never answers twice
  try {
    const reply = await instanceApi.sendText(apiOf(rt, await rt.credentials()), jid, body)
    const sent = (reply.data as { messageid?: unknown } | null)?.messageid
    const contact = await env.DB.prepare('SELECT contact_id FROM contact_channels WHERE workspace_id=? AND channel_id=? AND external_user_id=?').bind(ws, ch, jid).first<{ contact_id: string }>()
    if (reply.status === 200 && contact) {
      await recordMessage(env, { id, workspaceId: ws, conversationId: await ensureConversation(env, ws, contact.contact_id, ch), direction: 'out', sender: 'automation',
        text: body, status: 'sent', connectionId: ch, deliveryStatus: 'sent', ...(typeof sent === 'string' ? { externalMessageId: `${rt.connection.kind}:${ch}:${jid}:${sent}` } : {}) })
    }
  } catch { /* the contact simply gets no automatic text */ }
}

/** Option "texto para mensagem que não pôde ser aberta". Docs (reloadMessage): such a message arrives with messageType "error". */
async function answerUnopened(env: IntegrationEnv, rt: Rt, event: QueuedEvent) {
  const body = text(rt, 'unopenedMessageText')
  const message = event.payload.message as { chatid?: unknown } | undefined
  const chat = typeof message?.chatid === 'string' ? message.chatid : undefined
  if (body && chat) await autoReply(env, rt, event, chat, body, `unopened:${event.eventId}`)
}

/** Option "recusar ligação com mensagem configurável". Docs: POST /call/reject takes the call id; the caller is event.From / sender_pn. */
async function handleCall(env: IntegrationEnv, rt: Rt, event: QueuedEvent) {
  if (!on(rt, 'rejectCalls')) return
  const call = event.payload.event as { CallID?: unknown; From?: unknown } | undefined
  const callId = typeof call?.CallID === 'string' ? call.CallID : undefined
  if (!callId) return
  const caller = [event.payload.sender_pn, call?.From, event.payload.chatid].find((v): v is string => typeof v === 'string' && isDirectJid(v))
  try { await instanceApi.rejectCall(apiOf(rt, await rt.credentials()), phoneOfJid(caller)?.slice(1), callId) } catch { /* the call simply keeps ringing */ }
  const body = text(rt, 'rejectCallMessage')
  if (body && caller) await autoReply(env, rt, event, caller, body, `call:${callId}`)
}
