import type { ZodType } from 'zod'
import type { TemplateDraft } from './template-draft'
import type { ProviderTemplate } from './meta-templates'
import type { InboundEvent as QueuedEvent, IntegrationEnv } from '../integrations'
import type { ChannelAdapter, ChannelCapabilities, ChannelType, ContactOrigin, InboundEvent, InboundLocation, InboundMedia, InboundOrder, InboundSharedContact, OutboundMessage, SendResult } from './types'

/** Single source of truth for the provider layer (types now, zod schemas per provider later).
 * Design: replica/arquitetura-mensageria.md §1. Nothing here changes runtime behaviour yet. */
export type ChannelKind = ChannelType
/** Providers registered today. */
export type ProviderId = 'telegram_bot' | 'meta_whatsapp_cloud' | 'uazapi' | 'instagram_unified' | 'messenger_page' | 'zapi' | 'cloudflare_email'
/** Value stored in channels.provider for rows created before the layer existed. */
export type StoredProvider = ProviderId | 'legacy'

type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T

/** Channel rules plus the optional blocks the layer adds. Optional so today's profiles stay deep-equal. */
export interface ChannelProfile extends ChannelCapabilities {
  comments?: { posts: boolean; publicReply: boolean; like: boolean; privateReply: { textMaxLength: number; urlButtonsMax: number } | null } | null
  /** Story entry points: reply and mention reach the inbox as private messages; heart is the reaction sent to a mention; list names the active stories. */
  stories?: { reply: boolean; mention: boolean; heart: boolean; list: boolean } | null
  groups?: { inbound: boolean; reply: boolean; mentionDetect: boolean } | null
  templates?: { required: 'outside_window' | 'never'; managedBy: 'provider_api' | 'none' } | null
  profile?: { name: boolean; avatar: 'url' | 'bytes' | null; phone: boolean }
  unstable?: ('buttons' | 'list' | 'cards')[]
  risk?: { banOnColdOutreach: boolean }
}

/** A provider declares only what changes in the channel profile. Applied by mergeProfile(). */
export type ProfilePatch = DeepPartial<Omit<ChannelProfile, 'type' | 'unstable' | 'risk'>> & {
  remove?: ('window' | 'templates' | 'list' | 'cards' | 'quickReplies' | 'typing' | 'receipts.read')[]
  unstable?: ('buttons' | 'list' | 'cards')[]
  risk?: { banOnColdOutreach: boolean }
}

export type ConnectionStatus = 'pending' | 'connecting' | 'connected' | 'disconnected' | 'error' | 'restricted'

export interface Connection {
  id: string; workspaceId: string
  kind: ChannelKind; provider: ProviderId
  externalId: string
  displayName: string | null
  status: ConnectionStatus
  settings: Record<string, unknown>   // non-secret: serverUrl, graphVersion, wabaId...
  profile: ChannelProfile             // effective profile, already computed
}

/** Decrypted credentials exist only inside the process: never in logs, responses or queues. */
export type Credentials = Record<string, string>

/** One thing the connection needs from the provider's account: ok, missing (the connection cannot work without it), unknown (could not be told) or
 * unavailable (the provider's API does not offer it on this kind of connection: nothing to fix; `fix` then carries the reason). */
export type PermissionItem = { key: string; label: string; status: 'ok' | 'missing' | 'unknown' | 'unavailable'; fix?: string }

/** `credentials` is the very object the core seals after connect (create, rotate): a provider that resolves what the user pasted into the real
 * credential (e.g. a server-wide token into the instance token) may replace entries in it; whatever is left there is what gets stored. */
export interface ConnectContext { bindings?: { email?: EmailSendBinding }; env?: IntegrationEnv; connection: Connection; credentials: Credentials; hookUrl: string; webhookSecret: string; fetch: typeof fetch }

