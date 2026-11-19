import { z } from 'zod'
import type { Connection, ConnectContext, ConnectionStatus, ConnectStep, Credentials, DeliveryPart, InboundEventV2, Party, ProfilePatch, ProviderAdapter, ProviderCtx, RawWebhook, SendTarget, WebhookVerdict } from './contract'
import { equalSecret } from './core/webhook-http'
import { fitMessage } from './fit'
import { providers } from './providers'
import { syncUazapi } from './uazapi-sync'
import { downloadUazapiMedia, inboundMedia, isVisibleUnsupported } from './uazapi-media'
import type { OutboundMessage, SendResult } from './types'

// UAZAPI (uazapiGO), source "docs.uazapi.com v2.6.7": every endpoint and payload below was checked against the local copy
// ~/Projetos/uzapi/docs/v2.6.7/openapi.json (paths /instance/status, /instance/connect, /webhook, /send/text, /send/menu,
// /message/find, /message/markread, /call/reject). Behavior measured by the owner on a real server: ~/Projetos/uzapi/docs/
// MIGRACAO-UAZAPI.md and TESTES-INTERNOS-UAZAPI.md (header `token`; `POST /message/find {limit,offset}` with no chatid lists the newest messages
// of the instance; messages sent from the phone must not be filtered out, only the ones sent through the API).
// Unofficial WhatsApp: no signature on webhooks, no redelivery, and the number can be banned. See replica/arquitetura-mensageria.md §6.

/** Where the layer tells its own sends apart in `track_source` (docs: sendText `track_source`/`track_id`; echoes carry it back). */
export const TRACK_SOURCE = 'replica'
/** Delay (ms) that shows "typing…" before a send when the option is on. Docs: sendText `delay` ("durante o atraso aparecerá 'Digitando...'"). */
export const TYPING_DELAY_MS = 1500
const messageId = z.string().min(1).max(256)

// ---- addressing ----------------------------------------------------------------------------------------------------------------
// Docs (concepts): `number` takes a phone, `...@s.whatsapp.net`, `...@lid` or `...@g.us`; JIDs are opaque and never rewritten.
export const isPhoneJid = (jid: string) => /^\d{7,15}@s\.whatsapp\.net$/.test(jid)
export const isLidJid = (jid: string) => /^\d+@lid$/.test(jid)
export const isDirectJid = (jid: string) => isPhoneJid(jid) || isLidJid(jid)
/** E.164 of a phone JID. A LID never yields a number (it can hide the phone), so it can never unite contacts. */
export const phoneOfJid = (jid: unknown): string | undefined =>
  typeof jid === 'string' && isPhoneJid(jid) ? `+${jid.slice(0, jid.indexOf('@'))}` : undefined
/** A JID may carry a device suffix ("1538...:3@lid"); the address of the person is the part without it. */
const bare = (jid: unknown) => typeof jid === 'string' ? jid.replace(/^(\d+):\d+@/, '$1@') : undefined
const asString = (value: unknown) => typeof value === 'string' && value.length ? value : undefined
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

function party(jid: string, extra: { name?: string | undefined; phoneJid?: unknown } = {}): Party {
  const phoneE164 = phoneOfJid(jid) ?? phoneOfJid(extra.phoneJid)
  return { externalUserId: jid, addressKind: isPhoneJid(jid) ? 'wa_pn' : 'wa_lid',
    ...(phoneE164 ? { phoneE164 } : {}), ...(extra.name ? { profile: { firstName: extra.name } } : {}) }
}

// ---- server ----------------------------------------------------------------------------------------------------------------------
/** The customer's own UAZAPI server. Development can point a connection at a fake one through settings.apiBase (the connections
 * service only accepts it outside production). Anything but a public https host is refused, so a credential can never be sent elsewhere. */
export function serverRoot(credentials: Credentials, connection?: Connection): string | undefined {
  if (typeof connection?.settings.apiBase === 'string') return connection.settings.apiBase.replace(/\/+$/, '')
  try {
    const url = new URL(credentials.serverUrl ?? '')
    const host = url.hostname
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
      || /^\d+(\.\d+){3}$/.test(host) || host.includes(':') || !host.includes('.')) return undefined
    return url.origin
  } catch { return undefined }
}

