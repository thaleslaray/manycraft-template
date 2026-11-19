/**
 * Alcance e consentimento do contato numa conexão (`contact_channels`). Toda mudança de consentimento e de bloqueio passa por aqui.
 *
 * Três eixos, cada um com a sua hora:
 *  - consentimento: inscrito (opted_in=1, opted_out_at NULL) | descadastrado (opted_in=0, opted_out_at=hora) | nunca inscrito
 *    (opted_in=0, opted_out_at NULL). Hora da última mudança: `consent_changed_at`.
 *  - bloqueio: livre (blocked_at NULL) | bloqueado (blocked_at = hora do primeiro bloqueio). Hora da última mudança: `block_changed_at` (0125).
 *  - janela de 24 h (window_expires_at, human_window_expires_at, last_inbound_at): só cresce (max), então um evento atrasado nunca a encolhe;
 *    quem a escreve é a entrada de cada provedor e flow/dispatch.reopenWindow.
 *
 * Regra única: toda mudança leva a hora do fato (`at`: a do provedor, nunca depois da recepção; a da ação, para equipe e sistema).
 * Um fato mais velho que a última mudança gravada não vale; uma mudança aplicada grava a sua hora.
 *
 * Transições de consentimento:
 *   opt_in         qualquer → inscrito         START, toque de abertura, coleta com opt-in, ação do fluxo, equipe (e-mail, nova conversa), API
 *   opt_out        qualquer → descadastrado    STOP/parar, ação do fluxo, descadastro em massa, limpeza de lista, e-mail inalcançável, equipe
 *   first_inbound  nunca entrou → inscrito     primeira mensagem privada do contato (quem escreve primeiro aceita resposta). Não grava a hora:
 *                                              é o padrão do primeiro contato, não uma decisão; e não desfaz uma mudança mais nova.
 * Transições de bloqueio:
 *   block          livre → bloqueado           envio recusado por bloqueio (core/delivery), o contato bloqueou o bot (Telegram). Repetir mantém a
 *                                              hora do primeiro. Também não vale bloqueio mais velho que a última mensagem do contato.
 *   unblock        bloqueado → livre           o contato desbloqueou o bot; mensagem nova do contato (flow/dispatch.reopenWindow, que compara
 *                                              com `blocked_at`).
 * Escritores que ainda montam o SQL à mão e já seguem a regra: flow/dispatch.ts (START/STOP do sistema, reopenWindow) e
 * flow/questions.ts (parar e opt-in da coleta). O teste `consent.test.ts` confere que ninguém mais escreve esses campos.
 */
export type Fragment = { sql: string; binds: unknown[] }

/** Vale só se não houver mudança de consentimento mais nova que `at`. */
export const consentFresh = (at: number): Fragment => ({ sql: '(consent_changed_at IS NULL OR consent_changed_at<=?)', binds: [at] })

/** Muda o consentimento das identidades que `where` escolhe (sem o WHERE). `also` entra no SET (ex.: broadcast_opt_in). */
export function changeConsent(db: D1Database, change: { optedIn: boolean; at?: number; where: Fragment; also?: Fragment }): D1PreparedStatement {
  const at = change.at ?? Date.now(), fresh = consentFresh(at)
  const set = ['opted_in=?', 'opted_out_at=?', 'consent_changed_at=?', 'updated_at=?', ...change.also ? [change.also.sql] : []]
  return db.prepare(`UPDATE contact_channels SET ${set.join(',')} WHERE ${change.where.sql} AND ${fresh.sql}`)
    .bind(change.optedIn ? 1 : 0, change.optedIn ? null : at, at, Date.now(), ...change.also?.binds ?? [], ...change.where.binds, ...fresh.binds)
}

/** Valores de consentimento para uma identidade nova: com consentimento dado, a hora entra junto; sem ele, nada mudou ainda. */
export const newIdentityConsent = (optedIn: boolean, at = Date.now()) => ({ opted_in: optedIn ? 1 : 0, consent_changed_at: optedIn ? at : null })

/** Pedaço do SET da entrada de mensagem: a primeira mensagem privada (`grants`) inscreve quem nunca entrou, se não houver mudança mais nova
 * (antes valia mesmo mais velha que um descadastro feito pela equipe). `tap`: o toque no botão da resposta privada a um comentário (Instagram)
 * é um opt-in de verdade: com a mesma guarda, e grava a hora. */
export function firstInboundOptIn(grants: boolean, at: number, tap = false): Fragment {
  const fresh = '(consent_changed_at IS NULL OR consent_changed_at<=?)'
  const when = `(?=1 AND ${fresh} OR first_inbound_id IS NULL AND ?=1 AND ${fresh})`, whenBinds = [tap ? 1 : 0, at, grants ? 1 : 0, at]
  return { sql: `opted_in=CASE WHEN ${when} THEN 1 ELSE opted_in END, opted_out_at=CASE WHEN ${when} THEN NULL ELSE opted_out_at END,
      consent_changed_at=CASE WHEN ?=1 AND ${fresh} THEN ? ELSE consent_changed_at END`,
    binds: [...whenBinds, ...whenBinds, tap ? 1 : 0, at, at] }
}

/** Bloqueia ou desbloqueia as identidades que `where` escolhe. Fato mais velho que a última mudança de bloqueio não vale; bloqueio mais
 * velho que a última mensagem do contato também não (ele alcançou a conta depois). */
export function changeBlock(db: D1Database, change: { blocked: boolean; at: number; where: Fragment }): D1PreparedStatement {
  const guard = change.blocked ? '(block_changed_at IS NULL OR block_changed_at<=?) AND coalesce(last_inbound_at,0)<=?' : '(block_changed_at IS NULL OR block_changed_at<=?)'
  return db.prepare(`UPDATE contact_channels SET blocked_at=${change.blocked ? 'coalesce(blocked_at,?)' : 'NULL'}, block_changed_at=? WHERE ${change.where.sql} AND ${guard}`)
    .bind(...change.blocked ? [change.at] : [], change.at, ...change.where.binds, change.at, ...change.blocked ? [change.at] : [])
}
