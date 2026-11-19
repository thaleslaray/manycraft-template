import { z } from 'zod'
import type { Connection, ConnectContext, Credentials, InboundEventV2, Party, ProfilePatch, ProviderAdapter, ProviderCtx, RawWebhook, SendTarget, WebhookVerdict } from './contract'
import { equalSecret } from './core/webhook-http'
import { mediaError } from '../schemas/message-media'
import { fitMessage } from './fit'
import { telegramContact, telegramContentKeys, telegramLocation, telegramUpdate } from './telegram-update'
import type { Button, Degradation, InboundEvent, OutboundMessage, SendResult } from './types'
import { changeBlock } from './core/consent'

const API = 'https://api.telegram.org'
const botToken = (credentials: Credentials) => credentials.botToken ?? ''
/** Development can point a connection at a fake Bot API through settings.apiBase (the connections route only accepts it outside production). */
const apiRoot = (connection?: Connection) => typeof connection?.settings.apiBase === 'string' ? connection.settings.apiBase : API
const base = (credentials: Credentials, connection?: Connection) => `${apiRoot(connection)}/bot${botToken(credentials)}`
// Fetch errors embed the bot token in their URL: they are caught here and never logged or returned.

type InlineButton = { text: string; callback_data?: string; url?: string }
const sendReply = z.object({ ok: z.boolean(), error_code: z.number().optional(),
  parameters: z.object({ retry_after: z.number().positive().max(86400).optional() }).optional(),
  description: z.string().optional(),
  result: z.object({ message_id: z.number().int() }).optional() })

/** One button per row; fit only lets postback and url through, the two kinds InlineKeyboardButton can carry here (tipos/InlineKeyboardButton.md). */
const inlineKeyboard = (buttons: Button[] = []): InlineButton[][] => buttons.map(b => [{ text: b.title,
  ...(b.type === 'postback' ? { callback_data: b.id } : b.type === 'url' ? { url: b.url } : {}) }])
/** caption: 0-1024 characters after entities parsing (sendPhoto.md, sendAudio.md, sendVideo.md, sendDocument.md). */
const CAPTION_MAX = 1024
/** The pt-BR reason for a revoked bot token (HTTP 401 on a send): core/failure.ts shows it on the conversation, the broadcast and the connection. */
const tokenRefused = 'O token do bot foi recusado pelo Telegram (foi revogado no @BotFather ou o bot foi apagado). Gere um token novo no @BotFather e use “Trocar credencial” em Canais.'