type Reply = { status: number; data: unknown; headers: Headers }
/** One call to the instance. Throws on network failure or timeout; callers decide whether that is uncertain. */
async function call(ctx: { credentials: Credentials; connection?: Connection; fetch: typeof fetch }, method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 20_000): Promise<Reply> {
  const root = serverRoot(ctx.credentials, ctx.connection)
  if (!root || !ctx.credentials.token) throw new Error('UAZAPI server or token not configured')
  const response = await ctx.fetch(`${root}${path}`, { method, signal: AbortSignal.timeout(timeoutMs),
    headers: { token: ctx.credentials.token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  let data: unknown = null
  try { data = await response.json() } catch { /* not JSON: callers treat it as no confirmation */ }
  return { status: response.status, data, headers: response.headers }
}
/** Option values the connection carries (settings, not credentials). */
export const optionOf = (connection: Connection, key: string) => connection.settings[key]

// ---- sending ---------------------------------------------------------------------------------------------------------------------
/** The pt-BR reason for a refused credential (HTTP 401 on a send): core/failure.ts shows it on the conversation, the broadcast and the connection. */
const tokenRefused = 'O token da instância foi recusado pela UAZAPI (foi trocado ou a instância foi apagada). Copie o token atual no painel da UAZAPI e use “Trocar credencial” em Canais.'
const rejected = (code: string): SendResult => ({ ok: false, reason: 'rejected', code, detail: 'UAZAPI rejected send; check the instance' })
const unsupported = (detail: string) => ({ ok: false as const, reason: 'unsupported' as const, detail })
const retryAfter = (headers: Headers) => { const n = Number(headers.get('retry-after')); return n > 0 && n <= 86400 ? Math.ceil(n) : 1 }

/** Docs (sendMenu, type "button"): choices are "label|id", "label|https://url" or "label|call:+55...". */
function choices(buttons: NonNullable<Extract<OutboundMessage, { kind: 'text' }>['buttons']>): string[] {
  return buttons.map(b => b.type === 'postback' ? `${b.title}|${b.id}` : b.type === 'url' ? `${b.title}|${b.url}` : `${b.title}|call:${b.phone}`)
}

async function post(ctx: ProviderCtx, number: string, message: Extract<OutboundMessage, { kind: 'text' }>, mentions: string[] = []): Promise<SendResult> {
  const typing = optionOf(ctx.connection, 'typing') === true
  const tracked = { track_source: TRACK_SOURCE }
  // Docs: POST /send/text (sendText) and POST /send/menu with type "button" (sendMenu).
  const [path, body] = message.buttons?.length
    ? ['/send/menu', { number, type: 'button', text: message.text, choices: choices(message.buttons), ...tracked, ...(typing ? { delay: TYPING_DELAY_MS } : {}) }]
    : ['/send/text', { number, text: message.text, ...tracked, ...(mentions.length ? { mentions: mentions.join(',') } : {}), ...(typing ? { delay: TYPING_DELAY_MS } : {}) }]
  let reply: Reply
  try { reply = await call(ctx, 'POST', path, body) }
  catch { return { ok: false, reason: 'uncertain', detail: 'UAZAPI send outcome uncertain; reconcile before retry' } }
  const data = record(reply.data)
  if (reply.status === 429) return { ok: false, reason: 'rate_limited', retryAfterSec: retryAfter(reply.headers) }   // docs: errors-and-retries
  if (reply.status === 200) {
    const id = messageId.safeParse(data?.messageid ?? data?.id)
    return id.success ? { ok: true, externalId: id.data, parts: 1 }
      : { ok: false, reason: 'uncertain', detail: 'UAZAPI returned no valid send confirmation' }
  }
  // Docs (sendText 500): the WhatsApp server itself refused (error_source "whatsapp_server"); that is a definite no, not an unknown.
  // Docs (sendText 500, getWAMessageLimits): error 463 WHATSAPP_REACHOUT_TIMELOCK is a temporary restriction on starting conversations. The code
  // below is what the delivery layer uses to mark the number as restricted (core/failure.ts); the body already carries the diagnosis.
  if (reply.status === 500 && data?.error_source === 'whatsapp_server') return rejected(asString(data.error_key) ?? String(data.provider_code ?? 500))
  // The instance is not paired (phone offline): nothing was sent, so this is a definite no too (docs show this text on /chat/check).
  if (reply.status === 500 && /not connected/i.test(asString(data?.error) ?? '')) return rejected('instance_offline')
  // Docs (security: instance `token` header): 401 = the token is invalid or was revoked. Every next send fails the same way, so the neutral code says it
  // (core/failure.ts takes the connection to error with `detail` as the reason); other 4xx only refuse this message.
  if (reply.status === 401) return { ok: false, reason: 'rejected', code: 'token_refused', detail: tokenRefused }
  if (reply.status >= 400 && reply.status < 500) return rejected(String(reply.status))
  return { ok: false, reason: 'uncertain', detail: 'UAZAPI returned no valid send confirmation' }
}

// ---- inbound ---------------------------------------------------------------------------------------------------------------------
const messageKey = (m: Record<string, unknown>) => asString(m.messageid) ?? asString(m.id)
const SECONDS = (n: unknown) => typeof n === 'number' && Number.isFinite(n) ? n * 1000 : undefined
/** Docs (messages_update, SKILL.md): states Queued, Sent, Delivered, Read, Played, Failed, Expired, Canceled, Deleted. Queued/Sent add nothing to what the
 * send already recorded, and Deleted is a revoked message, not a delivery outcome: those stay undefined. Failed/Expired/Canceled never reached the contact. */
const stateOf = (state: unknown): 'delivered' | 'read' | 'failed' | undefined => {
  const s = typeof state === 'string' ? state.toLowerCase() : ''
  return s === 'read' || s === 'played' ? 'read' : s === 'delivered' ? 'delivered' : s === 'failed' || s === 'expired' || s === 'canceled' ? 'failed' : undefined
}
const STATE_RANK = { delivered: 1, read: 2 } as const
/** Docs (messages_update, "Grupos"): a GroupReceipts event has no `state`; each item of `event.Receipts` carries its own state and `timestamp` (seconds).
 * The message follows the most advanced participant, so the best item wins (ties keep the earliest). */
function groupState(event: Record<string, unknown>): { state: 'delivered' | 'read'; at: number | undefined } | undefined {
  let best: { state: 'delivered' | 'read'; at: number | undefined } | undefined
  for (const raw of Array.isArray(event.Receipts) ? event.Receipts : []) {
    const item = record(raw), state = stateOf(item?.state)
    if (state !== 'delivered' && state !== 'read') continue
    if (!best || STATE_RANK[state] > STATE_RANK[best.state]) best = { state, at: SECONDS(item?.timestamp) }
  }
  return best
}
const statusOf = (status: unknown): ConnectionStatus =>
  status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting' : 'disconnected'   // hibernated: paused, needs a connect

/** Events the webhook can carry that this layer cares about. Docs: integrations-webhooks ("Catálogo de eventos"). */
export function splitUazapi(body: unknown): DeliveryPart[] {
  const root = record(body)
  const base = { owner: asString(root?.owner), instanceName: asString(root?.instanceName) }   // never the token, the server address or the chat snapshot
  switch (root?.EventType) {
    case 'messages': {                                              // docs: webhooks/messages
      const message = record(root.message)
      const key = message && messageKey(message)
      if (!message || !key) return []
      return [{ eventKey: key, at: typeof message.messageTimestamp === 'number' ? message.messageTimestamp : undefined,
        payload: { EventType: 'messages', ...base, message } }]
    }
    case 'messages_update': {                                       // docs: webhooks/messages_update (ReadReceipt for direct chats, GroupReceipts for groups)
      const event = record(root.event)
      if (root.type === 'GroupReceipts' && event && Array.isArray(event.MessageIDs)) {
        const group = groupState(event), id = event.MessageIDs[0]
        if (!group || !messageId.safeParse(id).success) return []
        return [{ eventKey: `${id}:${group.state}`, payload: { EventType: 'messages_update', ...base, type: 'GroupReceipts', event: { ...event, MessageIDs: [id] } } }]
      }
      const state = stateOf(root.state)
      if (root.type !== 'ReadReceipt' || !event || !state || !Array.isArray(event.MessageIDs)) return []
      return event.MessageIDs.flatMap(id => messageId.safeParse(id).success ? [{ eventKey: `${id}:${state}`,
        payload: { EventType: 'messages_update', ...base, type: 'ReadReceipt', state: root.state, event: { ...event, MessageIDs: [id] } } }] : [])
    }
    case 'connection': {                                            // docs: webhooks/connection
      const instance = record(root.instance)
      const key = asString(root.event_id) ?? (instance ? `${asString(instance.status) ?? 'unknown'}:${asString(root.type) ?? ''}:${asString(instance.lastDisconnect) ?? ''}` : undefined)
      return key && instance ? [{ eventKey: `connection:${key}`, payload: { EventType: 'connection', ...base, type: root.type, instance } }] : []
    }
    case 'call': {                                                  // docs: webhooks/call (a call produces several notifications; only the offer matters)
      const event = record(root.event)
      const callId = asString(event?.CallID), tag = asString(record(event?.Data)?.Tag)
      if (root.type !== 'Call' || tag !== 'offer' || root.fromMe === true || !callId) return []
      return [{ eventKey: `call:${callId}:offer`, payload: { EventType: 'call', ...base, type: 'Call', fromMe: false, sender_pn: root.sender_pn, chatid: root.chatid, event } }]
    }
    default: return []
  }
}

// ---- groups ----------------------------------------------------------------------------------------------------------------------
const isGroupJid = (jid: string) => /^\d+(-\d+)?@g\.us$/.test(jid)
const userOf = (jid: string) => jid.slice(0, jid.indexOf('@')).replace(/:\d+$/, '')   // "5511...:12@s.whatsapp.net" -> "5511..."

/** Every list the message carries under a key named mentionedJid / mentionedJID (any case), wherever it sits in `content`. */
function mentionedJids(value: unknown, depth = 0): string[] {
  if (depth > 6 || typeof value !== 'object' || value === null) return []
  if (Array.isArray(value)) return value.flatMap(v => mentionedJids(v, depth + 1))
  return Object.entries(value).flatMap(([key, v]) =>
    /^mentioned_?jids?$/i.test(key) && Array.isArray(v) ? v.filter((j): j is string => typeof j === 'string') : mentionedJids(v, depth + 1))
}

/** THE ONE PLACE that knows how a mention of the connected account looks in a received message.
 * UNVERIFIED: the UAZAPI docs (v2.6.7) never describe the received mention (`message.content` "não possui um formato único"), so this follows the
 * WhatsApp message shape (contextInfo.mentionedJID, a list of JIDs) and the "@number" written in the text. The account may be listed by its phone
 * number or by its LID: the phone comes from the delivery's `owner`, a LID from the connection's `ownLid` setting if one is ever stored.
 * To be checked against a real payload in the group journey (replica/decisoes-camada-mensageria.md, decision 15). */
export function mentionsAccount(message: Record<string, unknown>, owner: string | undefined, connection: Pick<Connection, 'settings'>): boolean {
  const own = new Set([owner, asString(connection.settings.ownLid)].filter((v): v is string => !!v).map(v => userOf(v.includes('@') ? v : `${v}@x`)))
  if (!own.size) return false
  let content: unknown = message.content
  if (typeof content === 'string') { try { content = JSON.parse(content) } catch { /* plain text */ } }
  if (mentionedJids(content).some(jid => own.has(userOf(jid)))) return true
  const text = asString(message.text) ?? ''
  return [...own].some(id => new RegExp(`(^|[^0-9])@${id}(?![0-9])`).test(text))
}

function parseGroupMessage(root: Record<string, unknown>, m: Record<string, unknown>, eventKey: string, connection: Connection): InboundEventV2[] {
  const ignored = (why: string): InboundEventV2[] => [{ kind: 'ignored', why, eventKey }]
  const chat = asString(m.chatid)
  if (!chat || !isGroupJid(chat)) return ignored('Unsupported UAZAPI chat')
  if (m.fromMe === true) return ignored('Message written by the account in a group')   // never an author, never a trigger
  // Real payload: `sender` is "<lid>:3@lid" (device suffix); `sender_pn` / `sender_lid` carry the clean addresses.
  const author = [bare(m.sender_pn), bare(m.sender_lid), bare(m.sender)].find(j => !!j && isDirectJid(j))
  if (!author) return ignored('Group message without a usable author')
  const text = asString(m.text)
  if (m.messageType === 'error' || asString(m.reaction) || asString(m.buttonOrListid) || !text) return ignored('Unsupported UAZAPI group message')
  const occurredAt = typeof m.messageTimestamp === 'number' && m.messageTimestamp > 0 ? m.messageTimestamp : undefined
  const subject = asString(m.groupName) ?? asString(record(root.chat)?.name)
  return [{ kind: 'message', eventKey, from: party(author, { name: asString(m.senderName), phoneJid: m.sender_pn }),
    thread: { kind: 'group', externalGroupId: chat, ...(subject ? { subject } : {}) }, externalMessageId: messageKey(m)!, text,
    mentionsMe: mentionsAccount(m, asString(root.owner), connection), ...(occurredAt === undefined ? {} : { occurredAt }) }]
}

function parseMessage(root: Record<string, unknown>, connection: Connection): InboundEventV2[] {
  const m = record(root.message)
  const eventKey = m && messageKey(m)
  if (!m || !eventKey) return [{ kind: 'ignored', why: 'UAZAPI message without id' }]
  const ignored = (why: string): InboundEventV2[] => [{ kind: 'ignored', why, eventKey }]
  const chat = bare(m.chatid)
  if (m.isGroup === true || chat?.endsWith('@g.us')) return parseGroupMessage(root, m, eventKey, connection)
  if (!chat || !isDirectJid(chat)) return ignored('Unsupported UAZAPI chat')   // status@broadcast, newsletters, broadcast lists
  const occurredAt = typeof m.messageTimestamp === 'number' && m.messageTimestamp > 0 ? m.messageTimestamp : undefined
  const text = asString(m.text)
  if (m.fromMe === true) {
    // An echo of a send made through the API (ours or another integration's) is never a human takeover.
    const sentByApi = m.wasSentByApi === true || m.track_source === TRACK_SOURCE
    if (sentByApi) return ignored('Echo of a send made through the API')
    return [{ kind: 'own_message', eventKey, to: party(chat, { phoneJid: m.sender_pn }), thread: { kind: 'direct' }, externalMessageId: messageKey(m)!,
      ...(text ? { text } : {}), ...(occurredAt === undefined ? {} : { occurredAt }), sentByApi: false }]
  }
  const from = party(chat, { name: asString(m.senderName), phoneJid: m.sender_pn })
  const common = { eventKey, from, thread: { kind: 'direct' as const }, ...(occurredAt === undefined ? {} : { occurredAt }) }
  // Docs (Message schema): `buttonOrListid` is the id of the button or list item the contact picked.
  const picked = asString(m.buttonOrListid)
  if (picked) return [{ kind: 'click', ...common, payload: picked }]
  if (m.messageType === 'error') return ignored('Message could not be opened')       // docs: reloadMessage
  if (asString(m.reaction)) return ignored('Reaction')
  // Docs (downloadMessage): a file is fetched later by the message id; the caption is the message `text`.
  const media = inboundMedia(m, eventKey)
  if (media) return [{ kind: 'message', ...common, externalMessageId: eventKey, ...(text ? { text } : {}), media }]
  if (text) return [{ kind: 'message', ...common, externalMessageId: eventKey, text }]
  // A kind a contact can send that the inbox cannot show: the same explicit placeholder as the official channel, never a silent drop.
  const type = asString(m.messageType)
  if (isVisibleUnsupported(type)) return [{ kind: 'message', ...common, externalMessageId: eventKey, unsupported: { type: type!.slice(0, 64) } }]
  return ignored('Unsupported UAZAPI message type')
}

function parseReceipt(root: Record<string, unknown>): InboundEventV2[] {
  const event = record(root.event)
  const id = Array.isArray(event?.MessageIDs) ? messageId.safeParse(event.MessageIDs[0]) : undefined
  if (!event || !id?.success) return [{ kind: 'ignored', why: 'Receipt without message id' }]
  if (root.type === 'GroupReceipts') {
    // IsFromMe is not checked: the doc's GroupReceipts example carries IsFromMe false for a message of the account. Receipts for messages that
    // are not ours never match an outbound row and are dropped by recordReceipt.
    const group = groupState(event)
    if (!group) return [{ kind: 'ignored', why: 'Unsupported UAZAPI receipt' }]
    return [{ kind: 'receipt', eventKey: `${id.data}:${group.state}`, externalMessageId: id.data, status: group.state, occurredAt: group.at ?? Date.now() }]
  }
  const state = stateOf(root.state)
  const eventKey = `${id.data}:${state ?? 'unknown'}`
  // Real payload (2026-10-26): a receipt for OUR message arrives with IsFromMe false and Sender = the contact, so IsFromMe is not checked; foreign ids never match an outbound row.
  if (!state || event.IsGroup === true) return [{ kind: 'ignored', why: 'Unsupported UAZAPI receipt', eventKey }]
  return [{ kind: 'receipt', eventKey, externalMessageId: id.data, status: state, occurredAt: SECONDS(event.Timestamp) ?? Date.now() }]   // docs: Timestamp is in seconds
}

// ---- connect ---------------------------------------------------------------------------------------------------------------------
const instanceSchema = z.object({ id: z.string().min(1).max(128), status: z.string().optional(), name: z.string().optional(),
  profileName: z.string().optional(), qrcode: z.string().optional(), paircode: z.string().optional(), owner: z.string().optional() })
const QR_VALID_MS = 60_000

/** Docs: GET /instance/status (getInstanceStatus) proves the token and returns the instance; POST /instance/connect (connectInstance) starts the pairing. */
const listedInstance = z.object({ name: z.string().optional(), token: z.string().min(1).optional() })
const REFUSED = 'O provedor não aceitou o token (nem como token da instância, nem como token de administrador).'

/** Docs (listAllInstances, authentication): GET /instance/all with header `admintoken` lists every instance with its `name` and `token`.
 * Resolves the pasted admin token into the instance token; both are left in ctx.credentials (token = the instance's, adminToken = the pasted one),
 * which the core seals. Sending keeps using only `token`. Returns a failed step when no single instance can be chosen. */
async function viaAdmin(ctx: ConnectContext): Promise<ConnectStep | undefined> {
  const root = serverRoot(ctx.credentials, ctx.connection), admin = ctx.credentials.token
  if (!root || !admin) return undefined
  const response = await ctx.fetch(`${root}/instance/all`, { method: 'GET', signal: AbortSignal.timeout(10_000), headers: { admintoken: admin } })
  if (response.status === 401 || response.status === 403) return { kind: 'failed', code: 'invalid_credentials', detail: 'UAZAPI did not accept the token', message: REFUSED }
  let data: unknown = null
  try { data = await response.json() } catch { /* handled below */ }
  if (response.status !== 200 || !Array.isArray(data)) return { kind: 'failed', code: 'unreachable', detail: 'UAZAPI answered with something unexpected' }
  const all = data.flatMap(item => { const r = listedInstance.safeParse(item); return r.success && r.data.token ? [r.data] : [] })
  const names = all.map(i => i.name).filter((n): n is string => !!n)
  const wanted = ctx.credentials.instanceName?.trim()
  const picked = wanted ? all.find(i => i.name === wanted) : all.length === 1 ? all[0] : undefined
  if (!picked) {
    const list = names.length ? ` Instâncias disponíveis: ${names.join(', ')}.` : ''
    const message = !all.length ? 'Este servidor não tem nenhuma instância. Crie uma na UAZAPI e tente de novo.'
      : wanted ? `Não encontramos a instância “${wanted}” neste servidor.${list}` : `Este servidor tem mais de uma instância. Preencha o campo “Instância” com o nome da que vai usar.${list}`
    return { kind: 'failed', code: 'instance_not_chosen', detail: 'UAZAPI admin token matched no single instance', message }
  }
  ctx.credentials.adminToken = admin
  ctx.credentials.token = picked.token!
  return undefined
}

async function connect(ctx: ConnectContext): Promise<ConnectStep> {
  const failed = (code: string, detail: string) => ({ kind: 'failed' as const, code, detail })
  const read = async () => {
    const reply = await call(ctx, 'GET', '/instance/status', undefined, 10_000)
    const data = record(reply.data)
    const instance = instanceSchema.safeParse(data?.instance)
    return { reply, instance: instance.success ? instance.data : undefined }
  }
  try {
    let { reply, instance } = await read()
    if (reply.status === 401) {
      // Maybe the server's admin token was pasted: resolve it into the instance token and read again.
      const resolved = await viaAdmin(ctx)
      if (resolved) return resolved
      ;({ reply, instance } = await read())
    }
    if (reply.status === 401 || reply.status === 404) return { kind: 'failed', code: 'invalid_credentials', detail: 'UAZAPI did not accept the instance token', message: REFUSED }
    if (reply.status !== 200 || !instance) return failed('unreachable', 'UAZAPI answered with something unexpected')
    const account = `uazapi:${instance.id}`
    const named = instance.profileName || instance.name
    if (instance.status === 'connected') return { kind: 'done', externalId: account, ...(named ? { displayName: named } : {}) }
    if (instance.status !== 'connecting') {
      // 409 means a pairing is already running: its QR is read below.
      const started = await call(ctx, 'POST', '/instance/connect', {}, 15_000)
      if (started.status === 401) return failed('invalid_credentials', 'UAZAPI did not accept the instance token')
      // Docs (connectInstance): 429 = simultaneous connection limit reached; 503 = capacity temporarily unavailable (Retry-After in seconds).
      if (started.status === 429) return failed('rate_limited', 'UAZAPI atingiu o limite de conexões simultâneas. Tente de novo em instantes.')
      if (started.status === 503) return failed('unavailable', `UAZAPI sem capacidade de conexão agora. Tente de novo em ${retryAfter(started.headers)} s.`)
      if (started.status >= 500) return failed('unreachable', 'UAZAPI could not start the pairing')
      ;({ reply, instance } = await read())
      if (!instance) return failed('unreachable', 'UAZAPI answered with something unexpected')
    }
    if (instance.status === 'connected') return { kind: 'done', externalId: account, ...(named ? { displayName: named } : {}) }
    // Docs (connectInstance): the instance stays "connecting" until it pairs or expires; the QR may not be generated yet, and an empty one is useless.
    if (!instance.qrcode) return failed('qr_not_ready', 'O QR code ainda não foi gerado pela UAZAPI. Tente de novo em instantes.')
    // QR_VALID_MS is our own guess: the docs consulted give no QR lifetime.
    return { kind: 'qr', qr: instance.qrcode, expiresAt: Date.now() + QR_VALID_MS, externalId: account, ...(named ? { displayName: named } : {}) }
  } catch { return failed('unreachable', 'UAZAPI could not be reached') }
}

// ---- the provider ----------------------------------------------------------------------------------------------------------------
const WEBHOOK_EVENTS = ['messages', 'messages_update', 'connection', 'call']

export const uazapi: ProviderAdapter = {
  id: 'uazapi',
  syncDelivery: ctx => syncUazapi(ctx),   // lazy: uazapi-sync imports this module back
  kinds: ['whatsapp'],
  patch: providers.uazapi.patch as ProfilePatch,
  credentialsSchema: z.record(z.string(), z.string()).refine(c => !!c.token && !!serverRoot(c), { message: 'serverUrl (https) and token are required' }),
  settingsSchema: z.record(z.string(), z.unknown()),
  connect,

  /** Docs: POST /webhook (updateWebhook), simple mode: one webhook per instance, created or updated in place.
   * `wasSentByApi` is excluded so our own sends do not echo back; echoes that slip through are still recognised by id. */
  async registerWebhook(ctx: ConnectContext) {
    const manual = { kind: 'manual_webhook' as const, callbackUrl: ctx.hookUrl, verifyToken: '',
      checklist: ['Na UAZAPI, abra o webhook da instância', 'Cole a URL de retorno e assine messages, messages_update, connection e call'] }
    try {
      const reply = await call(ctx, 'POST', '/webhook', { enabled: true, url: ctx.hookUrl, events: WEBHOOK_EVENTS,
        excludeMessages: ['wasSentByApi'], addUrlEvents: false, addUrlTypesMessages: false }, 10_000)
      return reply.status === 200 ? { registered: true as const } : { registered: false as const, manual }
    } catch { return { registered: false as const, manual } }
  },
  /** Archiving stops deliveries. Docs (integrations-webhooks): a dead webhook slows the instance's whole queue, so it is switched off. The phone stays paired. */
  async disconnect(ctx: ConnectContext) {
    try { await call(ctx, 'POST', '/webhook', { enabled: false, url: ctx.hookUrl, events: WEBHOOK_EVENTS }, 10_000) } catch { /* best effort: the token may already be revoked */ }
  },
  /** The docs describe no signature. The delivery carries the instance token in its body, so the connection (named by the URL)
   * is proven by comparing that token with the stored one in constant time. */
  async verifyWebhook(raw: RawWebhook, secrets: { webhookSecret: string; credentials: Credentials }): Promise<WebhookVerdict> {
    if (raw.method !== 'POST') return { ok: false, status: 400 }
    const expected = secrets.credentials.token
    if (!expected) return { ok: false, status: 401 }
    let supplied: unknown
    try { supplied = record(JSON.parse(new TextDecoder().decode(raw.body)))?.token } catch { return { ok: false, status: 400 } }
    return typeof supplied === 'string' && await equalSecret(supplied, expected) ? { ok: true } : { ok: false, status: 401 }
  },
  /** One part per event, without the token. Events the layer ignores never reach the queue. */
  splitDelivery: splitUazapi,
  parseInbound(body: unknown, _connection: Connection): InboundEventV2[] {
    const root = record(body)
    switch (root?.EventType) {
      case 'messages': return parseMessage(root, _connection)
      case 'messages_update': return parseReceipt(root)
      case 'connection': {
        const instance = record(root.instance)
        const eventKey = splitUazapi(body)[0]?.eventKey
        if (!instance || !eventKey) return [{ kind: 'ignored', why: 'Invalid UAZAPI connection event' }]
        const banned = root.type === 'TemporaryBan'
        return [{ kind: 'connection', eventKey, status: banned ? 'restricted' : statusOf(instance.status),
          ...(banned ? { detail: 'O WhatsApp restringiu o número temporariamente.' } : {}) }]
      }
      case 'call': return [{ kind: 'ignored', why: 'Call', ...(splitUazapi(body)[0] ? { eventKey: splitUazapi(body)[0].eventKey } : {}) }]
      default: return [{ kind: 'ignored', why: 'Unsupported UAZAPI event' }]
    }
  },
  /** Text and reply buttons only: anything else is refused here, so the editor can block publishing it (replica/arquitetura-mensageria.md §3.2). */
  fit(message: OutboundMessage, profile) {
    if (message.kind !== 'text') return unsupported(`UAZAPI transport supports text and buttons only, not ${message.kind}`)
    // Docs (sendMenu): the label and id are joined with "|" and separated by line breaks.
    for (const b of message.buttons ?? []) {
      if (/[|\n]/.test(b.title) || (b.type === 'postback' && /[|\n]/.test(b.id))) return unsupported('UAZAPI buttons cannot contain "|" or line breaks')
    }
    return fitMessage(message, profile)
  },
  async send(ctx: ProviderCtx & { target: SendTarget }, part: OutboundMessage): Promise<SendResult> {
    if (part.kind !== 'text') return unsupported('UAZAPI transport supports text and buttons only')
    if (ctx.target.kind === 'group') {
      // Docs (sendText): `mentions` takes numbers and only applies in groups. Buttons are not offered in groups (v1 sends text).
      if (part.buttons?.length) return unsupported('UAZAPI buttons are not offered in groups')
      if (!isGroupJid(ctx.target.externalGroupId)) return rejected('invalid_recipient')
      const mentions = (ctx.target.mention ?? []).map(phoneOfJid).filter((p): p is string => !!p).map(p => p.slice(1))
      return post(ctx, ctx.target.externalGroupId, part, mentions)
    }
    if (!isDirectJid(ctx.target.externalUserId)) return rejected('invalid_recipient')
    return post(ctx, ctx.target.externalUserId, part)
  },
  /** Docs (checkChat, paginas/operacoes/checkChat.md): POST /chat/check {numbers:[...]} answers 200 with an array of
   * {query, jid, isInWhatsapp, error?}. Real reply (26/10): a number off WhatsApp comes with isInWhatsapp false AND `error` set ("... is not on WhatsApp"), so the boolean decides; anything else (non-200, no item, network failure) is unknown. */
  async checkRecipient(ctx: ProviderCtx, phoneDigits: string): Promise<'yes' | 'no' | 'unknown'> {
    try {
      const reply = await call(ctx, 'POST', '/chat/check', { numbers: [phoneDigits] }, 15_000)
      if (reply.status !== 200 || !Array.isArray(reply.data)) return 'unknown'
      const item = reply.data.map(record).find(i => i && typeof i.isInWhatsapp === 'boolean')
      return item ? (item.isInWhatsapp ? 'yes' : 'no') : 'unknown'
    } catch { return 'unknown' }
  },
  /** Docs (downloadMessage): POST /message/download answers with a public `fileURL`; see uazapi-media.ts. */
  downloadMedia: (ctx: ProviderCtx, media, maxBytes) => {
    const root = serverRoot(ctx.credentials, ctx.connection)
    if (!root) return Promise.resolve({ ok: false as const, transient: false, code: 'auth' as const })
    return downloadUazapiMedia(ctx, root, (path, body) => call(ctx, 'POST', path, body, 30_000), media, maxBytes)
  },
  /** Docs: POST /group/list (refreshGroups), recommended use: `search`, `limit`, `offset` and noParticipants=true; the answer carries `groups` and `pagination`. */
  async listGroups(ctx: ProviderCtx, query: { search?: string; limit: number; offset: number }) {
    const reply = await call(ctx, 'POST', '/group/list', { limit: query.limit, offset: query.offset, noParticipants: true, ...(query.search ? { search: query.search } : {}) }, 30_000)
    const data = record(reply.data)
    if (reply.status !== 200 || !Array.isArray(data?.groups)) throw new Error('UAZAPI group list failed')
    const groups = data.groups.flatMap(raw => { const g = record(raw), jid = asString(g?.JID); return jid && isGroupJid(jid) ? [{ externalGroupId: jid, subject: asString(g?.Name) ?? null }] : [] })
    const page = record(data.pagination)
    return { groups, nextOffset: page?.hasMore === true && typeof page.nextOffset === 'number' ? page.nextOffset : null }
  },
  /** Docs: POST /message/find (findMessages) with no filter but a page size returns the newest messages first. UAZAPI never redelivers
   * a webhook, so this recovers what a failed delivery lost; the event key is the webhook's, so a replay dedupes. */
  async pull(ctx: ProviderCtx, since: number) {
    const parts: DeliveryPart[] = []
    let cursor = since
    for (let offset = 0, page = 0; page < 5; page++) {
      const reply = await call(ctx, 'POST', '/message/find', { limit: 100, offset }, 20_000)
      const data = record(reply.data)
      if (reply.status !== 200 || !Array.isArray(data?.messages)) throw new Error('UAZAPI message search failed')
      let reachedKnown = data.messages.length === 0
      for (const raw of data.messages) {
        const message = record(raw), at = message?.messageTimestamp
        if (!message || typeof at !== 'number') continue
        if (at <= since) { reachedKnown = true; continue }
        parts.push(...splitUazapi({ EventType: 'messages', message }))
        cursor = Math.max(cursor, at)
      }
      const more = record(data.pagination)
      if (reachedKnown || more?.hasMore !== true || typeof more.nextOffset !== 'number') break
      offset = more.nextOffset
    }
    return { parts: parts.reverse(), cursor }   // oldest first
  },
}

/** Calls the sync layer needs (mark as read, reject a call, send a plain text) without going through delivery bookkeeping. */
export const instanceApi = {
  /** Docs: POST /message/markread (markMessageRead). */
  markRead: (ctx: ProviderCtx, ids: string[]) => call(ctx, 'POST', '/message/markread', { id: ids }, 10_000),
  /** Docs: POST /call/reject (rejectCall); `id` is the call to reject. */
  rejectCall: (ctx: ProviderCtx, number: string | undefined, callId: string) => call(ctx, 'POST', '/call/reject', { ...(number ? { number } : {}), id: callId }, 10_000),
  /** Docs: POST /send/text (sendText). */
  sendText: (ctx: ProviderCtx, number: string, text: string) => call(ctx, 'POST', '/send/text', { number, text, track_source: TRACK_SOURCE }, 15_000),
}
