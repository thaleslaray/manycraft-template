import { inlineMemo, peekInline } from '../../flow/inline-timing'
import { HTTPException } from 'hono/http-exception'
import { marketingBlocked, prepareTemplateMessage, templateDisplayText } from '../../inbox/template-message'
import { humanReplyMode, latestReplyTarget } from './reply-policy'
import { humanPauseUntil } from '../../inbox/team'
import type { IntegrationEnv } from '../../integrations'
import { assertRunActive } from '../../flow/state'
import { stableId } from '../../flow/types'
import { ensureConversation, notifyTimeline, recordMessage, type Message } from '../../inbox/service'
import type { Connection, Credentials, ProviderAdapter, SendTarget } from '../contract'
import { recordGroupMessage } from './groups'
import { canSend, connectionRefusal } from '../policy'
import { failureNotice, noteConnectionFailure } from './failure'
import { providers } from '../providers'
import { connectionColumns, connectionFromRow, liteRow, type ConnectionRow } from './connection'
import { effectiveStateSql } from './connection-state'
import type { ChannelType, OutboundMessage, SendContext, SendResult } from '../types'
import { changeBlock } from './consent'

/** Shared durable claim, limiter and inbox recording. A transport must never retry an ambiguous send. */
export async function sendVia(env: IntegrationEnv, ctx: SendContext, type: ChannelType, text: string,
  buttons: { id: string; title: string }[], transport: () => Promise<SendResult>, preflight?: () => Promise<SendResult | void>, metadata: Pick<Message, 'email_subject'> = {},
  /** Checagem de antes da reserva (contato e conexão), lida em paralelo com as leituras iniciais; uma recusa sai antes de reservar. */
  beforeClaim?: () => Promise<SendResult | void>): Promise<SendResult> {
  const run = ctx.run, key = [ctx.runId, ctx.step, ctx.part]
  // Leituras independentes em paralelo (uma ida). An answer in a group is kept with the group; it never opens or fills a private conversation.
  // A reserva da parte (gravação, leitura e posse 'ready' → 'sending', numa transação) sai junto das leituras iniciais: uma ida a menos
  // antes do envio. Uma recusa ou um run cancelado devolve a posse a 'ready', como se a reserva não tivesse acontecido.
  const claiming = env.DB.batch([
    env.DB.prepare(`INSERT INTO flow_outbound (run_id,step_index,part,status) VALUES (?,?,?,'ready')
    ON CONFLICT DO NOTHING`).bind(...key),
    env.DB.prepare('SELECT status,external_message_id FROM flow_outbound WHERE run_id=? AND step_index=? AND part=?').bind(...key),
    env.DB.prepare(`UPDATE flow_outbound SET status='sending'
    WHERE run_id=? AND step_index=? AND part=? AND status='ready' RETURNING run_id`).bind(...key),
  ])
  claiming.catch(() => undefined)
  const release = () => env.DB.prepare("UPDATE flow_outbound SET status='ready' WHERE run_id=? AND step_index=? AND part=? AND status='sending'").bind(...key).run()
  // Recusa antes do envio: a reserva some, como se não tivesse acontecido (uma linha 'ready' sem id externo equivale a nenhuma linha).
  const releaseIfClaimed = async () => { try { if ((await claiming)[2]?.results.length) await env.DB.prepare("DELETE FROM flow_outbound WHERE run_id=? AND step_index=? AND part=? AND status='sending'").bind(...key).run() } catch { /* reserva falhou: nada a devolver */ } }
  let conversationId: string, refusedBefore: SendResult | void
  try {
    [, conversationId, refusedBefore] = await Promise.all([assertRunActive(env, ctx.runId, { fresh: true }),
      ctx.group ? '' : ensureConversation(env, run.workspace_id, run.contact_id, ctx.channelId), beforeClaim?.()])
  } catch (error) { await releaseIfClaimed(); throw error }
  if (refusedBefore) { await releaseIfClaimed(); return refusedBefore }
  const record = async (externalId: string | null, status: 'sent' | 'failed', notice?: string, checked = false) => {
    if (!checked) await assertRunActive(env, ctx.runId, { fresh: true })
    if (ctx.group) {
      return recordGroupMessage(env, { workspaceId: run.workspace_id, threadId: ctx.group.threadId, direction: 'out',
        externalMessageId: externalId ?? `failed:${ctx.runId}:${ctx.step}:${ctx.part}`, text, extra: { sender: 'automation', status, runId: ctx.runId } })
    }
    return recordMessage(env, {
      id: `out-${await stableId(ctx.runId, String(ctx.step), String(ctx.part))}`,
      workspaceId: run.workspace_id, conversationId, direction: 'out', sender: 'automation', text,
      ...metadata, ...(buttons.length ? { buttons } : {}), status, connectionId: ctx.channelId, deliveryStatus: status,
      ...(status === 'failed' ? { error: notice ?? 'O canal não confirmou o envio. Confira a conversa antes de reenviar.' } : {}),
      ...(externalId === null ? {} : { externalMessageId: `${type}:${ctx.channelId}:${ctx.externalUserId}:${externalId}` }),
    })
  }
  const [, claimRows, claimed] = await claiming
  const existing = claimRows?.results[0] as { status: string; external_message_id: string | number | null } | undefined
  if (existing?.status === 'sent' && existing.external_message_id !== null) {
    const externalId = String(existing.external_message_id)
    await record(externalId, 'sent')
    return { ok: true, externalId, parts: 1 }
  }
  if (existing?.status !== 'ready') return { ok: false, reason: 'uncertain', detail: 'Send outcome uncertain; reconcile before retry' }
  if (!claimed?.results.length) return { ok: false, reason: 'uncertain', detail: 'Send outcome uncertain; reconcile before retry' }
  if (env.CHANNEL_LIMITER) {
    const permit = await env.CHANNEL_LIMITER.getByName(ctx.channelId).acquire(ctx.group?.externalGroupId ?? ctx.externalUserId)
    // Sem vaga: nada foi à rede, a posse volta a 'ready' (a próxima tentativa reserva de novo).
    if (!permit.allowed) { await release(); return { ok: false, reason: 'rate_limited', retryAfterSec: permit.retryAfter } }
  }
  let result: SendResult
  // A refusal here happens before anything reaches the network: release the claim instead of leaving the part uncertain.
  // A checagem do run e a do contato/conexão são independentes: em paralelo (um run cancelado ainda lança antes do envio).
  // Sem checagem de antes do envio (a de antes da reserva acabou de rodar, na mesma ida da reserva), não se lê de novo.
  if (preflight) {
    const [, refused] = await Promise.all([assertRunActive(env, ctx.runId, { fresh: true }), preflight()])
    if (refused) {
      await release()
      return refused
    }
  }
  try { result = await transport() }
  catch { result = { ok: false, reason: 'uncertain', detail: 'Send outcome uncertain; reconcile before retry' } }
  if (result.ok) {
    // Saiu: confere o run (cancelado durante a chamada deixa a parte incerta), marca 'sent' e grava a mensagem do inbox sem conferir de novo.
    const sentId = result.externalId
    await assertRunActive(env, ctx.runId, { fresh: true })
    await env.DB.prepare("UPDATE flow_outbound SET status='sent',external_message_id=? WHERE run_id=? AND step_index=? AND part=?").bind(sentId, ...key).run()
    await record(sentId, 'sent', undefined, true)
    return result
  }
  await assertRunActive(env, ctx.runId, { fresh: true })
  if (!result.ok) {
    await env.DB.prepare('UPDATE flow_outbound SET status=? WHERE run_id=? AND step_index=? AND part=?')
      .bind(result.reason === 'rate_limited' ? 'ready' : 'uncertain', ...key).run()
    if (result.reason !== 'rate_limited') await record(null, 'failed', failureNotice(result))
    await noteConnectionFailure(env, run.workspace_id, ctx.channelId, result)
    // Recusa por bloqueio: o contato apagou a conversa ou bloqueou a conta nesse canal. No Telegram a hora vai truncada no segundo: o
    // my_chat_member (telegram-bot.ts) só traz o segundo, e um desbloqueio no mesmo segundo da recusa não pode perder para ela.
    const refusedAt = type === 'telegram' ? Math.floor(Date.now() / 1000) * 1000 : Date.now()
    if (result.reason === 'blocked' && !ctx.group) await changeBlock(env.DB, { blocked: true, at: refusedAt,
      where: { sql: 'workspace_id=? AND contact_id=? AND channel_id=?', binds: [run.workspace_id, run.contact_id, ctx.channelId] } }).run()
    return result
  }
  return result
}

