import { humanPauseUntil } from '../inbox/team'
import type { InboundEvent as QueuedEvent, IntegrationEnv } from '../integrations'
import { stableId } from '../flow/types'
import { ensureConversation, notifyConversation, recordMessage } from '../inbox/service'
import type { InboundEventV2, SyncContext } from './contract'
import { claimNumber, isPhone, registerNumber } from './core/whatsapp-numbers'
import { zapi } from './zapi'
import { moveConnection } from './core/connection-state'
import { firstInboundOptIn } from './core/consent'

/** Bookkeeping for classic Z-API deliveries once they left the queue: the contact behind a message (united by phone number with the other WhatsApp
 * connections), the connected/disconnected state of the number, delivery receipts, and the account owner writing from their own phone. It is the
 * provider's `syncDelivery` hook. The same jobs exist in the other non official WhatsApp provider's sync file; they are repeated here because that file keeps them private. */

export async function syncZapi(ctx: SyncContext): Promise<void> {
  const { env, event } = ctx
  for (const item of zapi.parseInbound(event.payload, ctx.connection)) {
    if (item.kind === 'connection') await updateState(env, event, item)
    else if (item.kind === 'receipt') await recordReceipt(env, event, item)
    else if (item.kind === 'own_message') await takeOver(env, ctx, event, item)
    else if (item.kind === 'message' || item.kind === 'click') await syncContact(env, event, item)
  }
}

// ---- connection state ----------------------------------------------------------------------------------------------------------
/** ConnectedCallback / DisconnectedCallback (docs: webhooks/on-webhook-connected, on-whatsapp-disconnected): the provider itself proves the state. */
async function updateState(env: IntegrationEnv, event: QueuedEvent, item: Extract<InboundEventV2, { kind: 'connection' }>) {
  // Conexão desativada pela equipe não volta por evento; evento mais velho que a última mudança (ex.: "Atualizar conexão") não vale.
  await moveConnection(env.DB, { id: event.channelId, workspaceId: event.workspaceId, event: 'provider_event', to: item.status, at: event.receivedAt,
    detail: item.status === 'connected' ? null : item.detail ?? 'O número foi desconectado do WhatsApp.' })
}

