/**
 * Máquina de estados de uma execução de fluxo (`flow_runs.status`), levantada do código em 2026-11-13.
 *
 * Estados (CHECK de 0001_init): running, waiting_delay, waiting_click, waiting_input (ativos) e done, failed, cancelled (finais).
 * `waiting_delay` é "parada com hora para acordar ou esperando um aviso"; o motivo fica em `wait_reason` (migração 0124), que só vale
 * enquanto o status é waiting_delay (um gatilho do banco limpa o motivo em qualquer outra mudança de status):
 *   delay         passo Espera inteligente (wait_until = fim da espera)                         workflow.ts `waiting:<i>`
 *   story_delay   pausa do gatilho de menção em story antes do primeiro passo (wait_until)      story-effects.ts `story-delay-state`
 *   human_pause   atendimento humano pausou as automações do contato (wait_until = fim)          workflow.ts `pause-check`
 *   safety_pause  trava de segurança: 30 passos seguidos sem pausa (error='consecutive_block_limit', sem wait_until,
 *                 sem retomada; também quando a chamada esperada parou pela trava)               workflow.ts `safety-pause`, `call-paused`
 *   call          esperando a automação chamada com "esperar terminar" (sem wait_until)          nodes.ts callState
 *   connection    envio recusado pela conexão restrita ou fora do ar; espera o conserto até o prazo
 *                 (wait_until = prazo, CONNECTION_WAIT_MAX_MS)                                   connection-wait.ts
 * Antes de 0124 os quatro primeiros e `call` eram todos só `waiting_delay` (a trava se reconhecia por `error`).
 *
 * Quem muda o status (todo UPDATE de status passa por `moveRun`/`runGuard`, sempre com a guarda do estado de origem):
 *   INSERT (status padrão running): dispatch.ts (mensagem), comment/story/group/ref/surface-dispatch, follow-ups, content-run,
 *     nodes.ts startAutomation (filha), sequences.ts, rules/runtime.ts, public-api.ts, inbox/routes.ts, hotmart.ts, db/broadcasts.ts.
 *   workflow.ts (a própria execução):
 *     paused-cancel   ativo → cancelled (error automation_paused)         antes: só "<> cancelled"
 *     pause-check     ativo → waiting_delay/human_pause                    antes: só "<> cancelled"
 *     safety-pause    ativo → waiting_delay/safety_pause                   antes: só "<> cancelled"
 *     enter:<i>       ativo → running (passo atual)                        antes: só "<> cancelled" (podia ressuscitar done/failed)
 *     waiting:<i>     ativo → waiting_click | waiting_delay/delay          antes: só "<> cancelled"
 *     call-cancelled  ativo → cancelled;  call-paused ativo → waiting_delay/safety_pause
 *     finish          ativo → done;  failed (catch) ativo → failed          antes: só "<> cancelled" (failed podia sobrescrever done)
 *     connection-wait ativo → waiting_delay/connection → running (retomada) → … ou failed (channel_connection_wait_expired)
 *   story-effects.ts  ativo → waiting_delay/story_delay                    antes: só "<> cancelled"
 *   questions.ts      ativo → waiting_input (abre a pergunta)              antes: só "<> cancelled"
 *                     ativo → cancelled (STOP respondido na pergunta)      já guardado, lista copiada
 *   nodes.ts callState  ativo → waiting_delay/call (quem chamou)           já guardado, lista copiada
 *   dispatch.ts       ativo → cancelled (descadastro pela palavra de sistema)  já guardado
 *   db/broadcasts.ts  running → done | failed (destinatário sem continuação)   já guardado
 *                     running → running (continuação da transmissão)       SEM guarda de estado: ressuscitava a execução que o contato
 *                                                                          cancelou no meio do envio (corrigido; teste em run-state.test.ts)
 *   contacts.ts, contact-portability.ts, db/automation-library.ts: ativo → cancelled em lote (apagar, mesclar, lixeira), já com
 *     `activeRunStatusSql` (a mesma guarda de `runGuard('cancelled')`).
 * Final é final: nenhuma transição sai de done, failed ou cancelled.
 */
export const runStatuses = ['running', 'waiting_delay', 'waiting_click', 'waiting_input', 'done', 'failed', 'cancelled'] as const
export type RunStatus = typeof runStatuses[number]
/** Estados de uma execução que ainda não terminou. Fonte única: o teste estados-de-execucao recusa cópias. */
export const activeRunStatuses = ['running', 'waiting_delay', 'waiting_click', 'waiting_input'] as const satisfies readonly RunStatus[]
export const finalRunStatuses = ['done', 'failed', 'cancelled'] as const satisfies readonly RunStatus[]
/** Estados em que um toque num botão do passo atual ainda continua a execução (o passo acabou de sair ou espera o clique). */
export const clickableRunStatuses = ['running', 'waiting_click'] as const satisfies readonly RunStatus[]
export const waitReasons = ['delay', 'story_delay', 'human_pause', 'safety_pause', 'call', 'connection'] as const
export type WaitReason = typeof waitReasons[number]

