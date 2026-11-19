import type { WorkflowStep } from 'cloudflare:workers'
import type { FlowEnv } from './types'
import { notifyTimeline } from '../inbox/service'
import { finalRunStatusSql } from './run-state'
import { deferInline, flushDeferred, forgetVolatile, mark, measure, queueingWrites } from './inline-timing'
import { RateLimited } from '../channels/errors'
import { logTaskError } from '../log-error'

/** Caminho rápido: os primeiros passos de uma execução rodam aqui, no próprio webhook, com o mesmo executor do Workflow (runFlow).
 * Na primeira espera (Esperar, digitação longa, aguardar clique/resposta, espera da conexão), num erro ou no fim do tempo, a execução
 * passa para o Workflow, que devolve os passos já feitos pelo resultado gravado em flow_inline_steps e segue do ponto em que parou. */

/** Posse da execução (passos em linha ou criação do Workflow). Vencida sem Workflow, o cron retoma (recoverInlineRuns). */
export const EXECUTOR_LEASE_MS = 90_000
/** Tempo máximo de passos em linha: o waitUntil do webhook dura ~30 s depois da resposta. */
const INLINE_BUDGET_MS = 12_000
/** Pausa curta (digitação) que ainda roda em linha, somada na execução. */
const INLINE_SLEEP_MAX_MS = 3_000

export class Handoff extends Error {
  constructor(readonly reason: string) { super(`inline_handoff: ${reason}`) }
}

type Stored = { name: string; result: string }
const encode = (value: unknown) => JSON.stringify(value === undefined ? { u: 1 } : { v: value })
const decode = (text: string): unknown => { const parsed = JSON.parse(text) as { v?: unknown; u?: 1 }; return 'v' in parsed ? parsed.v : undefined }
const callback = (a: unknown, b: unknown) => (typeof a === 'function' ? a : b) as () => Promise<unknown>
/** Novas tentativas que o passo declara ao Workflow (`step.do(nome, { retries: { limit } }, fn)`); sem configuração, nenhuma. */
const retryLimit = (a: unknown, b: unknown) => typeof b === 'function' ? (a as { retries?: { limit?: number } } | undefined)?.retries?.limit ?? 0 : 0

export async function inlineResults(env: Pick<FlowEnv, 'DB'>, runId: string): Promise<Stored[]> {
  return (await env.DB.prepare('SELECT name,result FROM flow_inline_steps WHERE run_id=?').bind(runId).all<Stored>()).results
}

/** O passo do Workflow que já rodou em linha devolve o resultado gravado; o resto segue para o Workflow. */
export function replayStep(step: WorkflowStep, stored: Stored[]): WorkflowStep {
  const cache = new Map(stored.map(row => [row.name, row.result]))
  return {
    do: (name: string, a: unknown, b?: unknown) => cache.has(name) ? Promise.resolve(decode(cache.get(name)!)) : (b === undefined ? step.do(name, a as never) : step.do(name, a as never, b as never)),
    sleep: (name: string, duration: never) => cache.has(name) ? Promise.resolve() : step.sleep(name, duration),
    sleepUntil: (name: string, at: never) => step.sleepUntil(name, at),
    waitForEvent: (name: string, options: never) => step.waitForEvent(name, options),
  } as unknown as WorkflowStep
}

export type InlineTrace = { steps: number; firstSendAt?: number; reason?: string }

/** Passos que podem rodar de novo sem efeito visível (leitura, gravação idempotente, indicador de digitação): o resultado deles (e a
 * mudança de passo do enter) fica na memória e vai ao banco num lote só, logo antes do próximo passo com efeito (envio, métrica, ação),
 * no fim ou na passagem ao Workflow. O passo com efeito grava o próprio resultado logo depois de rodar, como antes.
 * Se o webhook cair antes, o Workflow apenas repete esses passos; o envio nunca se repete (flow_outbound guarda cada parte). */
const REPEATABLE = new Set(['load', 'channel-type', 'paused-check', 'pause-check', 'enter', 'personalize', 'tokens', 'typing', 'typing-wait'])
const repeatable = (name: string) => REPEATABLE.has(name.split(':')[0]!)

export type InlineStep = WorkflowStep & { flush(): Promise<void> }

/** Um WorkflowStep que executa na hora e grava cada resultado. Depois do primeiro pedido de espera ou erro, todo passo seguinte
 * recusa (Handoff): os `catch` do executor (timeout do clique, falha) não conseguem seguir em linha. */
