import type { AdapterEnv } from './core/credentials'
import { capabilities } from './capabilities'
import { canSend } from './policy'
import { telegramBot } from './telegram-bot'
import { connectionColumns, connectionFromRow, liteRow, type ConnectionRow } from './core/connection'
import { viewCredentials } from './core/credentials'
import { deliverAutomation } from './core/delivery'
import type { ChannelAdapter, ContactChannelState, OutboundMessage, SendContext, SendResult } from './types'

/** ChannelAdapter facade over the telegram_bot provider, for callers that still hold the pre-layer interface
 * (the flow executor, broadcasts). Transport and parsing live in telegram-bot.ts; sending goes through core/delivery. */
export class TelegramAdapter implements ChannelAdapter {
  constructor(private readonly env: AdapterEnv) {}
  capabilities() { return capabilities('telegram') }
  canSend(contact: ContactChannelState, now: number, intent: 'automation' | 'human' | 'broadcast') {
    return canSend(this.capabilities(), contact, now, intent)
  }
  fit = telegramBot.fit
  async send(ctx: SendContext, message: OutboundMessage): Promise<SendResult> {
    // The stored row carries the connection's settings and capability override; a bare row would lose both.
    const row = await this.env.DB.prepare(`SELECT ${connectionColumns} FROM channels WHERE workspace_id=? AND id=?`)
      .bind(ctx.run.workspace_id, ctx.channelId).first<ConnectionRow>()
    const connection = connectionFromRow(row ?? liteRow('telegram', ctx.channelId, ctx.run.workspace_id))
    return deliverAutomation(this.env, { connection, provider: telegramBot, credentials: async () => viewCredentials('telegram', this.env) }, ctx, message)
  }
}
