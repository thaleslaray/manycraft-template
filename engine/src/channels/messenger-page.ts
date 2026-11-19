import { cardTemplate, fitCards, nativeCards } from './card-template'
import { z } from 'zod'
import { stableId } from '../flow/types'
import { notifyConversation } from '../inbox/service'
import type { Connection, ConnectContext, Credentials, InboundEventV2, Party, ProfilePatch, ProviderAdapter, ProviderCtx, RawWebhook, SendTarget, SyncContext, WebhookVerdict } from './contract'
import { digest, verifyMetaWebhook } from './core/webhook-http'
import { fitMessage } from './fit'
import { adOriginOf } from './ad-origin'
import { metaTemplates } from './meta-templates'
import { configureMetaUserMenu, configureMetaSurface, metaSurfaceProfile } from './meta-surfaces'
import type { InboundEvent, OutboundMessage, SendResult } from './types'
import { firstInboundOptIn } from './core/consent'

// Messenger Platform docs checked 2026-10-23 (Send API, Meta Webhooks for Messenger Platform, message_reads / message_deliveries
// event references, User Profile API), all under developers.facebook.com/documentation/business-messaging/messenger-platform/.
export const MESSENGER_GRAPH_VERSION = 'v26.0'
export const psid = z.string().regex(/^\d{1,128}$/)
const id = z.string().min(1).max(512)
const callbackPayload = z.string().min(1).refine(value => new TextEncoder().encode(value).length <= 1000)
/** messaging_referrals / postback.referral (Messenger Platform, webhook-events/messaging_referrals, checked 2026-10-25):
 * source ADS|SHORTLINK, type OPEN_THREAD, ref (the m.me ?ref= value), referer_uri, ads_context_data. Only `ref` identifies the trigger. */
const referralSchema = z.object({ ref: z.string().min(1).max(250).optional(), source: z.string().max(64).optional(), type: z.string().max(64).optional() }).passthrough()
const itemSchema = z.object({
  sender: z.object({ id: psid }), recipient: z.object({ id: psid }),
  timestamp: z.number().int().nonnegative(),
  message: z.object({ mid: id, text: z.string().max(65536).optional(), is_echo: z.boolean().optional(), referral: referralSchema.optional(),
    quick_reply: z.object({ payload: callbackPayload }).optional() }).optional(),
  postback: z.object({ mid: id.optional(), payload: callbackPayload, referral: referralSchema.optional() }).optional(),
  referral: referralSchema.optional(),
  delivery: z.object({ mids: z.array(id).max(100).optional(), watermark: z.number().int().nonnegative() }).optional(),
  read: z.object({ watermark: z.number().int().nonnegative() }).optional(),
})
const envelope = z.object({ object: z.literal('page'), entry: z.array(z.object({ id,
  messaging: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
  changes: z.array(z.object({ field: id, value: z.record(z.string(), z.unknown()) }).passthrough()).max(100).optional() }).passthrough()).min(1).max(100) })
const unsupported = (detail: string) => ({ ok: false as const, reason: 'unsupported' as const, detail })
const rejected = (code: string): SendResult => ({ ok: false, reason: 'rejected', code, detail: 'Messenger rejected send; check channel configuration' })
const bytes = (text: string) => new TextEncoder().encode(text).length
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** A receipt that names no message ("everything up to the watermark") travels as `wm:<psid>:<watermark>`. */
const watermarkId = (user: string, watermark: number) => `wm:${user}:${watermark}`

