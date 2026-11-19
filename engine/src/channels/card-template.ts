import { cardsError } from '../schemas/message-cards'
import type { ChannelProfile } from './contract'
import type { OutboundMessage } from './types'

type CardsMessage = Extract<OutboundMessage, { kind: 'cards' }>
/** Both Graph transports declare the same native generic-template adaptation, without degrading to text. */
export const nativeCards = { adaptation: 'generic_template' as const }
export function fitCards(message: CardsMessage, profile: ChannelProfile): ReturnType<import('./types').ChannelAdapter['fit']> {
  const detail = cardsError({ ...message, kind: 'gallery', aspectRatio: message.aspectRatio ?? 'horizontal' }, [profile], false)
  return detail ? { ok: false as const, reason: 'unsupported' as const, detail } : { messages: [message], degraded: [] }
}
export function cardTemplate(part: CardsMessage) {
  return { attachment: { type: 'template', payload: { template_type: 'generic', image_aspect_ratio: part.aspectRatio ?? 'horizontal', elements: part.cards.map(c => ({
    title: c.title, ...(c.subtitle ? { subtitle: c.subtitle } : {}), ...(c.imageUrl ? { image_url: c.imageUrl } : {}),
    ...(c.actionUrl ? { default_action: { type: 'web_url', url: c.actionUrl } } : {}),
    ...(c.buttons?.length ? { buttons: c.buttons.map(b => b.type === 'url' ? { type: 'web_url', title: b.title, url: b.url } : b.type === 'postback' ? { type: 'postback', title: b.title, payload: b.id } : { type: 'phone_number', title: b.title, payload: b.phone }) } : {}),
  })) } } }
}
