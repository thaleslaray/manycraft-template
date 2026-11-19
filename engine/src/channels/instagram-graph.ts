import { cardTemplate, fitCards, nativeCards } from './card-template'
import { z } from 'zod'
import { adOriginOf } from './ad-origin'
import type { CommentPostsPage, Connection, ConnectContext, Credentials, InboundEventV2, Party, PermissionItem, ConnectStep, ProfilePatch, ProviderAdapter, ProviderId, ProviderCtx, RawWebhook, SendTarget, WebhookVerdict } from './contract'
import { digest, verifyMetaWebhook } from './core/webhook-http'
import { fitMessage } from './fit'
import { mediaError } from '../schemas/message-media'
import { configureMetaSurface, metaSurfaceProfile } from './meta-surfaces'
import { metaRefusalNotice, metaRefusalStatus, parseMetaError, ProviderRefusal } from './core/meta-error'
import type { MetaErrorInfo, OutboundMessage, SendResult } from './types'

// Transporte do Instagram (login unificado); o provedor só dá o host, a conferência da conta, as permissões e os textos. Sem login pela Meta: a conexão usa só o token colado.
export const INSTAGRAM_GRAPH_VERSION = 'v26.0'
export const igsid = z.string().regex(/^\d{1,128}$/)
const id = z.string().min(1).max(512)
const callbackPayload = z.string().min(1).refine(value => new TextEncoder().encode(value).length <= 1000)
/** Link ig.me/<usuário>?ref=<ref> (Instagram Platform, ig.me, checked 2026-10-25): postback.referral, message.referral ou, em conversa que já existia, só referral. */
const referralSchema = z.object({ ref: z.string().min(1).max(2083).optional(), source: z.string().max(64).optional(), type: z.string().max(64).optional() }).passthrough()
const itemSchema = z.object({
  sender: z.object({ id: igsid }), recipient: z.object({ id: igsid }),
  timestamp: z.number().int().nonnegative(),
  referral: referralSchema.optional(),
  message: z.object({ mid: id, referral: referralSchema.optional(), text: z.string().max(65536).optional(), is_echo: z.boolean().optional(),
    is_self: z.boolean().optional(), quick_reply: z.object({ payload: callbackPayload }).optional(),
    reply_to: z.object({ story: z.object({ id: id.optional(), url: z.string().optional() }).optional() }).optional(),
    attachments: z.array(z.object({ type: z.string().max(64), payload: z.object({ url: z.string().max(4096).optional() }).passthrough().optional() }).passthrough()).max(20).optional() }).optional(),
  postback: z.object({ mid: id, payload: callbackPayload, referral: referralSchema.optional() }).optional(),
  read: z.object({ mid: id }).optional(),
})
/** A Meta agrupa até 1000 atualizações por notificação e repete a entrega por até 36 horas se ela falhar (docs-meta-instagram, webhooks/setup.md, 'Frequency'): recusar mais de 100 perderia eventos em pico. */
const MAX_DELIVERY_EVENTS = 1000
const envelope = z.object({ object: z.literal('instagram'), entry: z.array(z.object({ id,
  messaging: z.array(z.record(z.string(), z.unknown())).max(MAX_DELIVERY_EVENTS).optional(),
  // Conversa cujo dono é outro app (encaminhamento de conversas): mesmo formato de messaging (webhooks.md, campo standby).
  standby: z.array(z.record(z.string(), z.unknown())).max(MAX_DELIVERY_EVENTS).optional(),
  changes: z.array(z.object({ field: id, value: z.record(z.string(), z.unknown()) }).passthrough()).max(MAX_DELIVERY_EVENTS).optional(),
}).passthrough()).min(1).max(MAX_DELIVERY_EVENTS) })
const unsupported = (detail: string) => ({ ok: false as const, reason: 'unsupported' as const, detail })
const rejected = (code: string, meta?: MetaErrorInfo): SendResult => ({ ok: false, reason: 'rejected', code, detail: 'Instagram rejected send; check channel configuration', ...(meta ? { meta } : {}) })
/** Corpo `error` da Meta -> código, subcódigo e mensagem (parseMetaError, já sem token); também vai ao log estruturado. */
function metaError(error: Record<string, unknown>, action: string): MetaErrorInfo {
  const meta = parseMetaError({ error }) ?? {}
  console.warn(JSON.stringify({ event: 'instagram_send_rejected', action, ...meta }))
  return meta
}
const bytes = (text: string) => new TextEncoder().encode(text).length
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Queue key of one messaging item: a read names the message it saw, a postback is told apart from its message. */
function keyOf(item: Record<string, unknown>): string | undefined {
  const seen = record(item.read)?.mid
  if (typeof seen === 'string') return `read:${seen}`
  const mid = record(item.message)?.mid ?? record(item.postback)?.mid
  const referral = record(item.referral)
  if (typeof mid !== 'string' && typeof referral?.ref === 'string') return `referral:${record(item.sender)?.id}:${item.timestamp}:${referral.ref}`
  return typeof mid === 'string' ? `${item.postback ? 'postback:' : ''}${mid}` : undefined
}
const isOwn = (item: Record<string, unknown>) => record(item.message)?.is_echo === true || record(item.message)?.is_self === true

