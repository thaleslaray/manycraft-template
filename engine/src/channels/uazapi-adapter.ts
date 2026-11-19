import { stableId } from '../flow/types'
import { effectiveProfile } from './core/profile-merge'
import { connectionFromRow, liteRow } from './core/connection'
import type { AdapterEnv } from './core/credentials'
import { deliverAutomation } from './core/delivery'
import { canSend } from './policy'
import { isDirectJid, uazapi } from './uazapi'
import type { ChannelAdapter, ContactChannelState, OutboundMessage, SendContext, SendResult } from './types'

const rejected = (code: string): SendResult => ({ ok: false, reason: 'rejected', code, detail: 'UAZAPI rejected send; check the instance' })

/** ChannelAdapter facade over the uazapi provider, for callers that still hold the pre-layer interface (the flow executor, broadcasts).
 * Transport and parsing live in uazapi.ts; sending goes through core/delivery. What stays here is the consent re-check before each part.
 * The credentials arrive in the adapter environment that core/credentials builds for this very connection. */
export class UazapiAdapter implements ChannelAdapter {
  constructor(private readonly env: AdapterEnv) {}
  private settings(): string { return this.env.CONNECTION_SETTINGS ?? '{}' }
  capabilities() { return effectiveProfile('whatsapp', 'uazapi') }
  canSend(contact: ContactChannelState, now: number, intent: 'automation' | 'human' | 'broadcast') {
    return canSend(this.capabilities(), contact, now, intent)
  }
  fit: ChannelAdapter['fit'] = (message, caps) => uazapi.fit(message, caps)
  async send(ctx: SendContext, message: OutboundMessage): Promise<SendResult> {
    const stored = JSON.parse(this.env.CONNECTION_CREDENTIALS ?? '{}') as Record<string, string>
    const credentials = { token: stored.token ?? '', serverUrl: stored.serverUrl ?? '' }
    const connection = connectionFromRow({ ...liteRow('whatsapp', ctx.channelId, ctx.run.workspace_id), provider: 'uazapi', settings: this.settings() })
    let nodeId = ''
    return deliverAutomation(this.env, { connection, provider: uazapi, credentials: async () => credentials }, ctx, message, {
      // Only a JID of this very run, on a connected UAZAPI instance.
      prepare: async () => {
        if (ctx.run.channel_type !== 'whatsapp' || !isDirectJid(ctx.externalUserId)) return rejected('context_mismatch')
        const state = await this.env.DB.prepare(`SELECT r.current_node_id FROM flow_runs r JOIN channels ch
          ON ch.workspace_id=r.workspace_id AND ch.id=r.channel_id WHERE r.workspace_id=? AND r.id=? AND r.contact_id=? AND r.channel_id=?
          AND ch.type='whatsapp' AND ch.provider='uazapi' AND ch.status='connected'`)
          .bind(ctx.run.workspace_id, ctx.runId, ctx.run.contact_id, ctx.channelId).first<{ current_node_id: string | null }>()
        if (!state?.current_node_id) return rejected('channel_not_configured')
        nodeId = state.current_node_id
      },
      // Consent is re-read for every part, right before the claim and again before the network call.
      guard: async () => {
        if (ctx.group) {
          // Answering in a group needs the group (of this very connection and run) and a subscribed author; no direct-message consent applies.
          const inGroup = await this.env.DB.prepare(`SELECT 1 AS found FROM group_threads g
            JOIN flow_runs r ON r.workspace_id=g.workspace_id AND r.reply_group_thread_id=g.id
            JOIN contacts c ON c.workspace_id=r.workspace_id AND c.id=r.contact_id
            JOIN channels ch ON ch.workspace_id=g.workspace_id AND ch.id=g.channel_id
            WHERE r.workspace_id=? AND r.id=? AND g.id=? AND g.channel_id=? AND g.external_group_id=? AND g.status='active'
            AND c.status='subscribed' AND ch.status='connected'`)
            .bind(ctx.run.workspace_id, ctx.runId, ctx.group.threadId, ctx.channelId, ctx.group.externalGroupId).first()
          return inGroup ? undefined : rejected('channel_not_configured')
        }
        const row = await this.env.DB.prepare(`SELECT cc.opted_in,c.status FROM contact_channels cc
          JOIN contacts c ON c.workspace_id=cc.workspace_id AND c.id=cc.contact_id
          JOIN channels ch ON ch.workspace_id=cc.workspace_id AND ch.id=cc.channel_id
          WHERE cc.workspace_id=? AND cc.channel_id=? AND cc.contact_id=? AND cc.external_user_id=? AND ch.status='connected'`)
          .bind(ctx.run.workspace_id, ctx.channelId, ctx.run.contact_id, ctx.externalUserId).first<{ opted_in: number; status: string }>()
        if (!row) return rejected('channel_not_configured')
        const mode = this.canSend({ optedIn: !!row.opted_in && row.status === 'subscribed', windowExpiresAt: null, humanWindowExpiresAt: null }, Date.now(), 'automation')
        if (!mode.ok) return mode
      },
      // Receipts find the run and the node through the message the delivery recorded.
      afterSend: async (sent) => {
        await this.env.DB.prepare(`UPDATE messages SET content=json_set(content,'$.uazapi',coalesce(json_extract(content,'$.uazapi'),json(?))) WHERE workspace_id=? AND id=?`)
          .bind(JSON.stringify({ runId: sent.runId, nodeId }), sent.run.workspace_id, `out-${await stableId(sent.runId, String(sent.step), String(sent.part))}`).run()
      },
    })
  }
}
