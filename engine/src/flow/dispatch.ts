import { consumeMessageCallback } from './message-callback'
import { SHARE_TO_DM_WIDGET } from '../db/automations'
import { AD_WIDGETS } from '../channels/ad-origin'
import { planSurfaceClick } from './surface-dispatch'
import { systemWord } from './system-words'
import type { InboundEvent, IntegrationEnv } from '../integrations'
import { firstKeywordMatch, type KeyedKeyword } from './matcher'
import { planCommentRun } from './comment-dispatch'
import { planGroupRun } from './group-dispatch'
import { matchStoryReply, planStoryMention, storyReplyContext } from './story-dispatch'
import { stableId, object, type FlowEnv } from './types'
import { z } from 'zod'
import { ensureConversation, recordMessage, insertMessage, publishRecordedMessage, isAutomationPaused, notifyTimeline, setMessageReaction, settleMessageMedia } from '../inbox/service'
import { describeInbound, mapLink, pendingMedia, richContent } from '../inbox/inbound-content'
import { receiveMedia, type SettledMedia } from '../channels/core/inbound-media'
import type { QuestionAttachment } from '../schemas/question'
import type { InboundEvent as ChannelInboundEvent } from '../channels'
import { hasConsent, upsertContact } from '../channels/core/identity'
import { normalizeInbound, syncInbound } from '../channels/core/inbound'
import { sourceOf } from '../channels/core/queue'
import { connectionRuntime } from '../channels/core/runtime'
import { recordTriggerImpressions } from '../db/trigger-metrics'
import { consumeQuestionAnswer, deliverQuestionAnswer } from './questions'
import { carriesCodeInText, refTextOf } from '../channels/ref-link'
import { planRefRun, refByCode, refByText, refPayloadStatement } from './ref-dispatch'
import type { ListBlock } from '../schemas/message-list'
import { handleAlertStart } from '../channels/team-alert-chat'
import { activeRunStatusSql, clickableRunStatuses } from './run-state'
import { CONNECTION_RESTORED_EVENT } from './connection-wait'
import { EXECUTOR_LEASE_MS, claimExecutor, createWorkflow, releaseExecutor, startRunInline } from './inline'
import { deferInline, mark } from './inline-timing'

type Trigger = { id: string; automation_id: string; published_version_id: string; repeat_mode: string; config: string }

export async function ensureWorkflow(env: FlowEnv, runId: string): Promise<void> {
  const run = await env.DB.prepare('SELECT workflow_created_at,workspace_id,status FROM flow_runs WHERE id=?').bind(runId)
    .first<{ workflow_created_at: number | null; workspace_id: string; status: string }>()
  if (!run) throw new Error('Flow run missing')
  if (run.status === 'cancelled') return
  await notifyTimeline(env, run.workspace_id)
  if (run.workflow_created_at !== null) return
  // Posse atômica: o caminho rápido pode estar executando os primeiros passos em linha agora (o cron retoma se ele cair).
  if (!await claimExecutor(env, runId)) return
  try { await createWorkflow(env, runId) }
  catch (error) { await releaseExecutor(env, runId); throw error }
}

/** Any private interaction reopens the messaging window the connection's effective profile declares (none: nothing changes).
 * It also proves the contact reaches the account again: a block recorded before the interaction is lifted (an older one delivered late keeps it). */
async function reopenWindow(env: FlowEnv, event: InboundEvent, window: { standardHours: number; humanAgentDays?: number } | null | undefined, occurredAt: number | undefined, externalUserId: string) {
  await reopenWindowStatement(env, event, window, occurredAt, externalUserId).run()
}
function reopenWindowStatement(env: FlowEnv, event: InboundEvent, window: { standardHours: number; humanAgentDays?: number } | null | undefined, occurredAt: number | undefined, externalUserId: string) {
  const now = Math.min(occurredAt ?? event.receivedAt, event.receivedAt)
  return env.DB.prepare(`UPDATE contact_channels SET last_inbound_at=max(coalesce(last_inbound_at,0),?),
    window_expires_at=CASE WHEN ? IS NULL THEN window_expires_at ELSE max(coalesce(window_expires_at,0),?) END,
    human_window_expires_at=CASE WHEN ? IS NULL THEN human_window_expires_at ELSE max(coalesce(human_window_expires_at,0),?) END,
    blocked_at=CASE WHEN blocked_at<=? THEN NULL ELSE blocked_at END
    WHERE workspace_id=? AND channel_id=? AND external_user_id=?`)
    .bind(now, window ? 1 : null, window ? now + window.standardHours * 3600000 : null,
      window?.humanAgentDays ?? null, window?.humanAgentDays ? now + window.humanAgentDays * 86400000 : null, now,
      event.workspaceId, event.channelId, externalUserId)
}

export type DispatchOptions = { inline?: boolean }

