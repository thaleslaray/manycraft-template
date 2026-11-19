import { apiRequest } from './api'

export type SystemField = 'first_name' | 'last_name' | 'email' | 'phone' | 'gender' | 'locale' | 'timezone'
export const systemFieldNames: Record<SystemField, string> = { first_name: 'Nome', last_name: 'Sobrenome', email: 'E-mail', phone: 'Telefone', gender: 'Gênero', locale: 'Idioma', timezone: 'Fuso horário' }
export type RuleTrigger = { type: '' | 'tag_added' | 'tag_removed' | 'field_changed' | 'contact_created' | 'sequence_entered' | 'date' | 'system_field_changed' | 'sequence_left'; field_id?: string; repeat_yearly?: boolean; offset_seconds?: number; at_time?: string }
export type RuleConditionItem = { type: 'tag'; tag_id: string; operator: 'has' | 'not_has' } | { type: 'field'; field_id: string; operator: 'equals' | 'not_equals' | 'contains' | 'is_set' | 'is_not_set' | 'gt' | 'gte' | 'lt' | 'lte'; value?: unknown }
export type RuleCondition = { match: 'all' | 'any'; groups: { match: 'all' | 'any'; rules: RuleConditionItem[] }[] }
export type RuleAction = { type: 'add_tag' | 'remove_tag'; tag_id: string } | { type: 'set_custom_field_value'; field_id: string; value: unknown } | { type: 'unset_custom_field_value'; field_id: string } | { type: 'add_to_sequence' | 'remove_from_sequence'; sequence_id: string } | { type: 'start_automation'; automation_id: string }
export type RuleConfig = { trigger: RuleTrigger; event_filter?: { tag_id?: string; field_id?: string; sequence_id?: string; system_field?: SystemField; operator?: 'equals' | 'contains'; value?: unknown }; condition?: RuleCondition; actions: RuleAction[]; frequency: 'once' | 'always' }
export type RuleInput = RuleConfig & { name: string }
export type Rule = { id: string; name: string; active: boolean; draft: RuleConfig; published: RuleConfig | null; executions: number; unique_contacts: number; updated_at: string }

export const listRules = () => apiRequest<Rule[]>('/rules')
export const saveRule = (input: RuleInput, id?: string) => apiRequest<Rule>(`/rules${id ? `/${encodeURIComponent(id)}` : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(input) })
export const publishRule = (id: string) => apiRequest<Rule>(`/rules/${encodeURIComponent(id)}/publish`, { method: 'POST' })
export const setRuleActive = (id: string, active: boolean) => apiRequest<Rule>(`/rules/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ active }) })
export const duplicateRule = (id: string) => apiRequest<Rule>(`/rules/${encodeURIComponent(id)}/duplicate`, { method: 'POST' })
export const deleteRule = (id: string) => apiRequest(`/rules/${encodeURIComponent(id)}`, { method: 'DELETE' })

const actionNames: Record<RuleAction['type'], string> = { add_tag: 'Aplicar tag', remove_tag: 'Remover tag', set_custom_field_value: 'Definir campo', unset_custom_field_value: 'Limpar campo', add_to_sequence: 'Inscrever em sequência', remove_from_sequence: 'Cancelar sequência', start_automation: 'Iniciar automação' }
/** O que falta para salvar a regra, dito pelo campo (o servidor só responderia "Dados inválidos."). `null` quando está completa. */
export function ruleProblem(input: RuleInput): string | null {
  if (!input.name.trim()) return 'Dê um nome à regra.'
  if (!input.trigger.type) return 'Escolha um gatilho para salvar a regra.'
  if (input.trigger.type === 'date' && !input.trigger.field_id) return 'Escolha um campo de data.'
  if (!input.actions.length) return 'Adicione ao menos uma ação.'
  for (const [index, action] of input.actions.entries()) {
    const where = `Ação ${index + 1} (${actionNames[action.type] ?? 'ação'}): `
    if ((action.type === 'add_tag' || action.type === 'remove_tag') && !action.tag_id) return `${where}escolha a tag.`
    if ((action.type === 'add_to_sequence' || action.type === 'remove_from_sequence') && !action.sequence_id) return `${where}escolha a sequência.`
    if (action.type === 'start_automation' && !action.automation_id) return `${where}escolha a automação.`
    if ((action.type === 'set_custom_field_value' || action.type === 'unset_custom_field_value') && !action.field_id) return `${where}escolha o campo.`
    if (action.type === 'set_custom_field_value' && action.value === undefined) return `${where}informe o valor.`
  }
  return null
}