const sqlList = (values: readonly string[]) => values.map(value => `'${value}'`).join(',')
/** Para `status IN (...)` no SQL (valores fixos, nada vindo de quem pede). */
export const activeRunStatusSql = sqlList(activeRunStatuses)
export const finalRunStatusSql = sqlList(finalRunStatuses)

/** Para cada estado de destino, os estados de origem aceitos. Mudar de passo sempre passa por running (enter): waiting_click nasce de
 * running (ou de si mesmo, no lembrete das respostas rápidas) e waiting_input só de running; waiting_delay e os finais vêm de qualquer
 * estado ativo (pausa humana, trava e espera da conexão acontecem depois de um clique ou de uma resposta). Nada sai de um final. */
export const runTransitions: Record<RunStatus, readonly RunStatus[]> = {
  running: activeRunStatuses,
  waiting_delay: activeRunStatuses,
  waiting_click: ['running', 'waiting_click'],
  waiting_input: ['running'],
  done: activeRunStatuses,
  failed: activeRunStatuses,
  cancelled: activeRunStatuses,
}

export const isActiveRunStatus = (status: string | null | undefined): boolean => (activeRunStatuses as readonly string[]).includes(status ?? '')
export const isFinalRunStatus = (status: string | null | undefined): boolean => (finalRunStatuses as readonly string[]).includes(status ?? '')

/** Guarda do estado de origem para um UPDATE que leva a execução a `to`. `from` só pode estreitar a tabela. */
export function runGuard(to: RunStatus, column = 'status', from?: readonly RunStatus[]): string {
  const allowed = runTransitions[to]
  if (from?.some(status => !allowed.includes(status))) throw new Error(`Transição não permitida: ${from.join('|')} → ${to}`)
  return `${column} IN (${sqlList(from ?? allowed)})`
}

/** A trava de segurança parou a execução de vez (não tem retomada). */
export const isSafetyPaused = (row: { status: string; wait_reason?: string | null } | null | undefined): boolean =>
  row?.status === 'waiting_delay' && row.wait_reason === 'safety_pause'
export const safetyPausedSql = (alias: string) => `(${alias}.status='waiting_delay' AND ${alias}.wait_reason='safety_pause')`

type Statement = { bind(...values: unknown[]): Statement }
export type RunMove = {
  /** Obrigatório para waiting_delay; nas outras transições o motivo é limpo. */
  waitReason?: WaitReason
  /** Hora de acordar. Sem valor: NULL. Um fragmento SQL serve para lê-la de outra tabela na mesma instrução. */
  waitUntil?: number | null | { sql: string; binds: unknown[] }
  /** undefined mantém o erro gravado. */
  error?: string | null
  currentNodeId?: string
  stepsSincePause?: number
  /** Estreita a guarda (ex.: a transmissão só fecha a execução que ainda está em running). */
  from?: readonly RunStatus[]
  workspaceId?: string
  now?: number
}

/** UPDATE de uma execução para `to`, só se o estado atual permite (nenhum final é sobrescrito). */
export function moveRun<S extends Statement>(db: { prepare(query: string): S }, runId: string, to: RunStatus, move: RunMove = {}): S {
  if ((to === 'waiting_delay') !== (move.waitReason !== undefined)) throw new Error(`wait_reason ${to === 'waiting_delay' ? 'obrigatório' : 'só vale'} em waiting_delay`)
  const sets = ['status=?', 'wait_reason=?']
  const values: unknown[] = [to, move.waitReason ?? null]
  if (move.waitUntil !== null && typeof move.waitUntil === 'object') { sets.push(`wait_until=${move.waitUntil.sql}`); values.push(...move.waitUntil.binds) }
  else { sets.push('wait_until=?'); values.push(move.waitUntil ?? null) }
  if (move.error !== undefined) { sets.push('error=?'); values.push(move.error) }
  if (move.currentNodeId !== undefined) { sets.push('current_node_id=?'); values.push(move.currentNodeId) }
  if (move.stepsSincePause !== undefined) { sets.push('steps_since_pause=?'); values.push(move.stepsSincePause) }
  sets.push('updated_at=?'); values.push(move.now ?? Date.now())
  const where = ['id=?', ...(move.workspaceId === undefined ? [] : ['workspace_id=?']), runGuard(to, 'status', move.from)]
  values.push(runId, ...(move.workspaceId === undefined ? [] : [move.workspaceId]))
  return db.prepare(`UPDATE flow_runs SET ${sets.join(',')} WHERE ${where.join(' AND ')}`).bind(...values) as S
}