/** The stored connection row (settings and capability override included); a bare row would lose both. */
export async function storedConnection(env: IntegrationEnv, kind: ChannelType, workspaceId: string, channelId: string,
  patch: Partial<ConnectionRow> = {}): Promise<Connection> {
  const row = await peekInline<ConnectionRow | null>(`chan:c:${workspaceId}:${channelId}`) ?? await inlineMemo(`chan:a:${workspaceId}:${channelId}`, () =>
    env.DB.prepare(`SELECT ${connectionColumns} FROM channels WHERE workspace_id=? AND id=?`).bind(workspaceId, channelId).first<ConnectionRow>())
  return connectionFromRow({ ...(row ?? liteRow(kind, channelId, workspaceId)), ...patch })
}

/** What delivery needs from a connection: its effective profile, a provider on the contract, and its credentials. */
export type DeliveryRuntime = { connection: Connection; provider: ProviderAdapter; credentials: () => Promise<Credentials> }
// Resolved per call: a captured reference would bypass anything that replaces the global (and the test doubles).
const networkFetch = ((input, init) => fetch(input, init)) as typeof fetch
const configured = async (rt: DeliveryRuntime) => {
  const credentials = await rt.credentials()
  return rt.provider.credentialsSchema.safeParse(credentials).success ? credentials : undefined
}