export async function dispatchInbound(event: InboundEvent, inboundId: string, env: FlowEnv, options: DispatchOptions = {}): Promise<void> {
  const rt = await connectionRuntime(env, event.workspaceId, event.channelId, { requireConnected: true })
  const caps = rt.connection.profile
  if (sourceOf(rt.connection.kind) !== event.provider) throw new Error('Channel provider mismatch')
  mark('d.runtime')
  const normalized = await normalizeInbound(rt, event)
  await syncInbound(env, rt, event, normalized)
  mark('d.sync')
  const comment = normalized.find((e): e is Extract<ChannelInboundEvent, { kind: 'comment' }> => e.kind === 'comment')
  if (comment) {
    await planCommentRun(env, rt, event, inboundId, comment)
    return startRuns(env, event, inboundId, options)
  }
  const mention = normalized.find((e): e is Extract<ChannelInboundEvent, { kind: 'story_mention' }> => e.kind === 'story_mention')
  if (mention) {
    await reopenWindow(env, event, caps.window, mention.occurredAt, mention.externalUserId)
    await planStoryMention(env, rt, event, inboundId, mention)
    return startRuns(env, event, inboundId, options)
  }
  const click = normalized.find((e): e is Extract<ChannelInboundEvent, { kind: 'click' }> => e.kind === 'click')
  // O link m.me que abre a conversa pelo botão Começar traz o ref no próprio postback: a impressão conta e o clique segue.
  const referral = normalized.find(e => e.kind === 'referral') as { ref?: string } | undefined
  if (referral?.ref) await recordTriggerImpressions(env.DB, event.workspaceId, event.channelId, referral.ref, inboundId)
  // Link de referência (m.me/ig.me ?ref=): o ref escolhe a automação que começa quando o contato chega por ele.
  const refTrigger = referral?.ref ? await refByCode(env, event.workspaceId, event.channelId, referral.ref) : undefined
  if (click) {
    // A provider-normalized private click is an interaction even when its flow token expired.
    // The effective profile alone determines whether this connection has a messaging window.
    await reopenWindow(env, event, caps.window, click.occurredAt, click.externalUserId)
    // A resposta de uma pergunta em andamento ganha do link: só planeja a execução do link depois, para nunca deixar uma execução planejada sem partida.
    if (await questionCallback(event, inboundId, click, env)) return recordClick(env, event, inboundId, click)
    const refStarted = refTrigger ? await planRefRun(env, event, inboundId, refTrigger, click.externalUserId) : false
    if (click.payload.startsWith('s:') || click.payload.startsWith('usermenu:')) {
      await planSurfaceClick(env, rt, event, inboundId, click)
      await recordClick(env, event, inboundId, click)
      return startRuns(env, event, inboundId, options)
    }
    // The flow writes the label of the tap it accepts (a duplicate of that tap stays one message); stale, expired or foreign taps are recorded here.
    if (!await callback(event, inboundId, click, env)) await recordClick(env, event, inboundId, click)
    if (refStarted) await startRuns(env, event, inboundId, options)
    return
  }
  // Conversa que já existia: só o evento de referral chega (sem mensagem). Com mensagem junto (canais que misturam os dois), ela segue adiante.
  if (referral?.ref && !normalized.some(e => e.kind === 'message')) {
    const who = (referral as { externalUserId?: string }).externalUserId
    if (refTrigger && who && await planRefRun(env, event, inboundId, refTrigger, who)) await startRuns(env, event, inboundId, options)
    return
  }
  const reaction = normalized.find((e): e is Extract<ChannelInboundEvent, { kind: 'reaction' }> => e.kind === 'reaction')
  if (reaction) return recordReaction(env, rt.connection.kind, event, inboundId, reaction)
  const message = normalized.find((e): e is Extract<ChannelInboundEvent, { kind: 'message' }> => e.kind === 'message')
  if (!message || !caps.inbound.message) return
  // /start <código> do bot vincula o chat de aviso de um membro: não é mensagem de contato.
  if (await handleAlertStart(env, event.workspaceId, event.channelId, message.externalUserId, message.text).catch(() => false)) return
  const system = systemWord(message.text)
  // Leitura independente, em paralelo com a da resposta de pergunta (uma ida a menos em fila).
  const plannedRead = message.group ? undefined : env.DB.prepare('SELECT planned_at FROM inbound_events WHERE id=? AND workspace_id=?')
    .bind(inboundId, event.workspaceId).first<{ planned_at: number | null }>()
  plannedRead?.catch(() => undefined)
  if (!system && await deliverQuestionAnswer(env, inboundId)) return
  if (message.group) {
    await planGroupRun(env, rt, event, inboundId, message, message.group)
    return startRuns(env, event, inboundId, options)
  }
  mark('d.prechecks')
  const planned = await plannedRead!
  if (!planned) throw new Error('Inbound missing')
  mark('d.planned')
  let runIds: string[] | undefined
  const preclaimed = new Map<string, { workspaceId: string; at: number }>()
  if (planned.planned_at === null) {
    const now = Date.now()
    await upsertContact(env, rt, event, inboundId, message, now)
    mark('d.upsert_contact')
    // Janela e leitura do contato numa ida só (o lote roda em ordem: a leitura já vê a janela reaberta).
    const [, contactRows] = await env.DB.batch([
      reopenWindowStatement(env, event, caps.window, message.occurredAt, message.externalUserId),
      env.DB.prepare(`SELECT c.id,c.status,c.automation_paused_until,cc.first_inbound_id,cc.opted_in,cc.consent_changed_at
      FROM contacts c JOIN contact_channels cc ON cc.workspace_id=c.workspace_id AND cc.contact_id=c.id
      WHERE c.workspace_id=? AND cc.channel_id=? AND cc.external_user_id=?`)
        .bind(event.workspaceId, event.channelId, message.externalUserId),
    ])
    const contact = contactRows?.results[0] as { id: string; status: string; automation_paused_until: number | null; first_inbound_id: string | null; opted_in: number; consent_changed_at: number | null } | undefined
    if (!contact) throw new Error('Contact missing')
    mark('d.contact')
    // Gatilhos, palavras-chave e link por texto só leem configuração: começam já, em paralelo com a conversa, a gravação da mensagem
    // e as respostas pendentes. As que acabarem sem uso (sem consentimento, gatilho já escolhido) são descartadas.
    const subscribed = contact.status === 'subscribed'
    const quiet = <T,>(promise: Promise<T>) => { promise.catch(() => undefined); return promise }
    const triggerRead = subscribed ? quiet(env.DB.prepare(`SELECT t.*,CASE WHEN t.kind='external_trigger' THEN json_extract(t.config,'$.system_kind') ELSE t.kind END AS effective_kind,a.published_version_id FROM triggers t
        JOIN automations a ON a.workspace_id=t.workspace_id AND a.id=t.automation_id
        WHERE t.workspace_id=? AND (t.channel_id=? OR t.channel_id IS NULL) AND t.status='active'
        AND a.status='live' AND a.deleted_at IS NULL AND a.published_version_id IS NOT NULL
        AND t.audience='direct' AND (t.kind IN ('keyword','welcome_message','default_reply','cart_reply') OR (t.kind='widget' AND t.widget_type IN ('${SHARE_TO_DM_WIDGET}',${AD_WIDGETS.map(w => `'${w}'`).join(',')}) AND t.channel_id=?)
          OR (t.kind='external_trigger' AND t.channel_id=? AND json_extract(t.config,'$.system_kind') IN ('system_opt_in','system_opt_out'))) ORDER BY t.id`)
        .bind(event.workspaceId, event.channelId, event.channelId, event.channelId).all<Trigger & { effective_kind: string }>()) : undefined
    const keywordRead = subscribed && !system && message.text !== undefined ? quiet(env.DB.prepare(`SELECT k.*,t.created_at AS trigger_created_at FROM keywords k JOIN triggers t
          ON t.workspace_id=k.workspace_id AND t.id=k.trigger_id
          WHERE k.workspace_id=? AND (t.channel_id=? OR t.channel_id IS NULL) AND t.audience='direct' AND t.kind='keyword'
          AND t.status='active' AND k.status='live' ORDER BY k.priority,k.id`)
          .bind(event.workspaceId, event.channelId).all<KeyedKeyword>()) : undefined
    const refTextRead = subscribed && !system && !refTrigger && carriesCodeInText(rt.connection.kind) && message.text
      ? quiet(refByText(env, event.workspaceId, event.channelId, refTextOf(rt.connection.kind, message.text))) : undefined
    // Consentimento e pausa também entram nesta ida: até a decisão, só a resposta de pergunta e o callback poderiam mudar algo, e os dois
    // encerram o evento quando consomem a mensagem (o que chega à decisão não mudou consentimento nem pausa).
    const consentRead = quiet(Promise.all([hasConsent(env, event, message), !system && subscribed ? isAutomationPaused(env, event.workspaceId, contact.id) : false]))
    // Callback de mensagem pendente: a leitura evita a ida do DELETE quando não há nenhum (o caso comum).
    const callbackRead = !system && message.text ? quiet(env.DB.prepare('SELECT 1 FROM message_callbacks WHERE workspace_id=? AND contact_id=? AND channel_id=? AND expires_at>?')
      .bind(event.workspaceId, contact.id, event.channelId, now).first()) : undefined
    const conversationId = await ensureConversation(env, event.workspaceId, contact.id, event.channelId)
    mark('d.conversation')
    const messageId = `in-${await stableId(inboundId)}`
    // The message is in the inbox before its file is: a file that takes retries (or never arrives) never hides what the contact wrote.
    const inboundMessage = {
      id: messageId, workspaceId: event.workspaceId, conversationId,
      direction: 'in' as const, sender: 'contact' as const, text: describeInbound(message), status: 'delivered' as const,
      externalMessageId: `${rt.connection.kind}:${event.channelId}:${message.externalUserId}:${message.externalMessageId}`,
      connectionId: event.channelId, rich: { ...richContent(message), ...(message.media ? { media: pendingMedia(message.media, message.text) } : {}) },
    }
    await insertMessage(env, inboundMessage)
    // Atribuição, avisos, etiquetas e tempo real não decidem a resposta: no caminho rápido saem depois do primeiro envio (na fila, na hora).
    await deferInline(() => publishRecordedMessage(env, inboundMessage, messageId))
    // Throws (and so retries through the queue) while a download can still succeed; a settled failure is recorded and the flow goes on.
    mark('d.record_message')
    const file = message.media ? await receiveMedia(env, rt, event, inboundId, message.media) : undefined
    if (file) await settleMessageMedia(env, event.workspaceId, conversationId, messageId, file)
    // A type the channel could not open reaches the inbox so the team sees it, and nothing more: it carries no words to answer and starts no flow.
    if (message.unsupported) { await env.DB.prepare('UPDATE inbound_events SET planned_at=? WHERE id=? AND planned_at IS NULL').bind(now, inboundId).run(); return }
    if (!system && await consumeQuestionAnswer(env, event.workspaceId, event.channelId, contact.id, inboundId, message.text ?? '', undefined, questionAttachment(message, file),
      Math.min(message.occurredAt ?? event.receivedAt, event.receivedAt))) return
    if (!system && message.text && await callbackRead && await consumeMessageCallback(env, event.workspaceId, event.channelId, contact.id, message.text, now)) {
      await env.DB.prepare('UPDATE inbound_events SET planned_at=? WHERE id=? AND planned_at IS NULL').bind(now, inboundId).run(); return
    }
    mark('d.callbacks')
    const statements: D1PreparedStatement[] = []
    // Horário do evento no provedor (nunca depois do recebimento); sem ele, o do recebimento. Palavra mais velha que a última aplicada não muda nada.
    const consentAt = Math.min(message.occurredAt ?? event.receivedAt, event.receivedAt)
    if (system && contact.status !== 'deleted' && contact.consent_changed_at !== null && contact.consent_changed_at > consentAt) {
      await env.DB.prepare('UPDATE inbound_events SET planned_at=? WHERE id=? AND planned_at IS NULL').bind(now, inboundId).run(); return
    }
    if (system && contact.status !== 'deleted') {
      statements.push(env.DB.prepare(`UPDATE contact_channels SET opted_in=?,broadcast_opt_in=CASE WHEN ?=1 THEN 1 ELSE broadcast_opt_in END,consent_changed_at=?,opted_out_at=?
        WHERE workspace_id=? AND contact_id=? AND channel_id=? AND external_user_id=? AND (consent_changed_at IS NULL OR consent_changed_at<=?)`)
        .bind(system === 'system_opt_in' ? 1 : 0, system === 'system_opt_in' ? 1 : 0, consentAt, system === 'system_opt_in' ? null : consentAt, event.workspaceId, contact.id, event.channelId, message.externalUserId, consentAt))
      if (system === 'system_opt_out') {
        // Close collection and persist its wake-up receipt in the same plan as consent and confirmation.
        statements.push(env.DB.prepare(`INSERT INTO flow_question_answers(inbound_event_id,run_id,step_index,attempt,outcome)
          SELECT ?,q.run_id,q.step_index,q.attempts,'stopped' FROM flow_questions q JOIN flow_runs r ON r.id=q.run_id
          WHERE q.workspace_id=? AND q.contact_id=? AND q.channel_id=? AND q.status='open'
          AND r.reply_group_thread_id IS NULL AND r.status IN (${activeRunStatusSql}) ON CONFLICT DO NOTHING`)
          .bind(inboundId, event.workspaceId, contact.id, event.channelId))
        statements.push(env.DB.prepare(`UPDATE flow_questions SET status='stopped',attempts=attempts+1 WHERE status='open'
          AND EXISTS (SELECT 1 FROM flow_question_answers a WHERE a.inbound_event_id=?
            AND a.run_id=flow_questions.run_id AND a.step_index=flow_questions.step_index)`)
          .bind(inboundId))
        // Cancelling the durable row also stops pending input, buttons and delayed sends on wake/retry.
        statements.push(env.DB.prepare(`UPDATE flow_runs SET status='cancelled',wait_until=NULL,error=NULL,updated_at=?
          WHERE workspace_id=? AND contact_id=? AND channel_id=? AND reply_group_thread_id IS NULL
          AND inbound_event_id IS NOT ? AND status IN (${activeRunStatusSql})`)
          .bind(now, event.workspaceId, contact.id, event.channelId, inboundId))
      }
      statements.push(env.DB.prepare(`INSERT INTO messages(id,workspace_id,conversation_id,direction,source,content,connection_id)
        VALUES (?,?,?,'out','human',?,?) ON CONFLICT(id) DO NOTHING`)
        .bind(`system-consent-${await stableId(inboundId)}`, event.workspaceId, conversationId, JSON.stringify({ sender: 'system',
          text: system === 'system_opt_out' ? 'Inscrição cancelada nesta conexão.' : 'Inscrição retomada nesta conexão.', status: 'sent' }), event.channelId))
    }
    let trigger: Trigger | undefined
    const [consent, paused] = await consentRead
    if ((system || consent) && subscribed && (system || !paused)) {
      mark('d.consent')
      const rows = (await triggerRead)!
      mark('d.triggers')
      if (system) trigger = rows.results.find(t => t.effective_kind === system)
      // A reply to a story belongs to the story trigger that watches it; without one it is an ordinary message.
      // O link de referência vence a palavra-chave: o contato escolheu aquele caminho (canal só de texto: o código do link vem na mensagem).
      const refMatch = system ? undefined : refTrigger ?? await refTextRead
      if (!system) trigger = refMatch ?? await matchStoryReply(env, event.workspaceId, event.channelId, rt, message) as Trigger | undefined
      // Carrinho enviado pelo contato: vira o campo de sistema "último carrinho" e dispara o gatilho de carrinho da conexão.
      // Conversa aberta por anúncio: o gatilho de anúncio da conexão (todos os anúncios ou só os ids escolhidos) vence palavras-chave.
      if (!system && message.origin?.kind === 'ad') trigger ??= rows.results.find(t => {
        const w = (t as Trigger & { widget_type?: string }).widget_type
        if (!w || !AD_WIDGETS.includes(w)) return false
        const ids = (object(JSON.parse(t.config)).ad_ids ?? []) as string[]
        return !ids.length || ids.includes(message.origin!.sourceId ?? '')
      })
      // Compartilhamento de post/reel: dispara o gatilho Share to DM da conexão (uma vez por contato, pela frequência do gatilho).
      if (!system && message.shared) trigger ??= rows.results.find(t => (t as Trigger & { widget_type?: string }).widget_type === SHARE_TO_DM_WIDGET)
      if (!system && message.order) {
        statements.push(env.DB.prepare('UPDATE contacts SET last_cart=? WHERE workspace_id=? AND id=?').bind(JSON.stringify(message.order), event.workspaceId, contact.id))
        trigger ??= rows.results.find(t => t.effective_kind === 'cart_reply')
      }
      mark('d.ref_story')
      if (!system && !trigger && message.text !== undefined) {
        const keywords = (await keywordRead)!
        const match = firstKeywordMatch(keywords.results, new Set(rows.results.map(t => t.id)), message.text)
        trigger = rows.results.find(t => t.id === match?.trigger_id)
        mark('d.keywords')
      }
      trigger ??= !system && contact.first_inbound_id === inboundId ? rows.results.find(t => t.effective_kind === 'welcome_message') : undefined
      // Uma keyword reconhecida mantém a prioridade mesmo quando sua frequência barra o disparo.
      trigger ??= !system && !message.like ? rows.results.find(t => t.effective_kind === 'default_reply'
        && !(caps.inbound.storyReply && message.storyReply && object(JSON.parse(t.config)).dm_only === true)) : undefined
    }
    if (trigger) {
      if (trigger === refTrigger) { const payload = refPayloadStatement(env, event.workspaceId, contact.id, refTrigger); if (payload) statements.push(payload) }
      const dedupe = trigger.repeat_mode === 'once' ? 'once' : inboundId
      const runId = `flow-${await stableId(inboundId, trigger.id)}`
      const config = object(JSON.parse(trigger.config))
      const start = config.node_id === undefined ? null : z.string().min(1).parse(config.node_id)
      // opt_in_status do_not_send: a inscrição que nasceu nesta mensagem não vale para transmissões.
      if (config.opt_in_status === 'do_not_send') statements.push(env.DB.prepare(`UPDATE contact_channels SET broadcast_opt_in=0
        WHERE workspace_id=? AND contact_id=? AND channel_id=? AND initial_opt_in_event_id=?`).bind(event.workspaceId, contact.id, event.channelId, inboundId))
      // Selection + frozen version + plan marker commit atomically; retry never re-matches a new publication.
      statements.push(env.DB.prepare(`INSERT INTO trigger_firings
        (workspace_id,trigger_id,contact_id,external_event_id,dedupe_key,fired_at) SELECT ?,?,?,?,?,? FROM triggers t
        JOIN automations a ON a.workspace_id=t.workspace_id AND a.id=t.automation_id
        WHERE t.workspace_id=? AND t.id=? AND t.status='active' AND a.status='live' AND a.deleted_at IS NULL
        AND (?<>'once_per_24_hours' OR NOT EXISTS (SELECT 1 FROM trigger_firings
          WHERE workspace_id=? AND trigger_id=? AND contact_id=? AND fired_at>?))
        ON CONFLICT(trigger_id,contact_id,dedupe_key) DO NOTHING`)
        .bind(event.workspaceId, trigger.id, contact.id, inboundId, dedupe, now, event.workspaceId, trigger.id,
          trigger.repeat_mode, event.workspaceId, trigger.id, contact.id, now - 86400000))
      statements.push(env.DB.prepare(`INSERT INTO flow_runs
        (id,workspace_id,contact_id,automation_version_id,trigger_id,inbound_event_id,channel_id,start_node_id,system_confirmation,story_context,trigger_opt_in)
        SELECT ?,?,?,?,?,?,?,?,?,?,EXISTS(SELECT 1 FROM contact_channels cc WHERE cc.workspace_id=trigger_firings.workspace_id
          AND cc.contact_id=trigger_firings.contact_id AND cc.channel_id=? AND cc.initial_opt_in_event_id=? AND cc.opted_in=1) FROM trigger_firings WHERE workspace_id=? AND trigger_id=? AND contact_id=?
        AND dedupe_key=? AND external_event_id=? AND EXISTS (SELECT 1 FROM triggers t
          JOIN automations a ON a.workspace_id=t.workspace_id AND a.id=t.automation_id
          WHERE t.workspace_id=trigger_firings.workspace_id AND t.id=trigger_firings.trigger_id
          AND t.status='active' AND a.status='live' AND a.deleted_at IS NULL) ON CONFLICT(id) DO NOTHING`)
        .bind(runId, event.workspaceId, contact.id, trigger.published_version_id, trigger.id, inboundId, event.channelId,
          start, system ?? null, storyReplyContext(trigger as { widget_type?: string | null }, rt, message), event.channelId, inboundId, event.workspaceId, trigger.id, contact.id, dedupe, inboundId))
      // Follow-up do gatilho: agenda a outra automação para depois do prazo (só começa se o contato não escrever antes).
      const followUp = config.follow_up as { after_minutes?: unknown; automation_id?: unknown } | undefined
      if (followUp && typeof followUp.automation_id === 'string' && typeof followUp.after_minutes === 'number') statements.push(env.DB.prepare(`INSERT INTO trigger_follow_ups
        (id,workspace_id,trigger_id,contact_id,channel_id,automation_id,created_at,due_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM trigger_firings WHERE workspace_id=? AND trigger_id=? AND contact_id=? AND external_event_id=?) ON CONFLICT DO NOTHING`)
        .bind(`fu-${await stableId(inboundId, trigger.id)}`, event.workspaceId, trigger.id, contact.id, event.channelId, followUp.automation_id, now, now + followUp.after_minutes * 60_000, event.workspaceId, trigger.id, contact.id, inboundId))
    }
    statements.push(env.DB.prepare('UPDATE inbound_events SET planned_at=? WHERE id=? AND planned_at IS NULL').bind(now, inboundId))
    mark('d.plan_build')
    // O plano e a leitura das execuções deste evento na mesma ida (a leitura vem por último no lote e já vê o que o plano gravou).
    statements.push(runsOfEvent(env, event, inboundId))
    // Caminho rápido: a posse das execuções novas vem no mesmo lote (a mesma regra de claimExecutor), uma ida a menos antes do envio.
    const claimAt = Date.now()
    if (options.inline) statements.push(env.DB.prepare(`UPDATE flow_runs SET executor_claimed_at=? WHERE workspace_id=? AND inbound_event_id=? AND status<>'cancelled'
      AND workflow_created_at IS NULL AND (executor_claimed_at IS NULL OR executor_claimed_at<?) RETURNING id,workspace_id`).bind(claimAt, event.workspaceId, inboundId, claimAt - EXECUTOR_LEASE_MS))
    const results = await env.DB.batch(statements)
    const runRows = results.at(options.inline ? -2 : -1)!.results as { id: string }[]
    runIds = runRows.map(row => row.id)
    if (options.inline) for (const row of results.at(-1)!.results as { id: string; workspace_id: string }[]) preclaimed.set(row.id, { workspaceId: row.workspace_id, at: claimAt })
    mark('d.plan_batch')
  }
  if (system === 'system_opt_out') await deliverQuestionAnswer(env, inboundId)
  if (system) await notifyTimeline(env, event.workspaceId)
  await startRuns(env, event, inboundId, options, runIds, preclaimed)
}

