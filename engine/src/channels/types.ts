/** Every channel kind the product knows. Lists of channels elsewhere derive from this one. */
import type { ChannelType } from './kinds'
export { channelKinds, type ChannelType } from './kinds'

export type EmailAction = { type: 'add_tag' | 'remove_tag'; tag_id: string }
export type EmailInteraction = { automationId?: string; actions?: EmailAction[] }
export type EmailContent = {
  subject: string; preheader?: string; html?: string; senderId?: string
  onOpen?: EmailInteraction & { mode: 'once' | 'every' }
  linkActions?: (EmailInteraction & { url: string })[]
  source?: { automationId?: string; broadcastId?: string; nodeId: string }
}

export type TemplateTextParameter = { type: 'text'; text: string; parameter_name?: string }
export type TemplateComponent =
  | { type: 'header'; parameters: (TemplateTextParameter | { type: 'image'; image: { link: string } } | { type: 'video'; video: { link: string } } | { type: 'document'; document: { link: string } })[] }
  | { type: 'button'; sub_type: 'url'; index: string; parameters: { type: 'text'; text: string }[] }

/** Categoria do modelo aprovado. O provedor pode usar uma rota própria para marketing. */
export type TemplateCategory = 'marketing' | 'utility' | 'authentication'

/** Mensagem neutra que o motor produz a partir de um nó "Enviar mensagem". */
export type OutboundMessage =
  | { kind: 'text'; text: string; buttons?: Button[]; quickReplies?: QuickReply[]; email?: EmailContent }
  | { kind: 'media'; media: 'image' | 'video' | 'audio' | 'file'; url: string; caption?: string; size?: number; mime?: string; buttons?: Button[] }
  | { kind: 'cards'; cards: Card[]; aspectRatio?: 'horizontal' | 'square'; text?: string }      // galeria; `text`: abertura do carrossel (WhatsApp)
  | { kind: 'list'; text: string; buttonText: string; sections: ListSection[]; header?: string; footer?: string }
  | { kind: 'template'; templateId: string; params: Record<string, string>; components?: TemplateComponent[]; category?: TemplateCategory } // WhatsApp fora da janela
  | { kind: 'typing'; seconds: number }

/** Botão de mensagem; no de link, webviewSize é o tamanho da janela onde o canal permite (Messenger: cheia 100%, média 75%, compacta 50%). */
export type Button = import('../schemas/message-cards').CardButton | { type: 'url'; title: string; url: string; webviewSize?: 'full' | 'medium' | 'compact' }
export type QuickReply = { id: string; title: string }
export type Card = import('../schemas/message-cards').Card
export type ListSection = { title?: string; rows: { id: string; title: string; description?: string }[] }

/** O que o canal aceita. Fonte única para editor e motor. */
export interface ChannelCapabilities {
  type: ChannelType
  text: { maxLength: number; unit: 'chars' | 'bytes'; linksClickable?: boolean }   // TikTok: false
  email?: { subjectMaxLength: number; preheader: boolean; html: boolean; unsubscribe: 'marketing' }
  buttons: { types: Button['type'][]; maxPerMessage: number; titleMax: number; payloadMaxBytes: number }
  quickReplies: { max: number; titleMax: number } | null          // null = não existe no ManyChat (WhatsApp, Telegram, e-mail, TikTok)
  /** Entry points published to the provider's conversation UI, independent from message buttons. */
  conversationStarters?: { maxItems: number; titleMax: number } | null
  mainMenu?: { maxItems: number; titleMax: number } | null
  cards: import('../schemas/message-cards').CardsProfile['cards']
  list: { maxRows: number; maxSections: number; rowTitleMax: number; rowDescMax: number } | null
  templateCarousel?: { min: 2; max: 10; marketingOnly: true }
  /** Pre-approved templates: `required` says when the channel only accepts one (outside the window); null/absent = no templates. */
  templates?: { required: 'outside_window' | 'never'; managedBy: 'provider_api' | 'none' } | null
  media: Partial<Record<'image' | 'video' | 'audio' | 'file', { maxBytes: number; mime: string[] }>>
  typing: { maxSeconds: number } | null
  receipts: { delivered: boolean; read: boolean }
  edit: boolean; delete: { maxAgeHours: number } | null
  window: WindowRule | null                                       // null = sem janela (Telegram, e-mail)
  inbound: { message: boolean; comment: boolean; storyReply: boolean; referral: boolean; emailOpenClick: boolean; /** The connection delivers photos, files, audio, video, locations and shared contacts, and the file can be downloaded. */ media?: boolean }
  commentReply: { maxAgeDays: number; maxMessages: 1 } | null     // Instagram
  initiator: 'user' | 'business_with_template' | 'business_with_optin'
  identity: { key: 'psid' | 'igsid' | 'bsuid' | 'telegram_id' | 'tiktok_id' | 'phone_e164' | 'email'; phoneGuaranteed: boolean
    /** How the provider names a person it reached by phone: bare digits (default) or a chat JID (digits@s.whatsapp.net). Needed to open a conversation that later replies land in. */
    address?: 'digits' | 'jid' }
  verified: Record<string, boolean>                               // chave -> confirmado na doc oficial?
}

