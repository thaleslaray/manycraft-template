import { INITIATING_STATES, stateInSql } from '../channels/core/connection-state'

/**
 * Máquina de estados da inscrição em sequência (`sequence_subscriptions`, uma linha por contato e sequência; `enrollment_id` muda a cada
 * nova inscrição). Os estados saem das colunas; quem decide é flow/sequences.ts (cron) e quem inscreve/cancela são as ações listadas abaixo.
 *
 *   scheduled  agendada            pending_run_id NULL, next_at NOT NULL. O passo de posição >= next_step sai em next_at, assim que a conexão
 *                                  puder iniciar conversa (INITIATING_STATES); até lá o cron nem olha a linha ("aguardando a conexão").
 *   running    passo em andamento  pending_run_id e pending_step_id NOT NULL; next_step é a posição do passo (next_at fica como estava).
 *   finished   terminada           pending_run_id NULL, next_at NULL: não há próximo passo vivo. A inscrição continua (o contato segue
 *                                  "na sequência"); editar a sequência pode acordá-la (rescheduleSequenceSubscriptions).
 *   left       saiu                a linha some (DELETE).
 * Combinação inválida: pending_step_id sem pending_run_id (a execução apagada de vez põe NULL pela chave estrangeira). O gatilho da 0125
 * `sequence_subscriptions_run_gone` a desfaz na hora (vira `run_gone`).
 *
 * Transições:
 *   enroll      (nada) → scheduled | finished (sem passo vivo)   ação do fluxo, inscrição em lote, regra; repetir mantém a inscrição atual
 *   plan        scheduled → running                              cron: execução criada para o passo
 *   wait        scheduled → scheduled (next_at adiante)          passo com janela de horário fora dela
 *   skip        scheduled → scheduled (passo seguinte) | finished   o passo não roda: automação parada, na lixeira, apagada ou sem versão
 *                                                                 publicada (antes a linha ficava parada na frente da fila do cron para sempre)
 *   step_done   running → scheduled (passo seguinte) | finished   execução concluída ou cancelada segue; com falha ou pausa de segurança termina
 *   run_gone    running → scheduled (passo seguinte, já)         execução apagada (gatilho do banco)
 *   exhaust     scheduled → finished                             não há mais passo vivo
 *   reschedule  scheduled | finished → scheduled | finished      edição da sequência
 *   leave       qualquer → left                                  cancelar no painel, regra, ação do fluxo, contato saiu da conexão
 *                                                                 (STOP, descadastro, exclusão); fusão de contatos apaga a do secundário
 *
 * Dado deixado pela 0125 (não corrigido de propósito): o gatilho `run_gone` da 0125, e o UPDATE de dados dela, mantinham o `next_at` do passo
 * cuja execução sumiu (a hora em que aquele passo saiu, no passado); a inscrição ficava agendada para o passo seguinte já vencida e o cron
 * o disparava no minuto seguinte, sem a espera dele. A 0126 corrigiu o gatilho, não os dados. Não há como separar essas linhas das
 * legitimamente atrasadas: nenhuma coluna guarda quem mexeu nem quando (sequence_subscriptions não tem updated_at), a execução do passo
 * apagado não existe mais para comparar horários, e "agendada, next_at no passado, passo com delay_seconds>0, sem execução pendente" é
 * exatamente o estado de quem esperava a conexão voltar (enrollmentConnectionReadySql) ou de um cron parado. Empurrar o next_at dessas
 * linhas atrasaria inscrições corretas; por isso nenhuma migração mexe nelas. Com o cron rodando, a linha afetada já saiu no minuto
 * seguinte (o passo seguinte foi antecipado) e não sobra o que consertar.
 */
export type SequenceEnrollmentState = 'scheduled' | 'running' | 'finished'

export function sequenceEnrollmentState(row: { pending_run_id: string | null; next_at: number | null }): SequenceEnrollmentState {
  return row.pending_run_id ? 'running' : row.next_at === null ? 'finished' : 'scheduled'
}
export const enrollmentStateSql = (alias: string) =>
  `(CASE WHEN ${alias}.pending_run_id IS NOT NULL THEN 'running' WHEN ${alias}.next_at IS NULL THEN 'finished' ELSE 'scheduled' END)`

/** A conexão da inscrição pode iniciar a conversa do próximo passo (a restrita, a com erro e a pareando esperam). */
export const enrollmentConnectionReadySql = (channelAlias: string) => stateInSql(INITIATING_STATES, channelAlias)

/** O passo só roda com a automação ligada, fora da lixeira e publicada; senão é pulado (transição `skip`). */
export const runnableAutomationSql = (automationAlias: string) =>
  `(${automationAlias}.status='live' AND ${automationAlias}.deleted_at IS NULL AND ${automationAlias}.published_version_id IS NOT NULL)`
