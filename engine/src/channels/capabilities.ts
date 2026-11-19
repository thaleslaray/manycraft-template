import type { ChannelType } from './types'
import type { ChannelProfile } from './contract'

const image = (maxBytes: number) => ({ maxBytes, mime: ['image/jpeg', 'image/png'] })
/** Documents the Cloud API takes (P/business-phone-numbers/media.md, Supported media types): txt, xls, xlsx, doc, docx, ppt, pptx and pdf. */
const whatsappDocuments = ['application/pdf', 'text/plain', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation']
/** Telegram sends any document type: sendDocument.md and conceitos/sending-files.md limit size only, never format. The list is closed because the
 * editor and the upload route need explicit types; it covers the common office, text, archive and data files. */
const telegramDocuments = [...whatsappDocuments, 'text/csv', 'application/zip', 'application/json', 'application/rtf', 'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet', 'application/vnd.oasis.opendocument.presentation', 'application/epub+zip']
const gallery = { maxCards: 10, titleMax: 80, subtitleMax: 80, maxButtons: 3 }
/** Approved snapshot: replica/canal-adaptador.md and recon/matriz-cruzamento.md (23/10/2026).
 * Unconfirmed limits stay conservative and explicitly marked; these are not delivery claims. */
const base: ChannelProfile = {
  type: 'telegram', text: { maxLength: 4096, unit: 'chars' },
  buttons: { types: ['postback', 'url'], maxPerMessage: 10, titleMax: 60, payloadMaxBytes: 64 },
  quickReplies: null, conversationStarters: null, mainMenu: null, cards: null, list: null,
  media: { image: image(5e6), video: { maxBytes: 20e6, mime: ['video/mp4'] },
    audio: { maxBytes: 20e6, mime: ['audio/mpeg', 'audio/mp4'] }, file: { maxBytes: 20e6, mime: telegramDocuments } },   // by URL: photo 5 MB, others 20 MB (sending-files.md); sendAudio takes MP3 or M4A
  typing: { maxSeconds: 5 }, receipts: { delivered: false, read: false }, edit: true, delete: { maxAgeHours: 48 },
  window: null, inbound: { message: true, comment: false, storyReply: false, referral: false, emailOpenClick: false },
  commentReply: null, initiator: 'user', identity: { key: 'telegram_id', phoneGuaranteed: false },
  verified: { textMax: true, payloadMaxBytes: true, maxButtons: false, buttonTitleMax: false, typing: true },
}
const profiles: Record<ChannelType, ChannelProfile> = {
  telegram: base,
  instagram: { ...base, type: 'instagram', text: { maxLength: 1000, unit: 'bytes' },
    conversationStarters: { maxItems: 4, titleMax: 80 }, mainMenu: { maxItems: 20, titleMax: 30 },
    comments: { posts: true, publicReply: true, like: true, privateReply: { textMaxLength: 1000, urlButtonsMax: 1 } },
    stories: { reply: true, mention: true, heart: true, list: true },
    buttons: { types: ['postback', 'url'], maxPerMessage: 3, titleMax: 20, payloadMaxBytes: 1000 },
    quickReplies: { max: 13, titleMax: 20 }, cards: gallery,
    media: { image: image(8e6), video: { maxBytes: 25e6, mime: ['video/mp4', 'video/ogg', 'video/avi', 'video/quicktime', 'video/webm'] },
      audio: { maxBytes: 25e6, mime: ['audio/aac', 'audio/mp4', 'audio/wav'] }, file: { maxBytes: 25e6, mime: ['application/pdf'] } },
    typing: { maxSeconds: 5 }, edit: false, delete: null, receipts: { delivered: false, read: true },
    window: { standardHours: 24, extended: { reason: 'ctd_ad', days: 7 }, humanAgentDays: 7, outside: 'human_agent_only' },
    inbound: { message: true, comment: true, storyReply: true, referral: false, emailOpenClick: false },
    commentReply: { maxAgeDays: 7, maxMessages: 1 }, identity: { key: 'igsid', phoneGuaranteed: false },
    verified: { textMax: true, maxButtons: true, buttonTitleMax: false, payloadMaxBytes: false, typingDuration: false, delivered: false } },
  messenger: { ...base, type: 'messenger', text: { maxLength: 2000, unit: 'chars' },
    comments: { posts: true, publicReply: true, like: true, privateReply: { textMaxLength: 2000, urlButtonsMax: 1 } },
    templates: { required: 'outside_window', managedBy: 'provider_api' },
    buttons: { types: ['postback', 'url', 'call'], maxPerMessage: 3, titleMax: 20, payloadMaxBytes: 1000 },
    quickReplies: { max: 13, titleMax: 20 }, cards: gallery,
    media: { image: image(25e6), video: { maxBytes: 25e6, mime: ['video/mp4'] },
      audio: { maxBytes: 25e6, mime: ['audio/mpeg'] }, file: { maxBytes: 25e6, mime: ['application/pdf'] } },
    typing: { maxSeconds: 5 }, edit: false, delete: null, receipts: { delivered: true, read: true },
    window: { standardHours: 24, extended: { reason: 'ctd_ad', days: 7 }, humanAgentDays: 7, outside: 'utility_or_marketing' },
    inbound: { message: true, comment: true, storyReply: false, referral: false, emailOpenClick: false },
    commentReply: { maxAgeDays: 7, maxMessages: 1 }, identity: { key: 'psid', phoneGuaranteed: false },
    verified: { textMax: false, mediaSize: false, maxButtons: true, payloadMaxBytes: true, buttonTitleMax: true, typingDuration: false, edit: false } },
  whatsapp: { ...base, type: 'whatsapp', templateCarousel: { min: 2, max: 10, marketingOnly: true },
    templates: { required: 'outside_window', managedBy: 'provider_api' },
    buttons: { types: ['postback', 'url'], maxPerMessage: 3, titleMax: 20, payloadMaxBytes: 256 },
    list: { maxRows: 10, maxSections: 10, rowTitleMax: 24, rowDescMax: 72 },
    media: { image: image(5e6), video: { maxBytes: 16e6, mime: ['video/mp4', 'video/3gpp'] },
      audio: { maxBytes: 16e6, mime: ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'] },
      file: { maxBytes: 100e6, mime: whatsappDocuments } },
    typing: { maxSeconds: 25 }, receipts: { delivered: true, read: true }, edit: false, delete: null,
    window: { standardHours: 24, outside: 'template' }, initiator: 'business_with_template',
    inbound: { message: true, comment: false, storyReply: false, referral: true, emailOpenClick: false },
    identity: { key: 'bsuid', phoneGuaranteed: false },
    verified: { textMax: true, maxButtons: true, buttonTitleMax: true, payloadMaxBytes: true, mediaSize: true, window: true, identity: true } },
  tiktok: { ...base, type: 'tiktok', text: { maxLength: 1000, unit: 'chars', linksClickable: false },
    buttons: { types: ['postback'], maxPerMessage: 3, titleMax: 20, payloadMaxBytes: 64 },
    media: { image: image(5e6) }, typing: null, edit: false, delete: null,
    window: { standardHours: 48, maxMessagesInWindow: 10, outside: 'nothing' },
    identity: { key: 'tiktok_id', phoneGuaranteed: false },
    verified: { window: true, video: false, maxButtons: false, textMax: false, broadcast: false, mediaSize: false } },
  email: { ...base, type: 'email', text: { maxLength: 100_000, unit: 'chars' },
    email: { subjectMaxLength: 998, preheader: true, html: true, unsubscribe: 'marketing' },
    buttons: { types: ['url'], maxPerMessage: 10, titleMax: 60, payloadMaxBytes: 0 },
    // delivered: Email Sending event cf.email.sending.message.delivered is consumed (email-channel/sending-events.ts). read: no such event.
    // emailOpenClick comes from our own pixel and link rewriting, not from Cloudflare (which has no open/click events).
    media: {}, typing: null, receipts: { delivered: true, read: false }, edit: false, delete: null,
    inbound: { message: true, comment: false, storyReply: false, referral: false, emailOpenClick: true },
    initiator: 'business_with_optin', identity: { key: 'email', phoneGuaranteed: false },
    verified: { textMax: false, inboundEmail: true, attachments: false, buttonsMax: false, mediaSize: true, subjectMaxLength: true } },
}
export function capabilities(type: ChannelType): ChannelProfile { return structuredClone(profiles[type]) }
