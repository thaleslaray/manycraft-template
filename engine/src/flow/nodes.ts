import { runAppAction } from '../apps'
import { connectionRuntime } from '../channels/core/runtime'
import { limit } from '../security'
import { runSheets, sheetsAccount } from '../google-sheets'
import { z } from 'zod'
import { durationSchema, mediaBlockSchema, cardBlockSchema, galleryBlockSchema, quickReplyBlockSchema, listBlockSchema, typingBlockSchema } from '../schemas/graph'
import { NonRetryableError } from 'cloudflare:workflows'
import { object, stableId, type FlowEnv, type Run } from './types'
import { ensureWorkflow } from './dispatch'
import { isFinalRunStatus, isSafetyPaused, moveRun } from './run-state'
import { sequenceAction, sequenceRunActive } from './sequences'
import { matchesFlowCondition } from './conditions'
import { validateFieldValue } from '../db/fields'
import { actionSchema } from '../schemas/actions'
import { contactVariableRenderer } from '../db/message-variables'
import { applyFieldOperation, hasVariable, numericValue, operationsByFieldType } from './field-operations'
import { buttonActionSchema } from '../schemas/graph'
import { editorActionStatements, notifyActionEffects } from './editor-actions'
import { deleteContacts } from '../contacts'
import { logStatement, performExternalRequest } from './external-request'
import { logTaskError } from '../log-error'