/** What the inbox shows for a sent part (templates are rendered from the stored model, see templateDisplayText).
 * Gallery: the carousel lead first, then one line per card. List: body, the open button, each section with its rows, and the footer. */
export function inboxText(part: Exclude<OutboundMessage, { kind: 'template' }>): string {
  if (part.kind === 'text') return part.text
  if (part.kind === 'media') return `[${part.media}] ${part.url}`
  if (part.kind === 'cards') {
    const cards = part.cards.map(c => [c.title, c.subtitle, c.actionUrl].filter(Boolean).join(' · ')).join('\n')
    return part.text?.trim() ? `${part.text}\n\n${cards}` : cards
  }
  if (part.kind === 'list') {
    const rows = part.sections.flatMap(s => [...(s.title ? [s.title] : []), ...s.rows.map(r => `• ${r.title}${r.description ? `: ${r.description}` : ''}`)])
    return [[part.header, part.text].filter(Boolean).join('\n'), [`[${part.buttonText}]`, ...rows].join('\n'), part.footer].filter(Boolean).join('\n\n')
  }
  return ''
}

export type DeliveryHooks = {
  /** Optional summary a provider records in the Inbox instead of its full transport body. */
  displayText?: (part: OutboundMessage) => string
  /** Provider-specific checks that need the database, after the shared context checks and before anything is claimed. */
  prepare?: () => Promise<SendResult | void>
  /** Re-checked for every part: right before the durable claim and again right before the network call. */
  guard?: (part: OutboundMessage) => Promise<SendResult | void>
  /** After a part was confirmed. */
  afterSend?: (sent: SendContext) => Promise<void>
}