export type WindowRule = {
  standardHours: number                       // 24 (IG/Messenger/WhatsApp), 48 (TikTok, doc ManyChat)
  maxMessagesInWindow?: number                // TikTok: 10 sem nova resposta do usuário
  extended?: { reason: 'ctd_ad'; days: 7 }    // IG/Messenger: anúncio Click-to-Direct/Messenger
  humanAgentDays?: number                     // IG/Messenger: 7, contados da última interação
  outside: 'template' | 'utility_or_marketing' | 'human_agent_only' | 'nothing'
  // Messenger: 'utility_or_marketing' + HUMAN_AGENT. Message Tags (descontinuadas 09/02/2026),
  // One-time/Recurring Notifications (retirada desde 12/01/2026) e IG DM Lists NÃO entram.
}

/** O que a Meta disse ao recusar um envio (já sem token): vai ao erro da mensagem e ao log, para a pessoa saber o motivo. */
export type MetaErrorInfo = { code?: number; subcode?: number; message?: string; type?: string; traceId?: string }
export type SendResult =
  | { ok: true; externalId: string; parts: number; degraded?: Degradation[] }
  | { ok: false; reason: 'unsupported'; detail: string }               // o canal não tem o recurso
  | { ok: false; reason: 'outside_window'; window: 'standard' | 'human_agent'; expiredAt: number; canUseTemplate: boolean }
  | { ok: false; reason: 'not_opted_in' | 'blocked' | 'comment_reply_used' | 'comment_too_old' | 'window_message_cap' } // TikTok 10/48 h
  | { ok: false; reason: 'rate_limited'; retryAfterSec: number }
  | { ok: false; reason: 'uncertain'; detail: string }                 // rede caiu; reconciliar antes de reenviar
  | { ok: false; reason: 'rejected'; code: string; detail: string; meta?: MetaErrorInfo }

export type Degradation =
  | { kind: 'buttons_split'; from: number; messages: number }
  | { kind: 'buttons_to_list' } | { kind: 'cards_to_messages' }
  | { kind: 'quick_replies_to_buttons' } | { kind: 'text_split'; parts: number }
  | { kind: 'text_truncated'; at: number } | { kind: 'media_as_link' }

export type CanSend =
  | { ok: true; mode: 'free' | 'human_agent' | 'template_only' | 'comment_reply' }
  | Extract<SendResult, { ok: false }>

/** What a contact can send besides text, in the provider-neutral shape. `ref` is the provider's own handle on the file: the core
 * hands it back to the provider (`downloadMedia`) to fetch the bytes; nothing else reads it. */
