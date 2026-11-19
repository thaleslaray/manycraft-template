import type { IntegrationEnv } from './integrations'
import { dispatchInbound, hasFlow } from './flow/dispatch'
import { senderOf } from './channels/core/inbound'
import { drainMemberAlerts, takeQueuedAlerts } from './team-alerts'
import { inboundEventSchema, sourceOf } from './channels/core/queue'
import { connectionRuntime } from './channels/core/runtime'
import { moveConnection } from './channels/core/connection-state'
import { finalRunStatusSql } from './flow/run-state'
import { countedDb, drainDeferred, forgetVolatile, logTiming, mark, newTiming, runWithTiming } from './flow/inline-timing'
import { logTaskError } from './log-error'

/** Posse de um evento em processamento: o caminho rápido do webhook e a fila nunca processam o mesmo evento ao mesmo tempo. */
export const INBOUND_CLAIM_MS = 60_000
export type InboundOutcome = 'processed' | 'already' | 'busy' | 'ingested'

/** O processamento de um evento, igual para a fila e para o caminho rápido do webhook (`inline`: primeiros passos sem esperar o Workflow).
 * 'busy': outro executor está com o evento agora (a fila tenta de novo mais tarde, a posse vence em INBOUND_CLAIM_MS). */
export async function processInbound(body: unknown, env: IntegrationEnv, options: { inline?: boolean; waitBusyMs?: number } = {}): Promise<InboundOutcome> {
  if (!options.inline) return processInboundNow(body, env, options)
  // Caminho rápido: mede cada fase (log 'inline_timing') e conta as idas ao D1.
  const timed = { ...env, DB: countedDb(env.DB) }
  return runWithTiming(newTiming(), async () => {
    let outcome: InboundOutcome | 'error' = 'error'
    try { outcome = await processInboundNow(body, timed, options); return outcome }
    finally { logTiming('inline_timing', { outcome }) }
  })
}