export type ConnectStep =
  /** accountId: the provider account above the connection, as the provider itself proved it for these credentials. */
  | { kind: 'done'; externalId: string; displayName?: string; accountId?: string
      /** The provider assigned the account to the webhook while connecting (null: it was not tried or the provider refused). */
      webhookSubscribed?: boolean
      /** pt-BR text about where the webhook was registered (the panel shows it after connecting). */
      notice?: string
      /** pt-BR text about something the provider corrected on its own while connecting (e.g. the typed account was not the one that owns the number). */
      warning?: string
      /** Health parts the provider read right now (kept in provider_health): a value sets the part, `null` clears it; a part left out is untouched. */
      health?: Record<string, Record<string, unknown> | null> }
  // externalId: the provider knows the account before the pairing is done (UAZAPI instance id), so the connection can be stored right away.
  | { kind: 'qr'; qr: string; expiresAt: number; externalId?: string; displayName?: string }
  | { kind: 'pairing_code'; code: string; expiresAt: number }
  /** reason: pt-BR text saying why the automatic registration did not happen (the panel shows it above the steps). */
  | { kind: 'manual_webhook'; callbackUrl: string; verifyToken: string; checklist: string[]; reason?: string }
  /** message: optional text in pt-BR the panel shows as is (otherwise a generic one by code). */
  | { kind: 'failed'; code: string; detail: string; message?: string }

export type RawWebhook = { method: 'GET' | 'POST'; headers: Headers; query: URLSearchParams; body: Uint8Array }
export type WebhookVerdict = { ok: true; challenge?: string } | { ok: false; status: 401 | 403 | 400 | 503 }

export type Party = {
  externalUserId: string
  addressKind: 'bsuid' | 'wa_pn' | 'wa_lid' | 'igsid' | 'psid' | 'telegram_id' | 'phone_e164' | 'email'
  phoneE164?: string
  profile?: { firstName?: string; lastName?: string; username?: string }
}
export type Thread = { kind: 'direct' } | { kind: 'group'; externalGroupId: string; subject?: string }
export type SendTarget = { kind: 'direct'; externalUserId: string } | { kind: 'group'; externalGroupId: string; mention?: string[] }

/** Next-generation inbound event (groups, mentions, connection state). Coexists with the
 * current InboundEvent in types.ts until F1 migrates the consumers. */
export type InboundEventV2 =
  | { kind: 'message'; eventKey: string; from: Party; thread: Thread; externalMessageId: string
      text?: string; media?: InboundMedia; location?: InboundLocation; sharedContacts?: InboundSharedContact[]; order?: InboundOrder; shared?: { url: string }; unsupported?: { type?: string }; origin?: ContactOrigin
      occurredAt?: number; mentionsMe?: boolean; replyTo?: string; storyReply?: boolean; storyId?: string
      /** The channel's like button (a sticker), delivered as the text "👍": it only answers a Like rule, never a default reply. */
      like?: boolean }
  | { kind: 'reaction'; eventKey: string; from: Party; thread: Thread; targetMessageId: string; emoji?: string; occurredAt?: number }
  | { kind: 'story_mention'; eventKey: string; from: Party; thread: Thread; externalMessageId: string; storyUrl?: string; occurredAt?: number }
  | { kind: 'click'; eventKey: string; from: Party; thread: Thread; payload: string; /** Visible text of the tapped button, when the provider reports it. */ label?: string; ackToken?: string; occurredAt?: number }
  | { kind: 'comment'; eventKey: string; from: Party; commentId: string; postId: string; text: string; createdAt: number; live?: boolean }
  | { kind: 'receipt'; eventKey: string; externalMessageId: string; status: 'sent' | 'delivered' | 'read' | 'failed'; occurredAt?: number; errorCode?: string; errors?: Array<{ code: string; title?: string; detail?: string }> }
  | { kind: 'optin' | 'optout' | 'referral'; eventKey: string; from: Party; ref?: string }
  | { kind: 'connection'; eventKey: string; status: ConnectionStatus; detail?: string }
  // The account owner wrote from their own device (not through this layer). `to` is the contact it was written to;
  // sentByApi marks echoes of sends made through the provider API (ours or another integration's).
  | { kind: 'own_message'; eventKey: string; to: Party; thread: Thread; externalMessageId: string; text?: string; occurredAt?: number; sentByApi: boolean }
  | { kind: 'ignored'; why: string; eventKey?: string }   // eventKey lets the entry point still queue a receipt for a payload it cannot use

