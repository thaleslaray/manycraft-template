import { RepositoryError, requireRow } from '../db/shared'
import { validateFieldValue } from '../db/fields'
import { ruleInputSchema, type Rule, type RuleConfig, type RuleInput } from './schema'

const globalRule = `json_extract(r.event_config,'$.email_event') IS NULL AND NOT (r.event_type='change_system_field_value' AND coalesce(json_extract(r.event_config,'$.field'),'')='email')`
type Row = { id: string; name: string; active: number; draft: string; published: string | null; executions: number; unique_contacts: number; updated_at: number }
const selection = `SELECT r.*, (SELECT count(*) FROM rule_executions e WHERE e.rule_id=r.id AND completed_at IS NOT NULL) AS executions,
  (SELECT count(DISTINCT contact_id) FROM rule_executions e WHERE e.rule_id=r.id AND completed_at IS NOT NULL) AS unique_contacts FROM rules r`
function decode(row: Row): Rule { return { id: row.id, name: row.name, active: !!row.active, draft: JSON.parse(row.draft), published: row.published ? JSON.parse(row.published) : null,
  executions: row.executions, unique_contacts: row.unique_contacts, updated_at: new Date(row.updated_at).toISOString() } }
export async function listRules(db: D1Database, workspace: string) {
  return (await db.prepare(`${selection} WHERE ${globalRule} AND r.workspace_id=? ORDER BY r.created_at DESC,r.id`).bind(workspace).all<Row>()).results.map(decode)
}
export async function getRule(db: D1Database, workspace: string, id: string) {
  return decode(requireRow(await db.prepare(`${selection} WHERE ${globalRule} AND r.workspace_id=? AND r.id=?`).bind(workspace,id).first<Row>()))
}
export async function validateReferences(db: D1Database, workspace: string, config: RuleConfig) {
  const reference = async (table: string, id: string) => {
    const row = await db.prepare(`SELECT * FROM ${table} WHERE workspace_id=? AND id=?`).bind(workspace,id).first<Record<string,unknown>>()
    if (!row) throw new RepositoryError('A referência não pertence a este espaço.',400)
    return row
  }
  const field = async (id: string) => {
    const row = await reference('custom_fields',id)
    if (row.scope !== 'contact' || row.archived) throw new RepositoryError('Selecione um campo ativo do contato.',400)
    return row
  }
  if (config.trigger.type === 'date') {
    const selected = await field(config.trigger.field_id!)
    if (!['date','datetime'].includes(String(selected.type))) throw new RepositoryError('A regra de data exige um campo de data.',400)
  }
  const filter = config.event_filter
  if (filter.tag_id) await reference('tags',filter.tag_id)
  if (filter.field_id) {
    const selected = await field(filter.field_id)
    if (filter.operator === 'contains' && (selected.type !== 'text' || typeof filter.value !== 'string')) throw new RepositoryError('Contém exige um campo e valor de texto.',400)
    if (filter.operator === 'equals') validateFieldValue(String(selected.type),filter.value)
  }
  if (config.trigger.type === 'system_field_changed' && filter.operator && !filter.system_field) throw new RepositoryError('Selecione o campo do sistema para filtrar seu valor.',400)
  if (filter.system_field && filter.operator && typeof filter.value !== 'string') throw new RepositoryError('O valor de um campo do sistema é texto.',400)
  if (filter.operator && !filter.field_id && !filter.system_field) throw new RepositoryError('Selecione o campo para filtrar seu valor.',400)
  if (filter.sequence_id) await reference('sequences',filter.sequence_id)
  for (const predicate of config.condition?.groups.flatMap(g => g.rules) ?? []) {
    if (predicate.type === 'tag') await reference('tags',predicate.tag_id)
    else {
      const selected = await field(predicate.field_id)
      if (['gt','gte','lt','lte'].includes(predicate.operator) && selected.type !== 'number') throw new RepositoryError('Comparações numéricas exigem um campo numérico.',400)
      if (!['is_set','is_not_set'].includes(predicate.operator)) {
        if (predicate.operator === 'contains') {
          if (selected.type !== 'text' || typeof predicate.value !== 'string') throw new RepositoryError('Contém exige um campo e valor de texto.',400)
        } else validateFieldValue(String(selected.type),predicate.value)
      }
    }
  }
  for (const action of config.actions) {
    if (action.type === 'add_tag' || action.type === 'remove_tag') await reference('tags',action.tag_id)
    else if (action.type === 'set_custom_field_value' || action.type === 'unset_custom_field_value') {
      const selected = await field(action.field_id)
      if (action.type === 'set_custom_field_value') validateFieldValue(String(selected.type),action.value)
    } else if (action.type === 'add_to_sequence' || action.type === 'remove_from_sequence') await reference('sequences',action.sequence_id)
    else if (action.type === 'start_automation') {
      const automation = await reference('automations',action.automation_id)
      if (automation.deleted_at != null || automation.status !== 'live' || !automation.published_version_id) throw new RepositoryError('Escolha uma automação publicada e ativa.',400)
    }
  }
}
export async function saveRule(db: D1Database, workspace: string, input: RuleInput, id?: string) {
  const { name,...config } = ruleInputSchema.parse(input)
  await validateReferences(db,workspace,config)
  const now = Date.now()
  if (id) {
    await getRule(db,workspace,id)
    await db.prepare('UPDATE rules SET name=?,draft=?,updated_at=? WHERE workspace_id=? AND id=?').bind(name,JSON.stringify(config),now,workspace,id).run()
  } else {
    id = crypto.randomUUID()
    await db.prepare(`INSERT INTO rules(id,workspace_id,name,draft,created_at,updated_at,kind,event_type,action_type,http_request) VALUES(?,?,?,?,?,?,'internal_event','user_created','http_request','{}')`).bind(id,workspace,name,JSON.stringify(config),now,now).run()
  }
  return getRule(db,workspace,id)
}