const runsOfEvent = (env: FlowEnv, event: InboundEvent, inboundId: string) => env.DB.prepare('SELECT id FROM flow_runs WHERE workspace_id=? AND inbound_event_id=?')
  .bind(event.workspaceId, inboundId)

async function startRuns(env: FlowEnv, event: InboundEvent, inboundId: string, options: DispatchOptions = {}, known?: string[],
  preclaimed?: Map<string, { workspaceId: string; at: number }>): Promise<void> {
  const ids = known ?? (await runsOfEvent(env, event, inboundId).all<{ id: string }>()).results.map(row => row.id)
  mark('d.runs_select')
  // Caminho rápido: os primeiros passos rodam aqui mesmo; a fila (rede de segurança) cria o Workflow como sempre.
  for (const id of ids) await (options.inline ? startRunInline(env, id, event.receivedAt, preclaimed?.get(id)) : ensureWorkflow(env, id))
}

async function callback(event: InboundEvent, inboundId: string, query: Extract<ChannelInboundEvent, { kind: 'click' }>, env: FlowEnv): Promise<boolean> {
  if (!/^b:[a-f0-9]{24}$/.test(query.payload)) return false
  const token = await env.DB.prepare(`SELECT b.*,r.contact_id,r.current_node_id,r.status,r.wait_reason,r.channel_id,r.automation_version_id,cc.external_user_id,cc.contact_id,b.button_id
    FROM button_tokens b JOIN flow_runs r ON r.workspace_id=b.workspace_id AND r.id=b.run_id
    JOIN contact_channels cc ON cc.workspace_id=r.workspace_id AND cc.contact_id=r.contact_id AND cc.channel_id=r.channel_id
    WHERE b.workspace_id=? AND b.token=? AND r.channel_id=? AND cc.external_user_id=?`)
    .bind(event.workspaceId, query.payload.slice(2), event.channelId, query.externalUserId)
    .first<{ run_id: string; node_id: string; step_index: number; token: string; expires_at: number; current_node_id: string; status: string; wait_reason: string | null; contact_id: string; button_id: string; automation_version_id: string }>()
  if (!token) return false
  // Esperando a conexão no passo do botão (o lembrete das respostas rápidas não saiu): o toque vale e encerra a espera.
  // O prazo do botão pode vencer enquanto a conexão está fora do ar; o contato ainda vê a mensagem, então o toque vale mesmo vencido.
  const connectionWait = token.status === 'waiting_delay' && token.wait_reason === 'connection'
  if (token.expires_at <= Date.now() && !connectionWait || token.current_node_id !== token.node_id
    || !(clickableRunStatuses as readonly string[]).includes(token.status) && !connectionWait) {
    // Toque repetido no botão que já foi aceito (a execução já seguiu adiante): é o mesmo toque, não um clique novo sem texto.
    return !!await env.DB.prepare('SELECT 1 FROM flow_clicks WHERE run_id=? AND step_index=? AND token=?').bind(token.run_id, token.step_index, token.token).first()
  }
  // Winner per visit: a second button or update cannot resume the same visit twice.
  await env.DB.prepare(`INSERT INTO flow_clicks (run_id,step_index,token,inbound_event_id) VALUES (?,?,?,?)
    ON CONFLICT(run_id,step_index) DO NOTHING`).bind(token.run_id, token.step_index, token.token, inboundId).run()
  const receipt = await env.DB.prepare('SELECT * FROM flow_clicks WHERE run_id=? AND step_index=?')
    .bind(token.run_id, token.step_index).first<{ token: string; inbound_event_id: string; delivered_at: number | null }>()
  if (!receipt || receipt.inbound_event_id !== inboundId || receipt.delivered_at !== null) return true
  const version = await env.DB.prepare('SELECT graph FROM automation_versions WHERE workspace_id=? AND id=?')
    .bind(event.workspaceId, token.automation_version_id).first<{ graph: string }>()
  const graph = JSON.parse(version!.graph) as { nodes: { id: string; type?: string; config: { blocks?: ({ kind: string; id?: string; label?: string; sections?: ListBlock['sections'] })[] } }[] }
  const published = graph.nodes.find(n => n.id === token.node_id)
  // A tapped list row is a tap like any other: the title the contact saw is what the inbox shows.
  const label = published?.config.blocks?.find(b => (b.kind === 'button' || b.kind === 'quick_reply') && b.id === token.button_id)?.label
    ?? published?.config.blocks?.flatMap(b => b.kind === 'list' && b.sections ? b.sections.flatMap(section => section.rows) : []).find(r => r.id === token.button_id)?.title
  // Botões vindos do bloco dinâmico não estão no grafo publicado: o clique segue sem registrar o rótulo.
  const dynamic = published?.type === 'dynamic' || token.node_id.startsWith('dynamic-callback:')
  if (!label && !dynamic) throw new Error('Published button label missing')
  const conversationId = await ensureConversation(env, event.workspaceId, token.contact_id, event.channelId)
  if (label) await recordMessage(env, { id: `in-${await stableId(inboundId)}`, connectionId: event.channelId,
    workspaceId: event.workspaceId, conversationId, direction: 'in', sender: 'contact', text: label, status: 'delivered' })
  const instance = await env.FLOW_RUN.get(token.run_id)
  await instance.sendEvent({ type: `click_${token.step_index}`, payload: { token: receipt.token } })
  // O clique fica guardado para o waitForEvent do passo; o aviso acorda a espera da conexão, que confere o clique e não reenvia o lembrete.
  if (connectionWait) await instance.sendEvent({ type: CONNECTION_RESTORED_EVENT, payload: {} })
  await env.DB.prepare('UPDATE flow_clicks SET delivered_at=? WHERE run_id=? AND step_index=?')
    .bind(Date.now(), token.run_id, token.step_index).run()
  return true
}

