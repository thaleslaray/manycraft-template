import type { IntegrationEnv, InboundEvent as QueuedEvent } from '../integrations'
import type { AdapterEnv } from './core/credentials'
import { getWhatsappIdentity, promotePhoneIdentity, upsertWhatsappIdentity } from '../db/contacts'
import { stableId } from '../flow/types'
import { notifyConversation } from '../inbox/service'
import { effectiveProfile } from './core/profile-merge'
import { canSend } from './policy'
import { viewCredentials } from './core/credentials'
import { deliverAutomation, storedConnection } from './core/delivery'
import { receiptFailureNotice } from './core/failure'
import { recordContactOrigin } from './core/origin'
import { claimNumber, registerNumber } from './core/whatsapp-numbers'
import { bsuid, metaWhatsappCloud } from './meta-whatsapp-cloud'
import type { ChannelAdapter, ContactChannelState, InboundEvent, OutboundMessage, SendContext, SendResult } from './types'
import { firstInboundOptIn } from './core/consent'

export { WHATSAPP_GRAPH_VERSION } from './meta-whatsapp-cloud'
const rejected = (code: string): SendResult => ({ ok: false, reason: 'rejected', code, detail: 'WhatsApp rejected send; check channel configuration' })

/** ChannelAdapter facade over the meta_whatsapp_cloud provider, for callers that still hold the pre-layer interface
 * (the flow executor, broadcasts). Transport and parsing live in meta-whatsapp-cloud.ts; sending goes through core/delivery.
 * What stays here is WhatsApp's own consent bookkeeping: the identity rows, the 24h window and the receipt correlation. */
export class WhatsAppAdapter implements ChannelAdapter {
  constructor(private readonly env: AdapterEnv) {}
  capabilities() { return effectiveProfile('whatsapp', 'meta_whatsapp_cloud') }
  canSend(contact: ContactChannelState, now: number, intent: 'automation' | 'human' | 'broadcast') {
    return canSend(this.capabilities(), contact, now, intent)
  }
  fit: ChannelAdapter['fit'] = (message, caps) => metaWhatsappCloud.fit(message, caps)
  async send(ctx: SendContext, message: OutboundMessage): Promise<SendResult> {
    const credentials = viewCredentials('whatsapp', this.env)
    const connection = await storedConnection(this.env, 'whatsapp', ctx.run.workspace_id, ctx.channelId)
    let nodeId = ''
    return deliverAutomation(this.env, { connection, provider: metaWhatsappCloud, credentials: async () => credentials }, ctx, message, {
      // Only the BSUID identity of this very run, on a connected number that is the configured one.
      prepare: async () => {
        if (ctx.run.channel_type !== 'whatsapp' || !bsuid.safeParse(ctx.externalUserId).success) return rejected('context_mismatch')
        const state = await this.env.DB.prepare(`SELECT r.current_node_id
          FROM contact_channels cc JOIN channels ch ON ch.workspace_id=cc.workspace_id AND ch.id=cc.channel_id
          JOIN contacts c ON c.workspace_id=cc.workspace_id AND c.id=cc.contact_id
          JOIN flow_runs r ON r.workspace_id=cc.workspace_id AND r.contact_id=cc.contact_id AND r.channel_id=cc.channel_id
          WHERE cc.workspace_id=? AND cc.channel_id=? AND cc.contact_id=? AND cc.external_user_id=? AND cc.identity_kind='bsuid'
          AND ch.type='whatsapp' AND ch.status='connected' AND ch.external_id=? AND r.id=?`)
          .bind(ctx.run.workspace_id, ctx.channelId, ctx.run.contact_id, ctx.externalUserId, credentials.phoneNumberId, ctx.runId)
          .first<{ current_node_id: string | null }>()
        if (!state?.current_node_id) return rejected('channel_not_configured')
        nodeId = state.current_node_id
      },
      // Consent and window are re-read from the database for every part, right before the claim and again before the network call.
      guard: async (part) => {
        const identity = await getWhatsappIdentity(this.env.DB, ctx.run.workspace_id, ctx.channelId, ctx.externalUserId)
        const channel = await this.env.DB.prepare(`SELECT c.status,ch.status AS channel_status FROM contacts c JOIN channels ch
          ON ch.workspace_id=c.workspace_id WHERE c.workspace_id=? AND c.id=? AND ch.id=?`)
          .bind(ctx.run.workspace_id, ctx.run.contact_id, ctx.channelId).first<{ status: string; channel_status: string }>()
        if (!identity || identity.contact_id !== ctx.run.contact_id || channel?.channel_status !== 'connected') return rejected('channel_not_configured')
        // getWhatsappIdentity decodes the INTEGER column to an ISO string. The connection's own profile decides, not the base one.
        const mode = canSend(connection.profile, { optedIn: identity.opted_in && channel.status === 'subscribed',
          windowExpiresAt: identity.window_expires_at ? Date.parse(identity.window_expires_at) : null, humanWindowExpiresAt: null }, Date.now(), 'automation')
        if (!mode.ok && !(part.kind === 'template' && mode.reason === 'outside_window')) return mode
      },
      // Existing JSON storage carries receipt correlation without a schema or inbox contract change.
      afterSend: async (sent) => {
        const messageId = `out-${await stableId(sent.runId, String(sent.step), String(sent.part))}`
        await this.env.DB.prepare(`UPDATE messages SET content=json_set(content,'$.whatsapp',
          coalesce(json_extract(content,'$.whatsapp'),json(?))) WHERE workspace_id=? AND id=?`)
          .bind(JSON.stringify({ runId: sent.runId, nodeId }), sent.run.workspace_id, messageId).run()
      },
    })
  }
}