/** Queue key of one messaging item. Reads and deliveries carry a watermark, not a message id, so the key names the sender and the mark. */
function keyOf(item: Record<string, unknown>): string | undefined {
  const sender = record(item.sender)?.id
  const read = record(item.read)?.watermark
  if (read !== undefined) return `read:${sender}:${read}`
  const delivery = record(item.delivery)
  if (delivery) {
    const mids = Array.isArray(delivery.mids) ? delivery.mids : []
    return mids.length === 1 ? `delivered:${mids[0]}` : `delivered:wm:${sender}:${delivery.watermark}`
  }
  const postback = record(item.postback)
  if (postback) return `postback:${postback.mid ?? `${sender}:${item.timestamp}`}`
  const mid = record(item.message)?.mid
  if (typeof mid === 'string') return mid
  const referral = record(item.referral)
  return referral ? `referral:${sender}:${item.timestamp}:${referral.ref ?? ''}` : undefined
}
/** Ids dos três tamanhos do like (polegar) que o Messenger envia como figurinha; o motor o trata como a mensagem "👍". */
const LIKE_STICKERS = new Set(['369239263222822', '369239343222814', '369239383222810'])
const isLikeSticker = (message: Record<string, unknown> | undefined) => {
  if (!message) return false
  const attachments = Array.isArray(message.attachments) ? message.attachments : []
  const ids = [message.sticker_id, ...attachments.map(a => record(record(a)?.payload)?.sticker_id)]
  return ids.some(value => value !== undefined && LIKE_STICKERS.has(String(value)))
}
const isEcho = (item: Record<string, unknown>) => record(item.message)?.is_echo === true

type Item = { eventKey: string; externalId: string; payload: Record<string, unknown> }
/** Every messaging item of a delivery, one entry per event and tagged with its page. A delivery receipt naming several messages is split per message. */
async function itemsOf(body: unknown): Promise<Item[]> {
  const items: Item[] = []
  for (const entry of envelope.parse(body).entry) for (const item of entry.messaging ?? []) {
    const recipient = record(item.recipient)?.id
    if (!isEcho(item) && recipient !== undefined && recipient !== entry.id && record(item.sender)?.id !== entry.id) throw new SyntaxError('Messenger recipient mismatch')
    const mids = record(item.delivery)?.mids
    if (Array.isArray(mids) && mids.length > 1) {
      for (const mid of mids) items.push({ eventKey: `delivered:${mid}`, externalId: entry.id, payload: { ...item, delivery: { ...record(item.delivery), mids: [mid] } } })
    } else items.push({ eventKey: keyOf(item) ?? await digest(JSON.stringify(item)), externalId: entry.id, payload: item })
  }
  // Comentários da página (campo feed): cada comentário novo vira um item próprio, com a página em `page`.
  for (const entry of envelope.parse(body).entry) for (const change of entry.changes ?? []) {
    if (change.field !== 'feed' || change.value.item !== 'comment') continue
    const commentId = change.value.comment_id
    if (typeof commentId === 'string') items.push({ eventKey: `feed:${commentId}:${String(change.value.verb)}`, externalId: entry.id, payload: { feed: change.value, page: entry.id, time: (entry as { time?: number }).time } })
  }
  if (items.length > 100) throw new SyntaxError('Too many events in one delivery')
  return items
}

/** Comentário em post da página (webhook feed, item=comment, verb=add). Só comentários de primeiro nível de visitantes; os da própria página ficam de fora. */
function parseFeedComment(raw: Record<string, unknown>, pageId: string): InboundEventV2[] {
  const value = record(raw.feed)
  const commentId = value?.comment_id
  const eventKey = typeof commentId === 'string' ? `feed:${commentId}:${String(value?.verb)}` : undefined
  const ignored = (why: string): InboundEventV2[] => [{ kind: 'ignored', why, ...(eventKey ? { eventKey } : {}) }]
  if (!value || value.verb !== 'add') return ignored('Messenger comment change')
  const from = record(value.from)
  if (!from || from.id === pageId || from.id === raw.page) return ignored('Messenger own comment')
  if (value.parent_id && value.parent_id !== value.post_id) return ignored('Messenger reply to a comment')
  if (!id.safeParse(commentId).success || !id.safeParse(value.post_id).success || typeof value.message !== 'string' || !id.safeParse(from.id).success) return ignored('Unsupported Messenger comment')
  const created = typeof value.created_time === 'number' ? value.created_time * 1000 : Date.now()
  return [{ kind: 'comment', eventKey: eventKey!, commentId: commentId as string, postId: value.post_id as string, text: value.message,
    from: { externalUserId: from.id as string, addressKind: 'psid', ...(typeof from.name === 'string' ? { profile: { firstName: from.name } } : {}) }, createdAt: created }]
}

