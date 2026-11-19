import type { IntegrationEnv } from '../../integrations'
import type { Run } from '../../flow/types'
import type { CommentContext } from '../../flow/comment-dispatch'
import type { SendResult } from '../types'
import { connectionRuntime } from './runtime'
import { sendVia } from './delivery'
import { stableId } from '../../flow/types'

/** Separate comment transport; it never grants consent or bypasses the ordinary DM guard. */
export async function deliverCommentOpening(env: IntegrationEnv, run: Run, index: number, blocks: { kind: string; text?: string; label?: string; id?: string; action?: { type: string; url?: string } }[],
  options: { nodeId?: string; button?: { type: 'url'; url: string } | { type: 'postback'; id: string } } = {}): Promise<SendResult> {
  const context = JSON.parse(run.comment_context!) as CommentContext
  const rt = await connectionRuntime(env, run.workspace_id, run.channel_id, { requireConnected: true })
  if (rt.connection.status !== 'connected') return { ok: false, reason: 'rejected', code: 'connection_not_ready', detail: 'Confirme o webhook da conexão antes de responder.' }
  const api = rt.provider?.comments, caps = rt.connection.profile.comments
  if (!api || !caps?.privateReply || !rt.connection.profile.commentReply) return { ok: false, reason: 'unsupported', detail: 'Connection cannot reply to comments' }
  if (context.createdAt + rt.connection.profile.commentReply.maxAgeDays * 86400000 <= Date.now()) return { ok: false, reason: 'comment_too_old' }
  const texts = blocks.filter(b => b.kind === 'text'), buttons = blocks.filter(b => b.kind === 'button')
  // Um texto e no máximo um botão, de link (url) ou de toque (go_to_node, que vira postback): ver a fonte em instagram-graph.ts, replyPrivate.
  if (texts.length !== 1 || !texts[0].text?.trim() || buttons.length > caps.privateReply.urlButtonsMax || buttons.some(b => b.action?.type !== 'url' && b.action?.type !== 'go_to_node') || blocks.length !== texts.length + buttons.length) return { ok: false, reason: 'unsupported', detail: 'Private reply requires one text and at most one button (link or tap)' }
  const openingText = texts[0].text!, openingButton = buttons[0]
  const asLink = openingButton?.action?.type === 'url'
  const tap = options.button?.type === 'postback' ? options.button : undefined
  if (new TextEncoder().encode(openingText).length > Math.min(caps.privateReply.textMaxLength, openingButton ? 640 : 1000)
    || openingButton && (!openingButton.label?.trim() || [...openingButton.label].length > rt.connection.profile.buttons.titleMax
      || (asLink ? !/^https?:\/\/[^\s]+$/.test(options.button?.type === 'url' ? options.button.url : openingButton.action?.url ?? '') : !tap))) return { ok: false, reason: 'unsupported', detail: 'Private reply exceeds the connection limits' }
  const guard = async (kind?: 'private' | 'public' | 'like'): Promise<SendResult | undefined> => {
    const state = await env.DB.prepare('SELECT status,automation_paused_until FROM contacts WHERE workspace_id=? AND id=?').bind(run.workspace_id, run.contact_id).first<{ status: string; automation_paused_until: number | null }>()
    if (state?.status !== 'subscribed') return { ok: false, reason: 'not_opted_in' }
    if ((state.automation_paused_until ?? 0) > Date.now()) return { ok: false, reason: 'blocked' }
    // Quem nasceu do comentário ainda não tem opt-in (opted_in=0) e pode receber a primeira resposta privada.
    // Quem pediu para sair (STOP, ação de fluxo, descadastro) tem a marca opted_out_at, gravada por todo caminho que retira o opt-in e limpa quando ele volta: não recebe a resposta privada.
    // A resposta pública e a curtida seguem, porque não são mensagens para a pessoa.
    if (kind === 'private' && await env.DB.prepare('SELECT 1 FROM contact_channels WHERE workspace_id=? AND channel_id=? AND contact_id=? AND external_user_id=? AND opted_out_at IS NOT NULL')
      .bind(run.workspace_id, run.channel_id, run.contact_id, run.external_user_id).first()) return { ok: false, reason: 'not_opted_in' }
  }
  const denied = await guard()
  if (denied) return denied
  const providerCtx = { connection: rt.connection, credentials: await rt.credentials(), fetch: rt.fetch, env }
  const effect = async (kind: 'private' | 'public' | 'like', transport: () => Promise<SendResult>): Promise<SendResult> => {
    const refused = await guard(kind)
    if (refused) return refused
    const key = [run.workspace_id, run.channel_id, context.commentId, kind]
    await env.DB.prepare("INSERT INTO comment_effects(workspace_id,channel_id,comment_id,effect,run_id) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING").bind(...key, run.id).run()
    const row = await env.DB.prepare('SELECT status,run_id,external_id FROM comment_effects WHERE workspace_id=? AND channel_id=? AND comment_id=? AND effect=?').bind(...key).first<{ status: string; run_id: string; external_id: string | null }>()
    if (row?.run_id !== run.id) return { ok: false, reason: 'comment_reply_used' }
    if (row.status === 'sent') return { ok: true, externalId: row.external_id!, parts: 1 }
    const claim = await env.DB.prepare("UPDATE comment_effects SET status='sending' WHERE workspace_id=? AND channel_id=? AND comment_id=? AND effect=? AND status='ready' RETURNING run_id").bind(...key).first()
    if (!claim) return { ok: false, reason: 'uncertain', detail: 'Comment reply outcome uncertain' }
    const stopped = await guard(kind)
    if (stopped) {
      await env.DB.prepare("UPDATE comment_effects SET status='ready' WHERE workspace_id=? AND channel_id=? AND comment_id=? AND effect=? AND status='sending'").bind(...key).run()
      return stopped
    }
    let result: SendResult
    try { result = await transport() } catch { result = { ok: false, reason: 'uncertain', detail: 'Comment reply outcome uncertain' } }
    await env.DB.prepare('UPDATE comment_effects SET status=?,external_id=? WHERE workspace_id=? AND channel_id=? AND comment_id=? AND effect=?').bind(result.ok ? 'sent' : result.reason === 'rate_limited' ? 'ready' : 'uncertain', result.ok ? result.externalId : null, ...key).run()
    return result
  }
  // Resposta pública e curtida são extras: se a Meta recusar uma delas (ex.: falta instagram_manage_engagement na curtida), a resposta privada segue.
  // Só a taxa (o passo tenta de novo) e o consentimento (opt-out, pausa) interrompem.
  const extra = async (action: 'public' | 'like', transport: () => Promise<SendResult>): Promise<SendResult | undefined> => {
    const result = await effect(action, transport)
    if (result.ok) return undefined
    if (result.reason === 'rate_limited' || result.reason === 'not_opted_in' || result.reason === 'blocked') return result
    console.warn(JSON.stringify({ event: 'comment_extra_failed', action, reason: result.reason, ...(result.reason === 'rejected' ? { code: result.code, meta: result.meta } : {}) }))
    return undefined
  }
  if (context.publicReply) {
    const stop = await extra('public', () => api.replyPublic(providerCtx, { commentId: context.commentId, text: context.publicReply! }))
    if (stop) return stop
  }
  if (context.like && rt.connection.profile.comments?.like) {
    const stop = await extra('like', () => api.like(providerCtx, { commentId: context.commentId }))
    if (stop) return stop
  }
  const text = texts[0].text!, button = buttons[0]
  const sent = await sendVia(env, { run, runId: run.id, step: index, part: 0, channelId: run.channel_id, externalUserId: run.external_user_id, mode: { ok: true, mode: 'comment_reply' } }, rt.connection.kind, text,
    button ? [{ id: button.id!, title: button.label! }] : [], () => effect('private', () => api.replyPrivate(providerCtx, { commentId: context.commentId, text, ...(button ? { button: asLink ? { title: button.label!, url: options.button?.type === 'url' ? options.button.url : button.action!.url! } : { title: button.label!, id: tap!.id } } : {}) })))
  // O read do Instagram chega com o mid e só acha a mensagem pelo passo que a enviou: sem esta marca ele ficava para sempre pendente.
  if (sent.ok && options.nodeId) await env.DB.prepare(`UPDATE messages SET content=json_set(content,'$.instagram',coalesce(json_extract(content,'$.instagram'),json(?))) WHERE workspace_id=? AND id=?`)
    .bind(JSON.stringify({ runId: run.id, nodeId: options.nodeId }), run.workspace_id, `out-${await stableId(run.id, String(index), '0')}`).run()
  return sent
}
