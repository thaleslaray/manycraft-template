import { z } from 'zod'
import { metaRefusalNotice, metaRefusalStatus, parseMetaError, ProviderRefusal, scrubMetaText } from './core/meta-error'
import { metaTemplates, TEMPLATE_ACCOUNT_LABEL, templateAccountOf } from './meta-templates'
import type { Connection, ConnectContext, MarketingStatus, Credentials, InboundEventV2, ProfilePatch, ProviderAdapter, ProviderCtx, RawWebhook, RoutingRoles, SendTarget, SyncContext, ThreadControlInput, ThreadControlResult, WebhookVerdict } from './contract'
import type { InboundEvent } from './types'
import { noteRefused, verifyMetaWebhook, WHATSAPP_MAX_WEBHOOK_BYTES, WHATSAPP_MAX_WEBHOOK_EVENTS } from './core/webhook-http'
import { accountItems, recordAccountEvent, recordMissingBsuid, type AccountItem } from './meta-whatsapp-health'
import { recordIdentityChange } from './meta-whatsapp-identity'
import { discoverWaba, ensureSubscribed, inspectToken, readNumberHealth } from './meta-whatsapp-account'
import { clearNumberOverride, setNumberOverride, WHATSAPP_WEBHOOK_STEPS } from './meta-whatsapp-webhook'
import { fitMessage } from './fit'
import { providers } from './providers'
import { cardBody } from '../schemas/message-cards'
import { fitCards } from './card-template'
import { mediaError } from '../schemas/message-media'
import { contentOf, inboundFields, originOf } from './meta-whatsapp-inbound'
import { downloadMetaMedia } from './meta-whatsapp-media'
import type { MetaErrorInfo, OutboundMessage, SendResult } from './types'

// Meta docs checked 2026-10-23: Graph v26.0, BSUID uses recipient (never to).
export const WHATSAPP_GRAPH_VERSION = 'v26.0'
export const bsuid = z.string().regex(/^[A-Z]{2}\.(?:ENT\.)?[A-Za-z0-9]{1,128}$/)
const id = z.string().min(1).max(512)
const timestamp = z.string().regex(/^\d{1,12}$/).transform(s => Number(s) * 1000)
const contactSchema = z.object({ user_id: bsuid.optional(), wa_id: z.string().optional(),
  profile: z.object({ name: z.string().optional(), username: z.string().optional() }).optional() })
const notification = z.object({ field: z.literal('messages'), kind: z.enum(['message', 'status']), id,
  timestamp, type: z.string().optional(), from_user_id: bsuid.optional(), from: z.string().optional(),
  contacts: z.array(contactSchema).max(WHATSAPP_MAX_WEBHOOK_EVENTS).optional(),
  text: z.object({ body: z.string().max(4096) }).optional(),
  interactive: z.object({ type: z.string(), button_reply: z.object({ id, title: z.string() }).optional(), list_reply: z.object({ id, title: z.string() }).optional() }).optional(),
  ...inboundFields,
  referral: z.unknown().optional(),
  button: z.object({ payload: id, text: z.string().optional() }).optional(),
  status: z.string().optional(),
  errors: z.array(z.object({ code: z.union([z.number(), z.string()]), title: z.string().optional(), message: z.string().optional(),
    error_data: z.object({ details: z.string().optional() }).passthrough().optional() }).passthrough()).transform(errors => errors.slice(0, 10)).optional(),
})
const record = z.record(z.string(), z.unknown())
const role = z.string().min(1).max(64)
const handoverSchema = z.object({
  type: z.enum(['control_passed', 'control_taken']), timestamp: z.string().regex(/^\d{1,12}$/),
  sender: z.object({ user_id: bsuid.optional(), phone_number: z.string().regex(/^\+?\d{7,15}$/).optional() }).refine(s => s.user_id || s.phone_number),
  recipient: z.object({ phone_number_id: z.string().min(1).max(512) }),
  control_passed: z.object({ previous_owner_role: role, new_owner_role: role }).optional(),
  control_taken: z.object({ previous_owner_role: role, new_owner_role: role }).optional(),
})
const envelope = z.object({ object: z.literal('whatsapp_business_account'), entry: z.array(z.object({
  id: z.coerce.string().max(512).optional(), time: z.number().int().nonnegative().optional(),
  changes: z.array(z.object({ field: z.string(), value: record })).max(WHATSAPP_MAX_WEBHOOK_EVENTS).optional(),
})).min(1).max(WHATSAPP_MAX_WEBHOOK_EVENTS) })
const unsupported = (detail: string) => ({ ok: false as const, reason: 'unsupported' as const, detail })
const rejected = (code: string, meta?: MetaErrorInfo): SendResult => ({ ok: false, reason: 'rejected', code, detail: 'WhatsApp rejected send; check channel configuration', ...(meta ? { meta } : {}) })
/** O que a Meta respondeu na recusa do envio (parseMetaError, já sem token), com o detalhe de `error_data.details` junto da mensagem; também vai ao log estruturado. */
function sendRefusal(data: unknown, path: string): MetaErrorInfo | undefined {
  const meta = parseMetaError(data)
  if (!meta) return undefined
  const details = (data as { error?: { error_data?: { details?: unknown } } }).error?.error_data?.details
  const full = { ...meta, ...(typeof details === 'string' && details ? { message: `${meta.message ?? ''} ${scrubMetaText(details)}`.trim().slice(0, 600) } : {}) }
  console.warn(JSON.stringify({ event: 'whatsapp_send_rejected', path, ...full }))
  return full
}
const graph = (connection: Connection) => typeof connection.settings.graphVersion === 'string' ? connection.settings.graphVersion : WHATSAPP_GRAPH_VERSION
const base = (connection: Connection) => `${typeof connection.settings.apiBase === 'string' ? connection.settings.apiBase : 'https://graph.facebook.com'}/${graph(connection)}`