function parseItem(raw: unknown, pageId: string): InboundEventV2[] {
  const item = itemSchema.safeParse(raw)
  const source = record(raw)
  if (!item.success || !source) return [{ kind: 'ignored', why: 'Unsupported Messenger event' }]
  const eventKey = keyOf(source)
  const ignored = (why: string): InboundEventV2[] => [{ kind: 'ignored', why, ...(eventKey === undefined ? {} : { eventKey }) }]
  const { sender, message, postback, delivery, read, timestamp } = item.data
  if (message?.is_echo || sender.id === item.data.recipient.id || sender.id === pageId) return ignored('Messenger own message')
  if (read) return [{ kind: 'receipt', eventKey: eventKey!, externalMessageId: watermarkId(sender.id, read.watermark), status: 'read', occurredAt: read.watermark }]
  if (delivery) {
    return delivery.mids?.length
      ? delivery.mids.map(mid => ({ kind: 'receipt' as const, eventKey: `delivered:${mid}`, externalMessageId: mid, status: 'delivered' as const, occurredAt: delivery.watermark }))
      : [{ kind: 'receipt', eventKey: eventKey!, externalMessageId: watermarkId(sender.id, delivery.watermark), status: 'delivered', occurredAt: delivery.watermark }]
  }
  const common = { eventKey: eventKey!, from: { externalUserId: sender.id, addressKind: 'psid' as const }, thread: { kind: 'direct' as const }, occurredAt: timestamp }
  if (postback) return [{ kind: 'click', ...common, payload: postback.payload },
    ...(postback.referral?.ref ? [{ kind: 'referral' as const, eventKey: eventKey!, from: common.from, ref: postback.referral.ref }] : [])]
  if (item.data.referral && !message) return item.data.referral.ref
    ? [{ kind: 'referral', eventKey: eventKey!, from: common.from, ref: item.data.referral.ref }] : ignored('Messenger referral without ref')
  if (message?.quick_reply) return [{ kind: 'click', ...common, payload: message.quick_reply.payload }]
  const origin = adOriginOf(message?.referral ?? item.data.referral)
  if (message?.text !== undefined) return [{ kind: 'message', ...common, externalMessageId: message.mid, text: message.text, ...(origin ? { origin } : {}) }]
  if (message && isLikeSticker(record(source.message))) return [{ kind: 'message', ...common, externalMessageId: message.mid, text: '👍', like: true }]
  return ignored('Unsupported Messenger event')
}

/** Development can point a connection at a fake Graph API through settings.apiBase (the connections route only accepts it outside production). */
const base = (connection?: Connection) => `${typeof connection?.settings.apiBase === 'string' ? connection.settings.apiBase : 'https://graph.facebook.com'}/${MESSENGER_GRAPH_VERSION}`

