import { capabilities } from './capabilities'
import { canSend } from './policy'
import { fitMessage } from './fit'
import type { ChannelAdapter, ChannelType, ContactChannelState, OutboundMessage, SendContext, SendResult } from './types'

/** Declaration only. No credentials, network, parsing or fabricated delivery for unimplemented providers. */
export class StubAdapter implements ChannelAdapter {
  constructor(readonly type: Exclude<ChannelType, 'telegram'>) {}
  capabilities() { return capabilities(this.type) }
  canSend(contact: ContactChannelState, now: number, intent: 'automation' | 'human' | 'broadcast') {
    return canSend(this.capabilities(), contact, now, intent)
  }
  fit = fitMessage
  async send(_ctx: SendContext, _message: OutboundMessage): Promise<SendResult> {
    return { ok: false, reason: 'unsupported', detail: `Channel adapter ${this.type} is a stub; sending is not implemented` }
  }
}
export class TikTokAdapter extends StubAdapter { constructor() { super('tiktok') } }
export { EmailAdapter } from './email-adapter'