/** Called only for the signed durable queue; no phone lookup or automatic re-opt-in. */
export async function syncWhatsappContact(event: QueuedEvent, input: Extract<InboundEvent, { kind: 'message' | 'click' }>, env: IntegrationEnv) {
  let identity = await getWhatsappIdentity(env.DB, event.workspaceId, event.channelId, input.externalUserId)
  if (!identity && input.kind === 'message' && input.profile?.phoneE164 && await promotePhoneIdentity(env.DB, event.workspaceId, event.channelId, input.externalUserId, input.profile.phoneE164))
    identity = await getWhatsappIdentity(env.DB, event.workspaceId, event.channelId, input.externalUserId)
  if (input.kind === 'message') {
    // The same number reaching us through another connection (another provider) is the same person: the number owns the contact.
    const candidate = `wa-${await stableId(event.workspaceId, event.channelId, input.externalUserId, event.eventId)}`
    const phone = input.profile?.phoneE164
    const contactId = identity?.contact_id ?? (phone ? await claimNumber(env.DB, event.workspaceId, phone, candidate, event.channelId, input.profile?.firstName ?? null) : candidate)
    identity = await upsertWhatsappIdentity(env.DB, event.workspaceId, { contact_id: contactId, channel_id: event.channelId,
      bsuid: input.externalUserId, ...(input.profile?.phoneE164 ? { phone_e164: input.profile.phoneE164 } : {}),
      ...(input.profile?.username ? { username: input.profile.username } : {}) },
      identity ? undefined : { firstName: input.profile?.firstName ?? null })
  }
  if (!identity) return
  if (input.kind === 'message' && input.profile?.phoneE164) await registerNumber(env.DB, event.workspaceId, input.profile.phoneE164, identity.contact_id, event.channelId)
  // Use provider time, capped at reception: retries cannot extend a 24h window.
  const at = Math.min(input.occurredAt ?? event.receivedAt, event.receivedAt)
  await env.DB.batch([
    // A contact who starts the conversation consents to replies; only the very first inbound grants it,
    // so a later opt-out is never undone by a new message.
    env.DB.prepare(`UPDATE contact_channels SET ${firstInboundOptIn(input.kind === 'message', at).sql},
      window_expires_at=max(coalesce(window_expires_at,0),?),
      last_inbound_at=max(coalesce(last_inbound_at,0),?),
      first_inbound_id=coalesce(first_inbound_id,?) WHERE workspace_id=? AND id=?`)
      .bind(...firstInboundOptIn(input.kind === 'message', at).binds, at + 86400000, at, JSON.stringify([event.provider, event.channelId, event.eventId]), event.workspaceId, identity.id),
    env.DB.prepare(`UPDATE contacts SET last_input_text=CASE WHEN coalesce(last_interaction_at,0)<=? THEN coalesce(?,last_input_text) ELSE last_input_text END,
      last_interaction_at=max(coalesce(last_interaction_at,0),?) WHERE workspace_id=? AND id=? AND status<>'deleted'`)
      .bind(at, input.kind === 'message' ? input.text ?? null : null, at, event.workspaceId, identity.contact_id),
    ...(input.kind === 'message' && input.origin ? [recordContactOrigin(env.DB, event.workspaceId, identity.contact_id, input.origin, at)] : []),
  ])
}