export function inlineStep(env: Pick<FlowEnv, 'DB'>, runId: string, trace: InlineTrace, started = Date.now()): InlineStep {
  let stopped: string | undefined
  let slept = 0
  const stop = (reason: string): never => { stopped ??= reason; trace.reason ??= reason; throw new Handoff(stopped) }
  const pending: D1PreparedStatement[] = []
  const statement = (name: string, text: string) => env.DB.prepare('INSERT INTO flow_inline_steps (run_id,name,result,created_at) VALUES (?,?,?,?) ON CONFLICT(run_id,name) DO NOTHING')
    .bind(runId, name, text, Date.now())
  /** Grava os resultados acumulados (em ordem, numa transação): nunca fica gravado um passo com efeito sem os anteriores. */
  const flush = async () => {
    if (!pending.length) return
    const batch = pending.splice(0)
    await env.DB.batch(batch)
  }
  const record = async (name: string, value: unknown) => {
    const text = encode(value)
    pending.push(statement(name, text))
    if (!repeatable(name)) await flush()
    return decode(text)
  }
  return {
    flush,
    do: async (name: string, a: unknown, b?: unknown) => {
      if (stopped) stop(stopped)
      if (Date.now() - started > INLINE_BUDGET_MS) stop('budget')
      if (!repeatable(name)) {
        // Um passo com efeito relê o estado vivo (run ativo, inscrição, pausa) em vez de usar a leitura de um passo anterior,
        // e encontra no banco o que os passos repetíveis gravaram (o passo atual da execução, que o envio confere).
        forgetVolatile()
        try { await measure(`flush.${name}`, flush) } catch { stop('record_failed') }
      }
      let value: unknown
      for (let attempt = 0; ; attempt++) {
        try {
          // Passo repetível: a gravação de estado dele (enter) vai no mesmo lote do resultado, junto do próximo passo com efeito.
          value = repeatable(name) ? await queueingWrites(write => pending.push(write), () => measure(`do.${name}`, callback(a, b)))
            : await measure(`do.${name}`, callback(a, b))
          break
        } catch (error) {
          // Limite de envio da conversa (1 por segundo: a foto e o texto da mesma mensagem): espera aqui, como a nova tentativa do
          // Workflow, em vez de passar a execução adiante. Sem vaga nada foi à rede (a parte voltou a 'ready'); a parte já enviada não se repete.
          const wait = error instanceof RateLimited ? Math.max(1, error.retryAfter) * 1000 : undefined
          if (wait !== undefined && attempt < retryLimit(a, b) && slept + wait <= INLINE_SLEEP_MAX_MS && Date.now() - started + wait <= INLINE_BUDGET_MS) {
            await new Promise(resolve => setTimeout(resolve, wait))
            slept += wait
            continue
          }
          stop(error instanceof Handoff ? error.reason : `step_error:${name.split(':')[0]}`)
        }
      }
      const send = name.startsWith('send:')
      if (send && trace.firstSendAt === undefined) trace.firstSendAt = Date.now()
      try {
        const result = await measure(`rec.${name}`, () => record(name, value))
        trace.steps++
        // Depois do primeiro envio, o trabalho adiado (inbox, atribuição, avisos) começa, sem segurar os próximos passos.
        if (send) void flushDeferred()
        return result
      } catch { return stop('record_failed') }
    },
    sleep: async (name: string, duration: unknown) => {
      if (stopped) stop(stopped)
      if (typeof duration !== 'number' || slept + duration > INLINE_SLEEP_MAX_MS || Date.now() - started + duration > INLINE_BUDGET_MS) stop('sleep')
      await new Promise(resolve => setTimeout(resolve, duration as number))
      slept += duration as number
      try { await record(name, undefined) } catch { stop('record_failed') }
    },
    sleepUntil: async () => stop(stopped ?? 'sleep'),
    waitForEvent: async () => stop(stopped ?? 'wait_event'),
  } as unknown as InlineStep
}

/** Cria o Workflow da execução (dona da posse). Uma instância que já existe é sucesso. */
export async function createWorkflow(env: FlowEnv, runId: string): Promise<void> {
  try { await env.FLOW_RUN.create({ id: runId, params: { runId } }) }
  catch (error) {
    // Only an existing instance is a successful recovery. Never swallow a binding outage.
    const instance = await env.FLOW_RUN.get(runId).catch(() => undefined)
    const status = await instance?.status().catch(() => undefined)
    if (!status || !status.status || status.status === 'unknown') throw error
  }
  await env.DB.prepare('UPDATE flow_runs SET workflow_created_at=? WHERE id=?').bind(Date.now(), runId).run()
}

/** Toma a posse da execução sem Workflow; falso quando outro executor está com ela. */
export async function claimExecutor(env: Pick<FlowEnv, 'DB'>, runId: string, now = Date.now()): Promise<boolean> {
  const result = await env.DB.prepare('UPDATE flow_runs SET executor_claimed_at=? WHERE id=? AND workflow_created_at IS NULL AND (executor_claimed_at IS NULL OR executor_claimed_at<?)')
    .bind(now, runId, now - EXECUTOR_LEASE_MS).run()
  return (result.meta.changes ?? 0) > 0
}
export async function releaseExecutor(env: Pick<FlowEnv, 'DB'>, runId: string): Promise<void> {
  await env.DB.prepare('UPDATE flow_runs SET executor_claimed_at=NULL WHERE id=? AND workflow_created_at IS NULL').bind(runId).run().catch(() => undefined)
}