type Item = AccountItem
/** Every message and status of a delivery, one entry per event. A delivery can carry several phone numbers and several events. */
function itemsOf(body: unknown): Item[] {
  const parsed = envelope.parse(body)
  const items: Item[] = []
  for (const entry of parsed.entry) for (const change of entry.changes ?? []) {
    // Conversation Routing: ownership of a thread changed (messaging_handovers). Keyed by type, time and user so a replay dedupes.
    if (change.field === 'messaging_handovers') {
      const handover = handoverSchema.safeParse(change.value)
      if (!handover.success) continue
      const user = handover.data.sender.user_id ?? handover.data.sender.phone_number!
      const eventKey = `handover:${handover.data.type}:${handover.data.timestamp}:${user}`
      items.push({ eventKey, externalId: handover.data.recipient.phone_number_id,
        payload: { ...change.value, id: eventKey, field: change.field, kind: 'handover' } })
      continue
    }
    if (change.field !== 'messages') { items.push(...accountItems(entry.id, entry.time, change)); continue }
    // A change without a readable phone number id cannot be routed to any connection: skip it, keep the rest of the delivery.
    const located = z.object({ phone_number_id: z.string().min(1).max(512) }).passthrough().safeParse(change.value.metadata)
    if (!located.success) continue
    const externalId = located.data.phone_number_id
    for (const [kind, list] of [['message', change.value.messages], ['status', change.value.statuses]] as const) {
      for (const item of z.array(record).parse(list ?? [])) {
        const itemId = id.parse(item.id)
        // A status without its name has no distinct key (and nothing to record): drop it instead of keying it "undefined".
        if (kind === 'status' && typeof item.status !== 'string') continue
        // Delivery transitions share the message ID; retain each distinct status.
        // A shared-contacts message carries its own `contacts`; the delivery's profile list takes that name below, so the message's list moves aside.
        items.push({ eventKey: kind === 'message' ? itemId : `${itemId}:${String(item.status)}`, externalId,
          payload: { ...item, ...(item.type === 'contacts' && Array.isArray(item.contacts) ? { shared_contacts: item.contacts } : {}),
            field: change.field, kind, metadata: change.value.metadata, contacts: change.value.contacts } })
      }
    }
  }
  if (items.length > WHATSAPP_MAX_WEBHOOK_EVENTS) {
    noteRefused('meta_whatsapp_cloud', 'too_many_events', { limit: WHATSAPP_MAX_WEBHOOK_EVENTS })
    throw new SyntaxError('Too many events in one delivery')
  }
  return items
}

/** The sender's BSUID: `from_user_id`, or the BSUID of the delivery's contact entry that carries the sender's phone (or the only entry with one). */
function senderBsuid(item: Pick<z.infer<typeof notification>, 'from_user_id' | 'from' | 'contacts'>): string | undefined {
  if (item.from_user_id) return item.from_user_id
  const withId = (item.contacts ?? []).filter(c => c.user_id)
  return (withId.find(c => item.from && c.wa_id === item.from) ?? (withId.length === 1 ? withId[0] : undefined))?.user_id
}

function parseItem(raw: unknown): InboundEventV2[] {
  const itemId = id.parse(z.object({ id: z.unknown() }).passthrough().parse(raw).id)
  // Nothing for the flow executor to do; the ownership is booked by `sync` below.
  if (z.object({ kind: z.literal('handover') }).safeParse(raw).success) return [{ kind: 'ignored', why: 'WhatsApp thread ownership change', eventKey: itemId }]
  // Account and contact notices (preferences, quality, limits, alerts, templates): booked by `sync`, nothing for the flow executor.
  if (z.object({ kind: z.literal('account') }).safeParse(raw).success) return [{ kind: 'ignored', why: 'WhatsApp account notice', eventKey: itemId }]
  const parsed = notification.safeParse(raw)
  if (!parsed.success) return [{ kind: 'ignored', why: 'Invalid WhatsApp notification', eventKey: itemId }]
  const item = parsed.data
  if (item.kind === 'status') {
    const eventKey = `${item.id}:${item.status}`
    if (!['sent', 'delivered', 'read', 'failed'].includes(item.status ?? '')) return [{ kind: 'ignored', why: 'Unsupported WhatsApp status', eventKey }]
    return [{ kind: 'receipt', eventKey, externalMessageId: item.id, status: item.status as 'sent' | 'delivered' | 'read' | 'failed', occurredAt: item.timestamp,
      ...(item.errors?.length ? { errors: item.errors.map(e => ({ code: String(e.code), ...((e.title ?? e.message) ? { title: (e.title ?? e.message)!.slice(0, 300) } : {}),
        ...(e.error_data?.details ? { detail: e.error_data.details.slice(0, 500) } : {}) })) } : {}) }]
  }
  // A change of phone number or of BSUID: the identity is re-linked by `sync` (meta-whatsapp-identity.ts); nothing for the flow executor.
  if (item.type === 'system') return [{ kind: 'ignored', why: 'WhatsApp identity change notice', eventKey: item.id }]
  // A phone or a username can never substitute for the business-scoped identity. The reference pages of the docs omit `from_user_id` while
  // business-scoped-user-ids.md says the BSUID is in every messages webhook (AC-17), so the BSUID of the delivery's own `contacts` entry is accepted too.
  // Without any BSUID the message is not kept (explicit reconciliation required) and `sync` raises a health warning (recordMissingBsuid).
  const userId = senderBsuid(item)
  if (!userId) return [{ kind: 'ignored', why: 'WhatsApp message has no BSUID; explicit legacy reconciliation required', eventKey: item.id }]
  const contact = item.contacts?.find(c => c.user_id === userId)
  const phone = contact?.wa_id ?? item.from
  const from = { externalUserId: userId, addressKind: 'bsuid' as const,
    ...(phone && /^\+?[1-9]\d{6,14}$/.test(phone) ? { phoneE164: `+${phone.replace(/^\+/, '')}` } : {}),
    ...(contact?.profile?.name || contact?.profile?.username ? { profile: {
      ...(contact?.profile?.name?.trim() ? (([first, ...rest]) => ({ firstName: first, ...(rest.length ? { lastName: rest.join(' ') } : {}) }))(contact.profile.name.trim().split(/\s+/)) : {}),
      ...(contact?.profile?.username ? { username: contact.profile.username } : {}) } } : {}) }
  const common = { eventKey: item.id, from, thread: { kind: 'direct' as const }, occurredAt: item.timestamp }
  if (item.type === 'interactive' && item.interactive?.type === 'button_reply' && item.interactive.button_reply) {
    return [{ kind: 'click', ...common, payload: item.interactive.button_reply.id, label: item.interactive.button_reply.title }]
  }
  // A row picked from a list answers like a button: the row id is the payload, its title what the contact sees.
  if (item.type === 'interactive' && item.interactive?.type === 'list_reply' && item.interactive.list_reply) {
    return [{ kind: 'click', ...common, payload: item.interactive.list_reply.id, label: item.interactive.list_reply.title }]
  }
  const content = contentOf(item)
  if (content?.kind === 'invalid') return [{ kind: 'ignored', why: 'Unreadable WhatsApp message content', eventKey: item.id }]
  if (content?.kind === 'reaction') return [{ kind: 'reaction', ...common, targetMessageId: content.targetMessageId, ...(content.emoji ? { emoji: content.emoji } : {}) }]
  const origin = originOf(item.referral)
  if (content) { const { kind: _kind, ...fields } = content; return [{ kind: 'message', ...common, externalMessageId: item.id, ...fields, ...(origin ? { origin } : {}) }] }
  if (item.type === 'button' && item.button) return [{ kind: 'click', ...common, payload: item.button.payload, ...(item.button.text ? { label: item.button.text } : {}) }]
  if (item.type !== 'text' || !item.text) return [{ kind: 'ignored', why: item.type === 'interactive' ? 'Unsupported WhatsApp interactive type' : 'Unsupported WhatsApp message type', eventKey: item.id }]
  return [{ kind: 'message', ...common, externalMessageId: item.id, text: item.text.body, ...(origin ? { origin } : {}) }]
}