const STALE_RECEIPT_MS = 10 * 60_000
/** Correlate by tenant + channel + provider message ID, never the run's current node. */
export async function recordWhatsappReceipt(event: QueuedEvent, receipt: Extract<InboundEvent, { kind: 'receipt' }>, env: IntegrationEnv) {
  const prefix = `whatsapp:${event.channelId}:`
  const rows = await env.DB.prepare(`SELECT m.id,m.conversation_id,m.content,r.id AS run_id,r.contact_id,v.automation_id,
    json_extract(m.content,'$.whatsapp.nodeId') AS node_id
    FROM flow_outbound o JOIN flow_runs r ON r.id=o.run_id
    JOIN automation_versions v ON v.workspace_id=r.workspace_id AND v.id=r.automation_version_id
    JOIN contact_channels cc ON cc.workspace_id=r.workspace_id AND cc.contact_id=r.contact_id AND cc.channel_id=r.channel_id
    JOIN messages m ON m.workspace_id=r.workspace_id AND m.external_message_id=?||cc.external_user_id||':'||o.external_message_id
    WHERE r.workspace_id=? AND r.channel_id=? AND o.external_message_id=?`)
    .bind(prefix, event.workspaceId, event.channelId, receipt.externalMessageId)
    .first<{ id: string; conversation_id: string; content: string; run_id: string; contact_id: string; automation_id: string; node_id: string | null }>()
  // Suffix match by substr, not LIKE: D1 refuses LIKE patterns as long as a Meta wamid ("pattern too complex").
  // Sent by a person from the inbox (reply or opening template): no flow_outbound row, only the message itself. No automation, so no node_events.
  const human = rows?.node_id ? null : await env.DB.prepare(`SELECT id,conversation_id,content FROM messages
    WHERE workspace_id=? AND connection_id=? AND direction='out' AND substr(external_message_id,-?)=?`)
    .bind(event.workspaceId, event.channelId, receipt.externalMessageId.length + 1, `:${receipt.externalMessageId}`)
    .first<{ id: string; conversation_id: string; content: string }>()
  if (!rows?.node_id && !human) {
    // The webhook may overtake the HTTP confirmation/correlation write: keep it pending for retry, but never forever (ids sent elsewhere).
    if (event.receivedAt > Date.now() - STALE_RECEIPT_MS) throw new Error('WhatsApp receipt is not yet correlated')
    return
  }
  const target = (rows?.node_id ? rows : human)!
  const kinds = receipt.status === 'read' ? ['delivered', 'read'] : [receipt.status]
  const previous = JSON.parse(target.content).whatsappStatus as string | undefined
  const ranks: Record<string, number> = { sent: 0, failed: 1, delivered: 2, read: 3 }
  const status = (ranks[previous ?? 'sent'] ?? 0) > ranks[receipt.status] ? previous! : receipt.status
  const writesError = status === 'failed' && receipt.status === 'failed'
  const reason = receiptFailureNotice(receipt.errors ?? []) ?? 'O canal não confirmou o envio. Confira a conversa antes de reenviar.'
  await env.DB.batch([
    ...(rows?.node_id ? kinds.map(type => env.DB.prepare(`INSERT INTO node_events(workspace_id,automation_id,node_id,contact_id,flow_run_id,type,created_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(event.workspaceId, rows.automation_id, rows.node_id, rows.contact_id,
      rows.run_id, type, receipt.occurredAt ?? event.receivedAt)) : []),
    // A late 'sent' or 'delivered' never takes the state back from a 'read' that already arrived.
    // A failure keeps what Meta said (code, title, detail) and the reason in plain pt-BR; a later better state drops both.
    // A lower-ranked receipt that arrives after the failure (a late 'sent') says nothing about the error: it leaves the reason as it was.
    env.DB.prepare(`UPDATE messages SET content=${writesError
      ? "json_set(content,'$.whatsappStatus',?,'$.status',?,'$.whatsappErrors',json(?),'$.error',?,'$.deliveryErrorCode',?)"
      : status === 'failed' ? "json_set(content,'$.whatsappStatus',?,'$.status',?)"
      : "json_remove(json_set(content,'$.whatsappStatus',?,'$.status',?),'$.whatsappErrors','$.error','$.deliveryErrorCode')"},delivery_status=?${writesError ? ',delivery_error=?' : status === 'failed' ? '' : ',delivery_error=NULL'} WHERE workspace_id=? AND id=?
      AND CASE coalesce(json_extract(content,'$.whatsappStatus'),'sent')
        WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'failed' THEN 1 ELSE 0 END <= ?`)
      .bind(status, status === 'read' ? 'delivered' : status, ...(writesError ? [JSON.stringify(receipt.errors ?? []), reason, receipt.errors?.[0]?.code === undefined ? null : String(receipt.errors[0].code)] : []), status,
        ...(writesError ? [reason] : []), event.workspaceId, target.id, ranks[status]),
  ])
  await notifyConversation(env, event.workspaceId, target.conversation_id)
}
