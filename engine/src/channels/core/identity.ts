import type { InboundEvent as QueuedEvent, IntegrationEnv } from '../../integrations'
import { stableId } from '../../flow/types'
import type { InboundEvent } from '../types'
import type { ConnectionRuntime } from './runtime'

type Message = Extract<InboundEvent, { kind: 'message' }>

/** Every provider honours the stored consent; a normal message never reverses an opt-out. */
export async function hasConsent(env: IntegrationEnv, event: QueuedEvent, message: Message): Promise<boolean> {
  return !!await env.DB.prepare(`SELECT id FROM contact_channels
    WHERE workspace_id=? AND channel_id=? AND external_user_id=? AND opted_in=1`)
    .bind(event.workspaceId, event.channelId, message.externalUserId).first()
}

/** Contact + channel identity for providers without their own sync. Concurrent messages converge on the unique channel identity;
 * a new incarnation uses its first inbound receipt. Ids keep the 'tg-' prefix of rows created before the layer.
 * `blocked_at` is not touched here: reopenWindow (flow/dispatch.ts) clears it only for a message newer than the block. */
export async function upsertContact(env: IntegrationEnv, rt: ConnectionRuntime, event: QueuedEvent, inboundId: string, message: Message, _now: number): Promise<void> {
  if (rt.meta.contacts !== 'generic') return
  const contactId = `tg-${await stableId(event.workspaceId, event.channelId, message.externalUserId, inboundId)}`
  const channelContactId = `tg-${await stableId(event.channelId, message.externalUserId, inboundId)}`
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO contacts (id,workspace_id,first_name,last_name,optin_source,last_input_text,last_interaction_at,profile_pic_url)
      SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM contact_channels
        WHERE workspace_id=? AND channel_id=? AND external_user_id=?) ON CONFLICT(id) DO NOTHING`)
      .bind(contactId, event.workspaceId, message.profile?.firstName ?? null, message.profile?.lastName ?? null, rt.connection.kind,
        message.text ?? null, event.receivedAt,
        // Relative path only: a provider file URL can carry the credential. The route answers 404 when there is no photo.
        rt.meta.profile?.avatar ? `/api/contacts/${contactId}/avatar` : null,
        event.workspaceId, event.channelId, message.externalUserId),
    env.DB.prepare(`INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,username,opted_in,first_inbound_id)
      VALUES (?,?,coalesce((SELECT contact_id FROM contact_channels WHERE workspace_id=? AND channel_id=? AND external_user_id=?),?),?,?,?,?,?)
      ON CONFLICT(channel_id,external_user_id) DO UPDATE SET username=coalesce(excluded.username,contact_channels.username),
      first_inbound_id=coalesce(contact_channels.first_inbound_id,excluded.first_inbound_id)`)
      .bind(channelContactId, event.workspaceId, event.workspaceId, event.channelId, message.externalUserId, contactId,
        event.channelId, message.externalUserId, message.profile?.username ?? null, 1, inboundId),
    env.DB.prepare(`UPDATE contacts SET first_name=coalesce(?,first_name),last_name=coalesce(?,last_name),
      last_input_text=CASE WHEN coalesce(last_interaction_at,0)<=? THEN ? ELSE last_input_text END,
      last_interaction_at=max(coalesce(last_interaction_at,0),?) WHERE workspace_id=? AND id=(
        SELECT contact_id FROM contact_channels WHERE workspace_id=? AND channel_id=? AND external_user_id=?) AND status<>'deleted'`)
      .bind(message.profile?.firstName ?? null, message.profile?.lastName ?? null, event.receivedAt, message.text ?? null,
        event.receivedAt, event.workspaceId, event.workspaceId, event.channelId, message.externalUserId),
  ])
}
