import type { ChannelKind, Connection, Credentials, ProviderId, ProviderCtx } from '../../src/channels/contract'
import type { AdapterEnv } from '../../src/channels/core/credentials'
import { emailFixture } from './email-fixture'
import { zapiFixture } from './zapi-fixture'

/** What a provider hands the shared battery. Skeleton (F0): only what the registry-level cases need.
 * Webhook payloads, fake provider API and error responses are added per provider in F1-F3
 * (replica/arquitetura-mensageria.md §5). */
export interface ProviderFixture {
  provider: ProviderId
  kind: ChannelKind
  env: AdapterEnv
  /** Present once the provider is on the contract (F1: Telegram). */
  contract?: ContractFixture
}

/** What the shared battery needs from a provider on the contract. */
export interface ContractFixture {
  native?: boolean
  connection?: Partial<Connection>
  binding?: (fake: () => Promise<Response>) => ProviderCtx['bindings']
  credentials: Credentials
  webhookSecret: string
  /** The party the inbound bodies come from and the text they carry. */
  user: { id: string; messageId: string; text: string }
  /** Bodies a provider's webhook delivers. `ownEcho` is anything the provider cannot attribute to a contact. */
  inbound: { text: unknown; click: unknown; ownEcho: unknown; unknownType: unknown; eventKey: string; clickPayload: string; clickAck: boolean }
  /** Providers that authenticate inside the body (no signature header): the body as the provider sends it, valid and tampered. */
  authBody?: { valid(body: unknown): unknown; tampered(body: unknown): unknown }
  /** Providers that authenticate through the query of the registered URL (no header, no signature): the query string valid and tampered. */
  authQuery?: { valid: string; tampered: string }
  /** Authentication of a delivery body: valid, and the same request tampered with. */
  headersFor(body: unknown): Promise<Record<string, string>>
  tamperedFor(body: unknown): Promise<Record<string, string>>
  /** A configuration the provider must refuse to authenticate with (no secret known). */
  unconfigured: { webhookSecret: string; credentials: Credentials }
  /** Provider API replies the fake network returns. */
  responses: { ok: Response; rateLimited: Response; rejected: Response; malformed: Response }
  /** The provider registers its webhook itself (body it posts) or the admin must paste the URL and token.
   * `app`: the webhook lives on the provider app (shared route) and the provider subscribes it through the provider API (Meta /{app-id}/subscriptions):
   * `reply` is the fake provider API, `appAuth` the app credential the subscription is made with and `form` what the subscription must carry
   * besides the connection's URL and secret. */
  webhook: { mode: 'auto'; body: Record<string, unknown> } | { mode: 'manual' }
    | { mode: 'app'; reply(url: string, init: RequestInit): Response; subscribeUrl: string; appAuth: string; form: Record<string, string> }
  connect: { ok: Response; refused: Response; externalId: string }
  /** GET handshake, when the provider verifies the endpoint that way. */
  handshake?: { query: (token: string) => string }
  /** Delivery receipts, when the channel reports them. */
  receipts?: { body: unknown; externalMessageId: string; status: 'sent' | 'delivered' | 'read' | 'failed'; eventKey?: string }
}

const env = { DB: {} as D1Database, TELEGRAM_BOT_TOKEN: 'TESTONLY' } satisfies AdapterEnv
const token = `b:${'a'.repeat(24)}`
const telegram: ContractFixture = {
  credentials: { botToken: 'TESTONLY', webhookSecret: 'hook-secret' }, webhookSecret: 'hook-secret',
  inbound: {
    text: { update_id: 7, message: { message_id: 3, from: { id: 100, first_name: 'Ana' }, chat: { id: 100, type: 'private' }, text: 'quero' } },
    click: { update_id: 8, callback_query: { id: 'cb-1', from: { id: 100 }, data: token, message: { chat: { id: 100, type: 'private' } } } },
    ownEcho: { update_id: 9, message: { message_id: 4, from: { id: 5, is_bot: true }, chat: { id: 5, type: 'private' }, text: 'eco' } },
    unknownType: { update_id: 10, edited_message: { message_id: 3 } },
    eventKey: '7', clickPayload: token, clickAck: true,
  },
  user: { id: '100', messageId: '3', text: 'quero' },
  headersFor: async () => ({ 'X-Telegram-Bot-Api-Secret-Token': 'hook-secret' }),
  tamperedFor: async () => ({ 'X-Telegram-Bot-Api-Secret-Token': 'hook-secrex' }),
  unconfigured: { webhookSecret: '', credentials: { botToken: 'TESTONLY', webhookSecret: 'hook-secret' } },
  webhook: { mode: 'auto', body: { url: 'https://x.test/api/hooks/conn', secret_token: 'hook-secret' } },
  connect: { ok: Response.json({ ok: true, result: { id: 42, username: 'bot' } }), refused: Response.json({ ok: false }, { status: 401 }), externalId: '42' },
  responses: {
    ok: Response.json({ ok: true, result: { message_id: 55 } }),
    rateLimited: Response.json({ ok: false, error_code: 429, parameters: { retry_after: 3 } }, { status: 429 }),
    rejected: Response.json({ ok: false, error_code: 400 }, { status: 400 }),
    malformed: new Response('<html>', { status: 502 }),
  },
}

