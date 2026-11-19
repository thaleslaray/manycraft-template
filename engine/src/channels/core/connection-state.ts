import type { ConnectionStatus } from '../contract'

/**
 * Máquina de estados da conexão de canal (tabela `channels`). Todo leitor e todo escritor do estado passa por aqui.
 *
 * Duas colunas, por história (0012): `status` só aceita connected/disconnected/error e o CHECK dela não muda sem recriar a tabela
 * (dezenas de chaves estrangeiras apontam para `channels`), então o conjunto inteiro mora em `connection_state`. Os papéis:
 *  - `status` é a chave da equipe: 'connected' = ligada (recebe webhooks, entra nas escolhas de conexão); 'disconnected' = desligada
 *    pela equipe ou arquivada. ('error' só existe em dado antigo e de teste; o gatilho `channels_state_follows_status` copia para a saúde.)
 *  - `connection_state` é a saúde, dita pelo provedor ou pelo servidor.
 * Invariante, garantido pelo banco desde a migração 0125 (`channels_disabled_state`): status='disconnected' ⇒ connection_state='disconnected'.
 * O estado efetivo é `effectiveConnectionState` / `effectiveStateSql`; ele ainda olha `status` para não depender só do invariante.
 *
 * Estados efetivos: pending (pendente: credencial colada, falta o primeiro webhook), connecting (pareando: QR code esperando leitura),
 * connected (conectada), error (com erro: credencial recusada, provedor fora), restricted (restrita: só responde a quem escreveu nas
 * últimas 24 h), disconnected (desligada: pela equipe, arquivada ou o número saiu do aparelho).
 *
 * Transições (`event`: de → para). "Ligada" = status='connected' e não arquivada.
 *   create          (linha nova)                 → pending                         colar token (createConnection)
 *                                                → connected                       e-mail da plataforma (emailConnection: sem webhook)
 *   webhook_auto    qualquer, ligada             → connected                       webhook registrado no provedor (wireWebhook)
 *   webhook_manual  pending|connecting|error|disconnected, ligada → pending          webhook à mão: espera a primeira entrega. Conectada ou restrita
 *                   não cai: a tentativa de registro que falhou não desfaz o webhook que o provedor já tem
 *   pairing         qualquer, ligada             → connecting                      provedor devolveu QR code
 *   paired          qualquer, ligada             → connected                       provedor confirmou o pareamento (refreshConnect)
 *   first_delivery  pending, ligada              → connected                       primeira entrega autenticada (jobs.consumeInbound)
 *   provider_event  qualquer, ligada             → connected|connecting|disconnected|error|restricted   evento de estado do número (WhatsApp não oficial);
 *                   só vale se não for mais velho que a última mudança gravada (`state_changed_at`)
 *   send_refused    connected|pending, ligada    → error|restricted                envio recusado (noteConnectionFailure)
 *   refresh         qualquer, ligada             → connected|connecting|error      "Atualizar conexão" (refreshConnection)
 *   enable          desligada, não arquivada     → connected                       reativar, só depois da conferência no provedor dar certo
 *   disable         qualquer, não arquivada      → disconnected (status também)    desativar pela equipe
 *   archive         qualquer                     → disconnected (status também)    arquivar (archiveConnection)
 * Fora da tabela não se escreve `status` nem `connection_state`; o teste `connection-state.test.ts` confere o código-fonte.
 */
export type ConnectionState = ConnectionStatus

export const connectionStateLabels: Record<ConnectionState, string> = {
  pending: 'pendente', connecting: 'pareando', connected: 'conectada', error: 'com erro', restricted: 'restrita', disconnected: 'desligada',
}

/** Estados em que a entrega aceita mandar (core/delivery + policy.connectionRefusal: a restrita só responde dentro da janela). */
export const SENDING_STATES = ['connected', 'pending', 'restricted'] as const satisfies readonly ConnectionState[]
/** Estados em que se pode iniciar uma conversa (passo de sequência): a restrita não inicia. */
export const INITIATING_STATES = ['connected', 'pending'] as const satisfies readonly ConnectionState[]
/** Estado de quem acabou de colar o token (INSERT de createConnection). */
export const INITIAL_STATE = 'pending' as const satisfies ConnectionState

const prefix = (alias?: string) => alias ? `${alias}.` : ''