/** Automation send: validates the context, fits the message to the effective profile, then sends each part under the durable claim. */
export async function deliverAutomation(env: IntegrationEnv, rt: DeliveryRuntime, ctx: SendContext, message: OutboundMessage,
  hooks: DeliveryHooks = {}): Promise<SendResult> {
  // A template is the one message the effective profile lets through an expired window (never past consent or blocking).
  const outsideWindow = (m: OutboundMessage, mode: SendContext['mode']) => m.kind === 'template' && !mode.ok && mode.reason === 'outside_window'
    && rt.connection.profile.templates?.required === 'outside_window'
  if (!ctx.mode.ok && !outsideWindow(message, ctx.mode)) return ctx.mode
  if (ctx.mode.ok && ctx.mode.mode !== 'free' && !rt.connection.profile.window) return { ok: false, reason: 'unsupported', detail: 'Provider only supports free messaging' }
  if (ctx.run.id !== ctx.runId || ctx.run.channel_id !== ctx.channelId || ctx.run.external_user_id !== ctx.externalUserId) {
    return { ok: false, reason: 'rejected', code: 'context_mismatch', detail: 'Send context does not match run' }
  }
  const credentials = await configured(rt)
  if (!credentials || ctx.channelId !== rt.connection.id) {
    return { ok: false, reason: 'rejected', code: 'channel_not_configured', detail: 'Channel not configured' }
  }
  const guard = async (part: OutboundMessage): Promise<SendResult | void> => {
    // Read live for every part: the connection can be refused or restricted, and the contact can block or leave, between two parts.
    // As três leituras (estado comum, marketing, checagem do provedor) são independentes: saem juntas; a ordem das recusas não muda.
    const marketingRead = ctx.group ? Promise.resolve(false) : marketingBlocked(env, ctx.run.workspace_id, ctx.channelId, ctx.externalUserId, part)
    const providerRead = hooks.guard?.(part)
    marketingRead.catch(() => undefined); providerRead?.catch(() => undefined)
    const state = await env.DB.prepare(`SELECT ${effectiveStateSql('ch')} AS connection_state,cc.opted_in,cc.window_expires_at,cc.human_window_expires_at,cc.last_inbound_at,cc.blocked_at,c.status
      FROM channels ch LEFT JOIN contact_channels cc ON cc.workspace_id=ch.workspace_id AND cc.channel_id=ch.id AND cc.contact_id=? AND cc.external_user_id=?
      LEFT JOIN contacts c ON c.workspace_id=cc.workspace_id AND c.id=cc.contact_id
      WHERE ch.workspace_id=? AND ch.id=?`)
      .bind(ctx.run.contact_id, ctx.externalUserId, ctx.run.workspace_id, ctx.channelId)
      .first<{ connection_state: string; opted_in: number | null; window_expires_at: number | null; human_window_expires_at: number | null
        last_inbound_at: number | null; blocked_at: number | null; status: string | null }>()
    const down = state ? connectionRefusal(state.connection_state, rt.connection.profile, state.last_inbound_at, Date.now(), !!ctx.group) : undefined
    if (down) return down
    if (!ctx.group && state && state.status !== null) {
      // Whoever blocked the account (or deleted the conversation) refuses everything, the opt-out confirmation included.
      if (state.blocked_at !== null) return { ok: false, reason: 'blocked' }
      if (state.status !== 'subscribed' || !state.opted_in && ctx.run.system_confirmation !== 'system_opt_out') {
        return { ok: false, reason: 'not_opted_in' }
      }
      // Confirmation may bypass consent only; the effective window still applies before every network call.
      if (!state.opted_in && ctx.run.system_confirmation === 'system_opt_out') {
        const mode = canSend(rt.connection.profile, { optedIn: true, windowExpiresAt: state.window_expires_at,
          humanWindowExpiresAt: state.human_window_expires_at }, Date.now(), 'automation')
        if (!mode.ok) return mode
      }
    }
    if (await marketingRead) return { ok: false, reason: 'rejected', code: '131050', detail: 'Contact stopped receiving marketing' }
    const refused = await providerRead
    if (refused && !refused.ok && refused.reason === 'not_opted_in' && ctx.run.system_confirmation === 'system_opt_out') return
    return refused
  }
  if (message.kind === 'typing') {
    // Cosmetic: the profile must declare it, and it is neither fitted nor recorded in the inbox.
    if (!rt.connection.profile.typing || !rt.provider.typing) return { ok: false, reason: 'unsupported', detail: 'Connection does not show a typing indicator' }
    const target: SendTarget = ctx.group ? { kind: 'group', externalGroupId: ctx.group.externalGroupId, mention: [ctx.externalUserId] } : { kind: 'direct', externalUserId: ctx.externalUserId }
    // WhatsApp attaches the indicator to the contact's latest message; the id is kept in the inbox as `<kind>:<channel>:<user>:<id>`.
    const prefix = `${rt.connection.kind}:${ctx.channelId}:${ctx.externalUserId}:`
    // The conversation is unique per contact identity, so the latest inbound message is found through inbox_history (conversation, newest first).
    const latest = rt.provider.typingNeedsReplyTo && !ctx.group
      ? await env.DB.prepare(`SELECT m.external_message_id FROM contact_channels cc
        JOIN conversations c ON c.workspace_id=cc.workspace_id AND c.contact_channel_id=cc.id
        JOIN messages m ON m.workspace_id=c.workspace_id AND m.conversation_id=c.id
        WHERE cc.workspace_id=? AND cc.contact_id=? AND cc.channel_id=? AND cc.external_user_id=?
        AND m.direction='in' AND substr(m.external_message_id,1,?)=?
        ORDER BY m.created_at DESC,m.id DESC LIMIT 1`)
        .bind(ctx.run.workspace_id, ctx.run.contact_id, ctx.channelId, ctx.externalUserId, prefix.length, prefix).first<{ external_message_id: string }>() : null
    return rt.provider.typing({ connection: rt.connection, credentials, fetch: networkFetch, env, intent: 'automation', target }, message.seconds,
      latest ? latest.external_message_id.slice(prefix.length) : undefined)
  }
  // A checagem do provedor (prepare) corre junto da primeira checagem de antes da reserva; uma recusa dela vem primeiro, como antes.
  const preparing = hooks.prepare ? hooks.prepare() : Promise.resolve()
  preparing.catch(() => undefined)
  const fitted = rt.provider.fit(message, rt.connection.profile)
  if ('ok' in fitted) return (await preparing) ?? fitted
  const target: SendTarget = ctx.group ? { kind: 'group', externalGroupId: ctx.group.externalGroupId, mention: [ctx.externalUserId] } : { kind: 'direct', externalUserId: ctx.externalUserId }
  let externalId = ''
  for (const [offset, part] of fitted.messages.entries()) {
    const text = hooks.displayText?.(part) ?? (part.kind === 'template' ? await templateDisplayText(env, ctx.run.workspace_id, ctx.channelId, part) : inboxText(part))
    // Quick replies are listed in the inbox as buttons on channels that have them; card reply buttons and list rows too, so a tap matches them.
    const listed = part.kind === 'text' ? [...part.buttons ?? [], ...(rt.connection.profile.quickReplies ? (part.quickReplies ?? []).map(q => ({ type: 'postback' as const, ...q })) : [])]
      : part.kind === 'cards' ? part.cards.flatMap(c => (c.buttons ?? []).filter(b => b.type === 'postback'))
      : part.kind === 'list' ? part.sections.flatMap(s => s.rows.map(r => ({ type: 'postback' as const, id: r.id, title: r.title }))) : []
    const buttons = listed.map(b => ({
      id: ctx.inboxButtons?.find(i => b.type === 'postback' ? i.payload === b.id : i.title === b.title)?.id ?? (b.type === 'postback' ? b.id : b.title), title: b.title,
    }))
    const current = { ...ctx, part: ctx.part + offset }
    // A checagem de antes da reserva roda junto das leituras iniciais de sendVia (uma recusa ainda sai antes de reservar a parte).
    const result = await sendVia(env, current, rt.connection.kind, text, buttons,
      () => rt.provider.send({ connection: rt.connection, credentials, fetch: networkFetch, env, intent: 'automation', target }, part),
      async () => guard(part), part.kind === 'text' && part.email ? { email_subject: part.email.subject } : {},
      offset === 0 ? async () => { const [denied, refused] = await Promise.all([preparing, guard(part)]); return denied ?? refused } : () => guard(part))
    if (!result.ok) return result
    externalId = result.externalId
    await hooks.afterSend?.(current)
  }
  // Sem parte nenhuma, a recusa do provedor ainda vale (como quando ela vinha antes do fit).
  if (!fitted.messages.length) { const denied = await preparing; if (denied) return denied }
  return { ok: true, externalId, parts: fitted.messages.length, ...(fitted.degraded.length ? { degraded: fitted.degraded } : {}) }
}

