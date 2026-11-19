import { Plus, Trash2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import type { SettingsItem } from '@/data/settings'
import type { RuleCondition, RuleConditionItem } from '@/data/rules'

export type RuleCatalog = { tags: { id: string; name: string }[]; fields: SettingsItem[]; sequences: { id: string; name: string }[]; flows: { id: string; name: string; published: boolean }[] }
const NONE = '__nenhum'
/** Escolha em lista do sistema (sem seletor nativo). Com `placeholder` explícito a primeira opção limpa a escolha. */
export function SelectField({ id, label, value, options, onChange, placeholder, hideLabel }: { id: string; label: string; value: string; options: { id: string; name: string }[]; onChange: (value: string) => void; placeholder?: string; hideLabel?: boolean }) {
  return <div className="min-w-0 space-y-1"><label htmlFor={id} className={hideLabel ? 'sr-only' : 'text-sm font-medium'}>{label}</label>
    <Select value={value} onValueChange={next => onChange(next === NONE ? '' : next)}>
      <SelectTrigger id={id} className="w-full"><SelectValue placeholder={placeholder ?? 'Escolha uma opção'} /></SelectTrigger>
      <SelectContent>{placeholder && <SelectItem value={NONE}>{placeholder}</SelectItem>}{value && !options.some(option => option.id === value) && <SelectItem value={value}>Referência indisponível</SelectItem>}{options.map(option => <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>)}</SelectContent>
    </Select></div>
}

export function RuleValue({ id, label, value, field, onChange }: { id: string; label: string; value: unknown; field?: SettingsItem; onChange: (value: unknown) => void }) {
  const type = field?.field_type
  if (type === 'boolean') return <SelectField id={id} label={label} value={value === true ? 'true' : value === false ? 'false' : ''} onChange={raw => onChange(raw === 'true' ? true : raw === 'false' ? false : '')} options={[{ id: 'true', name: 'Verdadeiro' }, { id: 'false', name: 'Falso' }]} />
  return <div className="space-y-1"><label htmlFor={id} className="text-sm font-medium">{label}{type === 'array' ? ' (lista JSON)' : type === 'datetime' ? ' (data e hora com fuso)' : ''}</label><Input id={id} disabled={!field} type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'} step={type === 'number' ? 'any' : undefined} value={typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')} onChange={event => {
    const raw = event.target.value
    if (type === 'number') onChange(raw === '' ? '' : Number(raw))
    else if (type === 'array') { try { onChange(JSON.parse(raw)) } catch { onChange(raw) } }
    else onChange(raw)
  }} /></div>
}
const matches = [{ id: 'all', name: 'Todas (E)' }, { id: 'any', name: 'Qualquer uma (OU)' }]
const comparisons = [{ id: 'equals', name: 'Igual a' }, { id: 'not_equals', name: 'Diferente de' }, { id: 'contains', name: 'Contém' }, { id: 'is_set', name: 'Tem valor' }, { id: 'is_not_set', name: 'Não tem valor' }, { id: 'gt', name: 'Maior que' }, { id: 'gte', name: 'Maior ou igual' }, { id: 'lt', name: 'Menor que' }, { id: 'lte', name: 'Menor ou igual' }]
export function RuleConditions({ condition, catalog, onChange }: { condition: RuleCondition; catalog: RuleCatalog; onChange: (condition: RuleCondition) => void }) {
  function setGroup(index: number, patch: Partial<RuleCondition['groups'][number]>) { onChange({ ...condition, groups: condition.groups.map((group, i) => i === index ? { ...group, ...patch } : group) }) }
  function setItem(group: number, index: number, item: RuleConditionItem) { setGroup(group, { rules: condition.groups[group].rules.map((rule, i) => i === index ? item : rule) }) }
  return <section aria-label="Condições do contato" className="min-w-0 space-y-4 border-t border-border pt-4">
    <h2 className="font-semibold">Se o contato atender</h2>
    {!condition.groups.length ? <p className="text-sm text-text-muted">Sem condições adicionais. A regra vale para todo contato que passar pelo gatilho.</p> : <SelectField id="rule-condition-match" label="Combinar grupos" value={condition.match} options={matches} onChange={match => onChange({ ...condition, match: match as 'all' | 'any' })} />}
    {condition.groups.map((group, g) => <fieldset key={g} className="min-w-0 space-y-3 rounded-md border border-border p-3"><legend className="px-1 text-xs font-semibold text-text-muted">Grupo {g + 1}</legend>
      <SelectField id={`rule-group-${g}`} label={`Combinar condições do grupo ${g + 1}`} value={group.match} options={matches} onChange={match => setGroup(g, { match: match as 'all' | 'any' })} />
      {group.rules.map((rule, r) => {
        const key = `${g + 1}.${r + 1}`
        return <div key={r} className="min-w-0 space-y-3 border-t border-border pt-3">
          <div className="flex items-end gap-1"><div className="min-w-0 flex-1"><SelectField id={`rule-condition-type-${key}`} label={`Condição ${key}`} value={rule.type} options={[{ id: 'tag', name: 'Verificar tag' }, { id: 'field', name: 'Comparar campo' }]} onChange={type => setItem(g, r, type === 'tag' ? { type, tag_id: '', operator: 'has' } : { type: 'field', field_id: '', operator: 'equals', value: '' })} /></div><Button type="button" variant="ghost" size="icon" aria-label={`Remover condição ${key}`} disabled={group.rules.length === 1} onClick={() => setGroup(g, { rules: group.rules.filter((_, i) => i !== r) })}><Trash2 className="size-4" aria-hidden="true" /></Button></div>
          {rule.type === 'tag' ? <><SelectField id={`rule-condition-tag-${key}`} label={`Tag da condição ${key}`} value={rule.tag_id} options={catalog.tags} onChange={tag_id => setItem(g, r, { ...rule, tag_id })} /><SelectField id={`rule-condition-comparison-${key}`} label={`Comparação ${key}`} value={rule.operator} options={[{ id: 'has', name: 'Possui a tag' }, { id: 'not_has', name: 'Não possui a tag' }]} onChange={operator => setItem(g, r, { ...rule, operator: operator as 'has' | 'not_has' })} /></>
            : <><SelectField id={`rule-condition-field-${key}`} label={`Campo da condição ${key}`} value={rule.field_id} options={catalog.fields} onChange={field_id => setItem(g, r, { ...rule, field_id, operator: 'equals', value: '' })} /><SelectField id={`rule-condition-comparison-${key}`} label={`Comparação ${key}`} value={rule.operator} options={comparisons.filter(option => option.id === 'contains' ? catalog.fields.find(f => f.id === rule.field_id)?.field_type === 'text' : ['gt', 'gte', 'lt', 'lte'].includes(option.id) ? catalog.fields.find(f => f.id === rule.field_id)?.field_type === 'number' : true)} onChange={operator => setItem(g, r, { ...rule, operator: operator as typeof rule.operator })} />{!['is_set', 'is_not_set'].includes(rule.operator) && <RuleValue id={`rule-condition-value-${key}`} label={`Valor da condição ${key}`} value={rule.value} field={catalog.fields.find(f => f.id === rule.field_id)} onChange={value => setItem(g, r, { ...rule, value })} />}</>}
        </div>
      })}
      <div className="flex flex-wrap gap-1"><Button type="button" size="sm" variant="secondary" className="h-auto min-h-8 max-w-full whitespace-normal" disabled={group.rules.length >= 20} onClick={() => setGroup(g, { rules: [...group.rules, { type: 'tag', tag_id: '', operator: 'has' }] })}>Adicionar condição ao grupo {g + 1}</Button><Button type="button" size="sm" variant="ghost" onClick={() => onChange({ ...condition, groups: condition.groups.filter((_, i) => i !== g) })}>Remover grupo {g + 1}</Button></div>
    </fieldset>)}
    <Button type="button" variant="secondary" disabled={condition.groups.length >= 10} onClick={() => onChange({ ...condition, groups: [...condition.groups, { match: 'all', rules: [{ type: 'tag', tag_id: '', operator: 'has' }] }] })}><Plus className="size-4" aria-hidden="true" />Adicionar grupo</Button>
  </section>
}