/** O estado que a equipe vê e que decide envio: a desativada pela equipe vence a saúde do provedor. */
export function effectiveConnectionState(row: { status?: string | null; connection_state: string }): ConnectionState {
  return (row.status === 'disconnected' ? 'disconnected' : row.connection_state) as ConnectionState
}
/** O mesmo em SQL, para SELECT e ORDER BY. */
export const effectiveStateSql = (alias?: string) => `(CASE WHEN ${prefix(alias)}status='disconnected' THEN 'disconnected' ELSE ${prefix(alias)}connection_state END)`
/** Ligada pela equipe (recebe webhooks e entra nas escolhas), qualquer que seja a saúde. */
export const enabledSql = (alias?: string) => `${prefix(alias)}status='connected'`
/** Ligada e num dos estados pedidos. */
export const stateInSql = (states: readonly ConnectionState[], alias?: string) =>
  `(${enabledSql(alias)} AND ${prefix(alias)}connection_state IN (${states.map(s => `'${s}'`).join(',')}))`

export type ConnectionEvent = 'webhook_auto' | 'webhook_manual' | 'pairing' | 'paired' | 'first_delivery' | 'provider_event' | 'send_refused'
  | 'refresh' | 'enable' | 'disable' | 'archive'
type Rule = { from: readonly ConnectionState[] | 'any'; to: readonly ConnectionState[]; guard: 'enabled' | 'disabled' | 'not_archived' | 'none'; status?: 'connected' | 'disconnected' }
export const connectionTransitions: Record<ConnectionEvent, Rule> = {
  webhook_auto: { from: 'any', to: ['connected'], guard: 'enabled' },
  // Registro que falhou não rebaixa conexão que já recebe (connected/restricted): o webhook antigo segue valendo no provedor.
  webhook_manual: { from: ['pending', 'connecting', 'error', 'disconnected'], to: ['pending'], guard: 'enabled' },
  pairing: { from: 'any', to: ['connecting'], guard: 'enabled' },
  paired: { from: 'any', to: ['connected'], guard: 'enabled' },
  first_delivery: { from: ['pending'], to: ['connected'], guard: 'enabled' },
  provider_event: { from: 'any', to: ['connected', 'connecting', 'disconnected', 'error', 'restricted'], guard: 'enabled' },
  send_refused: { from: ['connected', 'pending'], to: ['error', 'restricted'], guard: 'enabled' },
  refresh: { from: 'any', to: ['connected', 'connecting', 'error'], guard: 'enabled' },
  enable: { from: 'any', to: ['connected'], guard: 'disabled', status: 'connected' },
  disable: { from: 'any', to: ['disconnected'], guard: 'not_archived', status: 'disconnected' },
  archive: { from: 'any', to: ['disconnected'], guard: 'none', status: 'disconnected' },
}

export type Move = {
  id: string; workspaceId?: string; event: ConnectionEvent; to: ConnectionState
  /** Motivo mostrado na conexão; `undefined` mantém o que está gravado. */
  detail?: string | null
  /** Hora do fato. Grava em `state_changed_at`; no `provider_event`, um fato mais velho que a última mudança não muda nada. */
  at?: number
  /** Outras colunas na mesma escrita (ex.: `webhook_mode='auto'`), com os seus valores. */
  also?: { sql: string; binds: unknown[] }
}

/** A escrita de uma transição, com a guarda do estado de origem. Não casa (nenhuma linha muda) quando a transição não vale. */
export function moveConnectionStatement(db: D1Database, move: Move): D1PreparedStatement {
  const rule = connectionTransitions[move.event]
  if (!rule.to.includes(move.to)) throw new Error(`Transição inválida: ${move.event} → ${move.to}`)
  const at = move.at ?? Date.now()
  const set = ['connection_state=?', 'state_changed_at=max(coalesce(state_changed_at,0),?)']
  const binds: unknown[] = [move.to, at]
  if (rule.status) set.push(`status='${rule.status}'`)
  if (move.detail !== undefined) { set.push('status_detail=?'); binds.push(move.detail) }
  if (move.also) { set.push(move.also.sql); binds.push(...move.also.binds) }
  const where = ['id=?']
  binds.push(move.id)
  if (move.workspaceId !== undefined) { where.push('workspace_id=?'); binds.push(move.workspaceId) }
  if (rule.guard === 'enabled') where.push(`archived_at IS NULL AND ${enabledSql()}`)
  else if (rule.guard === 'disabled') where.push("archived_at IS NULL AND status='disconnected'")
  else if (rule.guard === 'not_archived') where.push('archived_at IS NULL')
  if (rule.from !== 'any') where.push(`connection_state IN (${rule.from.map(s => `'${s}'`).join(',')})`)
  if (move.event === 'provider_event') { where.push('coalesce(state_changed_at,0)<=?'); binds.push(at) }
  return db.prepare(`UPDATE channels SET ${set.join(', ')} WHERE ${where.join(' AND ')}`).bind(...binds)
}

/** Aplica a transição; `true` quando a conexão mudou. */
export async function moveConnection(db: D1Database, move: Move): Promise<boolean> {
  return (await moveConnectionStatement(db, move).run()).meta.changes > 0
}