async function post(ctx: ProviderCtx, recipient: string, part: Extract<OutboundMessage, { kind: 'text' | 'cards' | 'template' }>): Promise<SendResult> {
  // Modelo utility aprovado: único envio do Messenger fora da janela de 24 h (messaging_type UTILITY).
  const utility = part.kind === 'template'
  const message = part.kind === 'template' ? { attachment: { type: 'template', payload: { template_type: 'utility', name: part.templateId, language: part.params.language_code,
      parameters: Object.entries(part.params).filter(([k]) => k !== 'language_code').map(([k, v]) => ({ type: 'text', text: v, ...(/^\d+$/.test(k) ? {} : { parameter_name: k }) })) } } }
    : part.kind === 'cards' ? cardTemplate(part) : part.buttons?.length ? { attachment: { type: 'template', payload: { template_type: 'button', text: part.text,
    buttons: part.buttons.map(b => b.type === 'postback' ? { type: 'postback', title: b.title, payload: b.id }
      : b.type === 'url' ? { type: 'web_url', title: b.title, url: b.url, ...('webviewSize' in b && b.webviewSize ? { webview_height_ratio: { full: 'full', medium: 'tall', compact: 'compact' }[b.webviewSize] } : {}) }
        : { type: 'phone_number', title: b.title, payload: b.phone }) } } }
    : { text: part.text, ...(part.quickReplies?.length ? { quick_replies: part.quickReplies.map(q => ({ content_type: 'text', title: q.title, payload: q.id })) } : {}) }
  let response: Response, raw: unknown
  try {
    response = await ctx.fetch(`${base(ctx.connection)}/${ctx.credentials.pageId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.credentials.accessToken}` },
      body: JSON.stringify({ recipient: { id: recipient }, messaging_type: utility ? 'UTILITY' : ctx.intent === 'human' && ctx.humanAgent ? 'MESSAGE_TAG' : 'RESPONSE', message, ...(ctx.intent === 'human' && ctx.humanAgent ? { tag: 'HUMAN_AGENT' } : {}) }), signal: AbortSignal.timeout(20_000),
    })
    raw = await response.json()
  } catch { return { ok: false, reason: 'uncertain', detail: 'Messenger send outcome uncertain; reconcile before retry' } }
  const data = z.object({ message_id: id.optional(), recipient_id: psid.optional(),
    error: z.object({ code: z.number(), error_subcode: z.number().optional() }).optional() }).safeParse(raw)
  const error = data.success ? data.data.error : undefined
  if (response.status === 429 || error && [4, 17, 32, 613, 80006].includes(error.code)) {
    const retry = Number(response.headers.get('Retry-After'))
    return { ok: false, reason: 'rate_limited', retryAfterSec: Number.isFinite(retry) && retry > 0 ? Math.min(retry, 86400) : 1 }
  }
  if (error && response.status < 500) {
    if (error.code === 10 && error.error_subcode === 2018278) return { ok: false, reason: 'outside_window', window: 'standard', expiredAt: Date.now(), canUseTemplate: false }
    if (error.code === 551 || error.error_subcode === 1545041) return { ok: false, reason: 'blocked' }
    return rejected(String(error.code))
  }
  if (!response.ok || !data.success || error || !data.data.message_id || data.data.recipient_id && data.data.recipient_id !== recipient) {
    return { ok: false, reason: 'uncertain', detail: 'Messenger returned no valid send confirmation' }
  }
  return { ok: true, externalId: data.data.message_id, parts: 1 }
}

const rank: Record<string, number> = { sent: 0, failed: 1, delivered: 2, read: 3 }
/** messages.created_at is written after the send is confirmed over HTTP (up to this timeout later than the send itself),
 * so a watermark from just before that confirmation must still cover the message. */
const SEND_CONFIRMATION_SLACK_MS = 20_000
const lowerThan = (status: string) => Object.keys(rank).filter(key => rank[key] < rank[status])

/** Receipts. A delivery that names its messages updates those; a watermark ("everything up to here") updates the page's
 * messages to that person sent at or before it. A state never goes backwards (a late 'delivered' keeps a 'read'). */
async function recordReceipt(ctx: SyncContext, receipt: Extract<InboundEvent, { kind: 'receipt' }>) {
  const { env, event } = ctx
  if (receipt.status !== 'delivered' && receipt.status !== 'read') return
  const status = receipt.status
  const mark = receipt.externalMessageId.match(/^wm:(\d+):(\d+)$/)
  const where = mark
    ? { sql: "substr(m.external_message_id,1,length(?))=? AND m.created_at<=?", args: [`messenger:${event.channelId}:${mark[1]}:`, `messenger:${event.channelId}:${mark[1]}:`, Number(mark[2]) + SEND_CONFIRMATION_SLACK_MS] }
    : { sql: "substr(m.external_message_id,-length(?))=?", args: [`:${receipt.externalMessageId}`, `:${receipt.externalMessageId}`] }
  const rows = await env.DB.prepare(`SELECT m.id,m.conversation_id FROM messages m WHERE m.workspace_id=? AND m.connection_id=? AND m.direction='out'
    AND ${where.sql} AND coalesce(m.delivery_status,'sent') IN (${lowerThan(status).map(() => '?').join(',')})`)
    .bind(event.workspaceId, event.channelId, ...where.args, ...lowerThan(status)).all<{ id: string; conversation_id: string }>()
  if (!rows.results.length) {
    // The webhook can overtake the send confirmation: keep a named message pending for retry for a while, then let it go
    // (a reply typed in the Page's own inbox is never recorded here).
    const known = !mark && await env.DB.prepare('SELECT 1 FROM messages WHERE workspace_id=? AND connection_id=? AND substr(external_message_id,-length(?))=?')
      .bind(event.workspaceId, event.channelId, `:${receipt.externalMessageId}`, `:${receipt.externalMessageId}`).first()
    if (!mark && !known && Date.now() - event.receivedAt < 120_000) throw new Error('Messenger receipt is not yet correlated')
    return
  }
  const at = receipt.occurredAt ?? event.receivedAt
  const types = status === 'read' ? ['delivered', 'read'] : ['delivered']
  await env.DB.batch(rows.results.flatMap(row => [
    ...types.map(type => env.DB.prepare(`INSERT INTO node_events(workspace_id,automation_id,node_id,contact_id,flow_run_id,type,created_at)
      SELECT r.workspace_id,v.automation_id,json_extract(m.content,'$.messenger.nodeId'),r.contact_id,r.id,?,? FROM messages m
      JOIN flow_runs r ON r.workspace_id=m.workspace_id AND r.id=json_extract(m.content,'$.messenger.runId')
      JOIN automation_versions v ON v.workspace_id=r.workspace_id AND v.id=r.automation_version_id
      WHERE m.workspace_id=? AND m.id=? ON CONFLICT DO NOTHING`).bind(type, at, event.workspaceId, row.id)),
    env.DB.prepare(`UPDATE messages SET content=json_set(content,'$.messengerStatus',?,'$.status',?),delivery_status=? WHERE workspace_id=? AND id=? AND coalesce(delivery_status,'sent') IN (${lowerThan(status).map(() => '?').join(',')})`)
      .bind(status, 'delivered', status, event.workspaceId, row.id, ...lowerThan(status)),
  ]))
  for (const conversationId of new Set(rows.results.map(row => row.conversation_id))) await notifyConversation(env, event.workspaceId, conversationId)
}