async function post(ctx: ProviderCtx, recipient: string, message: OutboundMessage): Promise<SendResult> {
  let content: Record<string, unknown>
  if (message.kind === 'text' && message.buttons?.[0]?.type === 'url') {
    // https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-cta-url-messages: um único botão de link.
    content = { type: 'interactive', interactive: { type: 'cta_url', body: { text: message.text },
      action: { name: 'cta_url', parameters: { display_text: message.buttons[0].title, url: message.buttons[0].url } } } }
  } else if (message.kind === 'list') {
    // https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-list-messages
    content = { type: 'interactive', interactive: { type: 'list', ...(message.header ? { header: { type: 'text', text: message.header } } : {}),
      body: { text: message.text }, ...(message.footer ? { footer: { text: message.footer } } : {}),
      action: { button: message.buttonText, sections: message.sections.map(section => ({ ...(section.title ? { title: section.title } : {}),
        rows: section.rows.map(r => ({ id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) })) })) } } }
  } else if (message.kind === 'text') {
    content = message.buttons?.length ? { type: 'interactive', interactive: { type: 'button', body: { text: message.text },
      action: { buttons: message.buttons.map(b => ({ type: 'reply', reply: { id: b.type === 'postback' ? b.id : '', title: b.title } })) } } }
      : { type: 'text', text: { body: message.text, preview_url: false } }
  } else if (message.kind === 'template') {
    const keys = Object.keys(message.params).filter(k => k !== 'language_code').sort((a, b) => /^\d+$/.test(a) ? Number(a) - Number(b) : a.localeCompare(b))
    const components = [...(message.components ?? []).filter(c => c.type === 'header'),
      ...(keys.length ? [{type:'body',parameters:keys.map(k => ({type:'text',text:message.params[k],...(/^\d+$/.test(k) ? {} : {parameter_name:k})}))}] : []),
      ...(message.components ?? []).filter(c => c.type === 'button')]
    content = { type: 'template', template: { name: message.templateId, language: { code: message.params.language_code },
      ...(components.length ? {components} : {}) } }
  } else if (message.kind === 'cards') {
    content = cardsContent(message)
  } else if (message.kind === 'media') {
    // https://developers.facebook.com/docs/whatsapp/cloud-api/messages/image-messages (e vídeo, áudio, documento): mídia por link público.
    const type = message.media === 'file' ? 'document' : message.media
    content = { type, [type]: { link: message.url, ...(message.caption && type !== 'audio' ? { caption: message.caption } : {}) } }
  } else return unsupported('Unsupported WhatsApp message')
  // https://developers.facebook.com/documentation/business-messaging/whatsapp/marketing-messages/route-template-messages: marketing vai por /marketing_messages
  // quando a conta está habilitada; as demais categorias ficam em /messages.
  const route = message.kind === 'template' && message.category === 'marketing' && marketingEnabled(ctx.connection) ? 'marketing_messages' : 'messages'
  const payload = { messaging_product: 'whatsapp', ...(bsuid.safeParse(recipient).success ? { recipient } : { to: recipient }), ...content }
  let sent = await transmit(ctx, payload, route)
  // 131063: the template is Marketing but /messages refuses marketing for this account (disable_marketing_messages_on_cloud_api). Meta's own recipe is to refresh the
  // category and retry through /marketing_messages (marketing-messages/route-template-messages.md, step 5): the refusal is definitive, so one retry cannot duplicate.
  if (!sent.ok && route === 'messages' && message.kind === 'template' && sent.result.ok === false && sent.result.reason === 'rejected' && sent.result.code === '131063') {
    sent = await transmit(ctx, payload, 'marketing_messages')
  }
  if (!sent.ok) return sent.result
  const result = z.object({ messaging_product: z.literal('whatsapp'), messages: z.array(z.object({ id })).min(1).max(1) }).safeParse(sent.data)
  return result.success ? { ok: true, externalId: result.data.messages[0].id, parts: 1 }
    : { ok: false, reason: 'uncertain', detail: 'WhatsApp returned no valid send confirmation' }
}