export function milliseconds(value: unknown): number {
  const d = durationSchema.parse(value)
  const result = d.value * { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 }[d.unit]
  if (result > 365 * 86400000) throw new NonRetryableError('Duration exceeds one year')
  return result
}
export async function metric(env: FlowEnv, run: Run, nodeId: string, type: 'sent' | 'clicked', buttonId: string | null = null) {
  await env.DB.prepare(`INSERT INTO node_events (workspace_id,automation_id,node_id,button_id,contact_id,flow_run_id,type)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
    .bind(run.workspace_id, run.automation_id, nodeId, buttonId, run.contact_id, run.id, type).run()
}
export async function actions(env: FlowEnv, run: Run, config: Record<string, unknown>, stepIndex = 0) {
  const list = z.array(actionSchema).parse(config.actions)
  const deleted = list.some(action => action.type === 'delete_subscriber')
  if (await env.DB.prepare('SELECT run_id FROM timeline_action_receipts WHERE run_id=? AND step_index=?').bind(run.id, stepIndex).first()) {
    await notifyActionEffects(env, run)
    return { deleted }
  }
  if (!await sequenceRunActive(env, run.id)) throw new NonRetryableError('Sequence enrollment cancelled')
  const statements: D1PreparedStatement[] = []
  // Valores já calculados neste passo: duas operações no mesmo campo acumulam em vez de ler o valor antigo duas vezes.
  const fieldValues = new Map<string, unknown>()
  let timeZone: string | undefined
  let render: Awaited<ReturnType<typeof contactVariableRenderer>> | undefined
  const renderer = async () => render ??= await contactVariableRenderer(env.DB, run.workspace_id, run.contact_id)
  const pending = 'NOT EXISTS (SELECT 1 FROM timeline_action_receipts WHERE run_id=? AND step_index=?)'
  for (const [actionIndex, action] of list.entries()) {
    if (action.type === 'delete_subscriber') break
    if (action.type === 'add_tag' || action.type === 'remove_tag') {
      if (!await env.DB.prepare('SELECT id FROM tags WHERE workspace_id=? AND id=?').bind(run.workspace_id, action.tag_id).first()) {
        throw new NonRetryableError('Tag not found in workspace')
      }
      statements.push(action.type === 'add_tag'
        ? env.DB.prepare('INSERT INTO contact_tags (workspace_id,contact_id,tag_id) SELECT ?,?,? WHERE ' + pending + ' ON CONFLICT DO NOTHING').bind(run.workspace_id, run.contact_id, action.tag_id, run.id, stepIndex)
        : env.DB.prepare('DELETE FROM contact_tags WHERE workspace_id=? AND contact_id=? AND tag_id=? AND ' + pending).bind(run.workspace_id, run.contact_id, action.tag_id, run.id, stepIndex))
    } else if (action.type === 'set_user_level_menu') {
      // Menu dinâmico por contato: no máximo 10 trocas a cada 10 minutos por contato (limite do provedor); lista vazia volta ao menu da conexão.
      try {
        await limit(env as never, `user-menu:${run.contact_id}`, 10, 600_000)
        const rt = await connectionRuntime(env, run.workspace_id, run.channel_id, { requireConnected: true })
        if (rt.provider?.configureUserMenu) await rt.provider.configureUserMenu({ connection: rt.connection, credentials: await rt.credentials(), fetch: rt.fetch },
          run.external_user_id ?? '', action.items.length ? action.items.map(i => ({ title: i.title, payload: `usermenu:${i.automation_id}` })) : null)
      } catch (error) { logTaskError('user_menu_failed', error) }
    } else if (action.type === 'apps_request') {
      // Ação de app instalado: falha do serviço vai para os registros e o fluxo segue (como a requisição externa).
      try { await runAppAction(env, run.workspace_id, run, action.app_id, action.action, action.inputs) }
      catch (error) {
        await env.DB.prepare(`INSERT INTO external_request_logs (id,workspace_id,automation_id,node_id,run_id,contact_id,source,method,target,status,outcome,error_code,message,duration_ms)
          VALUES (?,?,?,NULL,?,?,'run','POST',?,NULL,'error','app',?,0) ON CONFLICT(id) DO NOTHING`)
          .bind(`app-${run.id}-${stepIndex}-${actionIndex}`, run.workspace_id, run.automation_id ?? null, run.id, run.contact_id, `app:${action.app_id}`, error instanceof Error ? error.message : 'Falha no app').run()
      }
    } else if (action.type === 'subscribe_topic' || action.type === 'unsubscribe_topic') {
      // Inscrever de novo (re-opt-in) renova a validade; tópico apagado depois da publicação só pula este passo.
      const topic = await env.DB.prepare('SELECT validity_days FROM notification_topics WHERE workspace_id=? AND id=?').bind(run.workspace_id, action.topic_id).first<number>('validity_days')
      if (topic == null) continue
      const now = Date.now()
      statements.push(env.DB.prepare(`INSERT INTO topic_subscriptions (workspace_id,topic_id,contact_id,status,expires_at,updated_at) SELECT ?,?,?,?,?,? WHERE ${pending}
        ON CONFLICT(topic_id,contact_id) DO UPDATE SET status=excluded.status,expires_at=CASE WHEN excluded.status='subscribed' THEN excluded.expires_at ELSE topic_subscriptions.expires_at END,updated_at=excluded.updated_at`)
        .bind(run.workspace_id, action.topic_id, run.contact_id, action.type === 'subscribe_topic' ? 'subscribed' : 'stopped', now + topic * 86_400_000, now, run.id, stepIndex))
    } else if (action.type === 'add_to_sequence' || action.type === 'remove_from_sequence') {
      statements.push(await sequenceAction(env, run, action.sequence_id, action.type === 'add_to_sequence', stepIndex))
    } else if (action.type === 'set_custom_field_value' || action.type === 'unset_custom_field_value') {
      const field = await env.DB.prepare("SELECT type,name FROM custom_fields WHERE workspace_id=? AND id=? AND scope='contact'")
        .bind(run.workspace_id, action.field_id).first<{ type: string; name: string }>()
      // Campo excluído depois da publicação: a automação segue e só esta gravação para.
      if (!field) continue
      const operation = action.type === 'unset_custom_field_value' ? 'clear' : action.operation ?? 'set'
      const remove = () => statements.push(env.DB.prepare('DELETE FROM contact_field_values WHERE workspace_id=? AND contact_id=? AND field_id=? AND ' + pending).bind(run.workspace_id, run.contact_id, action.field_id, run.id, stepIndex))
      const store = (value: unknown) => {
        fieldValues.set(action.field_id, value)
        statements.push(env.DB.prepare(`INSERT INTO contact_field_values (workspace_id,contact_id,field_id,value) SELECT ?,?,?,? WHERE ${pending}
          ON CONFLICT(contact_id,field_id) DO UPDATE SET value=excluded.value,updated_at=?`)
          .bind(run.workspace_id, run.contact_id, action.field_id, JSON.stringify(value), run.id, stepIndex, Date.now()))
      }
      if (operation === 'clear') { fieldValues.set(action.field_id, null); remove() }
      else {
        const rawValue = 'value' in action ? action.value : undefined
        // Texto e operandos podem trazer variáveis com valor padrão ({{campo:ID|padrão}}).
        const operand = typeof rawValue === 'string' && hasVariable(rawValue) && (field.type === 'text' || operation !== 'set') ? (await renderer())(rawValue) : rawValue
        if (operation === 'set') {
          try { validateFieldValue(field.type, operand) }
          catch (error) { throw new NonRetryableError(error instanceof Error ? error.message : 'Valor inválido do campo.') }
          store(operand)
        } else {
          if (!(operationsByFieldType[field.type] ?? []).includes(operation)) throw new NonRetryableError('Operação incompatível com o tipo do campo.')
          if (!fieldValues.has(action.field_id)) {
            const saved = await env.DB.prepare('SELECT value FROM contact_field_values WHERE workspace_id=? AND contact_id=? AND field_id=?')
              .bind(run.workspace_id, run.contact_id, action.field_id).first<{ value: string }>()
            fieldValues.set(action.field_id, saved ? JSON.parse(saved.value) as unknown : null)
          }
          timeZone ??= (await env.DB.prepare(`SELECT coalesce(c.timezone,w.timezone,'UTC') AS timezone FROM contacts c JOIN workspaces w ON w.id=c.workspace_id
            WHERE c.workspace_id=? AND c.id=?`).bind(run.workspace_id, run.contact_id).first<{ timezone: string }>())?.timezone ?? 'UTC'
          const current = fieldValues.get(action.field_id)
          const result = applyFieldOperation(field.type, operation, operand, current, Date.now(), timeZone)
          if (result.kind === 'value' && (operation === 'add' || operation === 'subtract')) {
            // Somar e subtrair acontecem no banco, na mesma instrução: dois passos ao mesmo tempo não se atropelam.
            const amount = numericValue(operand)!
            const delta = operation === 'add' ? amount : -amount
            const seen = typeof current === 'string' ? JSON.stringify(current) : null
            fieldValues.set(action.field_id, result.value)
            // O resultado inteiro grava o texto canônico ("3", não "3.0"): buscas por valor exato (API pública) comparam o texto.
            const canonical = `CAST(iif(n=CAST(n AS INTEGER),CAST(n AS INTEGER),n) AS TEXT)`
            statements.push(env.DB.prepare(`INSERT INTO contact_field_values (workspace_id,contact_id,field_id,value) SELECT ?,?,?,(SELECT ${canonical} FROM (SELECT ? AS n)) WHERE ${pending}
              ON CONFLICT(contact_id,field_id) DO UPDATE SET value=(SELECT ${canonical} FROM (SELECT CASE WHEN json_type(contact_field_values.value) IN ('integer','real')
                THEN json_extract(contact_field_values.value,'$') ELSE CAST(json_extract(contact_field_values.value,'$') AS REAL) END + ? AS n)),updated_at=?
              WHERE json_type(contact_field_values.value) IN ('integer','real') OR contact_field_values.value=?`)
              .bind(run.workspace_id, run.contact_id, action.field_id, delta, run.id, stepIndex, delta, Date.now(), seen))
          }
          else if (result.kind === 'value') store(result.value)
          else if (result.kind === 'clear') remove()
          else {
            // Nada muda no campo, mas o histórico da conversa diz por quê.
            const amount = numericValue(operand)
            const reason = operation === 'add_days' ? Number.isInteger(amount) ? 'current' : 'operand' : amount === undefined ? 'operand' : 'current'
            statements.push(env.DB.prepare(`INSERT INTO messages (id,workspace_id,conversation_id,direction,source,content,created_at)
              SELECT ?,?,v.id,'out','human',json_object('sender','system','text','','status','sent','event',json_object('kind','field_skipped',
                'field_id',?,'field_name',?,'operation',?,'reason',?)),CAST(unixepoch('subsec')*1000 AS INTEGER)
              FROM conversations v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id
              WHERE v.workspace_id=? AND cc.contact_id=? AND cc.channel_id=? AND ${pending} LIMIT 1 ON CONFLICT(id) DO NOTHING`)
              .bind(`event-skip-${run.id}-${stepIndex}-${actionIndex}`, run.workspace_id, action.field_id, field.name, operation, reason,
                run.workspace_id, run.contact_id, run.channel_id, run.id, stepIndex))
          }
        }
      }
    } else if (action.type === 'change_global_field_value') {
      // Campo do bot é um valor só para o espaço inteiro: o último passo que gravar vence.
      const field = await env.DB.prepare("SELECT type FROM custom_fields WHERE workspace_id=? AND id=? AND scope='bot' AND archived=0")
        .bind(run.workspace_id, action.field_id).first<{ type: string }>()
      if (!field) throw new NonRetryableError('Campo do bot indisponível.')
      if (action.operation === 'add' || action.operation === 'subtract') {
        // Contador global: a conta acontece no banco, então passos simultâneos não perdem incrementos.
        if (field.type !== 'number' || typeof action.value !== 'number') throw new NonRetryableError('Somar e subtrair exigem campo numérico.')
        const delta = action.operation === 'add' ? action.value : -action.value
        statements.push(env.DB.prepare(`UPDATE custom_fields SET bot_value=CAST(coalesce(json_extract(bot_value,'$'),0)+? AS TEXT),updated_at=?
          WHERE workspace_id=? AND id=? AND ${pending}`).bind(delta, Date.now(), run.workspace_id, action.field_id, run.id, stepIndex))
        continue
      }
      let value: unknown = null
      // Sem valor (ou null) limpa o campo.
      if (action.value != null) {
        value = typeof action.value === 'string' && hasVariable(action.value) ? (await renderer())(action.value) : action.value
        try { validateFieldValue(field.type, value) }
        catch (error) { throw new NonRetryableError(error instanceof Error ? error.message : 'Valor inválido do campo.') }
      }
      statements.push(env.DB.prepare(`UPDATE custom_fields SET bot_value=?,updated_at=? WHERE workspace_id=? AND id=? AND ${pending}`)
        .bind(value === null ? null : JSON.stringify(value), Date.now(), run.workspace_id, action.field_id, run.id, stepIndex))
    } else if (action.type === 'google_sheets') {
      // A planilha roda antes do lote; o recibo do passo impede repetir a gravação dos campos e o registro.
      const op = action.sheets, render = await renderer()
      const filled = op.operation === 'insert_row' ? { ...op, values: op.values.map(render) }
        : op.operation === 'update_row' ? { ...op, lookup_value: render(op.lookup_value), values: op.values.map(v => ({ ...v, value: render(v.value) })) }
        : { ...op, lookup_value: render(op.lookup_value) }
      try {
        const acc = await sheetsAccount(env, run.workspace_id)
        if (!acc) throw new Error('Google Sheets desconectado.')
        const result = await runSheets(acc, filled)
        for (const [fieldId, value] of Object.entries(result.found ?? {})) {
          if (op.operation !== 'get_row') break
          statements.push(env.DB.prepare(`INSERT INTO contact_field_values (workspace_id,contact_id,field_id,value) SELECT ?,?,?,? WHERE ${pending}
            ON CONFLICT(contact_id,field_id) DO UPDATE SET value=excluded.value,updated_at=?`).bind(run.workspace_id, run.contact_id, fieldId, JSON.stringify(value), run.id, stepIndex, Date.now()))
        }
      } catch (error) {
        statements.push(env.DB.prepare(`INSERT INTO external_request_logs (id,workspace_id,automation_id,node_id,run_id,contact_id,source,method,target,status,outcome,error_code,message,duration_ms)
          SELECT ?,?,?,NULL,?,?,'run','POST','sheets.googleapis.com',NULL,'error','google_sheets',?,0 WHERE ${pending} ON CONFLICT(id) DO NOTHING`)
          .bind(`sheets-${run.id}-${stepIndex}-${actionIndex}`, run.workspace_id, run.automation_id, run.id, run.contact_id, error instanceof Error ? error.message.slice(0, 500) : 'erro', run.id, stepIndex))
      }
    } else if (action.type === 'external_request') {
      // The request runs before the batch; the receipt keeps replays from applying fields or logging twice.
      const outcome = await performExternalRequest(env, run.workspace_id, run.contact_id, action)
      for (const item of outcome.mapped.filter(mapped => mapped.ok)) {
        statements.push(env.DB.prepare(`INSERT INTO contact_field_values (workspace_id,contact_id,field_id,value) SELECT ?,?,?,? WHERE ${pending}
          ON CONFLICT(contact_id,field_id) DO UPDATE SET value=excluded.value,updated_at=?`)
          .bind(run.workspace_id, run.contact_id, item.field_id, JSON.stringify(item.value), run.id, stepIndex, Date.now()))
      }
      if (outcome.error) statements.push(logStatement(env, { id: `extreq-${run.id}-${stepIndex}-${actionIndex}`, workspace_id: run.workspace_id,
        automation_id: run.automation_id, run_id: run.id, contact_id: run.contact_id, source: 'run', method: action.method }, outcome, { sql: pending, bind: [run.id, stepIndex] }))
    } else statements.push(...(await editorActionStatements(env, run, action, stepIndex, actionIndex) ?? []))
  }
  const receipt = env.DB.prepare('INSERT INTO timeline_action_receipts (run_id,step_index) VALUES (?,?) ON CONFLICT DO NOTHING').bind(run.id, stepIndex)
  if (deleted) await deleteContacts(env, run.workspace_id, [run.contact_id], { beforeErase: statements, afterErase: [receipt], skipTerminationRunId: run.id })
  else await env.DB.batch([...statements, receipt])
  await notifyActionEffects(env, run)
  return { deleted }
}
export async function condition(env: FlowEnv, run: Run, config: Record<string, unknown>): Promise<string> {
  return await matchesFlowCondition(env.DB, run, config) ? 'true' : 'false'
}
export async function randomize(env: FlowEnv, run: Run, nodeId: string, config: Record<string, unknown>): Promise<string> {
  const input = z.object({ variations: z.array(z.object({ id: z.string().min(1), weight: z.number().positive() })).min(2).max(6),
    random_every_time: z.boolean().default(true) }).parse(config)
  if (new Set(input.variations.map(v => v.id)).size !== input.variations.length) throw new NonRetryableError('Duplicate variation')
  const random = crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296
  let cursor = random * input.variations.reduce((sum, v) => sum + v.weight, 0)
  const selected = input.variations.find(v => (cursor -= v.weight) < 0)!.id
  if (input.random_every_time) return selected
  await env.DB.prepare(`INSERT INTO flow_random_assignments (workspace_id,automation_id,contact_id,node_id,variation_id)
    VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(run.workspace_id, run.automation_id, run.contact_id, nodeId, selected).run()
  return (await env.DB.prepare(`SELECT variation_id FROM flow_random_assignments
    WHERE workspace_id=? AND automation_id=? AND contact_id=? AND node_id=?`)
    .bind(run.workspace_id, run.automation_id, run.contact_id, nodeId).first<{ variation_id: string }>())!.variation_id
}
/** Chamada com espera: a automação alvo não pode já estar na cadeia de quem chamou (o laço nunca terminaria). */
async function inCallChain(env: FlowEnv, runId: string, automationId: string): Promise<boolean> {
  const hit = await env.DB.prepare(`WITH RECURSIVE up(id,parent,automation_id) AS (
      SELECT r.id,r.parent_run_id,v.automation_id FROM flow_runs r JOIN automation_versions v ON v.workspace_id=r.workspace_id AND v.id=r.automation_version_id WHERE r.id=?
      UNION ALL SELECT r.id,r.parent_run_id,v.automation_id FROM flow_runs r JOIN up ON r.id=up.parent
      JOIN automation_versions v ON v.workspace_id=r.workspace_id AND v.id=r.automation_version_id)
    SELECT 1 AS hit FROM up WHERE automation_id=? LIMIT 1`).bind(runId, automationId).first()
  return !!hit
}
/** O passo espera o término da chamada, salvo quando foi configurado para seguir sem esperar. */
export const waitsForCall = (node: { type: string; config: Record<string, unknown> }) => node.type === 'start_automation' && node.config.wait_for_finish === true

/** Teto de execuções filhas (de qualquer nível) por execução raiz: cobre o ciclo indireto A → B → A, que a profundidade 8 sozinha deixa multiplicar. */
export const MAX_CHILD_RUNS_PER_ROOT = 20

export async function startAutomation(env: FlowEnv, run: Run, index: number, config: Record<string, unknown>, wait = false) {
  if (!await sequenceRunActive(env, run.id)) throw new NonRetryableError('Sequence enrollment cancelled')
  const automationId = z.string().min(1).parse(config.automation_id)
  if (run.depth >= 8) throw new NonRetryableError('Automation recursion limit')
  if (wait && (automationId === run.automation_id || await inCallChain(env, run.id, automationId))) throw new NonRetryableError('Automation call loop')
  const id = `flow-${await stableId(run.id, String(index), automationId)}`
  // Replays retain the child's first selected version, even after a publication.
  const existing = await env.DB.prepare('SELECT id FROM flow_runs WHERE workspace_id=? AND id=?').bind(run.workspace_id, id).first()
  if (!existing) {
    const root = run.root_run_id ?? run.id
    const children = await env.DB.prepare('SELECT count(*) n FROM flow_runs WHERE root_run_id=?').bind(root).first<{ n: number }>()
    if ((children?.n ?? 0) >= MAX_CHILD_RUNS_PER_ROOT) throw new NonRetryableError('Automation child run limit')
    const target = await env.DB.prepare(`SELECT published_version_id FROM automations WHERE workspace_id=? AND id=?
      AND status='live' AND deleted_at IS NULL AND published_version_id IS NOT NULL`)
      .bind(run.workspace_id, automationId).first<{ published_version_id: string }>()
    if (!target) throw new NonRetryableError('Target automation is not published in workspace')
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO flow_runs (id,workspace_id,contact_id,automation_version_id,channel_id,depth,parent_run_id,root_run_id)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
        .bind(id, run.workspace_id, run.contact_id, target.published_version_id, run.channel_id, run.depth + 1, wait ? run.id : null, root),
      // A run started from one born in a group keeps answering in that group.
      ...(run.reply_group_thread_id ? [env.DB.prepare('UPDATE flow_runs SET reply_group_thread_id=? WHERE workspace_id=? AND id=?').bind(run.reply_group_thread_id, run.workspace_id, id)] : []),
      env.DB.prepare(`INSERT INTO sequence_flow_runs (run_id,workspace_id,sequence_id,step_id,contact_id,enrollment_id)
        SELECT ?,workspace_id,sequence_id,step_id,contact_id,enrollment_id FROM sequence_flow_runs WHERE run_id=? ON CONFLICT DO NOTHING`)
        .bind(id, run.id),
    ])
  }
  await ensureWorkflow(env, id)
  return id
}