/** Everything the contact tapped reaches the inbox, whether or not a flow was waiting for it. The handlers above
 * write the same deterministic ID with the published label first; this only fills the gap, so a retry never doubles it. */
async function recordClick(env: FlowEnv, event: InboundEvent, inboundId: string, click: Extract<ChannelInboundEvent, { kind: 'click' }>): Promise<void> {
  const contact = await env.DB.prepare(`SELECT c.id FROM contacts c JOIN contact_channels cc ON cc.workspace_id=c.workspace_id AND cc.contact_id=c.id
    WHERE c.workspace_id=? AND cc.channel_id=? AND cc.external_user_id=? AND c.status<>'deleted'`)
    .bind(event.workspaceId, event.channelId, click.externalUserId).first<{ id: string }>()
  if (!contact) return
  const conversationId = await ensureConversation(env, event.workspaceId, contact.id, event.channelId)
  await recordMessage(env, { id: `in-${await stableId(inboundId)}`, workspaceId: event.workspaceId, conversationId,
    direction: 'in', sender: 'contact', text: click.label ?? '[Clique sem texto]', status: 'delivered', connectionId: event.channelId })
}

/** The answer a photo, file or shared location gives to a question that asks for one: a link to the stored file, or to the place on a map. */
function questionAttachment(message: Extract<ChannelInboundEvent, { kind: 'message' }>, file: SettledMedia | undefined): QuestionAttachment | undefined {
  if (message.location) return { kind: 'location', value: mapLink(message.location) }
  if (!message.media || file?.status !== 'stored') return undefined
  // What a contact sent is private: the answer keeps the authenticated path (the team signs in to open it), never a public link to the stored file.
  return { kind: message.media.type === 'image' || message.media.type === 'sticker' ? 'image' : 'file', value: `/api/inbox/media/${file.id}` }
}