export type InlineOutcome = 'finished' | 'handoff' | 'skipped'

/** Roda a execução em linha até a primeira espera; o resto vai para o Workflow. `receivedAt` só serve para o log de tempos. */
export async function startRunInline(env: FlowEnv, runId: string, receivedAt?: number, preclaimed?: { workspaceId: string; at: number }): Promise<InlineOutcome> {
  // `preclaimed`: a posse veio no lote do planejamento (dispatch.ts), com a mesma regra.
  const started = preclaimed?.at ?? Date.now()
  // Leitura e posse numa ida só: a posse só pega execução viva, sem Workflow e sem outro executor (a mesma regra de claimExecutor).
  const claimed = preclaimed ? { workspace_id: preclaimed.workspaceId } : await env.DB.prepare(`UPDATE flow_runs SET executor_claimed_at=? WHERE id=? AND status<>'cancelled' AND workflow_created_at IS NULL
    AND (executor_claimed_at IS NULL OR executor_claimed_at<?) RETURNING workspace_id`).bind(started, runId, started - EXECUTOR_LEASE_MS).first<{ workspace_id: string }>()
  mark('i.claim')
  if (!claimed) {
    // Sem posse: execução cancelada, já com Workflow, com outro executor ou inexistente (esta última é erro, como antes).
    if (!await env.DB.prepare('SELECT 1 FROM flow_runs WHERE id=?').bind(runId).first()) throw new Error('Flow run missing')
    return 'skipped'
  }
  // Tempo real do inbox não decide a resposta: depois do primeiro envio (fora do caminho rápido nada é adiado).
  await deferInline(() => notifyTimeline(env, claimed.workspace_id))
  const trace: InlineTrace = { steps: 0 }
  // Import tardio: workflow.ts importa este arquivo.
  const { runFlow } = await import('./workflow')
  let outcome: InlineOutcome = 'finished'
  const step = inlineStep(env, runId, trace, started)
  try {
    const result = await runFlow(env, runId, step)
    // Pausa de segurança (e outros fins que não são done/cancelled): o Workflow assume, como antes, a partir dos passos gravados.
    if (result.status !== 'done' && result.status !== 'cancelled') throw new Handoff(`ended_${result.status}`)
    mark('i.flow_tail')
    await step.flush()
    // Terminou sem Workflow: 0 marca "executada, sem instância" (ensureWorkflow e a recuperação deixam em paz).
    await env.DB.prepare('UPDATE flow_runs SET workflow_created_at=0 WHERE id=? AND workflow_created_at IS NULL').bind(runId).run()
    mark('i.finish')
  } catch (error) {
    outcome = 'handoff'
    trace.reason ??= error instanceof Handoff ? error.reason : 'error'
    // O Workflow devolve os passos gravados: os que estavam só na memória vão ao banco antes de ele nascer (se falhar, ele os repete).
    await step.flush().catch(error => logTaskError('inline_flush_failed', error))
    try { await createWorkflow(env, runId) }
    catch (failure) { await releaseExecutor(env, runId); throw failure }
  } finally {
    const now = Date.now()
    console.log(JSON.stringify({ event: 'flow_inline', outcome, reason: trace.reason ?? null, steps: trace.steps, ms: now - started,
      firstSendMs: trace.firstSendAt === undefined ? null : trace.firstSendAt - started,
      sinceReceivedMs: receivedAt === undefined ? null : now - receivedAt,
      firstSendSinceReceivedMs: receivedAt === undefined || trace.firstSendAt === undefined ? null : trace.firstSendAt - receivedAt }))
  }
  return outcome
}

/** Execuções cuja posse venceu sem Workflow (o webhook caiu no meio dos passos em linha): o Workflow assume dos passos gravados. */
export async function recoverInlineRuns(env: FlowEnv, now = Date.now()): Promise<number> {
  const { ensureWorkflow } = await import('./dispatch')
  const rows = await env.DB.prepare(`SELECT id FROM flow_runs WHERE workflow_created_at IS NULL AND executor_claimed_at IS NOT NULL AND executor_claimed_at<?
    AND status NOT IN (${finalRunStatusSql}) LIMIT 50`).bind(now - EXECUTOR_LEASE_MS).all<{ id: string }>()
  let count = 0
  for (const row of rows.results) { try { await ensureWorkflow(env, row.id); count++ } catch (error) { logTaskError('inline_recovery_failed', error) } }
  return count
}