async function postMessage(ctx: ProviderCtx, chatId: string, text: string, buttons: InlineButton[][], media?: Extract<OutboundMessage, { kind: 'media' }>): Promise<SendResult> {
  let result: unknown
  try {
    const response = await ctx.fetch(`${base(ctx.credentials, ctx.connection)}/${media ? { image: 'sendPhoto', audio: 'sendAudio', video: 'sendVideo', file: 'sendDocument' }[media.media] : 'sendMessage'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ chat_id: chatId, ...(media ? { [{ image: 'photo', audio: 'audio', video: 'video', file: 'document' }[media.media]]: media.url, ...(media.caption ? { caption: media.caption } : {}) } : { text }), ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}) }),
    })
    result = await response.json()
  } catch { return { ok: false, reason: 'uncertain', detail: 'Telegram send outcome uncertain; reconcile before retry' } }
  const parsed = sendReply.safeParse(result)
  if (parsed.success && !parsed.data.ok && parsed.data.error_code === 429) {
    return { ok: false, reason: 'rate_limited', retryAfterSec: parsed.data.parameters?.retry_after ?? 1 }
  }
  if (!parsed.success || !parsed.data.ok || !parsed.data.result) {
    if (parsed.success && !parsed.data.ok && parsed.data.error_code === 403) return { ok: false, reason: 'blocked' }
    // 401 Unauthorized: the bot token was revoked (/revoke in @BotFather) or the bot deleted. Every next send fails the same way, so the neutral code
    // says it (core/failure.ts pauses broadcasts and takes the connection to error with `detail` as the reason the person reads).
    if (parsed.success && !parsed.data.ok && parsed.data.error_code === 401) return { ok: false, reason: 'rejected', code: 'token_refused', detail: tokenRefused }
    if (parsed.success && !parsed.data.ok && parsed.data.error_code && parsed.data.error_code < 500) {
      return { ok: false, reason: 'rejected', code: String(parsed.data.error_code), detail: parsed.data.description ? `Telegram rejected send: ${parsed.data.description.slice(0, 200)}` : 'Telegram rejected send' }
    }
    return { ok: false, reason: 'uncertain', detail: 'Telegram returned no valid send confirmation' }
  }
  return { ok: true, externalId: String(parsed.data.result.message_id), parts: 1 }
}

const photoSizes = z.array(z.object({ file_id: z.string().min(1).max(512), width: z.number().int(), height: z.number().int() }))
const MAX_AVATAR_BYTES = 1024 * 1024
/** Bytes of the user's current photo. The file URL embeds the bot token, so it is fetched here and never returned, stored or logged. */
async function profilePhoto(ctx: ProviderCtx, userId: string): Promise<ArrayBuffer | null> {
  if (!botToken(ctx.credentials) || !/^\d{1,20}$/.test(userId)) return null
  const call = async (method: string, params: Record<string, string | number>) => {
    const response = await ctx.fetch(`${base(ctx.credentials, ctx.connection)}/${method}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`,
      { signal: AbortSignal.timeout(10_000) })
    return response.ok ? await response.json() : null
  }
  try {
    const photos = z.object({ ok: z.literal(true), result: z.object({ total_count: z.number().int(), photos: z.array(photoSizes).max(1) }) })
      .safeParse(await call('getUserProfilePhotos', { user_id: userId, limit: 1 }))
    const sizes = photos.success ? photos.data.result.photos[0] : undefined
    if (!sizes?.length) return null
    const ordered = [...sizes].sort((a, b) => a.width - b.width)
    const chosen = ordered.find(s => s.width >= 160) ?? ordered.at(-1)!
    const file = z.object({ ok: z.literal(true), result: z.object({ file_path: z.string().regex(/^[\w\-./]{1,256}$/).refine(p => !p.includes('..')) }) })
      .safeParse(await call('getFile', { file_id: chosen.file_id }))
    if (!file.success) return null
    const download = await ctx.fetch(`${apiRoot(ctx.connection)}/file/bot${botToken(ctx.credentials)}/${file.data.result.file_path}`, { signal: AbortSignal.timeout(10_000) })
    if (!download.ok) return null
    const bytes = await download.arrayBuffer()
    return bytes.byteLength > 0 && bytes.byteLength <= MAX_AVATAR_BYTES ? bytes : null
  } catch { return null } // Photo is cosmetic; the panel falls back to initials on 404.
}

const party = (id: number, from: { first_name?: string; last_name?: string; username?: string }): Party => ({
  externalUserId: String(id), addressKind: 'telegram_id',
  ...(!from.first_name && !from.last_name && !from.username ? {} : { profile: {
    ...(from.first_name === undefined ? {} : { firstName: from.first_name }),
    ...(from.last_name === undefined ? {} : { lastName: from.last_name }),
    ...(from.username === undefined ? {} : { username: from.username }),
  } }),
})
const updateId = z.object({ update_id: z.number().int().nonnegative() }).passthrough()

export const telegramBot: ProviderAdapter = {
  id: 'telegram_bot',
  kinds: ['telegram'],
  patch: {} as ProfilePatch,
  credentialsSchema: z.record(z.string(), z.string()).refine(c => !!c.botToken, { message: 'botToken is required' }),
  settingsSchema: z.record(z.string(), z.unknown()),

  async connect(ctx: ConnectContext) {
    try {
      const response = await ctx.fetch(`${base(ctx.credentials, ctx.connection)}/getMe`, { signal: AbortSignal.timeout(10_000) })
      if (response.status >= 500 || response.status === 429) return { kind: 'failed' as const, code: 'unreachable', detail: 'Telegram is unavailable' }
      const me = z.object({ ok: z.literal(true), result: z.object({ id: z.number().int(), username: z.string().optional() }) }).safeParse(await response.json())
      if (!me.success) return { kind: 'failed' as const, code: 'invalid_credentials', detail: 'Telegram did not accept the bot token' }
      return { kind: 'done' as const, externalId: String(me.data.result.id), ...(me.data.result.username ? { displayName: `@${me.data.result.username}` } : {}) }
    } catch { return { kind: 'failed' as const, code: 'unreachable', detail: 'Telegram could not be reached' } }
  },
  async registerWebhook(ctx: ConnectContext) {
    const manual = { kind: 'manual_webhook' as const, callbackUrl: ctx.hookUrl, verifyToken: ctx.webhookSecret,
      checklist: ['Call setWebhook with this URL and secret_token'] }
    try {
      const response = await ctx.fetch(`${base(ctx.credentials, ctx.connection)}/setWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ url: ctx.hookUrl, secret_token: ctx.webhookSecret, allowed_updates: ['message', 'callback_query', 'my_chat_member'] }) })
      const reply = z.object({ ok: z.boolean() }).safeParse(await response.json())
      return reply.success && reply.data.ok ? { registered: true as const } : { registered: false as const, manual }
    } catch { return { registered: false as const, manual } }
  },
  /** Archiving stops deliveries; best effort, since the token may already be revoked. */
  async disconnect(ctx: ConnectContext) {
    try { await ctx.fetch(`${base(ctx.credentials, ctx.connection)}/deleteWebhook`, { method: 'POST', signal: AbortSignal.timeout(10_000) }) } catch { /* see above */ }
  },
  async verifyWebhook(raw: RawWebhook, secrets: { webhookSecret: string; credentials: Credentials }): Promise<WebhookVerdict> {
    if (raw.method !== 'POST') return { ok: false, status: 400 }
    const supplied = raw.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? ''
    return secrets.webhookSecret && await equalSecret(supplied, secrets.webhookSecret) ? { ok: true } : { ok: false, status: 401 }
  },
  /** Only the update id is required to accept a delivery; an update this bot cannot use is reported as ignored, not rejected. */
  parseInbound(body: unknown, _connection: Connection): InboundEventV2[] {
    const eventKey = String(updateId.parse(body).update_id)
    const parsed = telegramUpdate.safeParse(body)
    if (!parsed.success) return [{ kind: 'ignored', why: 'Invalid Telegram update', eventKey }]
    const query = parsed.data.callback_query
    if (query) {
      if (query.from.is_bot || query.message?.chat.type !== 'private' || query.message.chat.id !== query.from.id || !query.data) {
        return [{ kind: 'ignored', why: 'Unsupported Telegram callback', eventKey }]
      }
      return [{ kind: 'click', eventKey, from: party(query.from.id, {}), thread: { kind: 'direct' }, payload: query.data, ackToken: query.id }]
    }
    // tipos/Update.md: in a private chat my_chat_member arrives only when the user blocks (status kicked) or unblocks (member) the bot.
    const member = parsed.data.my_chat_member
    if (member) {
      const status = member.new_chat_member.status
      if (member.from.is_bot || member.chat.type !== 'private' || member.chat.id !== member.from.id || (status !== 'kicked' && status !== 'member')) {
        return [{ kind: 'ignored', why: 'Unsupported Telegram chat member update', eventKey }]
      }
      return [{ kind: status === 'kicked' ? 'optout' : 'optin', eventKey, from: party(member.from.id, {}) }]
    }
    const m = parsed.data.message
    if (!m || m.from.is_bot || m.chat.type !== 'private' || m.chat.id !== m.from.id) return [{ kind: 'ignored', why: 'Unsupported Telegram update', eventKey }]
    // tipos/Message.md: what the user sent besides text. Files are not downloaded yet, so they are named as unsupported instead of arriving as an empty message.
    const text = m.text ?? m.caption
    const kind = telegramContentKeys.find(key => m[key] !== undefined)
    const location = telegramLocation.safeParse(m.location)
    const contact = telegramContact.safeParse(m.contact)
    return [{ kind: 'message', eventKey, from: party(m.from.id, m.from), thread: { kind: 'direct' },
      externalMessageId: String(m.message_id), ...(m.date ? { occurredAt: m.date * 1000 } : {}), ...(text === undefined ? {} : { text: [...text].length > 4096 ? [...text].slice(0, 4096).join('') : text }),
      ...(location.success ? { location: { latitude: location.data.latitude, longitude: location.data.longitude } } : {}),
      ...(contact.success ? { sharedContacts: [{ name: [contact.data.first_name, contact.data.last_name].filter(Boolean).join(' '), phones: [contact.data.phone_number], emails: [] }] } : {}),
      ...(kind ? { unsupported: { type: kind } } : {}) }]
  },
  /** Native media stays neutral until this provider boundary. */
  fit(message: OutboundMessage, profile) {
    if (message.kind === 'media') {
      const error = mediaError(message, [profile], false)
      if (error) return { ok: false, reason: 'unsupported', detail: error }
      const degraded: Degradation[] = []
      let fitted = message
      if (message.buttons?.length) {
        // reply_markup is accepted by every media method; the same button rules as text apply, in a single message.
        const checked = fitMessage({ kind: 'text', text: '.', buttons: message.buttons }, profile)
        if ('ok' in checked) return checked
        const only = checked.messages[0]
        if (checked.messages.length !== 1 || only?.kind !== 'text') return { ok: false, reason: 'unsupported', detail: 'Too many buttons for one media message' }
        fitted = { ...fitted, buttons: only.buttons ?? [] }
        degraded.push(...checked.degraded)
      }
      if (message.caption && [...message.caption].length > CAPTION_MAX) {
        fitted = { ...fitted, caption: [...message.caption].slice(0, CAPTION_MAX - 1).join('') + '…' }
        degraded.push({ kind: 'text_truncated', at: CAPTION_MAX })
      }
      return { messages: [fitted], degraded }
    }
    const fitted = fitMessage(message, profile)
    if ('ok' in fitted) return fitted
    if (fitted.messages.some(part => part.kind !== 'text')) return { ok: false, reason: 'unsupported', detail: 'Telegram text transport requires text' }
    return fitted
  },
  async send(ctx: ProviderCtx & { target: SendTarget }, part: OutboundMessage): Promise<SendResult> {
    if (ctx.target.kind !== 'direct') return { ok: false, reason: 'unsupported', detail: 'Telegram groups are not supported' }
    if (part.kind === 'media') {
      const fitted = telegramBot.fit(part, ctx.connection.profile)
      if ('ok' in fitted) return fitted
      const sendable = fitted.messages[0]
      return sendable?.kind === 'media' ? postMessage(ctx, ctx.target.externalUserId, '', inlineKeyboard(sendable.buttons), sendable) : { ok: false, reason: 'unsupported', detail: 'Telegram media fit returned no media' }
    }
    if (part.kind !== 'text') return { ok: false, reason: 'unsupported', detail: 'Telegram text transport requires text' }
    return postMessage(ctx, ctx.target.externalUserId, part.text, inlineKeyboard(part.buttons))
  },
  /** The user blocking or unblocking the bot (my_chat_member) books the same contact flag a refused send does (core/delivery.ts); a normal message newer than the block clears it (reopenWindow in flow/dispatch.ts). */
  async sync(ctx, item: InboundEvent) {
    if (item.kind !== 'optout' && item.kind !== 'optin') return
    // A hora é a do Telegram (`my_chat_member.date`), nunca depois da recepção: bloquear e desbloquear fora de ordem na fila termina no último fato.
    const date = Number((ctx.event.payload as { my_chat_member?: { date?: unknown } } | undefined)?.my_chat_member?.date), received = ctx.event.receivedAt ?? Date.now()
    const at = Math.min(Number.isFinite(date) && date > 0 ? date * 1000 : received, received)
    await changeBlock(ctx.env.DB, { blocked: item.kind === 'optout', at,
      where: { sql: 'workspace_id=? AND channel_id=? AND external_user_id=?', binds: [ctx.event.workspaceId, ctx.event.channelId, item.externalUserId] } }).run()
  },
  /** sendChatAction lasts about 5 s on Telegram; the flow executor calls it again for a longer pause. */
  async typing(ctx: ProviderCtx & { target: SendTarget }): Promise<SendResult> {
    if (ctx.target.kind !== 'direct') return { ok: false, reason: 'unsupported', detail: 'Telegram groups are not supported' }
    try {
      const response = await ctx.fetch(`${base(ctx.credentials, ctx.connection)}/sendChatAction`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5_000),
        body: JSON.stringify({ chat_id: ctx.target.externalUserId, action: 'typing' }),
      })
      const reply = z.object({ ok: z.boolean(), error_code: z.number().optional(), parameters: z.object({ retry_after: z.number().positive().max(86400).optional() }).optional() }).safeParse(await response.json())
      if (reply.success && reply.data.ok) return { ok: true, externalId: 'typing', parts: 0 }
      if (reply.success && reply.data.error_code === 429) return { ok: false, reason: 'rate_limited', retryAfterSec: reply.data.parameters?.retry_after ?? 1 }
      return { ok: false, reason: 'rejected', code: String(reply.success ? reply.data.error_code ?? 'unknown' : 'unknown'), detail: 'Telegram rejected the typing indicator' }
    } catch { return { ok: false, reason: 'uncertain', detail: 'Telegram typing outcome uncertain' } }
  },
  async fetchProfile(ctx: ProviderCtx, who: Party) {
    const bytes = await profilePhoto(ctx, who.externalUserId)
    return bytes ? { avatar: { bytes } } : null
  },
  /** Dismisses the Telegram spinner only; delivery is tracked separately. An expired ack must not retry an already queued click. */
  async ack(ctx, event) {
    if (!botToken(ctx.credentials) || !event.ackToken) return
    try {
      await ctx.fetch(`${base(ctx.credentials, ctx.connection)}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(1000),
        body: JSON.stringify({ callback_query_id: event.ackToken }),
      })
    } catch { /* see above */ }
  },
}