/** One queued event of a delivery. externalId names the account on a route shared by several connections (Meta); a route that already
 * names its connection leaves it out. `at` (ms) is the provider's own timestamp, used to advance a reconciliation cursor. */
/** `accountId` names the provider account that owns the event when it belongs to no single connection (events about the account itself). */
/** standbySender: the event came in entry.standby (another app owns the conversation); the id of the person, for take_thread_control. */
export type DeliveryPart = { eventKey: string; externalId?: string; accountId?: string; payload: Record<string, unknown>; at?: number; standbySender?: string }

/** Current structured Workers API. Global SendEmail in workers-types also supports its legacy MIME overload. */
export interface EmailSendBinding {
  send(message: { to: string; from: string | { email: string; name?: string }; subject: string; text?: string; html?: string; replyTo?: string; headers?: Record<string, string> }): Promise<{ messageId: string }>
}
export type ProviderCtx = { bindings?: { email?: EmailSendBinding }; env?: IntegrationEnv; intent?: 'automation' | 'human' | 'broadcast'; humanAgent?: boolean; connection: Connection; credentials: Credentials; fetch: typeof fetch }
export type ConversationSurface = {
  kind: 'conversation_starters' | 'main_menu'
  enabled: boolean
  items: { title: string; payload: string }[]
}
/** Public media summary safe to store as the selected trigger's snapshot. Pagination exposes only the opaque cursor. */
export type CommentPost = { id: string; caption?: string; mediaType?: string; mediaUrl?: string; thumbnailUrl?: string; permalink?: string; publishedAt?: number; likes?: number; comments?: number }
export type CommentPostsPage = { posts: CommentPost[]; nextCursor: string | null }
/** Uma resposta privada = um texto e, se quiser, um botão: de link (`url`) ou de toque (`id` vira o payload do postback). */
export type CommentPrivateReply = { commentId: string; text: string; button?: { title: string } & ({ url: string; id?: undefined } | { id: string; url?: undefined }) }
/** What a provider's own bookkeeping (contact rows, windows, receipts) works from: the queued event it came from, and the database. */
export type SyncContext = ProviderCtx & { env: IntegrationEnv; event: QueuedEvent }

/** The bytes of a file a contact sent, or why they could not be had. `transient`: nothing was decided (network, 5xx, rate limit, a stale link) and a retry is safe.
 * `code` is a short word that is safe to store and show; it never carries provider text. */
export type MediaDownload =
  | { ok: true; body: ReadableStream<Uint8Array>; mime: string; size: number }
  | { ok: false; transient: boolean; code: 'not_found' | 'auth' | 'too_large' | 'invalid' | 'rate_limited' | 'server' | 'network' | 'expired' }

/** Roles a responder can hold under WhatsApp Conversation Routing (a `target_role` of a targeted pass). */
export const threadRoles = ['ai_agent', 'ctwa', 'customer_service', 'escalation', 'marketing', 'utility'] as const
export type ThreadRole = typeof threadRoles[number]
export type ThreadControlInput = { action: 'pass' | 'release' | 'take'; externalUserId: string; targetRole?: ThreadRole; metadata?: string }
/** `code` is the provider's own error code; `transient` means nothing was decided (network, 5xx, rate limit) and a retry is safe. */
export type RoutingFailure = { ok: false; code?: number; transient: boolean }
export type RoutingRoles = { ok: true; active: boolean; roles: string[]; standby: boolean } | RoutingFailure
export type ThreadControlResult = { ok: true; requestId: string } | RoutingFailure

/** Whether the account may send marketing through the provider's dedicated marketing API. `missing` names what the connection lacks to ask. */
export type MarketingStatus = { ok: true; enabled: boolean; status: string; cloudMarketingDisabled: boolean | null } | { ok: false; code?: number; transient: boolean; missing?: 'account_id' }

/** The contract every provider implements. The three current providers are wrapped by
 * ChannelAdapter for now (see registry.ts); each slice F1-F3 moves one onto this interface. */
