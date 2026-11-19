import type { WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'
import { RateLimited, type ChannelAdapter, type ChannelCapabilities, type OutboundMessage } from '../channels'
import { questionAnswer, validTimeZone, questionCapabilityError, questionFieldType, questionListFits, questionSchema, questionSystemField, questionSystemFieldFits, type QuestionAttachment, type QuestionConfig } from '../schemas/question'
import { contactVariableRenderer } from '../db/message-variables'
import { notifyTimeline } from '../inbox/service'
import type { FlowEnv, Run } from './types'
import { assertRunActive } from './state'
import { activeRunStatusSql, finalRunStatusSql, moveRun, runGuard } from './run-state'
import { CONNECTION_WAIT_MAX_MS, connectionWaitCode, waitForConnection } from './connection-wait'

type Question = { run_id: string; step_index: number; workspace_id: string; contact_id: string; channel_id: string; config: string; token: string; expires_at: number; attempts: number; status: string }
type Receipt = { run_id: string; step_index: number; attempt: number; outcome: string; delivered_at: number | null }
/** true quando o campo existe; um campo excluído depois da publicação não derruba a automação: a pergunta segue e só a gravação para. */
export async function assertQuestionField(db: D1Database, workspace: string, config: QuestionConfig): Promise<boolean> {
  if (questionSystemField(config.field_id)) {
    if (!questionSystemFieldFits(config.field_id, config.answer_type)) throw new NonRetryableError('Escolha um campo compatível com a resposta.')
    return true
  }
  const field = await db.prepare("SELECT type,archived FROM custom_fields WHERE workspace_id=? AND id=? AND scope='contact'")
    .bind(workspace, config.field_id).first<{ type: string; archived: number }>()
  if (!field) return false
  if (field.archived || field.type !== questionFieldType(config.answer_type)) throw new NonRetryableError('Escolha um campo de contato ativo e compatível com a resposta.')
  return true
}
export function questionMessage(config: QuestionConfig, caps: ChannelCapabilities, token: string, text: string): OutboundMessage {
  const choices = config.answer_type === 'multiple_choice' ? config.choices.map((title, i) => ({ title, id: `q:${token}:${i}` })) : []
  if (config.skip) choices.push({ title: 'Pular', id: `q:${token}:s` })
  if (!choices.length) return { kind: 'text', text }
  if (caps.buttons.types.includes('postback') && choices.length <= caps.buttons.maxPerMessage && choices.every(v => [...v.title].length <= caps.buttons.titleMax)) return { kind: 'text', text, buttons: choices.map(c => ({ ...c, type: 'postback' })) }
  if (caps.quickReplies && choices.length <= caps.quickReplies.max && choices.every(v => [...v.title].length <= caps.quickReplies!.titleMax)) return { kind: 'text', text, quickReplies: choices }
  // Too many options for buttons: a list, whose picked row comes back as the same click.
  if (config.answer_type === 'multiple_choice' && questionListFits(config, caps) && [...text].length <= 1024) return { kind: 'list', text, buttonText: 'Escolher', sections: [{ rows: choices.map(c => ({ id: c.id, title: c.title })) }] }
  return { kind: 'text', text: `${text}\n\nDigite Pular para continuar sem responder.` }
}
export async function executeQuestion(env: FlowEnv, step: WorkflowStep, run: Run, index: number, nodeId: string,
  input: Record<string, unknown>, adapter: ChannelAdapter, caps: ChannelCapabilities): Promise<string> {
  const config = questionSchema.parse(input)
  const unsupported = questionCapabilityError(config, caps)
  if (unsupported || run.reply_group_jid) throw new NonRetryableError(unsupported ?? 'Perguntas de captura exigem conversa privada.')
  const timeoutMs = config.timeout.value * { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 }[config.timeout.unit]
  const question = await step.do(`question-open:${index}`, async () => {
    await assertRunActive(env, run.id)
    await assertQuestionField(env.DB, run.workspace_id, config)
    const token = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('')
    const expires = Date.now() + timeoutMs
    await env.DB.batch([
      // A previous cancelled/failed collection cannot block a later run forever.
      env.DB.prepare(`UPDATE flow_questions SET status='stopped' WHERE workspace_id=? AND contact_id=? AND channel_id=? AND status='open'
        AND run_id IN (SELECT id FROM flow_runs WHERE status IN (${finalRunStatusSql}))`).bind(run.workspace_id, run.contact_id, run.channel_id),
      env.DB.prepare(`INSERT INTO flow_questions(run_id,step_index,workspace_id,contact_id,channel_id,node_id,config,token,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,step_index) DO NOTHING`).bind(run.id, index, run.workspace_id, run.contact_id, run.channel_id, nodeId, JSON.stringify(config), token, expires),
      moveRun(env.DB, run.id, 'waiting_input', { waitUntil: { sql: '(SELECT expires_at FROM flow_questions WHERE run_id=? AND step_index=?)', binds: [run.id, index] } }),
    ])
    return (await env.DB.prepare('SELECT * FROM flow_questions WHERE run_id=? AND step_index=?').bind(run.id, index).first<Question>())!
  })
  for (let attempt = 0; attempt < config.max_attempts; attempt++) {
    const send = (name: string) => step.do(name, { retries: { limit: 5, delay: ({ error }) => error instanceof RateLimited ? error.retryAfter * 1000 : 1000 }, timeout: '30 seconds' }, async () => {
      await assertRunActive(env, run.id)
      const active = await env.DB.prepare('SELECT status,expires_at FROM flow_questions WHERE run_id=? AND step_index=?').bind(run.id, index).first<{ status: string; expires_at: number }>()
      if (!active || active.status !== 'open') return active?.status ?? 'stopped'
      if (active.expires_at <= Date.now()) {
        await env.DB.prepare("UPDATE flow_questions SET status='no_response' WHERE run_id=? AND step_index=? AND status='open'").bind(run.id, index).run()
        return 'no_response'
      }
      await assertQuestionField(env.DB, run.workspace_id, config)
      const state = await env.DB.prepare(`SELECT cc.opted_in,cc.window_expires_at,cc.human_window_expires_at,cc.blocked_at,c.status FROM contact_channels cc
        JOIN contacts c ON c.workspace_id=cc.workspace_id AND c.id=cc.contact_id
        JOIN channels ch ON ch.workspace_id=cc.workspace_id AND ch.id=cc.channel_id
        WHERE cc.workspace_id=? AND cc.contact_id=? AND cc.channel_id=? AND ch.archived_at IS NULL`)
        .bind(run.workspace_id, run.contact_id, run.channel_id).first<{ opted_in: number; window_expires_at: number | null; human_window_expires_at: number | null; blocked_at: number | null; status: string }>()
      // Desligada pela equipe não some daqui: a entrega recusa com connection_unavailable e a pergunta espera ser religada (arquivada falha).
      if (!state) throw new NonRetryableError('Contact connection missing')
      const mode = adapter.canSend({ optedIn: state.opted_in === 1 && state.status === 'subscribed', windowExpiresAt: state.window_expires_at, humanWindowExpiresAt: state.human_window_expires_at, blocked: state.blocked_at !== null }, Date.now(), 'automation')
      if (!mode.ok) throw new NonRetryableError(`Channel send failed: ${mode.reason}`)
      const render = await contactVariableRenderer(env.DB, run.workspace_id, run.contact_id)
      const fitted = adapter.fit(questionMessage(config, caps, question.token, render(attempt === 0 ? config.text : config.retry_message)), caps)
      if ('ok' in fitted) throw new NonRetryableError('Channel send failed: unsupported')
      for (const [part, message] of fitted.messages.entries()) {
        const result = await adapter.send({ run, runId: run.id, step: index, part: attempt * 1000 + part, channelId: run.channel_id, externalUserId: run.external_user_id, mode }, message)
        if (!result.ok) {
          if (result.reason === 'rate_limited') throw new RateLimited(result.retryAfterSec)
          // Conexão restrita ou fora do ar: espera o conserto como a mensagem comum (connection-wait.ts). Partes já enviadas não saem de novo.
          const wait = connectionWaitCode(result)
          if (wait) return wait
          throw new NonRetryableError(`Channel send failed: ${result.reason}`)
        }
      }
      await notifyTimeline(env, run.workspace_id)
      return 'open'
    })
    let delivery = await send(`question-send:${index}:${attempt}`)
    let deadline: number | undefined
    for (let w = 1; delivery === 'connection_restricted' || delivery === 'connection_unavailable'; w++) {
      deadline ??= await step.do(`connection-deadline:question:${index}:${attempt}`, async () => Date.now() + CONNECTION_WAIT_MAX_MS)
      await waitForConnection(env, step, run, `question:${index}:${attempt}:${w - 1}`, deadline, delivery)
      // O prazo da resposta volta a contar inteiro antes do envio (a espera pode ter levado dias); a execução volta a esperar a resposta.
      question.expires_at = await step.do(`question-renew:${index}:${attempt}:${w - 1}`, async () => {
        await assertRunActive(env, run.id)
        const expires = Date.now() + timeoutMs
        await env.DB.batch([
          env.DB.prepare("UPDATE flow_questions SET expires_at=? WHERE run_id=? AND step_index=? AND status='open'").bind(expires, run.id, index),
          moveRun(env.DB, run.id, 'waiting_input', { waitUntil: expires, from: ['running'] }),
        ])
        return expires
      })
      delivery = await send(`question-send:${index}:${attempt}:w${w}`)
    }
    if (delivery !== 'open') return delivery
    let expired = false
    try {
      await step.waitForEvent(`question-answer:${index}:${attempt}`, { type: `question_${index}_${attempt}`, timeout: Math.max(1000, question.expires_at - Date.now()) })
    } catch { expired = true }
    const outcome = await step.do(`question-result:${index}:${attempt}`, async () => {
      if (expired) await env.DB.prepare("UPDATE flow_questions SET status='no_response' WHERE run_id=? AND step_index=? AND status='open'").bind(run.id, index).run()
      const row = await env.DB.prepare('SELECT status FROM flow_questions WHERE run_id=? AND step_index=?').bind(run.id, index).first<{ status: string }>()
      return row?.status ?? 'stopped'
    })
    if (outcome !== 'open') return outcome
  }
  return 'no_response'
}
/** Replay an event only from a persisted receipt. Queue retry cannot revalidate against a newer question or count twice. */
export async function deliverQuestionAnswer(env: FlowEnv, inboundId: string): Promise<boolean> {
  const receipt = await env.DB.prepare('SELECT * FROM flow_question_answers WHERE inbound_event_id=?').bind(inboundId).first<Receipt>()
  if (!receipt) return false
  if (receipt.delivered_at === null) {
    const instance = await env.FLOW_RUN.get(receipt.run_id)
    await instance.sendEvent({ type: `question_${receipt.step_index}_${receipt.attempt}`, payload: { inboundId } })
    await env.DB.prepare('UPDATE flow_question_answers SET delivered_at=? WHERE inbound_event_id=?').bind(Date.now(), inboundId).run()
  }
  return true
}
/** `at`: when the contact answered (provider time, never after receipt). A consent change older than the last one applied changes nothing. */
export async function consumeQuestionAnswer(env: FlowEnv, workspace: string, channel: string, contact: string, inboundId: string, raw: string, token?: string, attachment?: QuestionAttachment, at = Date.now()): Promise<boolean> {
  // A pergunta aberta é lida em paralelo com o recibo (uma ida); com recibo, a leitura é descartada.
  const questionRead = env.DB.prepare(`SELECT q.* FROM flow_questions q JOIN flow_runs r ON r.id=q.run_id
    JOIN contacts c ON c.workspace_id=q.workspace_id AND c.id=q.contact_id
    JOIN contact_channels cc ON cc.workspace_id=q.workspace_id AND cc.contact_id=q.contact_id AND cc.channel_id=q.channel_id
    WHERE q.workspace_id=? AND q.channel_id=? AND q.contact_id=? AND q.status='open' AND r.status IN (${activeRunStatusSql}) AND c.status='subscribed' AND cc.opted_in=1
    AND NOT (r.status='waiting_delay' AND r.wait_reason='connection' AND q.attempts=0)`)
    .bind(workspace, channel, contact).first<Question>()
  questionRead.catch(() => undefined)
  if (await deliverQuestionAnswer(env, inboundId)) return true
  const question = await questionRead
  if (!question || token !== undefined && token !== question.token) return false
  const config = questionSchema.parse(JSON.parse(question.config))
  const command = raw.trim().toLocaleLowerCase('pt-BR')
  // "Parar" mais antigo que a última mudança de consentimento desta conexão não é mais um pedido de saída: vale como resposta comum.
  const consentAt = command === 'parar' ? await env.DB.prepare('SELECT consent_changed_at FROM contact_channels WHERE workspace_id=? AND contact_id=? AND channel_id=? ORDER BY consent_changed_at DESC LIMIT 1')
    .bind(workspace, contact, channel).first<number | null>('consent_changed_at') : null
  const stopped = command === 'parar' && (consentAt === null || consentAt <= at)
  const skipped = config.skip && command === 'pular'
  const expired = question.expires_at <= Date.now()
  let timeZone: string | undefined
  if (config.answer_type === 'datetime' && !stopped && !skipped && !expired) {
    const zones = await env.DB.prepare('SELECT c.timezone AS contact, w.timezone AS workspace FROM contacts c JOIN workspaces w ON w.id=c.workspace_id WHERE c.workspace_id=? AND c.id=?')
      .bind(workspace, contact).first<{ contact: string | null; workspace: string | null }>()
    timeZone = [zones?.contact, zones?.workspace].find(validTimeZone)
  }
  let value = stopped || skipped || expired ? undefined : questionAnswer(config, raw, attachment, timeZone)
  let outcome = stopped ? 'stopped' : skipped || expired ? 'no_response' : value !== undefined ? 'success'
    : question.attempts + 1 >= config.max_attempts ? 'no_response' : 'retry'
  let keep = true
  if (outcome === 'success') {
    try { keep = await assertQuestionField(env.DB, workspace, config) }
    catch { outcome = 'no_response'; value = undefined }
  }
  const selected = `EXISTS (SELECT 1 FROM flow_question_answers a JOIN flow_questions q ON q.run_id=a.run_id AND q.step_index=a.step_index
    WHERE a.inbound_event_id=? AND q.attempts=a.attempt AND q.status='open')`
  const statements = [env.DB.prepare(`INSERT INTO flow_question_answers(inbound_event_id,run_id,step_index,attempt,outcome,value,answered_at)
    SELECT ?,run_id,step_index,attempts,?,?,? FROM flow_questions WHERE run_id=? AND step_index=? AND attempts=? AND status='open'
    ON CONFLICT DO NOTHING`).bind(inboundId, outcome, outcome === 'success' ? JSON.stringify(value) : null, Date.now(), question.run_id, question.step_index, question.attempts)]
  const system = questionSystemField(config.field_id)
  if (outcome === 'success' && system) {
    // Telefone do contato guarda só dígitos; e-mail em minúsculas. Valor já usado por outro contato não derruba a coleta.
    const stored = system.column === 'phone' ? String(value).replace(/\D/g, '') : system.column === 'email' ? String(value).toLowerCase() : String(value)
    statements.push(env.DB.prepare(`UPDATE contacts SET ${system.column}=?,updated_at=? WHERE workspace_id=? AND id=? AND ${selected}
      AND NOT EXISTS (SELECT 1 FROM contacts o WHERE o.workspace_id=? AND o.id<>? AND o.${system.column}=?)`)
      .bind(stored, Date.now(), workspace, contact, inboundId, workspace, contact, stored))
    // Opt-in junto da coleta: registra o consentimento e libera o canal nas identidades que o contato já tem.
    for (const channelType of config.opt_in) {
      statements.push(env.DB.prepare(`INSERT INTO contact_consents (id,workspace_id,contact_id,channel_type,value,phrase,source) SELECT ?,?,?,?,?,?,? WHERE ${selected}`)
        .bind(`consent-${inboundId}-${channelType}`, workspace, contact, channelType, stored, config.consent_phrase, `question:${question.run_id}:${question.step_index}`, inboundId))
      statements.push(env.DB.prepare(`UPDATE contact_channels SET opted_in=1,opted_out_at=NULL,consent_changed_at=?,updated_at=? WHERE workspace_id=? AND contact_id=? AND ${selected}
        AND channel_id IN (SELECT id FROM channels WHERE workspace_id=? AND type=?) AND (consent_changed_at IS NULL OR consent_changed_at<=?)`).bind(at, Date.now(), workspace, contact, inboundId, workspace, channelType, at))
    }
  } else if (outcome === 'success' && keep) statements.push(env.DB.prepare(`INSERT INTO contact_field_values(workspace_id,contact_id,field_id,value,updated_at)
    SELECT ?,?,?,?,? WHERE ${selected} ON CONFLICT(contact_id,field_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .bind(workspace, contact, config.field_id, JSON.stringify(value), Date.now(), inboundId))
  if (stopped) {
    statements.push(env.DB.prepare(`UPDATE contact_channels SET opted_in=0,opted_out_at=?,consent_changed_at=? WHERE workspace_id=? AND contact_id=? AND channel_id=? AND ${selected}
      AND (consent_changed_at IS NULL OR consent_changed_at<=?)`).bind(at, at, workspace, contact, channel, inboundId, at))
    // Mesma guarda do descadastro, lida depois dele: se uma mudança de consentimento mais nova chegou no meio, nada é cancelado.
    statements.push(env.DB.prepare(`UPDATE flow_runs SET status='cancelled',wait_until=NULL WHERE workspace_id=? AND contact_id=? AND channel_id=? AND ${runGuard('cancelled')} AND ${selected}
      AND EXISTS (SELECT 1 FROM contact_channels WHERE workspace_id=? AND contact_id=? AND channel_id=? AND opted_in=0 AND consent_changed_at<=?)`)
      .bind(workspace, contact, channel, inboundId, workspace, contact, channel, at))
  }
  statements.push(env.DB.prepare(`UPDATE flow_questions SET attempts=attempts+1,status=? WHERE run_id=? AND step_index=? AND attempts=? AND ${selected}`)
    .bind(outcome === 'retry' ? 'open' : outcome, question.run_id, question.step_index, question.attempts, inboundId))
  statements.push(env.DB.prepare('UPDATE inbound_events SET planned_at=? WHERE id=? AND planned_at IS NULL').bind(Date.now(), inboundId))
  await env.DB.batch(statements)
  if (!await deliverQuestionAnswer(env, inboundId)) {
    // Another inbound won this attempt. Re-read the same collection rather than dropping a concurrent reply.
    await consumeQuestionAnswer(env, workspace, channel, contact, inboundId, raw, question.token, attachment, at)
    return true
  }
  // E-mail com opt-in e sem vínculo de e-mail ainda: cria o vínculo já autorizado (junta com este contato pelo e-mail do cadastro).
  if (outcome === 'success' && system?.column === 'email' && config.opt_in.includes('email')) {
    const mail = await env.DB.prepare("SELECT id FROM channels WHERE workspace_id=? AND type='email' AND status='connected' AND archived_at IS NULL ORDER BY created_at LIMIT 1")
      .bind(workspace).first<{ id: string }>()
    if (mail) {
      const { emailContact } = await import('../email-channel/store')
      await emailContact(env as never, workspace, mail.id, String(value), true)
    }
  }
  return true
}

export { questionCapabilityError } from '../schemas/question'