/** The contact reacted to a message: the reaction hangs on that message in the inbox. Without that message there, one line says what happened. */
async function recordReaction(env: FlowEnv, kind: string, event: InboundEvent, inboundId: string, reaction: Extract<ChannelInboundEvent, { kind: 'reaction' }>): Promise<void> {
  const contact = await env.DB.prepare(`SELECT c.id FROM contacts c JOIN contact_channels cc ON cc.workspace_id=c.workspace_id AND cc.contact_id=c.id
    WHERE c.workspace_id=? AND cc.channel_id=? AND cc.external_user_id=? AND c.status<>'deleted'`)
    .bind(event.workspaceId, event.channelId, reaction.externalUserId).first<{ id: string }>()
  if (!contact) return
  if (await setMessageReaction(env, event.workspaceId, event.channelId, `${kind}:${event.channelId}:${reaction.externalUserId}:${reaction.targetMessageId}`, reaction.emoji) || reaction.emoji === undefined) return
  const conversationId = await ensureConversation(env, event.workspaceId, contact.id, event.channelId)
  await recordMessage(env, { id: `in-${await stableId(inboundId)}`, workspaceId: event.workspaceId, conversationId, direction: 'in', sender: 'contact',
    text: `Reagiu com ${reaction.emoji} a uma mensagem que não está nesta conversa.`, status: 'delivered', connectionId: event.channelId })
}