export type InboundMedia = { type: 'image' | 'audio' | 'video' | 'file' | 'sticker'; ref: string; mime?: string; filename?: string; sha256?: string; voice?: boolean; animated?: boolean }
export type InboundLocation = { latitude: number; longitude: number; name?: string; address?: string; url?: string }
export type InboundSharedContact = { name: string; company?: string; phones: string[]; emails: string[] }
export type InboundOrder = { catalogId: string; text?: string; items: { productId: string; quantity: number; price: number; currency: string }[] }

/** Where a conversation came from when the contact arrived through an ad: neutral across channels (every field is bounded and optional but the kind). */
export type ContactOrigin = { kind: 'ad'; sourceId?: string; sourceType?: string; headline?: string; clickId?: string; sourceUrl?: string }

export type InboundEvent =
  | { kind: 'message'; externalUserId: string; externalMessageId: string; text?: string; occurredAt?: number; profile?: { firstName?: string; lastName?: string; username?: string; phoneE164?: string }
      media?: InboundMedia; location?: InboundLocation; sharedContacts?: InboundSharedContact[]; order?: InboundOrder
      /** Post or reel the contact shared into the conversation. */
      shared?: { url: string }
      /** A message the channel delivered but this product cannot show (a kind the provider names, when it does). */
      unsupported?: { type?: string }
      /** Set on the message that opened the conversation from an ad. */
      origin?: ContactOrigin
      /** True when the provider distinguishes a story response from a direct message. */
      storyReply?: boolean
      /** The story the contact answered, when the provider names it. */
      storyId?: string
      /** The channel's like button (a sticker), delivered as the text "👍": it only answers a Like rule, never a default reply. */
      like?: boolean
      /** Set when the message was written in a group: the author is `externalUserId`, the conversation is the group. */
      group?: { externalGroupId: string; subject?: string; mentionsMe: boolean } }
  | { kind: 'click'; externalUserId: string; payload: string; /** Visible text of the tapped button, when the provider reports it. */ label?: string; ackToken?: string; occurredAt?: number }   // callback_query / postback / button_reply / list_reply
  | { kind: 'story_mention'; externalUserId: string; externalMessageId: string; storyUrl?: string; occurredAt?: number }
  /** The contact reacted to a message (`emoji` absent: the reaction was taken back). `targetMessageId` is the provider id of that message. */
  | { kind: 'reaction'; externalUserId: string; targetMessageId: string; emoji?: string; occurredAt?: number }
  | { kind: 'comment'; externalUserId: string; commentId: string; postId: string; text: string; createdAt: number; live?: boolean }
  | { kind: 'receipt'; externalMessageId: string; status: 'sent' | 'delivered' | 'read' | 'failed'; occurredAt?: number; errors?: Array<{ code: string; title?: string; detail?: string }> }
  | { kind: 'optin' | 'optout' | 'referral'; externalUserId: string; ref?: string }
  | { kind: 'ignored'; why: string }

export interface ChannelAdapter {
  capabilities(): ChannelCapabilities
  canSend(contact: ContactChannelState, now: number, intent: 'automation' | 'human' | 'broadcast'): CanSend
  /** Ajusta a mensagem neutra ao canal (pura, testável, sem rede). */
  fit(message: OutboundMessage, caps: ChannelCapabilities): { messages: OutboundMessage[]; degraded: Degradation[] } | Extract<SendResult, { reason: 'unsupported' }>
  send(ctx: SendContext, message: OutboundMessage): Promise<SendResult>
}

export type ContactChannelState = {
  optedIn: boolean; windowExpiresAt: number | null; humanWindowExpiresAt: number | null
  commentReply?: { commentId: string; createdAt: number; used: boolean }
  blocked?: boolean; windowMessagesSent?: number
}
export type SendContext = { run: import('../flow/types').Run; inboxButtons?: { id: string; title: string; payload?: string }[]; runId: string; step: number; part: number; channelId: string; externalUserId: string; mode: CanSend
  /** A run born in a group answers there: `externalUserId` stays the author (who is mentioned), the message goes to the group. */
  group?: { threadId: string; externalGroupId: string } }