// ---- contacts ------------------------------------------------------------------------------------------------------------------
async function syncContact(env: IntegrationEnv, event: QueuedEvent, item: Extract<InboundEventV2, { kind: 'message' | 'click' }>) {
  const ws = event.workspaceId, ch = event.channelId, user = item.from.externalUserId
  const find = () => env.DB.prepare('SELECT id,contact_id,phone_e164 FROM contact_channels WHERE workspace_id=? AND channel_id=? AND external_user_id=?')
    .bind(ws, ch, user).first<{ id: string; contact_id: string; phone_e164: string | null }>()
  let row = await find()
  const phone = item.from.phoneE164
  if (!row && item.kind === 'message') {
    const candidate = `wa-${await stableId(ws, ch, user, event.eventId)}`
    const name = item.from.profile?.firstName ?? null
    const contactId = phone ? await claimNumber(env.DB, ws, phone, candidate, ch, name) : candidate
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO contacts (id,workspace_id,first_name,optin_source) SELECT ?,?,?,'whatsapp'
        WHERE NOT EXISTS (SELECT 1 FROM contacts WHERE workspace_id=? AND id=?) ON CONFLICT(id) DO NOTHING`).bind(contactId, ws, name, ws, contactId),
      env.DB.prepare(`INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,identity_kind,address_kind,phone_e164)
        SELECT ?,?,c.id,?,?,'provider_id',?,? FROM contacts c WHERE c.workspace_id=? AND c.id=? AND c.status<>'deleted'
        ON CONFLICT(channel_id,external_user_id) DO NOTHING`)
        .bind(`cc-${await stableId(ch, user)}`, ws, ch, user, item.from.addressKind, isPhone(phone) ? phone : null, ws, contactId),
    ])
    row = await find()
  }
  if (!row) return
  if (isPhone(phone) && !row.phone_e164) {
    await env.DB.prepare('UPDATE contact_channels SET phone_e164=? WHERE workspace_id=? AND id=?').bind(phone, ws, row.id).run()
    await registerNumber(env.DB, ws, phone, row.contact_id, ch)
  }
  // Provider time, capped at reception: a retry cannot make a message look newer than it is.
  const at = Math.min(item.occurredAt ?? event.receivedAt, event.receivedAt)
  await env.DB.batch([
    // Whoever writes first consents to replies; a later opt-out is never undone by a new message.
    env.DB.prepare(`UPDATE contact_channels SET ${firstInboundOptIn(item.kind === 'message', at).sql},
      last_inbound_at=max(coalesce(last_inbound_at,0),?), first_inbound_id=coalesce(first_inbound_id,?) WHERE workspace_id=? AND id=?`)
      .bind(...firstInboundOptIn(item.kind === 'message', at).binds, at, JSON.stringify([event.provider, ch, event.eventId]), ws, row.id),
    env.DB.prepare(`UPDATE contacts SET last_input_text=CASE WHEN coalesce(last_interaction_at,0)<=? THEN coalesce(?,last_input_text) ELSE last_input_text END,
      last_interaction_at=max(coalesce(last_interaction_at,0),?) WHERE workspace_id=? AND id=? AND status<>'deleted'`)
      .bind(at, item.kind === 'message' ? item.text ?? null : null, at, ws, row.contact_id),
  ])
}

// ---- assuming from the phone ---------------------------------------------------------------------------------------------------
/** The owner answered from their own phone: the message joins the conversation as a human reply and the automation of that contact pauses,
 * exactly as a reply from the inbox does. It is never an inbound message of the contact, so it fires no trigger. */
async function takeOver(env: IntegrationEnv, ctx: SyncContext, event: QueuedEvent, item: Extract<InboundEventV2, { kind: 'own_message' }>) {
  if (item.sentByApi) return
  const ws = event.workspaceId, ch = event.channelId, user = item.to.externalUserId
  const target = await env.DB.prepare('SELECT contact_id FROM contact_channels WHERE workspace_id=? AND channel_id=? AND external_user_id=?')
    .bind(ws, ch, user).first<{ contact_id: string }>()
  if (!target) return                                   // a chat of the owner that never wrote to us is not a contact
  const stored = `${ctx.connection.kind}:${ch}:${user}:${item.externalMessageId}`
  if (await env.DB.prepare('SELECT 1 AS found FROM messages WHERE workspace_id=? AND connection_id=? AND external_message_id=?').bind(ws, ch, stored).first()) return
  const conversationId = await ensureConversation(env, ws, target.contact_id, ch)
  await env.DB.batch([
    env.DB.prepare('UPDATE contacts SET automation_paused_until=max(coalesce(automation_paused_until,0),?) WHERE workspace_id=? AND id=?').bind(await humanPauseUntil(env, ws), ws, target.contact_id),
    env.DB.prepare('UPDATE conversations SET unread=0,unread_count=0 WHERE workspace_id=? AND id=?').bind(ws, conversationId),
  ])
  await recordMessage(env, { id: `own-${await stableId(ws, ch, item.externalMessageId)}`, workspaceId: ws, conversationId, direction: 'out', sender: 'human',
    text: item.text ?? '[Mensagem sem texto]', status: 'sent', connectionId: ch, deliveryStatus: 'sent', externalMessageId: stored })
  await notifyConversation(env, ws, conversationId)
}

// ---- receipts ------------------------------------------------------------------------------------------------------------------
const RANK: Record<string, number> = { sent: 0, failed: 1, delivered: 2, read: 3 }
const STALE_RECEIPT_MS = 10 * 60_000
/** Delivery news for a message of this connection, found by the `messageId` Z-API gave at send time (the docs call the `ids` of a status callback "identificador da mensagem"; assumed to be that id).
 * A late 'delivered' never takes a 'read' back. */
async function recordReceipt(env: IntegrationEnv, event: QueuedEvent, item: Extract<InboundEventV2, { kind: 'receipt' }>) {
  const ws = event.workspaceId, ch = event.channelId
  const row = await env.DB.prepare(`SELECT m.id,m.conversation_id,m.delivery_status,json_extract(m.content,'$.zapi.runId') AS run_id,
    json_extract(m.content,'$.zapi.nodeId') AS node_id FROM messages m
    WHERE m.workspace_id=? AND m.connection_id=? AND m.direction='out' AND substr(m.external_message_id,-?)=?`)
    .bind(ws, ch, item.externalMessageId.length + 1, `:${item.externalMessageId}`)
    .first<{ id: string; conversation_id: string; delivery_status: string | null; run_id: string | null; node_id: string | null }>()
  if (!row) {
    // The webhook can overtake the HTTP answer: keep it pending for a retry, but never forever (receipts for messages sent elsewhere).
    if (event.receivedAt > Date.now() - STALE_RECEIPT_MS) throw new Error('Z-API receipt is not yet correlated')
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
