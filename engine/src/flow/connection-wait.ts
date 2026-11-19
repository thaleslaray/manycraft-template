import type { WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'
import type { ChannelCapabilities, SendResult } from '../channels/types'
import { ensureConversation, notifyTimeline, recordMessage } from '../inbox/service'
import { effectiveStateSql, INITIATING_STATES, stateInSql } from '../channels/core/connection-state'
import { capabilities } from '../channels/capabilities'
import type { ChannelKind, ProfilePatch, StoredProvider } from '../channels/contract'
import { effectiveProfile } from '../channels/core/profile-merge'
import { channelKinds } from '../channels/kinds'
import { connectionRefusal, restrictedWindowHours } from '../channels/policy'
import { moveRun } from './run-state'
import { assertRunActive } from './state'
import type { FlowEnv, Run } from './types'

/**
 * Prazo para a conexão voltar antes de a execução desistir. Sete dias: cobre um fim de semana inteiro sem ninguém olhar o painel e
 * a revisão de uma restrição da Meta (que costuma levar dias), e ainda é curto o bastante para a mensagem não chegar fora de contexto
 * (uma resposta a um comentário ou a um cadastro de semanas atrás confunde mais do que ajuda). Depois dele a execução falha com
 * `channel_connection_wait_expired`.
 */
export const CONNECTION_WAIT_MAX_MS = 7 * 86_400_000
export const CONNECTION_RESTORED_EVENT = 'connection_restored'

/** Recusas da própria conexão (core/delivery, policy.connectionRefusal): restrita para iniciar conversa, ou fora do ar. Esperam o conserto. */
export function connectionWaitCode(result: SendResult): 'connection_restricted' | 'connection_unavailable' | null {
  if (result.ok || result.reason !== 'rejected') return null
  return result.code === 'connection_restricted' || result.code === 'connection_unavailable' ? result.code : null
}

/**
 * A recusa que a entrega daria agora pela própria conexão (core/delivery: estado efetivo + `connectionRefusal`), para os envios que não
 * passam pela entrega de automação (resposta privada a comentário). `lastInboundAt`: a última mensagem do contato que conta para a janela da
 * restrita (no comentário, o próprio comentário). Desligada pela equipe conta como fora do ar: espera ser religada.
 */
export async function connectionRefusalNow(env: FlowEnv, run: Pick<Run, 'workspace_id' | 'channel_id'>, caps: ChannelCapabilities, lastInboundAt: number | null, group = false): Promise<Extract<SendResult, { ok: false }> | undefined> {
  const row = await env.DB.prepare(`SELECT ${effectiveStateSql('ch')} AS state FROM channels ch WHERE ch.workspace_id=? AND ch.id=?`)
    .bind(run.workspace_id, run.channel_id).first<{ state: string }>()
  return row ? connectionRefusal(row.state, caps, lastInboundAt, Date.now(), group) : undefined
}

/**
 * O envio foi recusado pela conexão: a execução fica em waiting_delay/connection até o prazo, acorda com o aviso
 * `connection_restored` (cron `wakeConnectionWaits`) ou no prazo, e volta a running para o envio tentar de novo. Prazo vencido: falha.
 * `deadline` vem de um passo durável, contado da primeira recusa deste envio.
 */
export async function waitForConnection(env: FlowEnv, step: WorkflowStep, run: Run, tag: string, deadline: number, code: string): Promise<void> {
  const left = await step.do(`connection-wait:${tag}`, async () => {
    await assertRunActive(env, run.id)
    if (Date.now() >= deadline) return 0
    await moveRun(env.DB, run.id, 'waiting_delay', { waitReason: 'connection', waitUntil: deadline }).run()
    // Um aviso por execução na conversa, como o de janela encerrada: quem atende sabe por que a automação parou.
    if (!run.reply_group_jid) await recordMessage(env, { id: `connection-wait:${run.id}`, workspaceId: run.workspace_id,
      conversationId: await ensureConversation(env, run.workspace_id, run.contact_id, run.channel_id), direction: 'out', sender: 'system',
      text: code === 'connection_restricted'
        ? 'Envio em espera: o número está restrito para iniciar conversas. A automação continua sozinha quando a restrição acabar (ou se o contato escrever); depois de 7 dias, ela para.'
        : 'Envio em espera: a conexão está fora do ar. A automação continua sozinha quando a conexão for consertada em Canais; depois de 7 dias, ela para.' })
    else await notifyTimeline(env, run.workspace_id)
    return deadline - Date.now()
  })
  if (left <= 0) throw new NonRetryableError('Channel send failed: connection_wait_expired')
  try { await step.waitForEvent(`connection-restored:${tag}`, { type: CONNECTION_RESTORED_EVENT, timeout: Math.max(1000, left) }) }
  catch { /* Prazo: tenta o envio uma última vez; se a conexão seguir recusando, a próxima espera já nasce vencida. */ }
  await step.do(`connection-resume:${tag}`, async () => {
    await assertRunActive(env, run.id)
    await moveRun(env.DB, run.id, 'running', { from: ['waiting_delay'] }).run()
  })
}

/** Janela da restrita por tipo de canal, do perfil de base (o filtro grosso da consulta; o ajuste fino por conexão é `connectionRefusal`). */
const restrictedWindowCase = `CASE ch.type ${channelKinds.map(kind => `WHEN '${kind}' THEN ${restrictedWindowHours(capabilities(kind)) * 3600000}`).join(' ')} ELSE ${restrictedWindowHours({ window: null }) * 3600000} END`

/**
 * Acorda as execuções que esperam a conexão quando ela pode enviar de novo, pela mesma regra da entrega (`connectionRefusal`): voltou a
 * connected/pending, ou segue restrita mas o contato está dentro da janela (escreveu há menos de 24 horas, ou a janela do canal), ou a
 * execução responde num grupo. Roda no cron de minuto pelo índice parcial das esperas de conexão; quem conserta a conexão pode chamar
 * com o canal para acordar na hora.
 */
export async function wakeConnectionWaits(env: FlowEnv, only?: { workspaceId: string; channelId: string }): Promise<number> {
  const now = Date.now()
  const contact = 'cc.workspace_id=r.workspace_id AND cc.contact_id=r.contact_id AND cc.channel_id=r.channel_id'
  const restricted = `${effectiveStateSql('ch')}='restricted'`
  const rows = await env.DB.prepare(`SELECT r.id,r.reply_group_thread_id,ch.type,ch.provider,ch.capabilities_override,${effectiveStateSql('ch')} AS state,
      CASE WHEN ${restricted} THEN (SELECT max(cc.last_inbound_at) FROM contact_channels cc WHERE ${contact} AND cc.last_inbound_at IS NOT NULL) END AS last_inbound_at
    FROM flow_runs r INDEXED BY flow_runs_connection_wait JOIN channels ch ON ch.workspace_id=r.workspace_id AND ch.id=r.channel_id
    WHERE r.status='waiting_delay' AND r.wait_reason='connection' AND r.workflow_created_at IS NOT NULL
    ${only ? 'AND r.workspace_id=? AND r.channel_id=?' : ''}
    AND (${stateInSql(INITIATING_STATES, 'ch')} OR (${restricted} AND (r.reply_group_thread_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM contact_channels cc WHERE ${contact} AND cc.last_inbound_at + ${restrictedWindowCase} > ?))))
    ORDER BY r.updated_at LIMIT 200`).bind(...(only ? [only.workspaceId, only.channelId] : []), now)
    .all<{ id: string; reply_group_thread_id: string | null; type: ChannelKind; provider: StoredProvider; capabilities_override: string | null; state: string; last_inbound_at: number | null }>()
  let woken = 0
  for (const row of rows.results) {
    // A janela exata segue o perfil efetivo da conexão (provedor e ajuste da equipe inclusive), como na entrega.
    const caps = effectiveProfile(row.type, row.provider, row.capabilities_override ? JSON.parse(row.capabilities_override) as ProfilePatch : undefined)
    if (connectionRefusal(row.state, caps, row.last_inbound_at, now, row.reply_group_thread_id !== null)) continue
    try { await (await env.FLOW_RUN.get(row.id)).sendEvent({ type: CONNECTION_RESTORED_EVENT, payload: {} }); woken++ }
    catch { /* a execução acorda sozinha no prazo; o próximo minuto tenta de novo */ }
  }
  return woken
}