type Cards = Extract<OutboundMessage, { kind: 'cards' }>
/** https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-media-carousel-messages: 2 a 10 cards, cada um com imagem,
 * texto e um botão de link ou botões de resposta. Um card só não é carrossel: vira mídia com legenda e botões (CTA URL ou botões de resposta com cabeçalho de imagem).
 * Os limites já foram conferidos em `fit` (cardsError), então aqui só se monta o corpo. */
function cardsContent(message: Cards): Record<string, unknown> {
  const header = (c: Cards['cards'][number]) => ({ type: 'image', image: { link: c.imageUrl } })
  if (message.cards.length > 1) {
    return { type: 'interactive', interactive: { type: 'carousel', body: { text: message.text }, action: { cards: message.cards.map((c, card_index) => ({
      card_index, type: 'cta_url', header: header(c), ...(cardBody(c) ? { body: { text: cardBody(c) } } : {}),
      action: c.buttons?.[0]?.type === 'url' ? { name: 'cta_url', parameters: { display_text: c.buttons[0].title, url: c.buttons[0].url } }
        : { buttons: (c.buttons ?? []).map(b => ({ type: 'quick_reply', quick_reply: { id: b.type === 'postback' ? b.id : '', title: b.title } })) } })) } } }
  }
  const [c] = message.cards, button = c.buttons?.[0]
  const body = { text: cardBody(c) }
  if (button?.type === 'url') return { type: 'interactive', interactive: { type: 'cta_url', ...(c.imageUrl ? { header: header(c) } : {}), body,
    action: { name: 'cta_url', parameters: { display_text: button.title, url: button.url } } } }
  if (button) return { type: 'interactive', interactive: { type: 'button', ...(c.imageUrl ? { header: header(c) } : {}), body,
    action: { buttons: (c.buttons ?? []).map(b => ({ type: 'reply', reply: { id: b.type === 'postback' ? b.id : '', title: b.title } })) } } }
  return c.imageUrl ? { type: 'image', image: { link: c.imageUrl, caption: body.text } } : { type: 'text', text: { body: body.text, preview_url: false } }
}

/** POST /{phone_number_id}/messages and classify a refusal; `data` is the confirmation body, whose shape depends on the call. */
async function transmit(ctx: ProviderCtx, payload: Record<string, unknown>, path: 'messages' | 'marketing_messages' = 'messages'): Promise<{ ok: true; data: unknown } | { ok: false; result: SendResult }> {
  let response: Response, data: unknown
  try {
    response = await ctx.fetch(`${base(ctx.connection)}/${ctx.credentials.phoneNumberId}/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.credentials.accessToken}` },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000),
    })
    data = await response.json()
  } catch { return { ok: false, result: { ok: false, reason: 'uncertain', detail: 'WhatsApp send outcome uncertain; reconcile before retry' } } }
  const error = z.object({ error: z.object({ code: z.number() }) }).safeParse(data)
  const code = error.success ? error.data.error.code : undefined
  // 4/17/32/613: limites da aplicação e da conta na Graph API; 80007/130429/131056: limites do WhatsApp (conta, vazão por número, par).
  if (response.status === 429 || [4, 17, 32, 613, 130429, 131056, 80007].includes(code ?? 0)) {
    const after = Number(response.headers.get('retry-after'))
    // Without Retry-After: the pair limit (131056) is 1 message every 6 s to the same user (about-the-platform.md, "Pair rate limits"), so a 1 s retry would hit it again.
    return { ok: false, result: { ok: false, reason: 'rate_limited', retryAfterSec: after > 0 && after <= 86400 ? after : code === 131056 ? 6 : 1 } }
  }
  if (code === 131047) return { ok: false, result: { ok: false, reason: 'outside_window', window: 'standard', expiredAt: 0, canUseTemplate: true } }
  if (!response.ok || error.success) {
    // 134102 (conta sem elegibilidade ou modelo sem sincronizar) vem com HTTP 500, mas é uma recusa definitiva da Meta.
    if ((response.status < 500 || code === 134102) && code !== 131000) return { ok: false, result: rejected(String(code ?? response.status), sendRefusal(data, path)) }
    return { ok: false, result: { ok: false, reason: 'uncertain', detail: 'WhatsApp returned no valid send confirmation' } }
  }
  return { ok: true, data }
}

/** Habilitada para a Marketing Messages API segundo a última checagem guardada na conexão (settings.marketingMessages). */
const marketingEnabled = (connection: Connection) => (connection.settings.marketingMessages as { enabled?: unknown } | undefined)?.enabled === true

const webUrl = (value: string) => { try { const url = new URL(value); return (url.protocol === 'https:' || url.protocol === 'http:') && !!url.hostname } catch { return false } }

/** Limits of an interactive list (P/messages/interactive-list-messages.md; body 1.024 is the contract value, CF-03). */
function listError(m: Extract<OutboundMessage, { kind: 'list' }>) {
  const size = (s: string | undefined) => [...(s ?? '')].length
  const rows = m.sections.flatMap(s => s.rows)
  if (!m.text.trim() || size(m.text) > 1024) return unsupported('List body must have 1 to 1024 characters')
  if (!m.buttonText.trim() || size(m.buttonText) > 20) return unsupported('List button must have 1 to 20 characters')
  if (size(m.header) > 60 || size(m.footer) > 60) return unsupported('List header and footer allow up to 60 characters')
  if (!m.sections.length || m.sections.length > 10) return unsupported('List needs 1 to 10 sections')
  if (!rows.length || rows.length > 10) return unsupported('List needs 1 to 10 rows in total')
  if (m.sections.length > 1 && m.sections.some(s => !s.title?.trim())) return unsupported('Every section needs a title when there are several')
  if (m.sections.some(s => !s.rows.length || size(s.title) > 24)) return unsupported('List section needs rows and a title up to 24 characters')
  if (rows.some(r => !r.id || size(r.id) > 200 || r.id.trim() !== r.id || !r.title.trim() || size(r.title) > 24 || size(r.description) > 72)) return unsupported('List row limits exceeded: id 200, title 24, description 72')
  if (new Set(rows.map(r => r.id)).size !== rows.length) return unsupported('List row IDs must be unique')
}