export const messageSchema = z.object({ blocks: z.array(z.discriminatedUnion('kind', [
  mediaBlockSchema, cardBlockSchema, galleryBlockSchema, quickReplyBlockSchema, listBlockSchema, typingBlockSchema,
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(4096) }),
  z.object({ kind: z.literal('button'), id: z.string().min(1), label: z.string().min(1).max(4096),
    actions: z.array(buttonActionSchema).max(5).optional(),
    action: z.discriminatedUnion('type', [z.object({ type: z.literal('go_to_node') }), z.object({ type: z.literal('url'), url: z.url({ protocol: /^https?$/ }), webview_size: z.enum(['full', 'medium', 'compact']).optional() }),
      z.object({ type: z.literal('dynamic'), url: z.url({ protocol: /^https$/ }) }), z.object({ type: z.literal('start_automation'), automation_id: z.string().min(1).max(128) })]) }),
])).min(1), click_timeout: durationSchema.optional(), reply_attempts: z.number().int().min(1).max(5).optional() })
export { object }

/** Avisa a execução que espera por esta; se o aviso se perder, ela confere o estado sozinha. */
export async function notifyParent(env: FlowEnv, runId: string): Promise<void> {
  const row = await env.DB.prepare('SELECT parent_run_id FROM flow_runs WHERE id=?').bind(runId).first<{ parent_run_id: string | null }>()
  if (!row?.parent_run_id) return
  try { await (await env.FLOW_RUN.get(row.parent_run_id)).sendEvent({ type: 'child_done', payload: {} }) } catch { /* a conferência periódica retoma */ }
}
/**
 * Estado da execução chamada. Terminal (done, failed, cancelled) libera quem espera; 'paused' é a pausa de segurança da filha
 * (consecutive_block_limit), que não tem retomada: quem espera por ela não pode ficar parado para sempre.
 */
export async function callState(env: FlowEnv, parentRunId: string, childId: string): Promise<string> {
  const row = await env.DB.prepare('SELECT status,wait_reason FROM flow_runs WHERE id=?').bind(childId).first<{ status: string; wait_reason: string | null }>()
  const status = isSafetyPaused(row) ? 'paused' : row?.status ?? 'failed'
  if (status !== 'paused' && !isFinalRunStatus(status)) await moveRun(env.DB, parentRunId, 'waiting_delay', { waitReason: 'call' }).run()
  return status
}
