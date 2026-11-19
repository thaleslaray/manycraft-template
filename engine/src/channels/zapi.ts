import { z } from 'zod'
import type { Connection, ConnectContext, ConnectStep, Credentials, DeliveryPart, InboundEventV2, Party, ProfilePatch, ProviderAdapter, ProviderCtx, RawWebhook, SendTarget, WebhookVerdict } from './contract'
import { equalSecret } from './core/webhook-http'
import { fitMessage } from './fit'
import { syncZapi } from './zapi-sync'
import { zapiMeta } from './zapi-meta'
import type { OutboundMessage, SendResult } from './types'

// Z-API classic (api.z-api.io, "instances"), WhatsApp Web paired by QR code; unofficial. NOT the Omni platform (api.omni.z-api.io, Bearer, /v1/channels):
// that is another surface with other paths, auth and payloads (docs-zapi AC-18).
// Source of truth: the local mirror ~/.claude/skills/docs-zapi (SKILL.md, site/, repositorio/docs/, postman/, referencias/avisos-cruzados.md):
//   security/introduction.md, security/client-token.md   URL https://api.z-api.io/instances/{instanceId}/token/{token}/<route>, header `Client-Token`
//   message/send-text.md, send-button-list.md, send-button-actions.md   answer 200 {zaapId, messageId, id}
//   instance/status.md, instance/qr-code.md                GET /status {connected, error, smartphoneConnected}; GET /qr-code {value: data URI} or {challenge}
//   webhooks/*.md   PUT update-webhook-{received,delivery,message-status,connected,disconnected} {value: https url} -> {value: true}; PUT update-notify-sent-by-me
//   webhooks/on-message-received(-examples).md, on-whatsapp-message-status-changes.md, on-message-send.md, on-webhook-connected.md, on-whatsapp-disconnected.md
// Cross-source warnings applied (avisos-cruzados.md):
//   AC-02  the site omits the Client-Token header on endpoint pages, the repository and Postman send it: it is sent on every call when configured.
//   AC-08  repository pages spell `update-webhook-receive` and `update-webhook-status`; the site and Postman use `-received` and `-message-status`: the latter.
//   AC-12  button support is unstable (the page marks all as working, its own summary says otherwise): buttons stay in profile.unstable.
//   AC-14  no rate limit or 429 is documented. 429 is still mapped (plain HTTP) so a surprise is never taken for a failure of the message.
//   AC-15  /qr-code: the site says JSON {value: data URI} or {challenge}, the repository says "bytes". Only the site's JSON is read; a `challenge`
//          (passkey/WebAuthn, POST /passkey-prologue) is not implemented here and ends in a clear failure instead of a guess.
//   AC-16  `fromApi` shows only in the site's examples, not in the attribute table; it is used to tell the echo of an API send from the owner's phone.
// Not documented (so not guessed): the shape of the error body of a failed send (only the HTTP status is read), that the `ids` of a status callback are
// the `messageId` the send returned (assumed, the page says "identificador da mensagem"), any rate limit, media/list/cards/groups (off in zapi-meta.ts).
// Webhook authentication: classic Z-API signs nothing and documents no header it sends back (the Client-Token is for calls TO the API). The only thing the
// documentation lets us control is the URL, so the connection's own webhook secret rides in the query of the URL we register (`?k=<secret>`) and is compared
// in constant time. A path segment would be the same proof but needs a new route in core, which this adapter must not touch. The URL must be https (Z-API
// refuses anything else) and is shown only to the account owner (it is part of the registered URL).

const messageId = z.string().min(1).max(256)
const ZAPI_API = 'https://api.z-api.io'
const QR_VALID_MS = 20_000   // docs (instance/qr-code, tips): WhatsApp invalidates the QR every 20 s
const NOT_PAIRED = 'O número foi desconectado do WhatsApp.'