async function processInboundNow(body: unknown, env: IntegrationEnv, options: { inline?: boolean; waitBusyMs?: number }): Promise<InboundOutcome> {
  const event = inboundEventSchema.parse(body)
  const rt = await connectionRuntime(env, event.workspaceId, event.channelId, { requireConnected: true, secrets: false })
  if (sourceOf(rt.connection.kind) !== event.provider) throw new Error('Invalid channel')
  const id = JSON.stringify([event.provider, event.channelId, event.eventId])
  mark('runtime')
  const insert = env.DB.prepare(`INSERT INTO inbound_events (id, workspace_id, channel_id, payload, received_at, external_user_id)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
    .bind(id, event.workspaceId, event.channelId, JSON.stringify(event.payload), event.receivedAt, senderOf(rt, event))
  const claimStatement = (at: number) => env.DB.prepare('UPDATE inbound_events SET claimed_at=? WHERE id=? AND processed_at IS NULL AND (claimed_at IS NULL OR claimed_at<?)')
    .bind(at, id, at - INBOUND_CLAIM_MS)
  // A channel without a working transport is ingestion only.
  const dispatches = rt.meta.live && hasFlow(env)
  let now = Date.now()
  let claim: D1Result | undefined
  if (dispatches && rt.connection.status !== 'pending') {
    // Gravar e tomar a posse numa ida só (o lote roda em ordem, numa transação).
    claim = (await env.DB.batch([insert, claimStatement(now)]))[1]
    mark('insert_claim')
  } else {
    await insert.run()
    mark('insert_event')
    // The first delivery that authenticates proves the webhook is wired.
    if (rt.connection.status === 'pending') {
      // A hora do fato é a da entrega: um evento de estado que veio no mesmo webhook (recebido no mesmo instante) ainda vale depois.
      await moveConnection(env.DB, { id: event.channelId, event: 'first_delivery', to: 'connected', detail: null, at: event.receivedAt,
        also: { sql: 'webhook_registered_at=coalesce(webhook_registered_at,?)', binds: [Date.now()] } })
      forgetVolatile('chan:')
    }
    if (!dispatches) return 'ingested'
    now = Date.now()
    claim = await claimStatement(now).run()
  }
  mark('claim')
  if (!claim?.meta.changes) {
    // O caminho rápido costuma terminar em instantes: a fila espera um pouco antes de pedir nova tentativa.
    for (const deadline = now + (options.waitBusyMs ?? 0); ;) {
      const row = await env.DB.prepare('SELECT processed_at FROM inbound_events WHERE id=?').bind(id).first<{ processed_at: number | null }>()
      if (row && row.processed_at !== null) return 'already'
      if (Date.now() >= deadline) return 'busy'
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
  try {
    await dispatchInbound(event, id, env, { inline: options.inline })
  } catch (error) {
    // Solta a posse: a fila retoma na próxima tentativa (planejamento e Workflow são idempotentes).
    await env.DB.prepare('UPDATE inbound_events SET claimed_at=NULL WHERE id=? AND claimed_at=?').bind(id, now).run().catch(() => undefined)
    throw error
  } finally {
    // Inbox, atribuição e avisos adiados pelo caminho rápido: antes de marcar o evento como processado (e também quando falhou).
    await drainDeferred()
  }
  mark('dispatch_tail')
  await env.DB.prepare('UPDATE inbound_events SET processed_at=? WHERE id=?').bind(Date.now(), id).run()
  mark('processed')
  if (takeQueuedAlerts()) try { await drainMemberAlerts(env) } catch (error) { logTaskError('member_alerts_unavailable', error) }
  return 'processed'
}

const receivedAtOf = (body: unknown) => body && typeof body === 'object' && 'receivedAt' in body && typeof body.receivedAt === 'number' ? body.receivedAt : undefined

/** Caminho rápido: o webhook processa o evento logo depois de enfileirar (waitUntil). Nunca lança: a fila é a rede de segurança. */
export async function processInboundFast(bodies: unknown[], env: IntegrationEnv): Promise<void> {
  // Na ordem da entrega, um de cada vez (como a fila): um evento de estado não passa na frente da mensagem a que se refere.
  for (const body of bodies) {
    const started = Date.now()
    let outcome: InboundOutcome | 'error' = 'error'
    try { outcome = await processInbound(body, env, { inline: true }) }
    catch (error) { logTaskError('inbound_fast_failed', error) /* A fila tenta de novo; sem payload nem ids no log. */ }
    const receivedAt = receivedAtOf(body)
    console.log(JSON.stringify({ event: 'inbound_fast', outcome, ms: Date.now() - started, sinceReceivedMs: receivedAt === undefined ? null : Date.now() - receivedAt }))
  }
}

/** Queue ack means durable ingestion/dispatch, not completed delivery. */
export async function consumeInbound(batch: MessageBatch<unknown>, env: IntegrationEnv): Promise<void> {
  for (const message of batch.messages) {
    try {
      const outcome = await processInbound(message.body, env, { waitBusyMs: 3000 })
      const receivedAt = receivedAtOf(message.body)
      console.log(JSON.stringify({ event: 'inbound_queue', outcome, attempts: message.attempts, sinceReceivedMs: receivedAt === undefined ? null : Date.now() - receivedAt }))
      // O caminho rápido está com o evento agora: volta depois; se ele cair, a posse vence e a fila processa.
      if (outcome === 'busy') message.retry({ delaySeconds: Math.ceil(INBOUND_CLAIM_MS / 1000) })
      else message.ack()
    } catch (error) {
      // Queue max_retries + DLQ retain poison messages. No user payload/identifier in logs.
      logTaskError('inbound_queue_failed', error)
      message.retry({ delaySeconds: Math.min(300, 2 ** Math.min(message.attempts, 8)) })
    }
  }
}

export async function cleanupInbound(env: Pick<IntegrationEnv, 'DB'>, now = Date.now()): Promise<void> {
  await env.DB.prepare('DELETE FROM button_tokens WHERE expires_at<?').bind(now - 86400000).run()
  const threshold = now - 30 * 24 * 60 * 60 * 1000
  // Pending executor work must not disappear during cleanup.
  await env.DB.prepare('DELETE FROM inbound_events WHERE received_at < ? AND processed_at IS NOT NULL')
    .bind(threshold).run()
  // Passos em linha: só servem enquanto a execução pode ser retomada pelo Workflow.
  await env.DB.prepare(`DELETE FROM flow_inline_steps WHERE created_at < ? AND (run_id IN (SELECT id FROM flow_runs WHERE status IN (${finalRunStatusSql})) OR run_id NOT IN (SELECT id FROM flow_runs))`)
    .bind(now - 86400000).run()
}