/** Provider identity is the PSID, scoped by workspace and page connection; no name or phone merge. Opt-in is the first message. */
async function syncContact(ctx: SyncContext, input: Extract<InboundEvent, { kind: 'message' | 'click' }> | Extract<InboundEvent, { kind: 'optin' | 'optout' | 'referral' }>) {
  const { env, event } = ctx
  let identity = await env.DB.prepare(`SELECT id,contact_id FROM contact_channels WHERE workspace_id=? AND channel_id=? AND external_user_id=?`)
    .bind(event.workspaceId, event.channelId, input.externalUserId).first<{ id: string; contact_id: string }>()
  const inboundId = JSON.stringify([event.provider, event.channelId, event.eventId])
  // Provider time, capped at reception: a retry cannot extend the window.
  const at = Math.min(('occurredAt' in input ? input.occurredAt : undefined) ?? event.receivedAt, event.receivedAt)
  if (!identity && (input.kind === 'message' || input.kind === 'referral')) {
    const contactId = `ms-${await stableId(event.workspaceId, event.channelId, input.externalUserId)}`
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO contacts(id,workspace_id,optin_source) VALUES (?,?,'messenger') ON CONFLICT(id) DO NOTHING`).bind(contactId, event.workspaceId),
      env.DB.prepare(`INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id) VALUES (?,?,?,?,?)
        ON CONFLICT(channel_id,external_user_id) DO NOTHING`)
        .bind(`ms-${await stableId(event.channelId, input.externalUserId)}`, event.workspaceId, contactId, event.channelId, input.externalUserId),
    ])
    identity = await env.DB.prepare(`SELECT id,contact_id FROM contact_channels WHERE workspace_id=? AND channel_id=? AND external_user_id=?`)
      .bind(event.workspaceId, event.channelId, input.externalUserId).first<{ id: string; contact_id: string }>()
  }
  if (!identity) return
  if (input.kind === 'message' || input.kind === 'referral') await fillProfile(ctx, identity, input.externalUserId)
  // Um referral isolado (link m.me aberto numa conversa que já existia) só identifica o contato: não é mensagem, não abre janela de 24 horas e não vira primeira entrada.
  if (input.kind === 'referral') return
  const message = input.kind === 'message' ? 1 : 0
  await env.DB.batch([
    env.DB.prepare(`UPDATE contact_channels SET ${firstInboundOptIn(message === 1, at).sql},
      window_expires_at=max(coalesce(window_expires_at,0),?), human_window_expires_at=max(coalesce(human_window_expires_at,0),?),
      first_inbound_id=CASE WHEN ?=1 THEN coalesce(first_inbound_id,?) ELSE first_inbound_id END WHERE workspace_id=? AND id=?`)
      .bind(...firstInboundOptIn(message === 1, at).binds, at + 86400000, at + 7 * 86400000, message, inboundId, event.workspaceId, identity.id),
    env.DB.prepare(`UPDATE contacts SET last_input_text=CASE WHEN coalesce(last_interaction_at,0)<=? THEN coalesce(?,last_input_text) ELSE last_input_text END,
      last_interaction_at=max(coalesce(last_interaction_at,0),?) WHERE workspace_id=? AND id=?`)
      .bind(at, input.kind === 'message' ? input.text ?? null : null, at, event.workspaceId, identity.contact_id),
  ])
}

/** Name and photo come from the User Profile API, once per contact (a channel row without a username yet; Messenger has none, so '' marks it done). */
async function fillProfile(ctx: SyncContext, identity: { id: string; contact_id: string }, externalUserId: string) {
  const { env, event } = ctx
  if (!messengerPage.credentialsSchema.safeParse(ctx.credentials).success) return
  const missing = await env.DB.prepare(`SELECT 1 FROM contact_channels WHERE workspace_id=? AND id=? AND username IS NULL`).bind(event.workspaceId, identity.id).first()
  if (!missing) return
  const profile = await messengerPage.fetchProfile!(ctx, { externalUserId, addressKind: 'psid' })
  if (!profile) return
  await env.DB.batch([
    env.DB.prepare(`UPDATE contact_channels SET username=? WHERE workspace_id=? AND id=?`).bind(profile.username ?? '', event.workspaceId, identity.id),
    env.DB.prepare(`UPDATE contacts SET first_name=coalesce(first_name,?),last_name=coalesce(last_name,?),profile_pic_url=coalesce(?,profile_pic_url)
      WHERE workspace_id=? AND id=?`).bind(profile.firstName ?? null, profile.lastName ?? null, profile.avatar && 'url' in profile.avatar ? profile.avatar.url : null, event.workspaceId, identity.contact_id),
  ])
}

/** Messenger through a Facebook Page. Meta configures webhooks per app, so registration is a guided manual step. */
export const messengerPage: ProviderAdapter = {
  id: 'messenger_page',
  kinds: ['messenger'],
  // Cards and galleries use the native generic template declared by the effective profile.
  patch: { ...metaSurfaceProfile, cards: nativeCards } as ProfilePatch,
  credentialsSchema: z.record(z.string(), z.string()).refine(c => !!c.accessToken && psid.safeParse(c.pageId).success, { message: 'accessToken and pageId are required' }),
  settingsSchema: z.record(z.string(), z.unknown()),
  configureSurface: (ctx, surface) => configureMetaSurface(ctx, surface, base(ctx.connection), ctx.credentials.pageId ?? ''),
  templates: metaTemplates,
  configureUserMenu: (ctx, user, items) => configureMetaUserMenu(ctx, base(ctx.connection), user, items),
  comments: {
    async listPosts(ctx, query) {
      try {
        const url = new URL(`${base(ctx.connection)}/${ctx.credentials.pageId ?? ''}/posts`)
        url.searchParams.set('fields', 'id,message,created_time,permalink_url,full_picture'); url.searchParams.set('limit', String(query.limit)); if (query.after) url.searchParams.set('after', query.after)
        const r = await ctx.fetch(url, { headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` }, signal: AbortSignal.timeout(15_000) })
        const data = await r.json() as { data?: { id: string; message?: string; created_time?: string; permalink_url?: string; full_picture?: string }[]; paging?: { cursors?: { after?: string } } }
        return { posts: (data.data ?? []).map(p => ({ id: p.id, ...(p.message ? { caption: p.message } : {}), ...(p.full_picture ? { mediaUrl: p.full_picture } : {}), ...(p.permalink_url ? { permalink: p.permalink_url } : {}), ...(p.created_time ? { publishedAt: Date.parse(p.created_time) } : {}) })),
          nextCursor: data.paging?.cursors?.after ?? null }
      } catch { return { posts: [], nextCursor: null } }
    },
    replyPublic: (ctx, input) => pageCommentAction(ctx, `${encodeURIComponent(input.commentId)}/comments`, { message: input.text }, 'public', input.commentId),
    like: (ctx, input) => pageCommentAction(ctx, `${encodeURIComponent(input.commentId)}/likes`, {}, 'like', input.commentId),
    replyPrivate: (ctx, input) => pageCommentAction(ctx, `${encodeURIComponent(ctx.credentials.pageId ?? '')}/messages`, { recipient: { comment_id: input.commentId },
      message: input.button ? { attachment: { type: 'template', payload: { template_type: 'button', text: input.text, buttons: [input.button.id !== undefined ? { type: 'postback', title: input.button.title, payload: input.button.id } : { type: 'web_url', title: input.button.title, url: input.button.url }] } } } : { text: input.text } }, 'private', input.commentId),
  },
  /** Saudação da página (greeting) no Messenger Profile: texto vazio remove. */
  async applySettings(ctx: ProviderCtx, settings: Record<string, unknown>) {
    const text = typeof settings.greeting === 'string' ? settings.greeting : ''
    try {
      const response = await ctx.fetch(`${base(ctx.connection)}/${ctx.credentials.pageId ?? ''}/messenger_profile`, {
        method: text ? 'POST' : 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.credentials.accessToken}` }, signal: AbortSignal.timeout(20_000),
        body: JSON.stringify(text ? { greeting: [{ locale: 'default', text }] } : { fields: ['greeting'] }) })
      if (!response.ok) throw new Error('provider')
    } catch { throw new Error('A página não aceitou a saudação. Confira a conexão.') }
  },

  async connect(ctx: ConnectContext) {
    try {
      const response = await ctx.fetch(`${base(ctx.connection)}/me?fields=id,name`, { headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` }, signal: AbortSignal.timeout(10_000) })
      const me = z.object({ id: z.string(), name: z.string().optional() }).safeParse(await response.json())
      const page = ctx.credentials.pageId ?? ''
      if (!response.ok || !me.success || !page || me.data.id !== page) {
        return { kind: 'failed' as const, code: 'invalid_credentials', detail: 'Messenger did not accept the page access token for this page' }
      }
      return { kind: 'done' as const, externalId: page, ...(me.data.name ? { displayName: me.data.name } : {}) }
    } catch { return { kind: 'failed' as const, code: 'unreachable', detail: 'Messenger could not be reached' } }
  },
  webhookChecklist: ['In the Meta app, open Messenger > Settings > Webhooks', 'Paste the callback URL and the verify token',
    'Subscribe to messages, messaging_postbacks, message_deliveries and message_reads', 'Subscribe the Page to the app'],
  async registerWebhook(ctx: ConnectContext) {
    return { registered: false as const, manual: { kind: 'manual_webhook' as const, callbackUrl: ctx.hookUrl, verifyToken: ctx.webhookSecret,
      checklist: [...messengerPage.webhookChecklist!] } }
  },
  async verifyWebhook(raw: RawWebhook, secrets: { webhookSecret: string; credentials: Credentials }): Promise<WebhookVerdict> {
    return verifyMetaWebhook(raw, secrets)
  },
  splitDelivery: itemsOf,
  /** A whole delivery (webhook body) or the single event the queue carries. */
  parseInbound(body: unknown, connection: Connection): InboundEventV2[] {
    if (envelope.safeParse(body).success) return envelope.parse(body).entry.flatMap(entry => [...(entry.messaging ?? []).flatMap(item => parseItem(item, entry.id)),
      ...(entry.changes ?? []).filter(c => c.field === 'feed').flatMap(c => parseFeedComment({ feed: c.value, page: entry.id }, entry.id))])
    const single = record(body)
    return single?.feed ? parseFeedComment(single, connection.externalId) : parseItem(body, connection.externalId)
  },
  fit(message: OutboundMessage, profile) {
    if (message.kind === 'cards') return fitCards(message, profile)
    if (message.kind === 'template') return /^[a-z0-9_]{1,512}$/.test(message.templateId) && message.params.language_code ? { messages: [message], degraded: [] } : unsupported('Template requires API name and language')
    if (message.kind !== 'text') return unsupported('Messenger transport supports text, button templates and quick replies')
    if (message.buttons?.length && message.quickReplies?.length) return unsupported('Choose buttons or quick replies')
    const replies = message.quickReplies ?? []
    if (replies.length > 13 || replies.some(q => !q.title || [...q.title].length > 20 || !q.id || bytes(q.id) > 1000)) {
      return unsupported('Quick replies require at most 13 titles of 20 characters and payloads of 1000 bytes')
    }
    // A button template limits its text to 640 characters.
    const fitted = fitMessage({ ...message, quickReplies: undefined }, { ...profile, text: { ...profile.text, maxLength: message.buttons?.length ? 640 : profile.text.maxLength } })
    if ('ok' in fitted) return fitted
    if (replies.length) {
      const last = fitted.messages.at(-1)!
      if (last.kind === 'text') last.quickReplies = replies
    }
    return fitted
  },
  async send(ctx: ProviderCtx & { target: SendTarget }, part: OutboundMessage): Promise<SendResult> {
    if (ctx.target.kind !== 'direct') return unsupported('Messenger groups are not supported')
    if (part.kind === 'cards') { const fitted = fitCards(part, ctx.connection.profile); if ('ok' in fitted) return fitted }
    if (part.kind !== 'text' && part.kind !== 'cards' && part.kind !== 'template') return unsupported('Messenger text transport requires text')
    if (!psid.safeParse(ctx.target.externalUserId).success) return rejected('invalid_recipient')
    return post(ctx, ctx.target.externalUserId, part)
  },
  /** Webhooks carry only the PSID; name and photo come from the User Profile API (empty when the app lacks that access). */
  async fetchProfile(ctx: ProviderCtx, who: Party) {
    if (!ctx.credentials.accessToken || !psid.safeParse(who.externalUserId).success) return null
    try {
      const response = await ctx.fetch(`${base(ctx.connection)}/${who.externalUserId}?fields=first_name,last_name,profile_pic`,
        { headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` }, signal: AbortSignal.timeout(10_000) })
      if (!response.ok) return null
      const profile = z.object({ first_name: z.string().max(200).optional(), last_name: z.string().max(200).optional(),
        profile_pic: z.string().url().max(2048).optional() }).parse(await response.json())
      return { ...(profile.first_name ? { firstName: profile.first_name } : {}), ...(profile.last_name ? { lastName: profile.last_name } : {}),
        ...(profile.profile_pic ? { avatar: { url: profile.profile_pic } } : {}) }
    } catch { return null } // Profile is cosmetic; never block the inbound message on it.
  },
  async sync(ctx: SyncContext, item: InboundEvent) {
    if (item.kind === 'receipt') await recordReceipt(ctx, item)
    else if (item.kind === 'message' || item.kind === 'click') await syncContact(ctx, item)
    // Quem abre a conversa por um link m.me com ref (Começar ou conversa que já existia) ganha identidade; o referral isolado não conta como mensagem.
    else if (item.kind === 'referral') await syncContact(ctx, item)
  },
}

/** Ações em comentário da página (resposta pública, curtida, resposta privada). Resultado ambíguo nunca é repetido às cegas. */
async function pageCommentAction(ctx: ProviderCtx, path: string, body: unknown, kind: 'public' | 'private' | 'like', commentId: string): Promise<SendResult> {
  let response: Response, raw: unknown
  try {
    response = await ctx.fetch(`${base(ctx.connection)}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.credentials.accessToken}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
    raw = await response.json()
  } catch { return { ok: false, reason: 'uncertain', detail: 'Messenger comment outcome uncertain; reconcile before retry' } }
  const error = record(record(raw)?.error)
  if (response.status === 429) return { ok: false, reason: 'rate_limited', retryAfterSec: 1 }
  if (error && response.status < 500) return rejected(String(typeof error.code === 'number' ? error.code : 'comment_rejected'))
  const data = record(raw)
  const externalId = kind === 'private' ? data?.message_id : kind === 'public' ? data?.id : data?.success === true ? commentId : undefined
  if (!response.ok || !id.safeParse(externalId).success) return { ok: false, reason: 'uncertain', detail: 'Messenger returned no valid comment confirmation' }
  return { ok: true, externalId: externalId as string, parts: 1 }
}