// ---- addressing ----------------------------------------------------------------------------------------------------------------
/** Docs (message/send-text.md): `phone` is digits only, country code and area code included. The same form comes back in `phone` of the webhooks. */
export const isPhoneId = (id: unknown): id is string => typeof id === 'string' && /^\d{7,15}$/.test(id)
const asString = (value: unknown) => typeof value === 'string' && value.length ? value : undefined
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const party = (phone: string, name?: string): Party => ({ externalUserId: phone, addressKind: 'wa_pn', phoneE164: `+${phone}`,
  ...(name && !/^[\d+\s-]+$/.test(name) ? { profile: { firstName: name } } : {}) })

// ---- server ----------------------------------------------------------------------------------------------------------------------
/** The Z-API host is fixed. Development can point a connection at a fake one through settings.apiBase (the connections service only accepts it
 * outside production), so a credential can never be sent to a host the customer typed. */
export function apiRoot(connection?: Connection): string {
  return typeof connection?.settings.apiBase === 'string' ? connection.settings.apiBase.replace(/\/+$/, '') : ZAPI_API
}
type Reply = { status: number; data: unknown; headers: Headers }
type CallCtx = { credentials: Credentials; connection?: Connection; fetch: typeof fetch }
/** One call to the instance. The instance id and token live in the path (docs: security/introduction.md) and are never put in a message or log. */
async function call(ctx: CallCtx, method: 'GET' | 'POST' | 'PUT', route: string, body?: unknown, timeoutMs = 20_000): Promise<Reply> {
  const { instanceId, token, clientToken } = ctx.credentials
  if (!instanceId || !token) throw new Error('Z-API credentials not configured')
  const response = await ctx.fetch(`${apiRoot(ctx.connection)}/instances/${encodeURIComponent(instanceId)}/token/${encodeURIComponent(token)}${route}`, { method, signal: AbortSignal.timeout(timeoutMs),
    // docs (security/client-token.md): once the account's security token is on, every call needs it; sent whenever configured (AC-02).
    headers: { 'Content-Type': 'application/json', ...(clientToken ? { 'Client-Token': clientToken } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  let data: unknown = null
  try { data = await response.json() } catch { /* not JSON: callers treat it as no confirmation */ }
  return { status: response.status, data, headers: response.headers }
}

// ---- sending ---------------------------------------------------------------------------------------------------------------------
/** The pt-BR reason for a refused credential (HTTP 401 on a send): core/failure.ts shows it on the conversation, the broadcast and the connection. */
const tokenRefused = 'O token da instância ou o Client-Token foi recusado pela Z-API (foi trocado ou a instância foi apagada). Copie os dados atuais no painel da Z-API e use “Trocar credencial” em Canais.'
const rejected = (code: string): SendResult => ({ ok: false, reason: 'rejected', code, detail: 'Z-API rejected send; check the instance' })
const unsupported = (detail: string) => ({ ok: false as const, reason: 'unsupported' as const, detail })
const retryAfter = (headers: Headers) => { const n = Number(headers.get('retry-after')); return n > 0 && n <= 86400 ? Math.ceil(n) : 1 }
type Text = Extract<OutboundMessage, { kind: 'text' }>

/** Route and body of a text. Docs: send-text; send-button-list (reply buttons, `{id, label}`); send-button-actions (type URL). The docs also have type CALL,
 * but the shared WhatsApp profile has no call button, so it stays off (zapi-meta.ts); and REPLY must go apart from URL/CALL ("all three at once fail on
 * WhatsApp Web"), so `fit` refuses a mix and only one family reaches here. */
function request(phone: string, message: Text): { route: string; body: Record<string, unknown> } {
  const buttons = message.buttons ?? []
  if (!buttons.length) return { route: '/send-text', body: { phone, message: message.text } }
  if (buttons.every(b => b.type === 'postback')) {
    return { route: '/send-button-list', body: { phone, message: message.text, buttonList: { buttons: buttons.map(b => ({ id: b.type === 'postback' ? b.id : '', label: b.title })) } } }
  }
  return { route: '/send-button-actions', body: { phone, message: message.text, buttonActions: buttons.map((b, index) =>
    ({ id: String(index + 1), type: 'URL', label: b.title, url: b.type === 'url' ? b.url : '' })) } }
}

async function post(ctx: ProviderCtx, phone: string, message: Text): Promise<SendResult> {
  const { route, body } = request(phone, message)
  let reply: Reply
  try { reply = await call(ctx, 'POST', route, body) }
  catch { return { ok: false, reason: 'uncertain', detail: 'Z-API send outcome uncertain; reconcile before retry' } }
  if (reply.status === 429) return { ok: false, reason: 'rate_limited', retryAfterSec: retryAfter(reply.headers) }
  if (reply.status === 200) {
    // docs: 200 {zaapId, messageId, id}; `id` repeats `messageId` for Zapier.
    const data = record(reply.data)
    const id = messageId.safeParse(data?.messageId ?? data?.id)
    return id.success ? { ok: true, externalId: id.data, parts: 1 } : { ok: false, reason: 'uncertain', detail: 'Z-API returned no valid send confirmation' }
  }
  // docs: 405 (wrong method) and 415 (no JSON content type) are the documented errors; the body of a failed send is not documented, so only the status is read.
  // 401: the instance token or the Client-Token was refused (security/client-token.md). Every next send fails the same way, so the neutral code says it
  // (core/failure.ts takes the connection to error with `detail` as the reason); other 4xx only refuse this message.
  if (reply.status === 401) return { ok: false, reason: 'rejected', code: 'token_refused', detail: tokenRefused }
  if (reply.status >= 400 && reply.status < 500) return rejected(String(reply.status))
  return { ok: false, reason: 'uncertain', detail: 'Z-API returned no valid send confirmation' }   // 5xx: the instance may have sent it
}

// ---- inbound ---------------------------------------------------------------------------------------------------------------------
const ids = (value: unknown): string[] => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
const moment = (value: unknown) => typeof value === 'number' && value > 0 ? value : undefined
const stamp = (occurredAt: number | undefined) => occurredAt === undefined ? {} : { occurredAt }

/** Docs (webhooks/on-whatsapp-message-status-changes.md): SENT, RECEIVED (delivered), READ, READ_BY_ME (the owner read it: not news about our message), PLAYED. */
const statusOf = (status: unknown): 'sent' | 'delivered' | 'read' | undefined =>
  status === 'SENT' ? 'sent' : status === 'RECEIVED' ? 'delivered' : status === 'READ' || status === 'PLAYED' ? 'read' : undefined

/** Events that carry the id of the message they talk about are keyed by it, so a repeated delivery is the same event. */
function parseReceived(root: Record<string, unknown>): InboundEventV2[] {
  const id = asString(root.messageId)
  if (!id) return [{ kind: 'ignored', why: 'Z-API message without id', eventKey: 'none:ReceivedCallback' }]
  const ignored = (why: string, eventKey = id): InboundEventV2[] => [{ kind: 'ignored', why, eventKey }]
  const occurredAt = moment(root.momment)
  if (root.isGroup === true || root.isNewsletter === true) return ignored('Group messages are not supported yet')
  if (root.isEdit === true || root.isStatusReply === true || root.waitingMessage === true) return ignored('Unsupported Z-API message type')
  const phone = root.phone
  if (!isPhoneId(phone)) return ignored('Unsupported Z-API address')
  const text = asString(record(root.text)?.message)
  if (root.fromMe === true) {
    // With "notify sent by me" on, the owner's own messages come back here. `fromApi` marks the echo of a send made through the API (ours or another integration's).
    if (root.fromApi === true) return ignored('Echo of a send made through the API', `${id}:echo`)
    return [{ kind: 'own_message', eventKey: id, to: party(phone), thread: { kind: 'direct' }, externalMessageId: id,
      ...(text ? { text } : {}), ...stamp(occurredAt), sentByApi: false }]
  }
  const common = { eventKey: id, from: party(phone, asString(root.senderName) ?? asString(root.chatName)), thread: { kind: 'direct' as const }, ...stamp(occurredAt) }
  // docs (on-message-received-examples): a tap on a reply button arrives as buttonsResponseMessage {buttonId, message} with the id we sent.
  const picked = record(root.buttonsResponseMessage)
  const buttonId = asString(picked?.buttonId), label = asString(picked?.message)
  if (buttonId) return [{ kind: 'click', ...common, payload: buttonId, ...(label ? { label } : {}) }]
  if (!text) return ignored('Unsupported Z-API message type')
  return [{ kind: 'message', ...common, externalMessageId: id, text }]
}

function parseStatus(root: Record<string, unknown>): InboundEventV2[] {
  const status = statusOf(root.status), list = ids(root.ids)
  if (root.isGroup === true) return [{ kind: 'ignored', why: 'Group receipts are not supported yet', eventKey: `${list[0] ?? 'none'}:group` }]
  if (!status || !list.length) return [{ kind: 'ignored', why: 'Noise: status without news about a message', eventKey: `${list[0] ?? 'none'}:${asString(root.status) ?? 'none'}` }]
  return list.map(id => ({ kind: 'receipt' as const, eventKey: `${id}:${status}`, externalMessageId: id, status, ...stamp(moment(root.momment)) }))
}

/** Parses one webhook body of the instance. `type` names the event (docs: ReceivedCallback, MessageStatusCallback, DeliveryCallback, ConnectedCallback, DisconnectedCallback). */
function parseEvent(root: Record<string, unknown>): InboundEventV2[] {
  switch (root.type) {
    case 'ReceivedCallback': return parseReceived(root)
    case 'MessageStatusCallback': return parseStatus(root)
    case 'DeliveryCallback': {
      // "Ao enviar": `error` is present only when the send failed. A success carries nothing the status callback does not bring later.
      const id = asString(root.messageId), error = asString(root.error)
      if (!id) return [{ kind: 'ignored', why: 'Noise: send callback without id', eventKey: 'none:delivery' }]
      if (!error) return [{ kind: 'ignored', why: 'Noise: send accepted', eventKey: `${id}:accepted` }]
      return [{ kind: 'receipt', eventKey: `${id}:failed`, externalMessageId: id, status: 'failed', ...stamp(moment(root.momment)) }]
    }
    // The state of the number, proven by the provider itself (docs: on-webhook-connected, on-whatsapp-disconnected).
    case 'ConnectedCallback': return root.connected === true
      ? [{ kind: 'connection', eventKey: `connected:${moment(root.momment) ?? 0}`, status: 'connected' }]
      : [{ kind: 'ignored', why: 'Noise: connected callback without connection', eventKey: `connected:${moment(root.momment) ?? 0}` }]
    case 'DisconnectedCallback': return root.disconnected === true
      ? [{ kind: 'connection', eventKey: `disconnected:${moment(root.momment) ?? 0}`, status: 'disconnected', detail: NOT_PAIRED }]
      : [{ kind: 'ignored', why: 'Noise: disconnected callback without disconnection', eventKey: `disconnected:${moment(root.momment) ?? 0}` }]
    case 'PresenceChatCallback': return [{ kind: 'ignored', why: 'Noise: presence', eventKey: `presence:${moment(root.momment) ?? 0}` }]
    default: return [{ kind: 'ignored', why: 'Unsupported Z-API event', eventKey: `${asString(root.messageId) ?? 'unknown'}:${asString(root.type) ?? 'unknown'}` }]
  }
}

/** One part per event, without the instance id. Echoes and noise never reach the queue; a status callback about several ids is split per id. */
export function splitZapi(body: unknown): DeliveryPart[] {
  const root = record(body)
  if (typeof root?.type !== 'string') return []
  const { instanceId: _instance, ...rest } = root
  return parseEvent(root).flatMap((event): DeliveryPart[] => {
    if (event.kind === 'ignored' && (!event.eventKey || /^(Echo|Noise)/.test(event.why))) return []
    const key = 'eventKey' in event ? event.eventKey : undefined
    if (!key) return []
    return [{ eventKey: key, payload: event.kind === 'receipt' && root.type === 'MessageStatusCallback' ? { ...rest, ids: [event.externalMessageId] } : rest }]
  })
}

// ---- connect ---------------------------------------------------------------------------------------------------------------------
/** The QR comes as a data URI (docs: instance/qr-code.md `{value}`); a bare base64 string is accepted too, as PNG. */
export function qrImage(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (!text || text.startsWith('data:') || text.startsWith('https://')) return text
  return /^[A-Za-z0-9+/=\s]+$/.test(text) ? `data:image/png;base64,${text.replace(/\s+/g, '')}` : ''
}

/** Docs: GET /status answers {connected, error, smartphoneConnected}. It proves the instance id, token and Client-Token at once, so it is the only
 * probe before pairing; connected=false then asks for the QR (GET /qr-code). Calling the QR of a connected instance is refused by Z-API. */
async function connect(ctx: ConnectContext): Promise<ConnectStep> {
  const failed = (code: string, detail: string) => ({ kind: 'failed' as const, code, detail })
  try {
    const account = `zapi:${ctx.credentials.instanceId}`
    const status = await call(ctx, 'GET', '/status', undefined, 15_000)
    if ([400, 401, 403, 404].includes(status.status)) return failed('invalid_credentials', 'Z-API did not accept the instance, the token or the Client-Token')
    const state = record(status.data)
    if (status.status !== 200 || typeof state?.connected !== 'boolean') return failed('unreachable', 'Z-API answered with something unexpected')
    if (state.connected) return { kind: 'done', externalId: account }
    const reply = await call(ctx, 'GET', '/qr-code', undefined, 15_000)
    const data = record(reply.data)
    if (reply.status === 200 && data?.challenge !== undefined) return failed('passkey_required', 'Este número exige chave de acesso (passkey) para parear, o que ainda não é suportado. Conecte pelo painel da Z-API.')
    const qr = qrImage(data?.value)
    if (reply.status !== 200 || !qr) return failed('unreachable', 'Z-API did not return a QR code')
    return { kind: 'qr', qr, expiresAt: Date.now() + QR_VALID_MS, externalId: account }
  } catch { return failed('unreachable', 'Z-API could not be reached') }
}

// ---- webhook ---------------------------------------------------------------------------------------------------------------------
/** The URL Z-API will call: the connection's own URL plus its secret (see the header comment). */
export const hookTarget = (hookUrl: string, secret: string) => `${hookUrl}${hookUrl.includes('?') ? '&' : '?'}k=${encodeURIComponent(secret)}`
/** Docs (webhooks/*): one PUT per event, `{value: url}` -> `{value: true}` (AC-08: the `-received` and `-message-status` spellings). */
const WEBHOOK_ROUTES = ['/update-webhook-received', '/update-webhook-delivery', '/update-webhook-message-status', '/update-webhook-connected', '/update-webhook-disconnected']

export const zapi: ProviderAdapter = {
  id: 'zapi',
  syncDelivery: ctx => syncZapi(ctx),   // lazy: zapi-sync imports this module back
  kinds: ['whatsapp'],
  patch: zapiMeta.patch as ProfilePatch,
  credentialsSchema: z.record(z.string(), z.string()).refine(c => /^[A-Za-z0-9]{8,64}$/.test(c.instanceId ?? '') && /^[A-Za-z0-9]{8,64}$/.test(c.token ?? '')
    && (!c.clientToken || /^[\x21-\x7e]{8,128}$/.test(c.clientToken)), { message: 'instanceId and token are required' }),
  settingsSchema: z.record(z.string(), z.unknown()),
  connect,

  /** Registers the five webhooks on the connection's URL, then asks for the owner's own messages too ("notify sent by me", docs: update-notify-sent-by-me)
   * and stops Z-API from queueing sends while the phone is offline (docs: update-queue-settings; the queue would otherwise fire everything on reconnect).
   * Repeating it only rewrites the same values. Any refusal ends in the guided manual step. */
  async registerWebhook(ctx: ConnectContext) {
    const url = hookTarget(ctx.hookUrl, ctx.webhookSecret)
    const manual = { kind: 'manual_webhook' as const, callbackUrl: url, verifyToken: '',
      checklist: ['No painel da Z-API, abra a instância e a aba de webhooks', 'Cole a URL de retorno nos webhooks Ao receber, Ao enviar, Status da mensagem, Ao conectar e Ao desconectar', 'Ative "Notificar as enviadas por mim também"'] }
    try {
      for (const route of WEBHOOK_ROUTES) {
        const reply = await call(ctx, 'PUT', route, { value: url }, 10_000)
        if (reply.status !== 200 || record(reply.data)?.value === false) return { registered: false as const, manual }
      }
      const own = await call(ctx, 'PUT', '/update-notify-sent-by-me', { notifySentByMe: true }, 10_000)
      if (own.status !== 200 || record(own.data)?.value === false) return { registered: false as const, manual }
      try { await call(ctx, 'PUT', '/update-queue-settings', { disableEnqueueWhenDisconnected: true }, 10_000) } catch { /* a safety net, not a requirement */ }
      return { registered: true as const }
    } catch { return { registered: false as const, manual } }
  },
  /** The docs describe no way to clear a webhook URL (the value must be https), and archiving must not unpair the owner's number. Deleting the
   * connection invalidates the secret in the URL, so the route answers 401 from then on. */
  async disconnect() { /* nothing to undo at Z-API */ },
  /** See the header comment: no signature exists, so the secret in the query of the registered URL proves the delivery. */
  async verifyWebhook(raw: RawWebhook, secrets: { webhookSecret: string; credentials: Credentials }): Promise<WebhookVerdict> {
    if (raw.method !== 'POST') return { ok: false, status: 400 }
    if (!secrets.webhookSecret) return { ok: false, status: 401 }
    const supplied = raw.query.get('k')
    return supplied && await equalSecret(supplied, secrets.webhookSecret) ? { ok: true } : { ok: false, status: 401 }
  },
  splitDelivery: splitZapi,
  parseInbound(body: unknown, _connection: Connection): InboundEventV2[] {
    const root = record(body)
    return root ? parseEvent(root) : [{ kind: 'ignored', why: 'Unsupported Z-API event', eventKey: 'unknown' }]
  },
  /** Text, reply buttons, and link buttons. Docs: reply buttons and link buttons are separate sends and must not be mixed. */
  fit(message: OutboundMessage, profile) {
    if (message.kind !== 'text') return unsupported(`Z-API transport supports text and buttons only, not ${message.kind}`)
    const buttons = message.buttons ?? []
    if (buttons.some(b => b.type === 'call')) return unsupported('Z-API call buttons are not supported')
    if (buttons.some(b => b.type === 'url') && (buttons.some(b => b.type !== 'url') || message.quickReplies?.length)) return unsupported('Z-API cannot mix link buttons with reply buttons')
    return fitMessage(message, profile)
  },
  async send(ctx: ProviderCtx & { target: SendTarget }, part: OutboundMessage): Promise<SendResult> {
    if (ctx.target.kind !== 'direct') return unsupported('Z-API groups are not supported yet')
    if (part.kind !== 'text') return unsupported('Z-API transport supports text and buttons only')
    if (!isPhoneId(ctx.target.externalUserId)) return rejected('invalid_recipient')
    return post(ctx, ctx.target.externalUserId, part)
  },
}