// ───────── Conversation Routing ─────────
// https://developers.facebook.com/documentation/business-messaging/whatsapp/conversation-routing/routing-roles
// https://developers.facebook.com/documentation/business-messaging/whatsapp/conversation-routing/thread-control
const graphError = z.object({ error: z.object({ code: z.number().optional() }).passthrough() })
const phoneDigits = /^[1-9]\d{6,14}$/
async function graphCall(ctx: ProviderCtx, path: string, body?: unknown): Promise<{ ok: true; data: unknown } | { ok: false; code?: number; transient: boolean }> {
  let response: Response, data: unknown
  try {
    response = await ctx.fetch(`${base(ctx.connection)}/${ctx.credentials.phoneNumberId}/${path}`, { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${ctx.credentials.accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) })
    data = await response.json()
  } catch { return { ok: false, transient: true } }
  if (response.ok) return { ok: true, data }
  const parsed = graphError.safeParse(data)
  const code = parsed.success ? parsed.data.error.code : undefined
  return { ok: false, ...(code === undefined ? {} : { code }), transient: response.status >= 500 || response.status === 429 || [4, 17, 32, 613, 80007, 130429, 131056].includes(code ?? 0) }
}
const routing: NonNullable<ProviderAdapter['routing']> = {
  async roles(ctx): Promise<RoutingRoles> {
    const result = await graphCall(ctx, 'routing_roles')
    if (!result.ok) {
      // 190 is a credential problem the person must see; any other refusal means the number does not use Conversation Routing.
      if (result.transient || result.code === 190) return result
      return { ok: true, active: false, roles: [], standby: false }
    }
    const parsed = z.object({ roles: z.array(z.string().max(64)).max(20), is_standby: z.boolean() }).safeParse(result.data)
    return parsed.success ? { ok: true, active: true, roles: parsed.data.roles, standby: parsed.data.is_standby } : { ok: false, transient: true }
  },
  async control(ctx, input: ThreadControlInput): Promise<ThreadControlResult> {
    const who = bsuid.safeParse(input.externalUserId).success ? { recipient: input.externalUserId }
      : phoneDigits.test(input.externalUserId.replace(/^\+/, '')) ? { to: input.externalUserId.replace(/^\+/, '') } : undefined
    if (!who) return { ok: false, code: 100, transient: false }
    const result = await graphCall(ctx, 'thread_control', { messaging_product: 'whatsapp', ...who, action: input.action,
      ...(input.action === 'pass' && input.targetRole ? { control_pass: { target_role: input.targetRole } } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}) })
    if (!result.ok) return result
    const parsed = z.object({ request_id: z.string().max(256) }).passthrough().safeParse(result.data)
    // The action may have happened without us seeing the confirmation: not safe to call it refused.
    return parsed.success ? { ok: true, requestId: parsed.data.request_id } : { ok: false, transient: true }
  },
}

// https://developers.facebook.com/documentation/business-messaging/whatsapp/marketing-messages/onboarding: marketing_messages_onboarding_status is ELIGIBLE or ONBOARDED
// (the Business API variant is an object with a `status`); only ONBOARDED sends through /marketing_messages. The same call reads
// disable_marketing_messages_on_cloud_api (send-marketing-messages.md), which decides whether /messages still takes marketing.
const marketingStatus = z.object({ marketing_messages_onboarding_status: z.union([z.string(), z.object({ status: z.string() }).transform(o => o.status)]).optional(),
  disable_marketing_messages_on_cloud_api: z.boolean().optional() }).passthrough()
