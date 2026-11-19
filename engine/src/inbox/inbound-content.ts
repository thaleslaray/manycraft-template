import type { InboundEvent, InboundLocation, InboundMedia, InboundOrder, InboundSharedContact } from '../channels/types'

/** What the inbox keeps about a message beyond its text. Stored in the message content; the wire form adds the media link. */
export type MessageMedia = { kind: InboundMedia['type']; status: 'pending' | 'stored' | 'failed'; id?: string; mime?: string; name?: string; size?: number; voice?: boolean; animated?: boolean; error?: string; caption?: string }
export type MessageRich = {
  media?: MessageMedia; location?: InboundLocation; shared_contacts?: InboundSharedContact[]; order?: InboundOrder
  unsupported?: { type?: string }; reaction?: { emoji: string }
}
type Incoming = Extract<InboundEvent, { kind: 'message' }>

const mediaLabels: Record<InboundMedia['type'], string> = { image: 'Imagem', audio: 'Áudio', video: 'Vídeo', file: 'Arquivo', sticker: 'Figurinha' }
const coordinate = (n: number) => n.toFixed(5)

/** The line the inbox shows (and the conversation list previews) for what the contact sent: the caption when there is one, else a short plain description. */
export function describeInbound(message: Incoming): string {
  if (message.media) {
    const label = `[${mediaLabels[message.media.type]}]`
    return message.text?.trim() ? message.text : message.media.filename ? `${label} ${message.media.filename}` : label
  }
  if (message.location) {
    const place = [message.location.name, message.location.address].filter(Boolean).join(', ')
    return `Localização: ${place ? `${place} ` : ''}(${coordinate(message.location.latitude)}, ${coordinate(message.location.longitude)})`
  }
  if (message.sharedContacts) {
    return `Contato compartilhado: ${message.sharedContacts.map(c => c.phones.length ? `${c.name} (${c.phones.join(', ')})` : c.name).join('; ')}`
  }
  if (message.order) {
    const items = message.order.items.map(i => `${i.quantity} × ${i.productId}`).join(', ')
    return `Pedido do catálogo: ${items || 'sem itens'}${message.order.text ? `. ${message.order.text}` : ''}`
  }
  if (message.unsupported) return '[Mensagem de um tipo que este canal não entrega]'
  return message.text ?? '[Mensagem sem texto]'
}

/** Everything but the media (which is settled once the file is downloaded). */
export function richContent(message: Incoming): MessageRich {
  return {
    ...(message.location ? { location: message.location } : {}), ...(message.sharedContacts ? { shared_contacts: message.sharedContacts } : {}),
    ...(message.order ? { order: message.order } : {}), ...(message.unsupported ? { unsupported: message.unsupported } : {}),
  }
}

export const pendingMedia = (media: InboundMedia, caption?: string): MessageMedia => ({ kind: media.type, status: 'pending', ...(caption?.trim() ? { caption } : {}),
  ...(media.mime ? { mime: media.mime } : {}), ...(media.filename ? { name: media.filename } : {}),
  ...(media.voice ? { voice: true } : {}), ...(media.animated ? { animated: true } : {}) })

/** A link to open where a map is wanted: the provider's own when it sent one, else a plain coordinate search. */
export const mapLink = (location: InboundLocation) => `https://www.google.com/maps?q=${location.latitude},${location.longitude}`