/** The messaging items of a delivery with the account each belongs to. A recipient that is not the entry's account is refused. */
function messagingOf(body: unknown): { externalId: string; item: Record<string, unknown>; standby?: boolean }[] {
  const out: { externalId: string; item: Record<string, unknown>; standby?: boolean }[] = []
  for (const entry of envelope.parse(body).entry) for (const [item, standby] of [...(entry.messaging ?? []).map(i => [i, false] as const), ...(entry.standby ?? []).map(i => [i, true] as const)]) {
    const recipient = record(item.recipient)?.id
    if (!isOwn(item) && recipient !== undefined && recipient !== entry.id) throw new SyntaxError('Instagram recipient mismatch')
    out.push({ externalId: entry.id, item, ...(standby ? { standby } : {}) })
  }
  return out
}

type Item = { eventKey: string; externalId: string; payload: Record<string, unknown>; standbySender?: string }
/** Every messaging item and field change of a delivery, one entry per event, tagged with the account it belongs to. */
async function itemsOf(body: unknown): Promise<Item[]> {
  const items: Item[] = []
  for (const { externalId, item, standby } of messagingOf(body)) {
    const from = record(item.sender)?.id
    const standbySender = standby && !isOwn(item) && typeof from === 'string' && igsid.safeParse(from).success ? from : undefined
    items.push({ eventKey: keyOf(item) ?? await digest(JSON.stringify(item)), externalId, payload: item, ...(standbySender ? { standbySender } : {}) })
  }
  for (const entry of envelope.parse(body).entry) for (const change of entry.changes ?? []) {
    const changeId = change.value.id ?? change.value.comment_id
    items.push({ eventKey: typeof changeId === 'string' ? ['comments', 'live_comments'].includes(change.field) ? `${change.field}:${changeId}` : `${change.field}:${changeId}:${await digest(JSON.stringify(change.value))}` : await digest(JSON.stringify(change)),
      externalId: entry.id, payload: { ...change, ...(entry.time !== undefined ? { timestamp: entry.time } : {}) } })
  }
  if (items.length > MAX_DELIVERY_EVENTS) throw new SyntaxError('Too many events in one delivery')
  return items
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value < 1e12 ? value * 1000 : value
  if (typeof value !== 'string') return undefined
  if (/^\d+(\.\d+)?$/.test(value)) return timestamp(Number(value))
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseComment(raw: Record<string, unknown>, accountId: string): InboundEventV2[] {
  const value = record(raw.value)
  const commentId = value?.id ?? value?.comment_id
  const live = raw.field === 'live_comments'
  const eventKey = typeof commentId === 'string' ? `${live ? 'live_comments' : 'comments'}:${commentId}` : undefined
  const ignored = (why: string): InboundEventV2[] => [{ kind: 'ignored', why, ...(eventKey ? { eventKey } : {}) }]
  if (!value || value.deleted === true || value.is_deleted === true || ['remove', 'delete'].includes(String(value.verb ?? value.action))) return ignored('Instagram deleted comment')
  const from = record(value.from), media = record(value.media)
  if (from?.id === accountId) return ignored('Instagram own comment')
  if (!id.safeParse(commentId).success || !igsid.safeParse(from?.id).success || !id.safeParse(media?.id).success || typeof value.text !== 'string') return ignored('Unsupported Instagram comment')
  return [{ kind: 'comment', eventKey: eventKey!, commentId: commentId as string, postId: media!.id as string, text: value.text,
    from: { externalUserId: from!.id as string, addressKind: 'igsid', ...(typeof from!.username === 'string' ? { profile: { username: from!.username } } : {}) },
    createdAt: timestamp(value.timestamp ?? value.created_time ?? raw.timestamp) ?? Date.now(), ...(live ? { live: true } : {}) }]
}

function parseItem(raw: unknown, accountId: string): InboundEventV2[] {
  if (['comments', 'live_comments'].includes(String(record(raw)?.field))) return parseComment(record(raw)!, accountId)
  // No login unificado a menção em comentário ou legenda é um campo próprio (webhooks/examples.md); a réplica ainda não a usa: fica reconhecida e contada.
  if (record(raw)?.field === 'mentions') return [{ kind: 'ignored', why: 'Instagram mention not handled' }]
  const item = itemSchema.safeParse(raw)
  const source = record(raw)
  if (!item.success || !source) return [{ kind: 'ignored', why: 'Unsupported Instagram event' }]
  const eventKey = keyOf(source)
  const ignored = (why: string): InboundEventV2[] => [{ kind: 'ignored', why, ...(eventKey === undefined ? {} : { eventKey }) }]
  const { sender, message, postback, read, timestamp } = item.data
  if (message?.is_echo || message?.is_self || sender.id === item.data.recipient.id || sender.id === accountId) return ignored('Instagram own message')
  if (read) return [{ kind: 'receipt', eventKey: `read:${read.mid}`, externalMessageId: read.mid, status: 'read', occurredAt: timestamp }]
  const common = { eventKey: eventKey!, from: { externalUserId: sender.id, addressKind: 'igsid' as const }, thread: { kind: 'direct' as const }, occurredAt: timestamp }
  const ref = postback?.referral?.ref ?? message?.referral?.ref ?? item.data.referral?.ref
  const referral: InboundEventV2[] = ref ? [{ kind: 'referral', eventKey: eventKey!, from: common.from, ref }] : []
  if (postback) return [{ kind: 'click', ...common, payload: postback.payload }, ...referral]
  if (!message && referral.length) return referral
  if (message?.quick_reply) return [{ kind: 'click', ...common, payload: message.quick_reply.payload }, ...referral]
  const mention = message?.attachments?.find(a => a.type === 'story_mention')
  if (message && mention) return [{ kind: 'story_mention', ...common, externalMessageId: message.mid, ...(mention.payload?.url ? { storyUrl: mention.payload.url } : {}) }]
  // Post ou reel compartilhado no direct (Share to DM): vira mensagem marcada como compartilhamento, com o link do conteúdo.
  // Tipos de anexo de compartilhamento na doc (webhooks/examples.md, seção `message`): `share` (post, legado: descontinuado em 01/02/2026), `ig_post` (o atual), `ig_reel`, `reel`, `story`, `ig_story` e `media`.
  const share = message?.attachments?.find(a => ['share', 'ig_post', 'ig_reel', 'reel', 'story', 'ig_story', 'media'].includes(a.type))
  if (message && share && message.text === undefined) return [{ kind: 'message', ...common, externalMessageId: message.mid, text: '', shared: { url: share.payload?.url ?? '' } }, ...referral]
  // Imagem, áudio, vídeo e arquivo sem texto: o time vê a mensagem na caixa de entrada e a janela abre, mas não dispara fluxo (não há palavras para responder).
  const attachment = message?.attachments?.[0]
  if (message && attachment && message.text === undefined) return [{ kind: 'message', ...common, externalMessageId: message.mid, unsupported: { type: attachment.type } }, ...referral]
  const adOrigin = adOriginOf(message?.referral ?? item.data.referral)
  if (message?.text !== undefined) return [{ kind: 'message', ...common, externalMessageId: message.mid, text: message.text, ...(adOrigin ? { origin: adOrigin } : {}),
    ...(message.reply_to?.story ? { storyReply: true, ...(message.reply_to.story.id ? { storyId: message.reply_to.story.id } : {}) } : {}) }, ...referral]
  return ignored('Unsupported Instagram event')
}

export interface InstagramGraphOptions {
  id: ProviderId
  /** Servidor da Graph para esta conexão (sem versão); `settings.apiBase` o substitui só em desenvolvimento. */
  host: string
  /** Confere a conta com o token colado; recebe a base já com a versão e a assinatura da conta no app. */
  connect: (ctx: ConnectContext, graph: { base: string; subscribeAccount: (account: string) => Promise<boolean> }) => Promise<ConnectStep>
  checkPermissions: (ctx: ConnectContext, step: ConnectStep, base: string) => Promise<PermissionItem[]>
  /** Assume a conversa que chegou em standby (outro app é o dono). */
  takeThreadControl?: (ctx: ProviderCtx, userId: string, base: string) => Promise<{ ok: boolean; code?: number | string }>
  /** Passos mostrados ao usuário no cadastro manual do webhook no painel da Meta. */
  webhookChecklist: string[]
  /** Assina o webhook do app sozinho, chamado depois que a conexão já está gravada (a Meta confere o callback na hora).
   * Sem ele, o webhook é só o passo manual. `reason` explica por que caiu no manual. */
  subscribeAppWebhook?: (ctx: ConnectContext, base: string) => Promise<{ ok: true } | { ok: false; reason: string }>
}

/** Provider de DM, comentários e stories do Instagram sobre a Graph API; cada login entrega só o que muda. */
export function makeInstagramGraphProvider(opts: InstagramGraphOptions): ProviderAdapter {
  /** Development can point a connection at a fake Graph API through settings.apiBase (the connections route only accepts it outside production). */
  const base = (connection?: Connection) => `${typeof connection?.settings.apiBase === 'string' ? connection.settings.apiBase : opts.host}/${INSTAGRAM_GRAPH_VERSION}`
  /** Tudo vai ao Graph do Instagram pela própria conta, com o token colado na conexão. */
  const api = (ctx: { connection: Connection; credentials: Credentials }) => base(ctx.connection)
  const sender = (ctx: { credentials: Credentials }) => ctx.credentials.accountId

  /** Shared result semantics for comment actions: an ambiguous network/5xx result must never be retried blindly. */
  async function commentAction(ctx: ProviderCtx, path: string, body: unknown, kind: 'public' | 'private' | 'like', commentId: string): Promise<SendResult> {
    let response: Response, raw: unknown
    try {
      response = await ctx.fetch(`${api(ctx)}/${path}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.credentials.accessToken}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
      raw = await response.json()
    } catch { return { ok: false, reason: 'uncertain', detail: 'Instagram comment outcome uncertain; reconcile before retry' } }
    const error = record(record(raw)?.error)
    if (response.status === 429 || typeof error?.code === 'number' && [4, 17, 32, 613, 80002].includes(error.code)) {
      const retry = Number(response.headers.get('Retry-After'))
      return { ok: false, reason: 'rate_limited', retryAfterSec: Number.isFinite(retry) && retry > 0 ? Math.min(retry, 86400) : 1 }
    }
    if (error && response.status < 500) {
      if (error.code === 10 && error.error_subcode === 2018278) return { ok: false, reason: 'outside_window', window: 'standard', expiredAt: Date.now(), canUseTemplate: false }
      return rejected(String(typeof error.code === 'number' ? error.code : 'comment_rejected'), metaError(error, `comment_${kind}`))
    }
    const data = record(raw)
    const externalId = kind === 'private' ? data?.message_id : kind === 'public' ? data?.id : data?.success === true ? commentId : undefined
    if (!response.ok || error || !id.safeParse(externalId).success) return { ok: false, reason: 'uncertain', detail: 'Instagram returned no valid comment confirmation' }
    return { ok: true, externalId: externalId as string, parts: 1 }
  }

  const buttonUrl = z.string().url().max(2048).regex(/^https?:\/\//i)
  const buttonTitle = z.string().min(1).refine(value => [...value].length <= 20)
  const privateReplySchema = z.object({ commentId: id, text: z.string().min(1), button: z.union([z.object({ title: buttonTitle, url: buttonUrl }).strict(), z.object({ title: buttonTitle, id: z.string().regex(/^b:[a-f0-9]{24}$/) }).strict()]).optional() }).strict()

  const listPosts = (ctx: ProviderCtx, query: { limit: number; after?: string }) => listMedia(ctx, query, 'media')
  const listStories = (ctx: ProviderCtx, query: { limit: number; after?: string }) => listMedia(ctx, query, 'stories')

  async function listMedia(ctx: ProviderCtx, query: { limit: number; after?: string }, edge: 'media' | 'stories'): Promise<CommentPostsPage> {
    if (edge === 'media' ? !ctx.connection.profile.comments?.posts : !ctx.connection.profile.stories?.list) throw new Error('Publicações não disponíveis nesta conexão.')
    const q = z.object({ limit: z.number().int().min(1).max(100), after: z.string().max(2048).optional() }).parse(query)
    const url = new URL(`${api(ctx)}/${encodeURIComponent(ctx.credentials.accountId)}/${edge}`)
    url.searchParams.set('fields', `id,caption,media_type,media_url,thumbnail_url,permalink,timestamp${edge === 'media' ? ',like_count,comments_count' : ''}`)
    url.searchParams.set('limit', String(q.limit))
    if (q.after) url.searchParams.set('after', q.after)
    const response = await ctx.fetch(url.toString(), { headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) {
      const meta = parseMetaError(await response.json().catch(() => null))
      if (meta) throw new ProviderRefusal(metaRefusalStatus(meta), metaRefusalNotice(edge === 'media' ? 'a lista de publicações' : 'a lista de stories', meta))
      throw new Error('Não foi possível listar as publicações.')
    }
    const page = z.object({ data: z.array(z.object({ id, caption: z.string().optional(), media_type: z.string().optional(), media_url: z.string().url().optional(),
      thumbnail_url: z.string().url().optional(), permalink: z.string().url().optional(), timestamp: z.string().optional(),
      like_count: z.number().int().nonnegative().optional(), comments_count: z.number().int().nonnegative().optional() })).max(1000),
      paging: z.object({ cursors: z.object({ after: z.string().max(2048).optional() }).optional(), next: z.string().optional() }).optional() }).parse(await response.json())
    return { posts: page.data.map(post => ({ id: post.id, ...(post.caption !== undefined ? { caption: post.caption } : {}), ...(post.media_type ? { mediaType: post.media_type } : {}),
      ...(post.media_url ? { mediaUrl: post.media_url } : {}), ...(post.thumbnail_url ? { thumbnailUrl: post.thumbnail_url } : {}), ...(post.permalink ? { permalink: post.permalink } : {}),
      ...(post.like_count !== undefined ? { likes: post.like_count } : {}), ...(post.comments_count !== undefined ? { comments: post.comments_count } : {}),
      ...(timestamp(post.timestamp) !== undefined ? { publishedAt: timestamp(post.timestamp)! } : {}) })),
      nextCursor: page.paging?.next ? page.paging.cursors?.after ?? null : null }
  }

  /** The heart on a message the contact sent. Never retried blindly: a network failure is reported as uncertain.
   * No login unificado (instagram_unified) o `sender_action: react` em graph.facebook.com/<IG_ID>/messages ainda não está confirmado: spec do login unificado, §7 (fatia 08, passo opcional). */
  async function react(ctx: ProviderCtx & { target: SendTarget }, input: { messageId: string; reaction: 'love' }): Promise<SendResult> {
    if (ctx.target.kind !== 'direct' || !igsid.safeParse(ctx.target.externalUserId).success) return unsupported('Reactions need a direct Instagram contact')
    if (!ctx.connection.profile.stories?.heart) return unsupported('Connection cannot react to stories')
    let response: Response, raw: unknown
    try {
      response = await ctx.fetch(`${api(ctx)}/${sender(ctx)}/messages`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.credentials.accessToken}` },
        body: JSON.stringify({ recipient: { id: ctx.target.externalUserId }, sender_action: 'react', payload: { message_id: input.messageId, reaction: input.reaction } }), signal: AbortSignal.timeout(20_000) })
      raw = await response.json()
    } catch { return { ok: false, reason: 'uncertain', detail: 'Instagram reaction outcome uncertain; reconcile before retry' } }
    const error = record(record(raw)?.error)
    if (response.status === 429 || typeof error?.code === 'number' && [4, 17, 32, 613, 80002].includes(error.code)) {
      const retry = Number(response.headers.get('Retry-After'))
      return { ok: false, reason: 'rate_limited', retryAfterSec: Number.isFinite(retry) && retry > 0 ? Math.min(retry, 86400) : 1 }
    }
    if (error && response.status < 500) return rejected(String(typeof error.code === 'number' ? error.code : 'reaction_rejected'), metaError(error, 'reaction'))
    if (!response.ok || error) return { ok: false, reason: 'uncertain', detail: 'Instagram returned no valid reaction confirmation' }
    return { ok: true, externalId: input.messageId, parts: 1 }
  }

  /** messaging-api.md: imagem vai em `attachments` ('Send Images': até dez; usamos a lista, a forma dos exemplos de coleção); áudio, vídeo e arquivo em `attachment`
   * ('Send audio, video or file', type audio|video|file). Em todos, payload.url. */
  const mediaBody = (part: Extract<OutboundMessage, { kind: 'media' }>) => {
    const attachment = { type: part.media, payload: { url: part.url } }
    return part.media === 'image' ? { attachments: [attachment] } : { attachment }
  }

  async function post(ctx: ProviderCtx, recipient: string, part: Extract<OutboundMessage, { kind: 'text' | 'cards' | 'media' }>): Promise<SendResult> {
    const message = part.kind === 'media' ? mediaBody(part) : part.kind === 'cards' ? cardTemplate(part) : part.buttons?.length ? { attachment: { type: 'template', payload: { template_type: 'button', text: part.text,
      buttons: part.buttons.map(b => b.type === 'postback' ? { type: 'postback', title: b.title, payload: b.id }
        : { type: 'web_url', title: b.title, url: b.type === 'url' ? b.url : '' }) } } }
      : { text: part.text, ...(part.quickReplies?.length ? { quick_replies: part.quickReplies.map(q => ({ content_type: 'text', title: q.title, payload: q.id })) } : {}) }
    let response: Response, raw: unknown
    try {
      response = await ctx.fetch(`${api(ctx)}/${sender(ctx)}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.credentials.accessToken}` },
        // As páginas de Instagram do espelho só dizem "adicione a tag Human Agent" (overview.md), sem o formato. Usamos o da Messenger Platform, que a Instagram Messaging herda:
        // messaging_type=MESSAGE_TAG junto de tag (docs-meta-messenger, messenger-platform/faq.md). Hoje instagram.ts só envia em modo 'free', então este caminho não roda em produção.
        body: JSON.stringify({ recipient: { id: recipient }, message, ...(ctx.intent === 'human' && ctx.humanAgent ? { messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' } : {}) }), signal: AbortSignal.timeout(20_000),
      })
      raw = await response.json()
    } catch { return { ok: false, reason: 'uncertain', detail: 'Instagram send outcome uncertain; reconcile before retry' } }
    const data = z.object({ message_id: id.optional(), recipient_id: igsid.optional(),
      error: z.object({ code: z.number(), error_subcode: z.number().optional() }).optional() }).safeParse(raw)
    const metaBody = record(record(raw)?.error)
    if (response.status === 429 || data.success && data.data.error && [4, 17, 32, 613, 80002].includes(data.data.error.code)) {
      const retry = Number(response.headers.get('Retry-After'))
      return { ok: false, reason: 'rate_limited', retryAfterSec: Number.isFinite(retry) && retry > 0 ? Math.min(retry, 86400) : 1 }
    }
    if (data.success && data.data.error && response.status < 500) {
      if (data.data.error.code === 10 && data.data.error.error_subcode === 2018278) {
        return { ok: false, reason: 'outside_window', window: 'standard', expiredAt: Date.now(), canUseTemplate: false }
      }
      if (data.data.error.code === 551 || data.data.error.error_subcode === 1545041) return { ok: false, reason: 'blocked' }
      return rejected(String(data.data.error.code), metaError(metaBody ?? data.data.error, 'message'))
    }
    if (!response.ok || !data.success || data.data.error || !data.data.message_id
      || data.data.recipient_id && data.data.recipient_id !== recipient) {
      return { ok: false, reason: 'uncertain', detail: 'Instagram returned no valid send confirmation' }
    }
    return { ok: true, externalId: data.data.message_id, parts: 1 }
  }

  /** Campos que o motor sabe ler. A lista de messaging_api.md escreve `messaging_referrals`/`messaging_reactions`, mas a tabela de campos (webhooks/fields.md) usa
   * `messaging_referral`/`message_reactions`; ficamos com a tabela de campos e sem reações/opt-ins, que o motor ainda não interpreta. */
  const MESSAGE_FIELDS = ['messages', 'messaging_postbacks', 'messaging_seen', 'messaging_referral']
  const COMMENT_FIELDS = ['comments', 'live_comments']

  /** Cada conta precisa ser assinada no app além do painel: POST /<IG_ID>/subscribed_apps com o token de Instagram User (webhooks/setup.md, 'Instagram credentials').
   * Sem login pela Meta: usa o token colado. Melhor esforço: comments/live_comments pedem Advanced Access, então, se a Meta recusar, tenta de novo só com as mensagens.
   * Uma falha aqui nunca derruba a conexão (o passo manual do painel continua valendo). */
  async function subscribeAccount(ctx: ConnectContext, account: string): Promise<boolean> {
    // standby: mensagem que chega quando outro app é o dono da conversa (webhooks.md, campos); sem ele a DM some calada.
    for (const fields of [[...MESSAGE_FIELDS, 'standby', ...COMMENT_FIELDS], MESSAGE_FIELDS]) {
      try {
        const url = new URL(`${base(ctx.connection)}/${encodeURIComponent(account)}/subscribed_apps`)
        url.searchParams.set('subscribed_fields', fields.join(','))
        const response = await ctx.fetch(url.toString(), { method: 'POST', headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` }, signal: AbortSignal.timeout(10_000) })
        if (response.ok && record(await response.json())?.success === true) return true
      } catch { /* tenta o conjunto menor; no fim, fica o passo manual */ }
    }
    return false
  }

  /** Instagram DMs. Meta configures webhooks per app, so registration is a guided manual step. */
  return {
    id: opts.id,
    kinds: ['instagram'],
    patch: { ...metaSurfaceProfile, cards: nativeCards, comments: { like: false } } as ProfilePatch,   // the instagram channel profile already is this API's
    credentialsSchema: z.record(z.string(), z.string()).refine(c => !!c.accessToken && igsid.safeParse(c.accountId).success, { message: 'accessToken and accountId are required' }),
    settingsSchema: z.record(z.string(), z.unknown()),
    // Iniciadores de conversa (messenger_profile) no instagram_unified: não documentados para o login unificado, pendentes de prova na fatia 08 (spec do login unificado, §7).
    configureSurface: (ctx, surface) => configureMetaSurface(ctx, surface, api(ctx), sender(ctx) ?? '', { platform: 'instagram' }),

    connect: ctx => opts.connect(ctx, { base: base(ctx.connection), subscribeAccount: account => subscribeAccount(ctx, account) }),
    checkPermissions: (ctx, step) => opts.checkPermissions(ctx, step, base(ctx.connection)),
    webhookChecklist: opts.webhookChecklist,
    ...(opts.subscribeAppWebhook ? { registersSharedWebhook: true } : {}),
    async registerWebhook(ctx: ConnectContext) {
      const auto = opts.subscribeAppWebhook ? await opts.subscribeAppWebhook(ctx, base(ctx.connection)) : undefined
      if (auto?.ok) return { registered: true as const }
      return { registered: false as const, manual: { kind: 'manual_webhook' as const, callbackUrl: ctx.hookUrl, verifyToken: ctx.webhookSecret, checklist: [...opts.webhookChecklist],
        ...(auto && !auto.ok ? { reason: auto.reason } : {}) } }
    },
    async verifyWebhook(raw: RawWebhook, secrets: { webhookSecret: string; credentials: Credentials }): Promise<WebhookVerdict> {
      return verifyMetaWebhook(raw, secrets)
    },
    splitDelivery: itemsOf,
    ...(opts.takeThreadControl ? { takeThreadControl: (ctx: ProviderCtx, userId: string) => opts.takeThreadControl!(ctx, userId, base(ctx.connection)) } : {}),
    /** A whole delivery (webhook body) or the single messaging/comment event the queue carries. */
    parseInbound(body: unknown, connection: Connection): InboundEventV2[] {
      const parsed = envelope.safeParse(body)
      if (!parsed.success) return parseItem(body, connection.externalId)
      return [...messagingOf(body).flatMap(({ item }) => parseItem(item, connection.externalId)),
        ...parsed.data.entry.filter(entry => entry.id === connection.externalId).flatMap(entry => (entry.changes ?? []).flatMap(change => parseItem({ ...change, timestamp: entry.time }, connection.externalId)))]
    },
    react,
    stories: { list: listStories },
    comments: {
      listPosts,
      async replyPublic(ctx, input) {
        if (!ctx.connection.profile.comments?.publicReply) return unsupported('Public comment replies are unavailable')
        if (!z.object({ commentId: id, text: z.string().min(1).max(2200) }).strict().safeParse(input).success) return unsupported('A public reply requires one comment and text')
        return commentAction(ctx, `${encodeURIComponent(input.commentId)}/replies`, { message: input.text }, 'public', input.commentId)
      },
      async like(ctx, input) {
        if (!ctx.connection.profile.comments?.like) return unsupported('Comment likes are unavailable')
        if (!id.safeParse(input.commentId).success) return unsupported('A comment identifier is required')
        // Desligado no perfil: /likes só existe no login com Facebook; aqui a Meta responde 400 code 100 subcode 33. Mantido para quando houver login com Facebook. Curtir comentário: POST /<IG_USER_ID>/likes com comment_id (docs-meta-instagram, changelog.md, 'Like Media and Comments API'). A doc exige a permissão instagram_manage_engagement.
        return commentAction(ctx, `${encodeURIComponent(sender(ctx))}/likes`, { comment_id: input.commentId }, 'like', input.commentId)
      },
      async replyPrivate(ctx, input) {
        const capability = ctx.connection.profile.comments?.privateReply
        if (!capability || !privateReplySchema.safeParse(input).success || bytes(input.text) > Math.min(capability.textMaxLength, input.button ? 640 : 1000)
          || input.button && capability.urlButtonsMax < 1) return unsupported('A private comment reply requires one text and at most one button (link or tap)')
        // Fonte do botão: instagram-platform/private-replies.md só mostra `message.text`, mas a página de private replies da Messenger (discovery/private-replies.md) diz que todos os
        // tipos da Send API valem e exemplifica o template de botão com postback em recipient post_id/comment_id; a Send API do Instagram (messaging-api.md) aceita web_url e postback.
        // Nenhuma página proíbe o botão de toque. O limite de 640 bytes com botão não é confirmado: se a Meta recusar, o motivo vai ao delivery_error.
        const button = input.button && (input.button.id !== undefined ? { type: 'postback', title: input.button.title, payload: input.button.id } : { type: 'web_url', title: input.button.title, url: input.button.url })
        const message = button ? { attachment: { type: 'template', payload: { template_type: 'button', text: input.text, buttons: [button] } } } : { text: input.text }
        return commentAction(ctx, `${encodeURIComponent(sender(ctx))}/messages`, { recipient: { comment_id: input.commentId }, message }, 'private', input.commentId)
      },
    },
    fit(message: OutboundMessage, profile) {
      if (message.kind === 'cards') return fitCards(message, profile)
      if (message.kind === 'media') {
        // Anexo não tem legenda nem botões (messaging-api.md): a mídia vai sozinha e legenda/botões seguem como mensagem de texto separada.
        const error = mediaError(message, [profile], false)
        if (error) return unsupported(error)
        const bare = { ...message, caption: undefined, buttons: undefined }
        if (!message.caption && !message.buttons?.length) return { messages: [bare], degraded: [] }
        if (!message.caption) return unsupported('Botões depois de uma mídia precisam de um texto')
        const text = fitMessage({ kind: 'text', text: message.caption, buttons: message.buttons }, { ...profile, text: { maxLength: message.buttons?.length ? 640 : 1000, unit: 'bytes' } })
        if ('ok' in text) return text
        return { messages: [bare, ...text.messages], degraded: text.degraded }
      }
      if (message.kind !== 'text') return unsupported('Instagram transport supports text, button templates and quick replies')
      if (message.buttons?.length && message.quickReplies?.length) return unsupported('Choose buttons or quick replies')
      const replies = message.quickReplies ?? []
      if (replies.length > 13 || replies.some(q => !q.title || [...q.title].length > 20 || !q.id || bytes(q.id) > 1000)) {
        return unsupported('Quick replies require at most 13 titles of 20 characters and payloads of 1000 bytes')
      }
      // The template also limits text to 640 characters; a 640-byte cap satisfies both limits.
      const fitted = fitMessage({ ...message, quickReplies: undefined }, {
        ...profile, text: { maxLength: message.buttons?.length ? 640 : 1000, unit: 'bytes' },
      })
      if ('ok' in fitted) return fitted
      if (replies.length) {
        const last = fitted.messages.at(-1)!
        if (last.kind === 'text') last.quickReplies = replies
      }
      return fitted
    },
    async send(ctx: ProviderCtx & { target: SendTarget }, part: OutboundMessage): Promise<SendResult> {
      if (ctx.target.kind !== 'direct') return unsupported('Instagram groups are not supported')
      if (part.kind === 'cards') { const fitted = fitCards(part, ctx.connection.profile); if ('ok' in fitted) return fitted }
      if (part.kind !== 'text' && part.kind !== 'cards' && part.kind !== 'media') return unsupported('Instagram transport supports text, media and cards')
      if (!igsid.safeParse(ctx.target.externalUserId).success) return rejected('invalid_recipient')
      return post(ctx, ctx.target.externalUserId, part)
    },
    /** Webhooks carry only the IGSID; name, username and photo come from the User Profile API. */
    async fetchProfile(ctx: ProviderCtx, who: Party) {
      if (!ctx.credentials.accessToken || !igsid.safeParse(who.externalUserId).success) return null
      try {
        const response = await ctx.fetch(`${api(ctx)}/${who.externalUserId}?fields=name,username,profile_pic,follower_count,is_user_follow_business,is_business_follow_user,is_verified_user`,
          { headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` }, signal: AbortSignal.timeout(10_000) })
        if (!response.ok) return null
        const profile = z.object({ name: z.string().max(200).optional(), username: z.string().max(100).optional(),
          profile_pic: z.string().url().max(2048).optional(), follower_count: z.number().int().nonnegative().optional(),
          is_user_follow_business: z.boolean().optional(), is_business_follow_user: z.boolean().optional(), is_verified_user: z.boolean().optional() }).parse(await response.json())
        const [first, ...rest] = (profile.name ?? '').trim().split(/\s+/)
        const channelFields = {
          ...(profile.is_user_follow_business !== undefined ? { follows_business: profile.is_user_follow_business } : {}),
          ...(profile.is_business_follow_user !== undefined ? { business_follows_contact: profile.is_business_follow_user } : {}),
          ...(profile.is_verified_user !== undefined ? { verified: profile.is_verified_user } : {}),
          ...(profile.follower_count !== undefined ? { follower_count: profile.follower_count } : {}),
        }
        const firstName = first || profile.username
        return { ...(firstName ? { firstName } : {}), ...(rest.length ? { lastName: rest.join(' ') } : {}),
          ...(profile.username ? { username: profile.username } : {}), ...(profile.profile_pic ? { avatar: { url: profile.profile_pic } } : {}),
          ...(Object.keys(channelFields).length ? { channelFields } : {}) }
      } catch { return null } // Profile is cosmetic; never block the inbound message on it.
    },
  }
}