/** D7: the reply leaves through the connection the person wrote through last, even when the operator answers in the conversation of an older
 * one (the same person reached us through two connections of one channel). Without a newer connection the request stands as asked. */
async function viaLatestConnection<T extends { workspaceId: string; contactId: string; externalUserId: string }>(env: IntegrationEnv,
  rt: DeliveryRuntime | undefined, input: T): Promise<{ rt: DeliveryRuntime | undefined; input: T }> {
  if (!rt) return { rt, input }
  const latest = await latestReplyTarget(env, input.workspaceId, input.contactId, rt.connection.kind)
  if (!latest || latest.channel_id === rt.connection.id) return { rt, input }
  const { connectionRuntime } = await import('./runtime')   // loaded on demand: the runtime module imports the adapters, which import this one
  const other = await connectionRuntime(env, input.workspaceId, latest.channel_id, { requireConnected: true }).catch(() => undefined)
  if (!other?.provider) return { rt, input }
  return { rt: { connection: other.connection, provider: other.provider, credentials: other.credentials }, input: { ...input, externalUserId: latest.external_user_id } }
}

export type HumanDelivery =
  | { ok: false; reason: 'unavailable' }
  /** Janela de atendimento fechada: só modelo aprovado fala com o contato agora. */
  | { ok: false; reason: 'outside_window' }
  /** Modelo pedido para contato que não autorizou receber modelos. */
  | { ok: false; reason: 'not_opted_in' }
  | { ok: false; reason: 'rate_limited'; retryAfter: number }
  | { ok: false; reason: 'unsupported'; detail: string }
  | { ok: true; message: Message }

