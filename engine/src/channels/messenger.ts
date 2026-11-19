import type { AdapterEnv } from './core/credentials'
import { stableId } from '../flow/types'
import { canSend } from './policy'
import { connectionColumns, connectionFromRow, liteRow, type ConnectionRow } from './core/connection'
import { loadCredentials } from './core/credentials'
import { deliverAutomation } from './core/delivery'
import { effectiveProfile } from './core/profile-merge'
import { messengerPage, psid } from './messenger-page'
import type { ChannelAdapter, ContactChannelState, OutboundMessage, SendContext, SendResult } from './types'

const rejected = (code: string): SendResult => ({ ok: false, reason: 'rejected', code, detail: 'Messenger rejected send; check channel configuration' })

/** ChannelAdapter facade over the messenger_page provider, for callers that still hold the pre-layer interface (the flow executor).
 * Transport, parsing, contact rows and receipts live in messenger-page.ts; sending goes through core/delivery.
 * It reads the connection and its credentials from the database itself, so it needs nothing from the environment view. */
export class MessengerAdapter implements ChannelAdapter {
  constructor(private readonly env: AdapterEnv) {}
  capabilities() { return effectiveProfile('messenger', 'messenger_page') }
  canSend(contact: ContactChannelState, now: number, intent: 'automation' | 'human' | 'broadcast') {
    return canSend(this.capabilities(), contact, now, intent)
  }
  fit: ChannelAdapter['fit'] = (message, caps) => messengerPage.fit(message, caps)
  async send(ctx: SendContext, message: OutboundMessage): Promise<SendResult> {
    const workspaceId = ctx.run.workspace_id
    const row = await this.env.DB.prepare(`SELECT ${connectionColumns} FROM channels WHERE workspace_id=? AND id=?`).bind(workspaceId, ctx.channelId).first<ConnectionRow>()
    const connection = connectionFromRow(row ?? liteRow('messenger', ctx.channelId, workspaceId))
    const credentials = await loadCredentials(this.env, workspaceId, ctx.channelId)
    let nodeId = ''
    return deliverAutomation(this.env, { connection, provider: messengerPage, credentials: async () => credentials }, ctx, message, {
      // Only a PSID of this very run, on the connected page that is the configured one.
      prepare: async () => {
        if (ctx.run.channel_type !== 'messenger' || !psid.safeParse(ctx.externalUserId).success) return rejected('context_mismatch')
        const state = await this.env.DB.prepare(`SELECT r.current_node_id FROM flow_runs r JOIN channels ch ON ch.workspace_id=r.workspace_id AND ch.id=r.channel_id
          WHERE r.workspace_id=? AND r.id=? AND r.contact_id=? AND r.channel_id=? AND ch.type='messenger' AND ch.status='connected' AND ch.external_id=?`)
          .bind(workspaceId, ctx.runId, ctx.run.contact_id, ctx.channelId, credentials.pageId).first<{ current_node_id: string | null }>()
        if (!state?.current_node_id) return rejected('channel_not_configured')
        nodeId = state.current_node_id
      },
      // Consent and window are re-read from the database for every part, right before the claim and again before the network call.
      guard: async () => {
        const state = await this.env.DB.prepare(`SELECT cc.opted_in,cc.window_expires_at,c.status FROM contact_channels cc
          JOIN channels ch ON ch.workspace_id=cc.workspace_id AND ch.id=cc.channel_id
          JOIN contacts c ON c.workspace_id=cc.workspace_id AND c.id=cc.contact_id
          WHERE cc.workspace_id=? AND cc.channel_id=? AND cc.contact_id=? AND cc.external_user_id=? AND ch.type='messenger' AND ch.status='connected' AND ch.external_id=?`)
          .bind(workspaceId, ctx.channelId, ctx.run.contact_id, ctx.externalUserId, credentials.pageId)
          .first<{ opted_in: number; window_expires_at: number | null; status: string }>()
        if (!state) return rejected('channel_not_configured')
        const mode = this.canSend({ optedIn: !!state.opted_in && state.status === 'subscribed', windowExpiresAt: state.window_expires_at, humanWindowExpiresAt: null }, Date.now(), 'automation')
        if (!mode.ok) return mode
      },
      // Receipts find the run and node through the message they refer to.
      afterSend: async (sent) => {
        await this.env.DB.prepare(`UPDATE messages SET content=json_set(content,'$.messenger',coalesce(json_extract(content,'$.messenger'),json(?))) WHERE workspace_id=? AND id=?`)
          .bind(JSON.stringify({ runId: sent.runId, nodeId }), workspaceId, `out-${await stableId(sent.runId, String(sent.step), String(sent.part))}`).run()
      },
    })
  }
}
