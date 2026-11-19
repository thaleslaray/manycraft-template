import { z } from 'zod'
import type { ContactOrigin, InboundLocation, InboundMedia, InboundOrder, InboundSharedContact } from './types'

/** What a contact sends besides text, read from a `messages` webhook item (P/webhooks/reference/messages/{image,audio,video,document,sticker,location,contacts,reaction,order,unsupported}.md).
 * Every field is bounded: an item comes from the network, and what it says ends up in the inbox. */
const id = z.string().min(1).max(512)
const short = (max: number) => z.string().max(max)
const mediaRef = z.object({ id, mime_type: short(255).optional(), sha256: short(128).optional(), caption: short(4096).optional(),
  filename: short(255).optional(), voice: z.boolean().optional(), animated: z.boolean().optional() })
const location = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  name: short(1000).optional(), address: short(1000).optional(), url: short(2048).optional() })
const sharedContact = z.object({
  name: z.object({ formatted_name: short(300).optional(), first_name: short(150).optional(), last_name: short(150).optional() }).optional(),
  org: z.object({ company: short(300).optional() }).optional(),
  phones: z.array(z.object({ phone: short(64).optional(), wa_id: short(64).optional() })).max(20).optional(),
  emails: z.array(z.object({ email: short(320).optional() })).max(20).optional(),
})
const order = z.object({ catalog_id: short(128), text: short(4096).optional(),
  product_items: z.array(z.object({ product_retailer_id: short(128), quantity: z.number(), item_price: z.number(), currency: short(8) })).max(500) })
export const inboundFields = {
  image: mediaRef.optional(), audio: mediaRef.optional(), video: mediaRef.optional(), document: mediaRef.optional(), sticker: mediaRef.optional(),
  location: location.optional(),
  /** The message's own `contacts` collide with the delivery-level profiles; the splitter keeps them apart under this name. */
  shared_contacts: z.array(sharedContact).max(257).optional(),
  order: order.optional(),
  reaction: z.object({ message_id: id, emoji: short(32).optional() }).optional(),
  unsupported: z.object({ type: short(64).optional() }).optional(),
}
type Fields = { [K in keyof typeof inboundFields]?: z.infer<typeof inboundFields[K]> } & { type?: string }

export type InboundContent =
  | { kind: 'message'; text?: string; media?: InboundMedia; location?: InboundLocation; sharedContacts?: InboundSharedContact[]; order?: InboundOrder; unsupported?: { type?: string } }
  | { kind: 'reaction'; targetMessageId: string; emoji?: string }
  | { kind: 'invalid' }

const mediaTypes = { image: 'image', audio: 'audio', video: 'video', document: 'file', sticker: 'sticker' } as const
/** The mime type without its parameters ("audio/ogg; codecs=opus" is audio/ogg). */
const cleanMime = (mime: string | undefined) => mime?.split(';')[0]?.trim().toLowerCase() || undefined

/** The content of a non-text, non-interactive item, or `undefined` when the type is not one of these. */
export function contentOf(item: Fields): InboundContent | undefined {
  const type = item.type
  if (type === 'image' || type === 'audio' || type === 'video' || type === 'document' || type === 'sticker') {
    const ref = item[type]
    if (!ref) return { kind: 'invalid' }
    const mime = cleanMime(ref.mime_type)
    return { kind: 'message', ...(ref.caption?.trim() ? { text: ref.caption } : {}),
      media: { type: mediaTypes[type], ref: ref.id, ...(mime ? { mime } : {}), ...(ref.filename ? { filename: ref.filename } : {}), ...(ref.sha256 ? { sha256: ref.sha256 } : {}),
        ...(ref.voice !== undefined ? { voice: ref.voice } : {}), ...(ref.animated !== undefined ? { animated: ref.animated } : {}) } }
  }
  if (type === 'location') return item.location ? { kind: 'message', location: item.location } : { kind: 'invalid' }
  if (type === 'contacts') {
    if (!item.shared_contacts) return { kind: 'invalid' }
    return { kind: 'message', sharedContacts: item.shared_contacts.map(c => {
      const name = c.name?.formatted_name?.trim() || [c.name?.first_name, c.name?.last_name].filter(Boolean).join(' ').trim()
      return { name: name || 'Contato sem nome', ...(c.org?.company ? { company: c.org.company } : {}),
        phones: (c.phones ?? []).flatMap(p => p.phone ?? p.wa_id ?? []), emails: (c.emails ?? []).flatMap(e => e.email ?? []) }
    }) }
  }
  if (type === 'order') {
    if (!item.order) return { kind: 'invalid' }
    return { kind: 'message', order: { catalogId: item.order.catalog_id, ...(item.order.text ? { text: item.order.text } : {}),
      items: item.order.product_items.map(i => ({ productId: i.product_retailer_id, quantity: i.quantity, price: i.item_price, currency: i.currency })) } }
  }
  if (type === 'reaction') {
    return item.reaction ? { kind: 'reaction', targetMessageId: item.reaction.message_id, ...(item.reaction.emoji ? { emoji: item.reaction.emoji } : {}) } : { kind: 'invalid' }
  }
  if (type === 'unsupported') return { kind: 'message', unsupported: { ...(item.unsupported?.type ? { type: item.unsupported.type } : {}) } }
  return undefined
}

/** Click to WhatsApp (P/webhooks/reference/messages/text.md, "Click to WhatsApp ad"): the first message of a conversation that started from an ad carries `referral`.
 * A referral that does not read is dropped; the message itself must still arrive. */
const referral = z.object({ source_id: short(256).optional(), source_type: short(32).optional(), headline: short(1000).optional(),
  ctwa_clid: short(512).optional(), source_url: short(2048).optional() })
export function originOf(raw: unknown): ContactOrigin | undefined {
  const parsed = referral.safeParse(raw)
  if (!parsed.success) return undefined
  const r = parsed.data
  if (!r.source_id && !r.ctwa_clid && !r.headline && !r.source_url) return undefined
  return { kind: 'ad', ...(r.source_id ? { sourceId: r.source_id } : {}), ...(r.source_type ? { sourceType: r.source_type } : {}),
    ...(r.headline ? { headline: r.headline } : {}), ...(r.ctwa_clid ? { clickId: r.ctwa_clid } : {}), ...(r.source_url ? { sourceUrl: r.source_url } : {}) }
}
