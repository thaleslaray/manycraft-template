import type { CanSend, ChannelCapabilities, ContactChannelState, SendResult } from './types'

export function canSend(caps: ChannelCapabilities, contact: ContactChannelState, now: number,
  intent: 'automation' | 'human' | 'broadcast'): CanSend {
  if (contact.blocked) return { ok: false, reason: 'blocked' }
  if (!contact.optedIn) return { ok: false, reason: 'not_opted_in' }
  if (!caps.window) return { ok: true, mode: 'free' }
  if (contact.windowExpiresAt !== null && contact.windowExpiresAt > now) {
    if (caps.window.maxMessagesInWindow !== undefined && (contact.windowMessagesSent ?? 0) >= caps.window.maxMessagesInWindow) {
      return { ok: false, reason: 'window_message_cap' }
    }
    return { ok: true, mode: 'free' }
  }
  if (intent === 'human' && caps.window.humanAgentDays && contact.humanWindowExpiresAt !== null && contact.humanWindowExpiresAt > now) {
    return { ok: true, mode: 'human_agent' }
  }
  if (contact.commentReply && caps.commentReply) {
    if (contact.commentReply.used) return { ok: false, reason: 'comment_reply_used' }
    if (contact.commentReply.createdAt + caps.commentReply.maxAgeDays * 86400000 <= now) return { ok: false, reason: 'comment_too_old' }
    return { ok: true, mode: 'comment_reply' }
  }
  return { ok: false, reason: 'outside_window', window: 'standard', expiredAt: contact.windowExpiresAt ?? 0,
    canUseTemplate: ['template', 'utility_or_marketing'].includes(caps.window.outside) }
}

/** Janela em que a conexão restrita ainda responde a quem escreveu: a janela padrão do perfil, ou 24 horas no canal sem janela. */
export function restrictedWindowHours(caps: Pick<ChannelCapabilities, 'window'>): number {
  return caps.window?.standardHours ?? 24
}

/** What the connection's own state refuses before anything reaches the provider. A refused token (`error`), a number that is off
 * (`disconnected`) or still pairing (`connecting`) sends nothing automated. `restricted` (WhatsApp stopped the number from starting
 * new conversations, replica/contratos/meta-whatsapp) still answers whoever wrote within the window, and in groups; `pending`
 * (credentials pasted again, waiting for the first webhook) sends. */
export function connectionRefusal(state: string, caps: ChannelCapabilities, lastInboundAt: number | null, now: number, group: boolean): Extract<SendResult, { ok: false }> | undefined {
  if (state === 'error' || state === 'disconnected' || state === 'connecting') return { ok: false, reason: 'rejected', code: 'connection_unavailable',
    detail: 'A conexão está fora do ar ou o provedor recusou a credencial. Conserte em Canais (Atualizar conexão ou Trocar credencial) para voltar a enviar.' }
  const hours = restrictedWindowHours(caps)
  if (state === 'restricted' && !group && (lastInboundAt === null || lastInboundAt + hours * 3600000 <= now)) return { ok: false, reason: 'rejected', code: 'connection_restricted',
    detail: `O número está restrito para iniciar conversas: só responde a quem escreveu nas últimas ${hours} horas.` }
}
