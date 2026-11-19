import type { AdapterEnv } from './core/credentials'
import { storedConnection, deliverAutomation } from './core/delivery'
import { effectiveProfile } from './core/profile-merge'
import { emailMessageForRun } from './email-design'
import { cloudflareEmail } from './cloudflare-email'
import { canSend } from './policy'
import type { ChannelAdapter, ContactChannelState, OutboundMessage, SendContext, SendResult } from './types'

/** Facade retained for generic automation/broadcast consumers. All business rules stay in the provider layer. */
export class EmailAdapter implements ChannelAdapter {
  constructor(private readonly env: AdapterEnv) {}
  capabilities() { return effectiveProfile('email', 'cloudflare_email') }
  canSend(contact: ContactChannelState, now: number, intent: 'automation' | 'human' | 'broadcast') {
    return canSend(this.capabilities(), intent === 'human' ? { ...contact, optedIn: true } : contact, now, intent)
  }
  fit: ChannelAdapter['fit'] = (message, profile) => cloudflareEmail.fit(message, profile)
  async send(ctx: SendContext, message: OutboundMessage): Promise<SendResult> {
    const prepared = await emailMessageForRun(this.env, ctx, message)
    if ('ok' in prepared) return prepared
    const connection = await storedConnection(this.env, 'email', ctx.run.workspace_id, ctx.channelId)
    return deliverAutomation(this.env, { connection, provider: cloudflareEmail, credentials: async () => JSON.parse(this.env.CONNECTION_CREDENTIALS ?? '{}') }, ctx, prepared, {
      displayText: part => part.kind === 'text' ? `E-mail enviado: ${part.email?.subject || 'Mensagem da equipe'}` : '',
    })
  }
}
