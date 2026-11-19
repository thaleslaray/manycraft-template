import { z } from 'zod'
import { staticUrlIssue } from '../flow/external-url'
import { variableErrors } from './message-variables'
import { optChannels } from '../channels/manychat-nodes'
import { assertFieldOperation, fieldOperations } from '../flow/field-operations'
import { validateFieldValue } from '../db/fields'
import { sheetsOperation } from '../google-sheets'
const id = z.string().min(1).max(128)

export type OptChannel = typeof optChannels[number]
export const optActionTypes = optChannels.flatMap(channel => [`set_${channel}_opt_in`, `set_${channel}_opt_out`] as const)
const optAction = z.object({ type: z.enum(optActionTypes) })
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add_tag'), tag_id: id }),
  z.object({ type: z.literal('remove_tag'), tag_id: id }),
  z.object({ type: z.literal('set_custom_field_value'), field_id: id, operation: z.enum(fieldOperations).optional(), value: z.unknown().optional() }),
  z.object({ type: z.literal('unset_custom_field_value'), field_id: id }),
  z.object({ type: z.literal('change_global_field_value'), field_id: id, value: z.unknown().optional(), operation: z.enum(['set', 'add', 'subtract']).optional() }),
  z.object({ type: z.literal('add_to_sequence'), sequence_id: id }),
  z.object({ type: z.literal('remove_from_sequence'), sequence_id: id }),
  z.object({ type: z.literal('assign_conversation'), assignee_id: id.nullable() }),
  z.object({ type: z.literal('open_conversation') }),
  z.object({ type: z.literal('close_conversation') }),
  z.object({ type: z.literal('notify_admin'), message: z.string().trim().min(1).max(2000), recipient_id: id.optional(), via: z.array(z.enum(['email', 'chat'])).max(2).optional() }),
  z.object({ type: z.literal('pause_automations'), duration: z.object({ value: z.number().int().positive(), unit: z.enum(['seconds', 'minutes', 'hours', 'days']) }), automation_id: id.optional(), scope: z.enum(['rules', 'sequences']).optional() }),
  z.object({ type: z.literal('subscribe_to_account'), connection_id: id }),
  z.object({ type: z.literal('unsubscribe_to_account'), connection_id: id }),
  optAction,
  z.object({ type: z.literal('delete_subscriber') }),
  z.object({ type: z.enum(['subscribe_topic', 'unsubscribe_topic']), topic_id: id }),
  z.object({ type: z.literal('set_user_level_menu'), items: z.array(z.object({ title: z.string().trim().min(1).max(30), automation_id: id })).max(20).default([]) }),
  z.object({ type: z.literal('apps_request'), app_id: id, action: z.string().min(1).max(40), inputs: z.record(z.string().max(40), z.string().max(2000)).default({}) }),
  z.object({ type: z.literal('fire_custom_event'), event_name: z.string().trim().min(1).max(100), value: z.number().nonnegative().optional(), currency: z.enum(['BRL', 'USD', 'EUR']).optional() }),
  z.object({ type: z.literal('google_sheets'), sheets: sheetsOperation }),
  z.object({ type: z.literal('external_request'), method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']), url: z.string().trim().min(1).max(2048),
    headers: z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9-]{1,100}$/).refine(name => !['host', 'content-length', 'connection', 'transfer-encoding'].includes(name.toLowerCase())),
      value: z.string().max(2000) })).max(10).default([]),
    body: z.string().max(10000).optional(),
    mappings: z.array(z.object({ path: z.string().trim().min(1).max(200), field_id: id })).max(10).default([]) }),
])
export type FlowAction = z.infer<typeof actionSchema>