export interface ProviderAdapter {
  readonly id: ProviderId
  readonly kinds: readonly ChannelKind[]
  readonly patch: ProfilePatch
  readonly credentialsSchema: ZodType<Credentials>
  readonly settingsSchema: ZodType<Record<string, unknown>>
  /** Largest webhook body (bytes) this provider's own deliveries may have; without it the shared default applies. */
  readonly maxWebhookBytes?: number
  /** Corpo que não é JSON (ex.: formulário): o provedor converte antes da verificação de conteúdo e do parse. */
  decodeBody?(raw: RawWebhook): unknown

  connect(ctx: ConnectContext): Promise<ConnectStep>
  /** "Atualizar conexão": o que a conexão consegue fazer na conta hoje, item a item, com o passo para resolver o que falta. Provedores sem esta conferência não a têm. */
  checkPermissions?(ctx: ConnectContext, step: ConnectStep): Promise<PermissionItem[]>
  /** Passos do webhook manual que o painel mostra para este provedor; fonte única (o painel e o registerWebhook leem daqui). */
  readonly webhookChecklist?: readonly string[]
  /** The webhook lives on the provider app (shared hook) but the provider registers it itself after the row is stored (instagram_unified). */
  readonly registersSharedWebhook?: boolean
  /** awaitFirstEvent: the provider accepted the webhook, but only a real delivery proves events reach it (the connection stays pending until then). */
  registerWebhook(ctx: ConnectContext): Promise<{ registered: true; awaitFirstEvent?: boolean } | { registered: false; manual: Extract<ConnectStep, { kind: 'manual_webhook' }> }>
  verifyWebhook(raw: RawWebhook, secrets: { webhookSecret: string; credentials: Credentials }): Promise<WebhookVerdict>
  parseInbound(body: unknown, connection: Connection): InboundEventV2[]
  /** For providers whose delivery bundles several events (and possibly several accounts): one entry per event,
   * with the payload the queue keeps for it and the account it belongs to. Without it the whole body is one event. */
  splitDelivery?(body: unknown): DeliveryPart[] | Promise<DeliveryPart[]>
  /** Takes the conversation with `userId` from the app that owns it (conversation routing). Best effort, never throws. */
  takeThreadControl?(ctx: ProviderCtx, userId: string): Promise<{ ok: boolean; code?: number | string }>
  /** For providers that never redeliver a webhook: recent events (newer than `since`, ms) straight from the provider API, in the
   * same shape splitDelivery queues, so a replayed event dedupes on its key. `cursor` is the newest timestamp seen. */
  pull?(ctx: ProviderCtx, since: number): Promise<{ parts: DeliveryPart[]; cursor: number }>
  /** Optional bookkeeping for a provider that owns its contact rows and receipts. Runs for every interpreted event, before the flow executor sees it. */
  sync?(ctx: SyncContext, item: InboundEvent): Promise<void>
  /** The same bookkeeping at the level of the whole queued delivery, for a provider that needs more than the interpreted items: events the flow
   * executor never sees (own messages, connection state, calls) and the raw payload. When present it replaces both `sync` and the shared
   * per-kind bookkeeping: the provider owns everything its delivery changes. */
  syncDelivery?(ctx: SyncContext): Promise<void>
  fit(message: OutboundMessage, profile: ChannelProfile): ReturnType<ChannelAdapter['fit']>
  send(ctx: ProviderCtx & { target: SendTarget }, part: OutboundMessage): Promise<SendResult>
  /** The "typing…" indicator shown before a send. Cosmetic: called only when the effective profile declares `typing`, never recorded in the inbox. `replyTo` is the provider id of the contact's latest message, for providers (WhatsApp) that attach the indicator to it. */
  typing?(ctx: ProviderCtx & { target: SendTarget }, seconds: number, replyTo?: string): Promise<SendResult>
  /** The provider's typing indicator hangs on the contact's latest message (WhatsApp): the delivery layer looks that message up and passes it as `replyTo`. */
  readonly typingNeedsReplyTo?: boolean
  /** The file behind an inbound `media.ref`. The provider asks for a fresh link every time: links expire in minutes, refs last days. `maxBytes` refuses larger files before downloading them. */
  downloadMedia?(ctx: ProviderCtx, media: InboundMedia, maxBytes: number): Promise<MediaDownload>
  fetchProfile?(ctx: ProviderCtx, party: Party): Promise<{ firstName?: string; lastName?: string; username?: string; avatar?: { url: string } | { bytes: ArrayBuffer }; channelFields?: import('../contracts').ChannelFields } | null>
  ack?(ctx: { credentials: Credentials; fetch: typeof fetch; connection?: Connection }, event: Extract<InboundEventV2, { kind: 'click' }>): Promise<void>
  templates?: { create(ctx: ProviderCtx, draft: TemplateDraft): Promise<ProviderTemplate>; list(ctx: ProviderCtx): Promise<ProviderTemplate[]> }
  /** Perfil comercial público do número (descrição, endereço, e-mail, sites, setor). */
  businessProfile?: { get(ctx: ProviderCtx): Promise<BusinessProfile>; update(ctx: ProviderCtx, profile: BusinessProfile): Promise<void> }
  /** Catálogo de produtos ligado à conta (só leitura no painel). */
  catalog?(ctx: ProviderCtx): Promise<{ catalogId: string | null; products: { id: string; retailerId: string; name: string; price?: string; imageUrl?: string; availability?: string }[] }>
  /** Publishes or removes conversation entry points. Throws a sanitized error when the provider does not confirm success. */
  configureSurface?(ctx: ProviderCtx, surface: ConversationSurface): Promise<void>
  /** Menu só deste contato (substitui o menu principal para ele); null volta ao menu da conexão. */
  configureUserMenu?(ctx: ProviderCtx, externalUserId: string, items: { title: string; payload: string }[] | null): Promise<void>
  /** Opções da conexão que vivem no provedor (ex.: saudação da página): aplicadas antes de salvar; erro sai limpo. */
  applySettings?(ctx: ProviderCtx, settings: Record<string, unknown>): Promise<void>
  /** Reaction to a message the contact sent (the heart on a story mention). The outcome is reported, never thrown. */
  react?(ctx: ProviderCtx & { target: SendTarget }, input: { messageId: string; reaction: 'love' }): Promise<SendResult>
  /** The account's active stories, to pick the one a story-reply trigger watches. */
  stories?: { list(ctx: ProviderCtx, query: { limit: number; after?: string }): Promise<CommentPostsPage> }
  comments?: {
    listPosts(ctx: ProviderCtx, query: { limit: number; after?: string }): Promise<CommentPostsPage>
    replyPublic(ctx: ProviderCtx, input: { commentId: string; text: string }): Promise<SendResult>
    like(ctx: ProviderCtx, input: { commentId: string }): Promise<SendResult>
    replyPrivate(ctx: ProviderCtx, input: CommentPrivateReply): Promise<SendResult>
  }
  /** Groups the account takes part in, for choosing where a group trigger applies. A page of `limit` summaries matching `search`. */
  listGroups?(ctx: ProviderCtx, query: { search?: string; limit: number; offset: number }): Promise<{ groups: { externalGroupId: string; subject: string | null }[]; nextOffset: number | null }>
  /** Conversation Routing (more than one partner on one number): our roles on the number, and pass/release/take of one conversation. */
  routing?: {
    roles(ctx: ProviderCtx): Promise<RoutingRoles>
    control(ctx: ProviderCtx, input: ThreadControlInput): Promise<ThreadControlResult>
  }
  /** Providers with a separate API for marketing templates (WhatsApp Marketing Messages API): is the account enabled for it? */
  marketing?: { status(ctx: ProviderCtx): Promise<MarketingStatus> }
  /** Is this phone number reachable on the channel? 'unknown' when the provider could not tell (transport, unexpected answer): callers never block on it. */
  checkRecipient?(ctx: ProviderCtx, phoneDigits: string): Promise<'yes' | 'no' | 'unknown'>
  disconnect?(ctx: ConnectContext): Promise<void>
  rotateCredentials?(ctx: ConnectContext): Promise<Credentials>
}

export type BusinessProfile = { about?: string; description?: string; address?: string; email?: string; websites?: string[]; vertical?: string }