const waSecret = 'APP-SECRET'
const waUser = 'BR.abc123', waPhone = '123456789'
const hmac = async (body: unknown, key: string) => {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(JSON.stringify(body)))
  return { 'X-Hub-Signature-256': `sha256=${[...new Uint8Array(sig)].map(n => n.toString(16).padStart(2, '0')).join('')}` }
}
const waEnvelope = (messages: unknown[] = [], statuses: unknown[] = []) => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba',
  changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: waPhone }, messages, statuses } }] }] })
const waTime = '1760000000'
const whatsapp: ContractFixture = {
  credentials: { accessToken: 'TESTONLY', phoneNumberId: waPhone, appSecret: waSecret, webhookSecret: 'VERIFY' }, webhookSecret: 'VERIFY',
  user: { id: waUser, messageId: 'wamid.in', text: 'quero' },
  inbound: {
    text: waEnvelope([{ id: 'wamid.in', type: 'text', timestamp: waTime, from_user_id: waUser, text: { body: 'quero' } }]),
    click: waEnvelope([{ id: 'wamid.click', type: 'interactive', timestamp: waTime, from_user_id: waUser, interactive: { type: 'button_reply', button_reply: { id: token, title: 'Ir' } } }]),
    ownEcho: waEnvelope([{ id: 'wamid.anon', type: 'text', timestamp: waTime, from: '5511999999999', text: { body: 'sem BSUID' } }]),
    unknownType: waEnvelope([{ id: 'wamid.img', type: 'image', timestamp: waTime, from_user_id: waUser }]),
    eventKey: 'wamid.in', clickPayload: token, clickAck: false,
  },
  headersFor: body => hmac(body, waSecret), tamperedFor: body => hmac(body, 'outro-segredo'),
  unconfigured: { webhookSecret: 'VERIFY', credentials: { accessToken: 'TESTONLY', phoneNumberId: waPhone } },
  responses: {
    ok: Response.json({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.out.1' }] }),
    rateLimited: Response.json({ error: { code: 130429 } }, { status: 400, headers: { 'Retry-After': '3' } }),
    rejected: Response.json({ error: { code: 400 } }, { status: 400 }),
    malformed: new Response('<html>', { status: 502 }),
  },
  webhook: { mode: 'manual' },
  connect: { ok: Response.json({ id: waPhone, display_phone_number: '+55 11 99999-9999', verified_name: 'Loja' }), refused: Response.json({ error: { code: 190 } }, { status: 401 }), externalId: waPhone },
  handshake: { query: token => `hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1158201444` },
  receipts: { body: waEnvelope([], [{ id: 'wamid.out.1', status: 'read', timestamp: waTime }]), externalMessageId: 'wamid.out.1', status: 'read' },
}

const igAccount = '17841400000000000', igUser = '987654321012345', igSecret = 'IG-APP-SECRET', igAppId = '5550001'
const igEnvelope = (item: unknown) => ({ object: 'instagram', entry: [{ id: igAccount, messaging: [item] }] })
const igBase = { sender: { id: igUser }, recipient: { id: igAccount }, timestamp: 1760000000000 }
const instagram: ContractFixture = {
  credentials: { accessToken: 'TESTONLY', accountId: igAccount, appSecret: igSecret, webhookSecret: 'VERIFY' }, webhookSecret: 'VERIFY',
  user: { id: igUser, messageId: 'ig.in', text: 'quero' },
  inbound: {
    text: igEnvelope({ ...igBase, message: { mid: 'ig.in', text: 'quero' } }),
    click: igEnvelope({ ...igBase, postback: { mid: 'ig.click', payload: token } }),
    ownEcho: igEnvelope({ ...igBase, sender: { id: igAccount }, recipient: { id: igUser }, message: { mid: 'ig.echo', text: 'eco', is_echo: true } }),
    unknownType: igEnvelope({ ...igBase, message: { mid: 'ig.img' } }),
    eventKey: 'ig.in', clickPayload: token, clickAck: false,
  },
  headersFor: body => hmac(body, igSecret), tamperedFor: body => hmac(body, 'outro-segredo'),
  unconfigured: { webhookSecret: 'VERIFY', credentials: { accessToken: 'TESTONLY', accountId: igAccount } },
  responses: {
    ok: Response.json({ recipient_id: igUser, message_id: 'ig.out.1' }),
    rateLimited: Response.json({ error: { code: 4 } }, { status: 429, headers: { 'Retry-After': '3' } }),
    rejected: Response.json({ error: { code: 400 } }, { status: 400 }),
    malformed: new Response('<html>', { status: 502 }),
  },
  // Webhook do app (tópico instagram) assinado pela Graph API: GET /app dá o id do app; lista as assinaturas e assina com o token do app.
  webhook: { mode: 'app', subscribeUrl: `https://graph.facebook.com/v26.0/${igAppId}/subscriptions`, appAuth: `Bearer ${igAppId}|${igSecret}`, form: { object: 'instagram' },
    reply: (url, init) => url.endsWith('/app?fields=id') ? Response.json({ id: igAppId })
      : url.endsWith(`/${igAppId}/subscriptions`) ? (init.method === 'POST' ? Response.json({ success: true }) : Response.json({ data: [] }))
      : Response.json({ error: { code: 100, message: `rota inesperada: ${url}` } }, { status: 400 }) },
  connect: { ok: Response.json({ id: igAccount, username: 'loja' }), refused: Response.json({ error: { code: 190 } }, { status: 401 }), externalId: igAccount },
  handshake: { query: t => `hub.mode=subscribe&hub.verify_token=${t}&hub.challenge=1158201444` },
  receipts: { body: igEnvelope({ ...igBase, read: { mid: 'ig.out.1' } }), externalMessageId: 'ig.out.1', status: 'read', eventKey: 'read:ig.out.1' },
}

const uzToken = 'INSTANCE-TOKEN', uzUser = '5511888888888@s.whatsapp.net', uzOwner = '5511999999999'
const uzMessage = (over: Record<string, unknown> = {}) => ({ EventType: 'messages', owner: uzOwner, instanceName: 'Loja',
  message: { id: `${uzOwner}:MSG-IN`, messageid: 'MSG-IN', chatid: uzUser, sender: uzUser, senderName: 'Ana', fromMe: false, isGroup: false,
    messageType: 'Conversation', text: 'quero', messageTimestamp: 1760000000000, ...over } })
const uazapiFixture: ContractFixture = {
  credentials: { serverUrl: 'https://loja.uazapi.com', token: uzToken, webhookSecret: 'hook-secret' }, webhookSecret: 'hook-secret',
  user: { id: uzUser, messageId: 'MSG-IN', text: 'quero' },
  inbound: {
    text: uzMessage(),
    click: uzMessage({ id: `${uzOwner}:MSG-CLICK`, messageid: 'MSG-CLICK', text: 'Ir', messageType: 'ButtonsResponseMessage', buttonOrListid: token }),
    // What the instance reports about a send made through its API: never a message from the contact.
    ownEcho: uzMessage({ id: `${uzOwner}:MSG-ECHO`, messageid: 'MSG-ECHO', fromMe: true, wasSentByApi: true, text: 'eco' }),
    unknownType: uzMessage({ id: `${uzOwner}:MSG-IMG`, messageid: 'MSG-IMG', messageType: 'ProtocolMessage', text: '' }),
    eventKey: 'MSG-IN', clickPayload: token, clickAck: false,
  },
  // The only proof of origin is the instance token inside the body (docs: "Envelope comum").
  authBody: { valid: body => ({ ...(body as object), token: uzToken }), tampered: body => ({ ...(body as object), token: 'outro-token' }) },
  headersFor: async () => ({}), tamperedFor: async () => ({}),
  unconfigured: { webhookSecret: 'hook-secret', credentials: { serverUrl: 'https://loja.uazapi.com' } },
  webhook: { mode: 'auto', body: { url: 'https://x.test/api/hooks/conn', enabled: true, events: ['messages', 'messages_update', 'connection', 'call'], excludeMessages: ['wasSentByApi'] } },
  connect: { ok: Response.json({ instance: { id: 'r183e2ef', name: 'Loja', status: 'connected', profileName: 'Loja da Ana' }, status: { connected: true, loggedIn: true } }),
    refused: Response.json({ error: 'instance info not found' }, { status: 401 }), externalId: 'uazapi:r183e2ef' },
  responses: {
    ok: Response.json({ id: `${uzOwner}:MSG-OUT`, messageid: 'MSG-OUT', response: { status: 'success' } }),
    rateLimited: Response.json({ error: 'rate limit exceeded' }, { status: 429, headers: { 'Retry-After': '3' } }),
    rejected: Response.json({ error: 'Missing number or text' }, { status: 400 }),
    malformed: new Response('<html>', { status: 502 }),
  },
  receipts: { body: { EventType: 'messages_update', owner: uzOwner, type: 'ReadReceipt', state: 'Read',
    event: { Chat: uzUser, chatid: uzUser, MessageIDs: ['MSG-OUT'], Timestamp: 1760000000, Type: 'Read', IsFromMe: true, IsGroup: false } },
    externalMessageId: 'MSG-OUT', status: 'read' },
}

const msPage = '110022003300440', msUser = '550066007700880'
const msEnvelope = (item: unknown) => ({ object: 'page', entry: [{ id: msPage, time: 1760000000000, messaging: [item] }] })
const msBase = { sender: { id: msUser }, recipient: { id: msPage }, timestamp: 1760000000000 }
const messenger: ContractFixture = {
  credentials: { accessToken: 'TESTONLY', pageId: msPage, appSecret: igSecret, webhookSecret: 'VERIFY' }, webhookSecret: 'VERIFY',
  user: { id: msUser, messageId: 'mid.in', text: 'quero' },
  inbound: {
    text: msEnvelope({ ...msBase, message: { mid: 'mid.in', text: 'quero' } }),
    click: msEnvelope({ ...msBase, postback: { mid: 'mid.click', title: 'Ir', payload: token } }),
    ownEcho: msEnvelope({ ...msBase, sender: { id: msPage }, recipient: { id: msUser }, message: { mid: 'mid.echo', text: 'eco', is_echo: true } }),
    unknownType: msEnvelope({ ...msBase, message: { mid: 'mid.img', attachments: [{ type: 'image', payload: { url: 'https://x.test/a.png' } }] } }),
    eventKey: 'mid.in', clickPayload: token, clickAck: false,
  },
  headersFor: body => hmac(body, igSecret), tamperedFor: body => hmac(body, 'outro-segredo'),
  unconfigured: { webhookSecret: 'VERIFY', credentials: { accessToken: 'TESTONLY', pageId: msPage } },
  responses: {
    ok: Response.json({ recipient_id: msUser, message_id: 'mid.out.1' }),
    rateLimited: Response.json({ error: { code: 613 } }, { status: 429, headers: { 'Retry-After': '3' } }),
    rejected: Response.json({ error: { code: 400 } }, { status: 400 }),
    malformed: new Response('<html>', { status: 502 }),
  },
  webhook: { mode: 'manual' },
  connect: { ok: Response.json({ id: msPage, name: 'Loja' }), refused: Response.json({ error: { code: 190 } }, { status: 401 }), externalId: msPage },
  handshake: { query: t => `hub.mode=subscribe&hub.verify_token=${t}&hub.challenge=1158201444` },
  receipts: { body: msEnvelope({ ...msBase, delivery: { mids: ['mid.out.1'], watermark: 1760000000000 } }), externalMessageId: 'mid.out.1', status: 'delivered', eventKey: 'delivered:mid.out.1' },
}

export const fixtures: ProviderFixture[] = [
  { provider: 'telegram_bot', kind: 'telegram', env, contract: telegram },
  { provider: 'meta_whatsapp_cloud', kind: 'whatsapp', env, contract: whatsapp },
  { provider: 'instagram_unified', kind: 'instagram', env, contract: instagram },
  { provider: 'uazapi', kind: 'whatsapp', env, contract: uazapiFixture },
  { provider: 'messenger_page', kind: 'messenger', env, contract: messenger },
  { provider: 'zapi', kind: 'whatsapp', env, contract: zapiFixture },
  { provider: 'cloudflare_email', kind: 'email', env, contract: emailFixture },
]