/** Publication and execution use the same references; the runtime also checks the contact's identity. */
export async function validateActionReference(db: D1Database, workspaceId: string, action: FlowAction): Promise<void> {
  let exists: unknown = true
  if (action.type === 'assign_conversation' && action.assignee_id !== null) {
    exists = await db.prepare("SELECT id FROM workspace_members WHERE workspace_id=? AND id=? AND (inbox_seat=1 OR role='owner')")
      .bind(workspaceId, action.assignee_id).first()
  } else if (action.type === 'notify_admin' && action.recipient_id) {
    exists = await db.prepare('SELECT id FROM workspace_members WHERE workspace_id=? AND id=?').bind(workspaceId, action.recipient_id).first()
  } else if (action.type === 'apps_request') {
    exists = await db.prepare('SELECT id FROM installed_apps WHERE workspace_id=? AND id=?').bind(workspaceId, action.app_id).first()
  } else if (action.type === 'subscribe_topic' || action.type === 'unsubscribe_topic') {
    exists = await db.prepare('SELECT id FROM notification_topics WHERE workspace_id=? AND id=?').bind(workspaceId, action.topic_id).first()
  } else if (action.type === 'subscribe_to_account' || action.type === 'unsubscribe_to_account') {
    exists = await db.prepare('SELECT id FROM channels WHERE workspace_id=? AND id=? AND archived_at IS NULL').bind(workspaceId, action.connection_id).first()
  }
  else if (action.type === 'change_global_field_value') {
    const field = await db.prepare("SELECT type,name,archived FROM custom_fields WHERE workspace_id=? AND id=? AND scope='bot'").bind(workspaceId, action.field_id).first<{ type: string; name: string; archived: number }>()
    if (field?.archived) throw new Error(`O campo do bot "${field.name}" está arquivado.`)
    exists = field
    if (field && action.operation && action.operation !== 'set') {
      if (field.type !== 'number' || typeof action.value !== 'number' || !Number.isFinite(action.value)) throw new Error('Somar e subtrair exigem campo do bot numérico e um número.')
    } else if (field && action.value != null && !(field.type === 'text' && typeof action.value === 'string')) validateFieldValue(field.type, action.value)
  }
  else if (action.type === 'google_sheets') {
    if (!await db.prepare("SELECT 1 FROM workspace_integrations WHERE workspace_id=? AND kind='google_sheets'").bind(workspaceId).first()) throw new Error('Conecte o Google Sheets em Configurações > Integrações.')
    const fields = await db.prepare("SELECT id FROM custom_fields WHERE workspace_id=? AND scope='contact' AND archived=0").bind(workspaceId).all<{ id: string }>()
    const known = new Set(fields.results.map(f => f.id)), op = action.sheets
    if (op.operation === 'get_row' && op.mappings.some(m => !known.has(m.field_id))) throw new Error('Campo do mapeamento indisponível neste workspace.')
    const texts = op.operation === 'insert_row' ? op.values : op.operation === 'update_row' ? [op.lookup_value, ...op.values.map(v => v.value)] : [op.lookup_value]
    if (texts.flatMap(text => variableErrors(text, known)).length) throw new Error('Variável inexistente na planilha.')
  }
  else if (action.type === 'pause_automations' && action.automation_id) {
    exists = await db.prepare('SELECT id FROM automations WHERE workspace_id=? AND id=? AND deleted_at IS NULL').bind(workspaceId, action.automation_id).first()
  }
  else if (action.type === 'set_custom_field_value') {
    const field = await db.prepare("SELECT type,name,archived FROM custom_fields WHERE workspace_id=? AND id=? AND scope='contact'").bind(workspaceId, action.field_id).first<{ type: string; name: string; archived: number }>()
    if (field?.archived) throw new Error(`O campo "${field.name}" está arquivado. Escolha outro campo ou restaure este em Campos.`)
    exists = field
    if (field) {
      const operation = action.operation ?? 'set'
      assertFieldOperation(field.type, operation, action.value)
      if (operation === 'set' && !(field.type === 'text' && typeof action.value === 'string')) validateFieldValue(field.type, action.value)
    }
  }
  else if (action.type === 'external_request') {
    const issue = staticUrlIssue(action.url)
    if (issue) throw new Error(issue)
    const fields = await db.prepare("SELECT id FROM custom_fields WHERE workspace_id=? AND scope='contact' AND archived=0").bind(workspaceId).all<{ id: string }>()
    const known = new Set(fields.results.map(field => field.id))
    if (action.mappings.some(mapping => !known.has(mapping.field_id))) throw new Error('Campo do mapeamento indisponível neste workspace.')
    if (new Set(action.mappings.map(mapping => mapping.field_id)).size !== action.mappings.length) throw new Error('Cada campo pode receber só um caminho.')
    const texts = [action.url, (action.body ?? '').replaceAll('{{full_contact_data}}', ''), ...action.headers.map(header => header.value)]
    if (texts.flatMap(text => variableErrors(text, known)).length) throw new Error('Variável inexistente na requisição.')
  }
  if (!exists) throw new Error('A referência da ação não está disponível neste workspace.')
}
