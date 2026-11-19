/** Vocabulário da ManyChat por canal: o importador de fluxos lê isto, nunca decide por nome de canal. */
import type { ChannelType } from './types'

/** Tipo de nó de mensagem da ManyChat -> tipo de canal nosso. */
export const manychatMessageNodes: Record<string, ChannelType> = {
  instagram: 'instagram', content: 'messenger', whatsApp: 'whatsapp', telegram: 'telegram', tiktok: 'tiktok'
}
/** `set_<canal>_optin` / `set_<canal>_optout` da ManyChat -> tipo de ação do nosso grafo (`set_<canal>_opt_in`). */
export function manychatOptAction(type: string): string | null {
  const match = /^set_([a-z]+)_opt(in|out)$/.exec(type)
  return match ? `set_${match[1]}_opt_${match[2]}` : null
}

/** Canais em que a inscrição (opt-in) é uma ação do fluxo; as ações valem para todas as identidades do contato naquele tipo de canal. */
export const optChannels = ['instagram', 'whatsapp', 'email', 'tiktok', 'telegram'] as const

/** Tipo de conteúdo do fluxo compartilhado (getSharedFlow) -> tipo de nó do editor da ManyChat (chave de `manychatMessageNodes`). */
export const manychatSharedContentNodes: Record<string, string> = {
  instagram: 'instagram', content: 'content', messenger: 'content', facebook: 'content', whatsapp: 'whatsApp', telegram: 'telegram', tiktok: 'tiktok'
}