/** A file the operator attaches in the inbox: already stored (media_objects), so `url` is the public link providers fetch and `id` the inbox's own copy. */
export type HumanMedia = { id: string; media: 'image' | 'video' | 'audio' | 'file'; url: string; mime: string; size: number; name?: string; caption?: string }

/** Operator reply from the inbox. The message is stored as failed before the network call: if the call dies midway
 * the outcome is unknown and a human message is never resent automatically. */
export async function deliverHuman(env: IntegrationEnv, requested: DeliveryRuntime | undefined, asked: {
  workspaceId: string; conversationId: string; contactId: string; externalUserId: string; text: string; template?: { id: string; params: Record<string, string> }; media?: HumanMedia
}): Promise<HumanDelivery> {
  const { rt, input } = await viaLatestConnection(env, requested, asked)
  const credentials = rt && rt.connection.status === 'connected' ? await configured(rt) : undefined
  if (!rt || !credentials) return { ok: false, reason: 'unavailable' }
  const { connection } = rt
  // A channel with a conversation window only takes a human reply while that window (or the human-agent extension) is open.
  let humanAgent = false
  if (input.template && !connection.profile.templates) return { ok: false, reason: 'unavailable' }
  if (connection.profile.window || input.template) {
    const state = await env.DB.prepare(`SELECT opted_in,window_expires_at,human_window_expires_at,last_inbound_at FROM contact_channels
      WHERE workspace_id=? AND channel_id=? AND contact_id=? AND external_user_id=?`)
      .bind(input.workspaceId, connection.id, input.contactId, input.externalUserId)
      .first<{ opted_in: number; window_expires_at: number | null; human_window_expires_at: number | null; last_inbound_at: number | null }>()
    const { mode } = humanReplyMode(connection.profile, state ?? { opted_in: 0, window_expires_at: null, human_window_expires_at: null, last_inbound_at: null })
    const templateAllowed = input.template && !!state?.opted_in && (mode.ok || mode.reason === 'outside_window' && connection.profile.templates?.required === 'outside_window')
    // Motivo próprio para cada recusa que a pessoa resolve (modelo, opt-in), em vez do "canal indisponível".
    if (input.template && !templateAllowed) return { ok: false, reason: state?.opted_in ? 'outside_window' : 'not_opted_in' }
    if (!input.template && (!mode.ok || !['free', 'human_agent'].includes(mode.mode))) return { ok: false, reason: !mode.ok && mode.reason !== 'outside_window' ? 'unavailable' : 'outside_window' }
    humanAgent = !input.template && mode.ok && mode.mode === 'human_agent'
  }
  if (input.media && input.template) return { ok: false, reason: 'unavailable' }
  // Media goes through the same neutral message and provider fit the automations use: the effective profile decides type and size.
  const attachment = input.media
  const mediaMessage = attachment ? { kind: 'media' as const, media: attachment.media, url: attachment.url, mime: attachment.mime, size: attachment.size, ...(attachment.caption ? { caption: attachment.caption } : {}) } : undefined
  if (mediaMessage) {
    const fitted = rt.provider.fit(mediaMessage, connection.profile)
    if ('ok' in fitted) return { ok: false, reason: 'unsupported', detail: 'detail' in fitted ? fitted.detail : 'O canal não aceita este anexo.' }
  }
  const prepared = mediaMessage ? { message: mediaMessage, text: attachment!.caption ?? `[${({ image: 'Imagem', audio: 'Áudio', video: 'Vídeo', file: 'Arquivo' })[attachment!.media]}]${attachment!.name ? ` ${attachment!.name}` : ''}` }
    : input.template ? await prepareTemplateMessage(env, input.workspaceId, connection.id, input.template) : { message: { kind: 'text' as const, text: input.text }, text: input.text }
  if (await marketingBlocked(env, input.workspaceId, connection.id, input.externalUserId, prepared.message))
    throw new HTTPException(409, { message: 'Este contato pediu para não receber mensagens de marketing. Modelos de marketing não podem ser enviados a ele; modelos de utilidade e respostas dentro da janela continuam permitidos.' })
  const text = prepared.text
  const template = input.template ? { template: input.template } : {}
  const rich = attachment ? { media: { kind: attachment.media, status: 'stored' as const, id: attachment.id, mime: attachment.mime, size: attachment.size,
    ...(attachment.name ? { name: attachment.name } : {}), ...(attachment.caption ? { caption: attachment.caption } : {}) } } : {}
  if (env.CHANNEL_LIMITER) {
    const quota = await env.CHANNEL_LIMITER.getByName(connection.id).acquire(input.externalUserId)
    if (!quota.allowed) return { ok: false, reason: 'rate_limited', retryAfter: quota.retryAfter }
  }
  const messageId = crypto.randomUUID()
  const pending = 'Envio sem confirmação; verifique antes de reenviar.'
  await env.DB.batch([
    env.DB.prepare('UPDATE contacts SET automation_paused_until=? WHERE workspace_id=? AND id=?')
      .bind(await humanPauseUntil(env, input.workspaceId), input.workspaceId, input.contactId),
    env.DB.prepare('UPDATE conversations SET unread=0,unread_count=0 WHERE workspace_id=? AND id=?').bind(input.workspaceId, input.conversationId),
    env.DB.prepare(`INSERT INTO messages (id,workspace_id,conversation_id,direction,source,content,connection_id,delivery_status,delivery_error)
      VALUES (?,?,?,'out','human',?,?,'failed',?)`)
      .bind(messageId, input.workspaceId, input.conversationId, JSON.stringify({ sender: 'human', text, ...template, ...rich, status: 'failed', error: pending }), connection.id, pending),
  ])
  await notifyTimeline(env, input.workspaceId)
  let externalId: string | null = null, error: string | undefined = pending
  try {
    const result = await rt.provider.send({ connection, credentials, fetch: networkFetch, env, intent: 'human', ...(humanAgent ? { humanAgent: true } : {}), target: { kind: 'direct', externalUserId: input.externalUserId } },
      prepared.message)
    if (result.ok) { externalId = `${connection.kind}:${connection.id}:${input.externalUserId}:${result.externalId}`; error = undefined }
    else if (result.reason !== 'uncertain') {
      error = failureNotice(result) ?? `O ${providers[connection.provider].label} recusou o envio. Confira o canal antes de tentar novamente.`
      await noteConnectionFailure(env, input.workspaceId, connection.id, result)
    }
  } catch { /* Do not log fetch errors: their URL can contain the credential. */ }
  const status = externalId ? 'sent' : 'failed'
  await env.DB.prepare('UPDATE messages SET content=?,external_message_id=?,delivery_status=?,delivery_error=? WHERE workspace_id=? AND id=?')
    .bind(JSON.stringify({ sender: 'human', text, ...template, ...rich, status, ...(error ? { error } : {}) }), externalId, status, error ?? null, input.workspaceId, messageId).run()
  return { ok: true, message: await recordMessage(env, { id: messageId, workspaceId: input.workspaceId, conversationId: input.conversationId,
    direction: 'out', sender: 'human', text, ...template, ...(attachment ? { rich } : {}), status, error, connectionId: connection.id, deliveryStatus: status }) }
}

