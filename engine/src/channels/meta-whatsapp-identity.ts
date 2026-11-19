import { z } from 'zod'
import type { SyncContext } from './contract'

/** A contact changed phone number or BSUID: `messages` webhook of type `system`
 * (webhooks/reference/messages/system.md; business-scoped-user-ids.md: "regenerated if a user changes their phone number").
 * The notice carries the new `user_id` and, when available, `previous_user_id`.
 *
 * Identities are immutable by design (trigger whatsapp_identity_update: "a verified BSUID is a new channel identity linked explicitly to the
 * existing contact, never a key rewrite"), so the new BSUID becomes a new `contact_channels` row of the SAME contact. It inherits the consent
 * and the 24h window of the row it replaces, so the person is not reborn as a stranger without opt-in. The replaced row stays for history and
 * for receipts of messages already sent, but stops receiving broadcasts (otherwise the same person would be addressed twice). */
const bsuidPattern = /^[A-Z]{2}\.(?:ENT\.)?[A-Za-z0-9]{1,128}$/
const digits = /^[1-9]\d{6,14}$/
const notice = z.object({ from: z.string().regex(digits).optional(), system: z.object({
  type: z.enum(['user_changed_number', 'user_changed_user_id']), user_id: z.string().regex(bsuidPattern),
  previous_user_id: z.string().regex(bsuidPattern).optional(), wa_id: z.string().regex(digits).optional() }) })

export async function recordIdentityChange(ctx: SyncContext): Promise<void> {
  const parsed = notice.safeParse(ctx.event.payload)
  if (!parsed.success) return
  const { from, system } = parsed.data
  const db = ctx.env.DB, workspaceId = ctx.event.workspaceId, channelId = ctx.connection.id
  const known = await db.prepare('SELECT 1 AS found FROM contact_channels WHERE channel_id=? AND external_user_id=?').bind(channelId, system.user_id).first()
  if (known) return
  let source = system.previous_user_id
    ? await db.prepare("SELECT id FROM contact_channels WHERE workspace_id=? AND channel_id=? AND identity_kind='bsuid' AND external_user_id=?")
      .bind(workspaceId, channelId, system.previous_user_id).first<{ id: string }>() : null
  if (!source && from) {
    // The previous BSUID is optional in the notice (or one we never saw): the number the person had is how we knew them.
    const old = `+${from}`
    const found = await db.prepare(`SELECT id FROM contact_channels WHERE workspace_id=? AND channel_id=? AND identity_kind='bsuid'
      AND (phone_e164=? OR id IN (SELECT contact_channel_id FROM contact_identity_aliases WHERE channel_id=? AND alias_kind='phone_e164' AND alias_value=?)) LIMIT 2`)
      .bind(workspaceId, channelId, old, channelId, old).all<{ id: string }>()
    // Two rows with that number would be two different people: never guess.
    if (found.results.length === 1) source = found.results[0]
  }
  if (!source) return
  const phone = system.type === 'user_changed_number' && system.wa_id ? `+${system.wa_id}` : null
  const newId = `cc-${crypto.randomUUID()}`
  await db.batch([
    // Consent and block go with their times (channels/core/consent.ts): without them a late older STOP/START or block would apply to the new row.
    // The new number is kept only when no row already owns it (aliases are unique per channel); the BSUID link matters more than the number.
    db.prepare(`INSERT INTO contact_channels (id, workspace_id, contact_id, channel_id, external_user_id, identity_kind, phone_e164, username, opted_in,
        window_expires_at, human_window_expires_at, last_inbound_at, first_inbound_id, initial_opt_in_event_id, window_messages_sent,
        marketing_blocked_at, marketing_preference_at, broadcast_opt_in, blocked_at, channel_fields, opted_out_at, consent_changed_at, block_changed_at)
      SELECT ?, workspace_id, contact_id, channel_id, ?, 'bsuid',
        CASE WHEN ? IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contact_identity_aliases WHERE channel_id=? AND alias_kind='phone_e164' AND alias_value=?) THEN ? ELSE NULL END,
        username, opted_in, window_expires_at, human_window_expires_at, last_inbound_at, first_inbound_id, initial_opt_in_event_id, window_messages_sent,
        marketing_blocked_at, marketing_preference_at, broadcast_opt_in, blocked_at, channel_fields, opted_out_at, consent_changed_at, block_changed_at
      FROM contact_channels WHERE workspace_id=? AND id=? AND NOT EXISTS (SELECT 1 FROM contact_channels WHERE channel_id=? AND external_user_id=?)`)
      .bind(newId, system.user_id, phone, channelId, phone, phone, workspaceId, source.id, channelId, system.user_id),
    db.prepare(`UPDATE contact_channels SET broadcast_opt_in=0 WHERE workspace_id=? AND id=?
      AND EXISTS (SELECT 1 FROM contact_channels WHERE workspace_id=? AND id=?)`).bind(workspaceId, source.id, workspaceId, newId),
  ])
}