export function hasFlow(env: IntegrationEnv): env is FlowEnv { return !!env.FLOW_RUN }

async function questionCallback(event: InboundEvent, inboundId: string, query: Extract<ChannelInboundEvent, { kind: 'click' }>, env: FlowEnv): Promise<boolean> {
  if (!/^q:[a-f0-9]{24}:(\d+|s)$/.test(query.payload)) return false
  if (await deliverQuestionAnswer(env, inboundId)) return true
  const [, token, choice] = query.payload.split(':')
  const row = await env.DB.prepare(`SELECT q.contact_id,q.config FROM flow_questions q JOIN contact_channels cc
    ON cc.workspace_id=q.workspace_id AND cc.contact_id=q.contact_id AND cc.channel_id=q.channel_id
    WHERE q.workspace_id=? AND q.channel_id=? AND q.token=? AND q.status='open' AND cc.external_user_id=?`)
    .bind(event.workspaceId, event.channelId, token, query.externalUserId).first<{ contact_id: string; config: string }>()
  if (!row) return true
  const config = JSON.parse(row.config) as { choices: string[]; skip: boolean; answer_type: string }
  const answer = choice === 's' ? config.skip ? 'Pular' : undefined
    : config.answer_type === 'multiple_choice' ? config.choices[Number(choice)] : undefined
  if (answer === undefined) return true
  const conversationId = await ensureConversation(env, event.workspaceId, row.contact_id, event.channelId)
  await recordMessage(env, { id: `in-${await stableId(inboundId)}`, workspaceId: event.workspaceId, conversationId,
    direction: 'in', sender: 'contact', text: answer, status: 'delivered', connectionId: event.channelId })
  await consumeQuestionAnswer(env, event.workspaceId, event.channelId, row.contact_id, inboundId, answer, token, undefined, Math.min(query.occurredAt ?? event.receivedAt, event.receivedAt))
  return true
}