const marketing: NonNullable<ProviderAdapter['marketing']> = {
  async status(ctx): Promise<MarketingStatus> {
    const waba = templateAccountOf('whatsapp', ctx.credentials, ctx.connection.settings)
    if (typeof waba !== 'string' || !/^\d+$/.test(waba)) return { ok: false, transient: false, missing: 'account_id' }
    let response: Response, data: unknown
    try {
      response = await ctx.fetch(`${base(ctx.connection)}/${waba}?fields=marketing_messages_onboarding_status,disable_marketing_messages_on_cloud_api`,
        { headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` }, signal: AbortSignal.timeout(15_000) })
      data = await response.json()
    } catch { return { ok: false, transient: true } }
    if (!response.ok) {
      const code = graphError.safeParse(data)
      return { ok: false, ...(code.success && code.data.error.code !== undefined ? { code: code.data.error.code } : {}), transient: response.status >= 500 || response.status === 429 }
    }
    const parsed = marketingStatus.safeParse(data)
    if (!parsed.success || !parsed.data.marketing_messages_onboarding_status) return { ok: false, transient: true }
    const status = parsed.data.marketing_messages_onboarding_status
    return { ok: true, enabled: status === 'ONBOARDED', status, cloudMarketingDisabled: parsed.data.disable_marketing_messages_on_cloud_api ?? null }
  },
}

/** Books a messaging_handovers notice: who owns the thread now. A late notice never undoes a newer one. */
async function recordHandover(ctx: SyncContext): Promise<void> {
  const parsed = handoverSchema.safeParse(ctx.event.payload)
  if (!parsed.success) return
  const { type, timestamp, sender } = parsed.data
  const change = parsed.data[type]
  if (!change) return
  const user = sender.user_id ?? sender.phone_number!.replace(/^\+/, '')
  await upsertThreadOwner(ctx.env.DB, ctx.event.workspaceId, ctx.connection.id, user, change.new_owner_role, change.previous_owner_role, Number(timestamp) * 1000)
}
export async function upsertThreadOwner(db: D1Database, workspaceId: string, channelId: string, user: string, owner: string | null, previous: string | null, at: number) {
  await db.prepare(`INSERT INTO whatsapp_thread_owners(workspace_id,channel_id,external_user_id,owner_role,previous_role,updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(workspace_id,channel_id,external_user_id) DO UPDATE SET owner_role=excluded.owner_role,previous_role=excluded.previous_role,updated_at=excluded.updated_at
    WHERE excluded.updated_at>=whatsapp_thread_owners.updated_at`).bind(workspaceId, channelId, user, owner, previous, at).run()
}

const phoneNumbersPage = z.object({ data: z.array(z.object({ id: z.coerce.string() })), paging: z.object({ next: z.string().optional() }).optional() })
/** GET /{waba}/phone_numbers, following paging.next. Any failure means "not proved", never a broken connection. */
async function ownsNumber(ctx: ConnectContext, wabaId: string, phoneNumberId: string, headers: Record<string, string>): Promise<boolean> {
  try {
    let url: string | undefined = `${base(ctx.connection)}/${wabaId}/phone_numbers?fields=id&limit=100`
    for (let page = 0; url && page < 20; page++) {
      const response = await ctx.fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
      const parsed = phoneNumbersPage.safeParse(await response.json())
      if (!response.ok || !parsed.success) return false
      if (parsed.data.data.some(n => n.id === phoneNumberId)) return true
      const next = parsed.data.paging?.next   // the token only goes where the first call went
      url = next && new URL(next).origin === new URL(base(ctx.connection)).origin ? next : undefined
    }
  } catch { /* not proved */ }
  return false
}

/** WhatsApp through Meta's Cloud API. The webhook is pointed at the number only (alternate callback); a refusal falls back to the guided manual step. */
export const metaWhatsappCloud: ProviderAdapter = {
  id: 'meta_whatsapp_cloud',
  maxWebhookBytes: WHATSAPP_MAX_WEBHOOK_BYTES,
  kinds: ['whatsapp'],
  templates: metaTemplates,
  patch: providers.meta_whatsapp_cloud.patch as ProfilePatch,   // the whatsapp channel profile plus the carousel the Cloud API adds
  credentialsSchema: z.record(z.string(), z.string()).refine(c => !!c.accessToken && /^\d+$/.test(c.phoneNumberId ?? ''), { message: 'accessToken and phoneNumberId are required' }),
  settingsSchema: z.record(z.string(), z.unknown()),

  async connect(ctx: ConnectContext) {
    try {
      const headers = { Authorization: `Bearer ${ctx.credentials.accessToken}` }
      const response = await ctx.fetch(`${base(ctx.connection)}/${ctx.credentials.phoneNumberId}?fields=display_phone_number,verified_name`,
        { headers, signal: AbortSignal.timeout(10_000) })
      if (response.status >= 500 || response.status === 429) return { kind: 'failed' as const, code: 'unreachable', detail: 'WhatsApp is unavailable' }
      const me = z.object({ id: z.string(), verified_name: z.string().optional(), display_phone_number: z.string().optional() }).safeParse(await response.json())
      if (!response.ok || !me.success || me.data.id !== ctx.credentials.phoneNumberId) {
        return { kind: 'failed' as const, code: 'invalid_credentials', detail: 'WhatsApp did not accept the access token for this number' }
      }
      const name = me.data.verified_name ?? me.data.display_phone_number
      // The phone number node does not name its account: the account is proved by listing the numbers of the typed WABA and finding this one.
      const typed = ctx.credentials.wabaId ?? ctx.connection.settings.wabaId
      const owns = (candidate: string) => ownsNumber(ctx, candidate, me.data.id, headers)
      // The token says which app it belongs to and which accounts it can manage (debug_token): that finds the account when none was typed,
      // and tells whether this app is already subscribed to it. Asked only when one of those is needed.
      const call = { base: base(ctx.connection), token: ctx.credentials.accessToken, fetch: ctx.fetch }
      let inspected: Awaited<ReturnType<typeof inspectToken>> | undefined
      let accountId: string | undefined
      // The number's health names the account that owns it (the one Meta looks templates up in) and what blocks sending. Unknown on any failure.
      const health = await readNumberHealth(call, me.data.id)
      const owner = health?.ownerWaba
      let warning: string | undefined
      if (typeof typed === 'string' && /^\d{1,64}$/.test(typed)) {
        if (owner && owner !== typed) {
          accountId = owner
          // Stored by create and rotate: what was typed is corrected to the owner (settings.accountId carries it everywhere else).
          ctx.credentials.wabaId = owner
          warning = `O ${TEMPLATE_ACCOUNT_LABEL} informado (${typed}) foi trocado pela conta dona do número (${owner}). A conta informada só compartilha o número, e a Meta procura os modelos de mensagem na conta dona.`
        } else accountId = owner === typed || await owns(typed) ? typed : undefined
      } else if (typed === undefined) {
        if (owner) accountId = owner
        else { inspected = await inspectToken(call); accountId = await discoverWaba(inspected.wabaIds, owns) }
      }
      // Meta only delivers webhooks for accounts the app is subscribed to. Best effort: a refusal (token without whatsapp_business_management) must not
      // fail the connection, which still sends; the callback URL goes to the number in registerWebhook.
      if (accountId) await ensureSubscribed(call, accountId, (inspected ??= await inspectToken(call)).appId)
      // Sending health part: set while something blocks or limits sending, cleared (null) once a read comes back clean, untouched when unknown.
      const sending = health ? { sending: health.blocks.length ? { status: health.overall ?? health.blocks[0].status, items: health.blocks } : null } : undefined
      return { kind: 'done' as const, externalId: me.data.id, ...(name ? { displayName: name } : {}), ...(accountId ? { accountId } : {}), ...(warning ? { warning } : {}), ...(sending ? { health: sending } : {}) }
    } catch { return { kind: 'failed' as const, code: 'unreachable', detail: 'WhatsApp could not be reached' } }
  },
  webhookChecklist: WHATSAPP_WEBHOOK_STEPS,
  registersSharedWebhook: true,
  /** O webhook vai só para o número (endereço alternativo por número), nunca para o app inteiro. Antes, a conta precisa ter o app assinado
   * ("Before setting an alternate callback URL, make sure your app is subscribed to webhooks on the Messaging account", webhooks/override.md):
   * sem a conta (WABA) provada ou sem confirmar a assinatura, nada é gravado e fica o passo manual com o motivo. */
  async registerWebhook(ctx: ConnectContext) {
    const manual = (reason: string) => ({ registered: false as const, manual: { kind: 'manual_webhook' as const, callbackUrl: ctx.hookUrl, verifyToken: ctx.webhookSecret,
      checklist: [...WHATSAPP_WEBHOOK_STEPS], reason } })
    const account = typeof ctx.connection.settings.accountId === 'string' && /^\d{1,64}$/.test(ctx.connection.settings.accountId) ? ctx.connection.settings.accountId : undefined
    if (!account) return manual('sem o ID da conta do WhatsApp Business (WABA) confirmado, o ManyCraft não consegue assinar o app na conta, e sem essa assinatura a Meta não entrega eventos ao número.')
    if (!ctx.hookUrl || !ctx.webhookSecret) return manual('faltam a URL de retorno ou o token de verificação desta conexão.')
    const call = { base: base(ctx.connection), token: ctx.credentials.accessToken, fetch: ctx.fetch }
    if (!await ensureSubscribed(call, account, (await inspectToken(call)).appId)) return manual('não deu para confirmar que o app está assinado na conta do WhatsApp Business (WABA) deste número; sem essa assinatura a Meta não entrega eventos.')
    const set = await setNumberOverride(call, ctx.credentials.phoneNumberId, ctx.hookUrl, ctx.webhookSecret)
    // Aceito pela Meta: a conexão espera o primeiro evento real (o app ainda precisa assinar o campo messages, o que não se confere daqui).
    return set.ok ? { registered: true as const, awaitFirstEvent: true } : manual(set.reason)
  },
  /** Arquivar: tira o endereço alternativo do número só se for o deste motor; o de outro sistema fica. */
  async disconnect(ctx: ConnectContext) {
    if (!ctx.credentials.accessToken || !ctx.credentials.phoneNumberId || !ctx.hookUrl) return
    await clearNumberOverride({ base: base(ctx.connection), token: ctx.credentials.accessToken, fetch: ctx.fetch }, ctx.credentials.phoneNumberId, ctx.hookUrl)
  },
  async verifyWebhook(raw: RawWebhook, secrets: { webhookSecret: string; credentials: Credentials }): Promise<WebhookVerdict> {
    return verifyMetaWebhook(raw, secrets)
  },
  splitDelivery: itemsOf,
  routing,
  marketing,
  async sync(ctx: SyncContext, item: InboundEvent) {
    if (item.kind === 'ignored' && ctx.event.payload.kind === 'handover') await recordHandover(ctx)
    if (item.kind === 'ignored' && ctx.event.payload.kind === 'account') await recordAccountEvent(ctx, base(ctx.connection))
    if (item.kind === 'ignored' && ctx.event.payload.kind === 'message') {
      const parsed = notification.safeParse(ctx.event.payload)
      if (!parsed.success) return
      if (parsed.data.type === 'system') await recordIdentityChange(ctx)
      // edit and revoke exist only for Coexistence (webhooks/reference/messages/{edit,revoke}.md) and are not read; they are not a BSUID problem.
      else if (!['edit', 'revoke'].includes(parsed.data.type ?? '') && !senderBsuid(parsed.data)) await recordMissingBsuid(ctx, parsed.data.timestamp)
    }
  },
  /** A whole delivery (webhook body) or the single event the queue carries. */
  parseInbound(body: unknown, _connection: Connection): InboundEventV2[] {
    return envelope.safeParse(body).success ? itemsOf(body).flatMap(item => parseItem(item.payload)) : parseItem(body)
  },
  fit(message: OutboundMessage, profile) {
    if (message.kind === 'template') {
      if (!/^[a-z0-9_]{1,512}$/.test(message.templateId)
        || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(message.params.language_code ?? '')) return unsupported('Template requires API name and params.language_code')
      const keys = Object.keys(message.params).filter(k => k !== 'language_code')
      const positional = keys.every(k => /^[1-9]\d*$/.test(k))
      if (positional && keys.map(Number).sort((a, b) => a - b).some((n, i) => n !== i + 1)) return unsupported('Template parameters must be consecutive from 1')
      if (!positional && keys.some(k => !/^[a-z][a-z_]*$/.test(k))) return unsupported('Invalid named template parameters')
      if (keys.some(k => !message.params[k] || [...message.params[k]].length > 32768)) return unsupported('Invalid template text parameter')
      return { messages: [message], degraded: [] }
    }
    if (message.kind === 'media') {
      const error = mediaError(message, [profile], false)
      return error || message.buttons?.length ? unsupported(error ?? 'Media buttons are not implemented') : { messages: [message], degraded: [] }
    }
    if (message.kind === 'cards') return fitCards(message, profile)
    if (message.kind === 'list') return listError(message) ?? { messages: [message], degraded: [] }
    if (message.kind !== 'text') return unsupported('WhatsApp transport supports text, media, lists, reply buttons, one link button, cards and text templates')
    const buttons = [...message.buttons ?? [], ...(message.quickReplies ?? []).map(q => ({ type: 'postback' as const, ...q }))]
    // O botão de link (CTA URL) é uma ação única: nem com botões de resposta, nem com outro link.
    if (buttons.some(b => b.type === 'url') && buttons.length > 1) return unsupported('A link button cannot share the message with other buttons')
    if (buttons.some(b => b.type !== 'postback' && b.type !== 'url')) return unsupported('Only reply buttons and one link button are implemented')
    // Meta refuses a CTA URL whose address is not a full http(s) URL; catch it at publication instead of at send time.
    if (buttons.some(b => b.type === 'url' && !webUrl(b.url))) return unsupported('The link button needs a full http or https address')
    // Interactive bodies have a lower limit than plain text; split before adding buttons.
    const fitted = fitMessage(message, { ...profile, text: { ...profile.text, maxLength: buttons.length ? 1024 : 4096 } })
    if ('ok' in fitted) return fitted
    for (const part of fitted.messages) {
      if (part.kind !== 'text') continue
      const titles = (part.buttons ?? []).map(b => b.title)
      const ids = (part.buttons ?? []).map(b => b.type === 'postback' ? b.id : '')
      if (new Set(titles).size !== titles.length || new Set(ids).size !== ids.length) return unsupported('Reply buttons must have unique titles and IDs')
      if ((part.buttons ?? []).some(b => b.type === 'postback' && b.id.trim() !== b.id)) return unsupported('Reply button IDs cannot have surrounding spaces')
    }
    return fitted
  },
  async send(ctx: ProviderCtx & { target: SendTarget }, part: OutboundMessage): Promise<SendResult> {
    if (ctx.target.kind !== 'direct') return unsupported('WhatsApp groups are not supported by the Cloud API')
    // Same rule as at publication: a gallery that does not fit is refused here, before any call to the network.
    if (part.kind === 'cards') { const fitted = fitCards(part, ctx.connection.profile); if ('ok' in fitted) return fitted }
    return post(ctx, ctx.target.externalUserId, part)
  },
  downloadMedia: (ctx, media, maxBytes) => downloadMetaMedia(ctx, base(ctx.connection), media, maxBytes),
  typingNeedsReplyTo: true,
  /** https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators: "lida" mais "digitando" sobre a mensagem recebida (some em 25 s ou ao responder). */
  async typing(ctx: ProviderCtx & { target: SendTarget }, _seconds: number, replyTo?: string): Promise<SendResult> {
    if (ctx.target.kind !== 'direct') return unsupported('WhatsApp groups are not supported by the Cloud API')
    if (!replyTo) return unsupported('The typing indicator needs the contact message it answers')
    const sent = await transmit(ctx, { messaging_product: 'whatsapp', status: 'read', message_id: replyTo, typing_indicator: { type: 'text' } })
    if (!sent.ok) return sent.result
    return z.object({ success: z.literal(true) }).safeParse(sent.data).success ? { ok: true, externalId: 'typing', parts: 0 }
      : { ok: false, reason: 'uncertain', detail: 'WhatsApp returned no valid typing confirmation' }
  },
}

const profileFields = 'about,address,description,email,websites,vertical'
/** Perfil comercial do número pela Cloud API. O texto dos erros do Graph não sai daqui (pode conter dados da conta): só código, subcódigo e a frase traduzida. */
export const whatsappBusinessProfile = {
  async get(ctx: ProviderCtx) {
    try {
      const response = await ctx.fetch(`${base(ctx.connection)}/${ctx.credentials.phoneNumberId}/whatsapp_business_profile?fields=${profileFields}`, { headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` }, signal: AbortSignal.timeout(15_000) })
      const body = z.object({ data: z.array(z.record(z.string(), z.unknown())).min(1) }).parse(await response.json())
      const d = body.data[0]
      const str = (k: string) => typeof d[k] === 'string' ? d[k] as string : undefined
      return { about: str('about'), description: str('description'), address: str('address'), email: str('email'), vertical: str('vertical'), websites: Array.isArray(d.websites) ? (d.websites as unknown[]).filter((w): w is string => typeof w === 'string') : [] }
    } catch { throw new Error('Não foi possível ler o perfil comercial.') }
  },
  async update(ctx: ProviderCtx, profile: { about?: string; description?: string; address?: string; email?: string; websites?: string[]; vertical?: string }) {
    try {
      const response = await ctx.fetch(`${base(ctx.connection)}/${ctx.credentials.phoneNumberId}/whatsapp_business_profile`, { method: 'POST', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.credentials.accessToken}` }, body: JSON.stringify({ messaging_product: 'whatsapp', ...profile }) })
      if (!response.ok) {
        const meta = parseMetaError(await response.json().catch(() => null))
        throw meta ? new ProviderRefusal(metaRefusalStatus(meta), metaRefusalNotice('o perfil comercial', meta, { echo: false }))
          : new ProviderRefusal(502, 'A Meta não respondeu ao pedido do perfil comercial. Tente de novo em instantes.')
      }
    } catch (error) {
      if (error instanceof ProviderRefusal) throw error
      throw new ProviderRefusal(502, 'A Meta não respondeu ao pedido do perfil comercial. Tente de novo em instantes.')
    }
  },
}
;(metaWhatsappCloud as { businessProfile?: typeof whatsappBusinessProfile }).businessProfile = whatsappBusinessProfile

/** Catálogo da conta do WhatsApp (Commerce): primeiro catálogo ligado à WABA e seus produtos (até 100). */
;(metaWhatsappCloud as { catalog?: NonNullable<import('./contract').ProviderAdapter['catalog']> }).catalog = async (ctx: ProviderCtx) => {
  const waba = templateAccountOf('whatsapp', ctx.credentials, ctx.connection.settings)
  const headers = { Authorization: `Bearer ${ctx.credentials.accessToken}` }
  try {
    const catalogs = await (await ctx.fetch(`${base(ctx.connection)}/${waba}/product_catalogs?fields=id,name`, { headers, signal: AbortSignal.timeout(15_000) })).json() as { data?: { id: string }[] }
    const catalogId = catalogs.data?.[0]?.id ?? null
    if (!catalogId) return { catalogId: null, products: [] }
    const products = await (await ctx.fetch(`${base(ctx.connection)}/${catalogId}/products?fields=id,retailer_id,name,price,image_url,availability&limit=100`, { headers, signal: AbortSignal.timeout(15_000) })).json() as { data?: { id: string; retailer_id: string; name: string; price?: string; image_url?: string; availability?: string }[] }
    return { catalogId, products: (products.data ?? []).map(p => ({ id: p.id, retailerId: p.retailer_id, name: p.name, ...(p.price ? { price: p.price } : {}), ...(p.image_url ? { imageUrl: p.image_url } : {}), ...(p.availability ? { availability: p.availability } : {}) })) }
  } catch { throw new Error('Não foi possível ler o catálogo.') }
}
