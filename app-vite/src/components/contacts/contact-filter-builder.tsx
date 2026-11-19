import * as React from 'react'
import { byChannelOrder, ChannelIcon, channelNames, type ChannelId } from "@/components/settings/settings-nav"
import { genderLabel, genderOptions } from './gender'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getSegmentOptions, type ContactFilterRule, type ContactQueryFilter, type FilterOperator, type SegmentOptions } from '@/data/segments'
import { useAsync } from '@/hooks/use-async'

const systemFields = [
  { id: 'first_name', name: 'Primeiro nome', type: 'text' }, { id: 'last_name', name: 'Sobrenome', type: 'text' },
  { id: 'status', name: 'Inscrição', type: 'status' }, { id: 'gender', name: 'Gênero', type: 'gender' }, { id: 'subscribed_at', name: 'Data de inscrição', type: 'datetime' },
  { id: 'last_interaction_at', name: 'Última interação', type: 'datetime' },
  { id: 'phone', name: 'Telefone', type: 'phone' }, { id: 'locale', name: 'Idioma', type: 'locale' }, { id: 'timezone', name: 'Fuso horário', type: 'timezone' },
  { id: 'last_input_text', name: 'Última mensagem do contato', type: 'last_message' }, { id: 'contact_id', name: 'ID do contato', type: 'contact_id' },
]
const channels = [
  { id: 'messenger', name: 'Messenger' }, { id: 'instagram', name: 'Instagram' }, { id: 'whatsapp', name: 'WhatsApp' },
  { id: 'telegram', name: 'Telegram' }, { id: 'tiktok', name: 'TikTok' }, { id: 'email', name: 'E-mail' },
]
const comparisons: Record<string, string> = {
  equals: 'É igual a', not_equals: 'É diferente de', contains: 'Contém', not_contains: 'Não contém', starts_with: 'Começa com', is_set: 'Tem valor', is_not_set: 'Sem valor',
  gt: 'Depois de / maior que', gte: 'Maior ou igual a', lt: 'Antes de / menor que', lte: 'Menor ou igual a', within_last_days: 'Há menos de N dias',
  in_connection: 'Está nesta conta', not_in_connection: 'Não está nesta conta', has: 'Possui a tag', not_has: 'Não possui a tag', inside: 'Dentro da janela de 24 h', outside: 'Fora da janela de 24 h', follow_up_eligible: 'Pode receber follow-up (24+1)', outside_24_plus_1: 'Fora do 24+1',
  subscribed: 'Inscrito', not_subscribed: 'Não inscrito',
  entered_by: 'Entrou por este gatilho', not_entered_by: 'Não entrou por este gatilho',
}
/** Select do sistema com nome acessível; valor vazio mostra o texto de orientação. */
function Pick({ label, value, onChange, options, placeholder, disabled }: { label: string; value: string; onChange: (value: string) => void; options: { id: string; name: string; channel?: string }[]; placeholder?: string; disabled?: boolean }) {
  return <Select value={value} onValueChange={onChange} disabled={disabled}>
    <SelectTrigger aria-label={label} className="min-w-0"><span className="min-w-0 truncate"><SelectValue placeholder={placeholder} /></span></SelectTrigger>
    <SelectContent>{options.map(o => <SelectItem key={o.id} value={o.id} detail={o.channel && o.channel in channelNames && channelNames[o.channel as ChannelId] !== o.name ? channelNames[o.channel as ChannelId] : undefined}>{o.channel && o.channel in channelNames ? <span className="flex min-w-0 items-center gap-2.5"><ChannelIcon channel={o.channel as ChannelId} className="size-6" /><span className="truncate">{o.name}</span></span> : o.name}</SelectItem>)}</SelectContent>
  </Select>
}
function optionsFor(type: string) {
  if (type === 'status') return ['equals', 'not_equals']
  // Dados de texto do próprio contato: só as comparações que fazem sentido para cada um (mesma regra do passo Condição).
  if (type === 'phone') return ['is_set', 'is_not_set', 'starts_with', 'equals', 'not_equals']
  if (type === 'locale' || type === 'timezone') return ['equals', 'not_equals', 'is_set', 'is_not_set']
  if (type === 'last_message') return ['contains', 'not_contains', 'is_set', 'is_not_set']
  if (type === 'contact_id') return ['equals', 'not_equals']
  // Gênero não tem "não é" no original.
  if (type === 'gender') return ['equals', 'is_set', 'is_not_set']
  return ['equals', 'not_equals', 'is_set', 'is_not_set', ...(type === 'text' || type === 'array' ? ['contains', 'not_contains'] : []),
    ...(['number', 'date', 'datetime'].includes(type) ? ['gt', 'gte', 'lt', 'lte'] : []), ...(['date', 'datetime'].includes(type) ? ['within_last_days'] : [])]
}
export function labelFor(rule: ContactFilterRule, options?: SegmentOptions) {
  if (rule.type === 'tag') return `${options?.tags.find(t => t.id === rule.tag_id)?.name ?? 'Tag indisponível'} · ${comparisons[rule.operator]}`
  if (rule.type === 'channel') return `${channels.find(c => c.id === rule.channel)?.name ?? rule.channel} · ${comparisons[rule.operator]}`
  if (rule.type === 'entry_trigger') return `${options?.triggers?.find(t => t.id === rule.trigger_id)?.name ?? 'Gatilho indisponível'} · ${comparisons[rule.operator]}`
  if (rule.type === 'connection') { const account = options?.accounts?.find(c => c.id === rule.connection_id); return `${account ? `${account.label}${channels.find(c => c.id === account.channel) && channels.find(c => c.id === account.channel)!.name !== account.label ? ` (${channels.find(c => c.id === account.channel)!.name})` : ''}` : 'Conta indisponível'} · ${comparisons[rule.operator]}` }
  if (rule.type === 'window24') return `${options?.connections.find(c => c.id === rule.connection_id)?.label ?? 'Conexão indisponível'} · ${comparisons[rule.operator]}`
  const field = rule.type === 'system' ? systemFields.find(f => f.id === rule.field) : options?.fields.find(f => f.id === rule.field_id)
  const exact = 'case_sensitive' in rule && rule.case_sensitive ? ' · exato' : ''
  return `${field?.name ?? 'Campo indisponível'} · ${comparisons[rule.operator]}${exact}${rule.value !== undefined ? ` · ${rule.value === false ? 'Falso' : rule.value === true ? 'Verdadeiro' : field?.type === 'gender' ? genderLabel(String(rule.value)) : rule.value}` : ''}`
}
export function useFilterOptions() { const c = useAsync(getSegmentOptions, 'segment-options'); return c.data ?? c.stale }
export function ContactFilterBuilder({ filter, onChange }: { filter: ContactQueryFilter; onChange: (filter: ContactQueryFilter) => void }) {
  const catalog = useAsync(getSegmentOptions, 'segment-options')
  const options = catalog.data ?? catalog.stale
  const [kind, setKind] = React.useState('tag')
  const [target, setTarget] = React.useState('')
  const [operator, setOperator] = React.useState('has')
  const [value, setValue] = React.useState('')
  const fields = kind === 'system' ? systemFields : kind === 'channel' ? channels.map(c => ({ ...c, type: 'channel' })) : options?.fields ?? []
  const field = fields.find(f => f.id === target)
  const firstOperator = (k: string) => k === 'tag' ? 'has' : k === 'connection' ? 'in_connection' : k === 'window24' ? 'inside' : k === 'channel' ? 'subscribed' : k === 'entry_trigger' ? 'entered_by' : 'equals'
  const operators = kind === 'tag' ? ['has', 'not_has'] : kind === 'channel' ? ['subscribed', 'not_subscribed'] : kind === 'entry_trigger' ? ['entered_by', 'not_entered_by'] : kind === 'connection' ? ['in_connection', 'not_in_connection'] : kind === 'window24' ? ['inside', 'outside', 'follow_up_eligible', 'outside_24_plus_1'] : optionsFor(field?.type ?? 'text')
  const [caseSensitive, setCaseSensitive] = React.useState(false)
  const needsValue = !['has', 'not_has', 'in_connection', 'not_in_connection', 'inside', 'outside', 'follow_up_eligible', 'outside_24_plus_1', 'subscribed', 'not_subscribed', 'entered_by', 'not_entered_by', 'is_set', 'is_not_set'].includes(operator)
  const numeric = operator === 'within_last_days' || field?.type === 'number'
  const validValue = !needsValue || (value.trim() !== '' && (!numeric || (Number.isFinite(Number(value)) && (operator !== 'within_last_days' || Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= 36500))))
  const validDate = !needsValue || operator === 'within_last_days' || !['date', 'datetime'].includes(field?.type ?? '') || (Number.isFinite(Date.parse(value)) && (field?.type !== 'datetime' || /(?:Z|[+-]\d{2}:\d{2})$/.test(value)))
  let arrayValue: unknown
  try { arrayValue = JSON.parse(value) } catch { /* Keep the condition disabled until the JSON list is complete. */ }
  // Em lista, "contém" compara um item; os outros operadores comparam a lista inteira (JSON).
  const itemOfList = field?.type === 'array' && (operator === 'contains' || operator === 'not_contains')
  const validArray = !needsValue || field?.type !== 'array' || itemOfList || Array.isArray(arrayValue)
  const textual = field?.type === 'text' && ['equals', 'not_equals', 'contains', 'not_contains'].includes(operator)
  const canAdd = !!target && validValue && validDate && validArray && filter.rules.length < 30
  function add() {
    if (!canAdd) return
    const typedValue = itemOfList ? value : field?.type === 'array' ? arrayValue : numeric ? Number(value) : field?.type === 'boolean' ? value === 'true' : value
    const rule: ContactFilterRule = kind === 'tag' ? { type: 'tag', tag_id: target, operator: operator as 'has' | 'not_has' }
      : kind === 'connection' ? { type: 'connection', connection_id: target, operator: operator as 'in_connection' | 'not_in_connection' }
      : kind === 'window24' ? { type: 'window24', connection_id: target, operator: operator as 'inside' | 'outside' }
      : kind === 'entry_trigger' ? { type: 'entry_trigger', trigger_id: target, operator: operator as 'entered_by' | 'not_entered_by' }
      : kind === 'channel' ? { type: 'channel', channel: target, operator: operator as 'subscribed' | 'not_subscribed' }
      : { ...(kind === 'system' ? { type: 'system' as const, field: target as Extract<ContactFilterRule, { type: 'system' }>['field'] } : { type: 'field' as const, field_id: target }), operator: operator as FilterOperator, ...(needsValue ? { value: typedValue } : {}), ...(textual && caseSensitive ? { case_sensitive: true } : {}) }
    onChange({ ...filter, rules: [...filter.rules, rule] })
  }
  return <section aria-label="Construtor de filtro" className="space-y-4">
    <h3 className="text-sm font-semibold">Condições</h3>
    <div className="flex flex-wrap items-center gap-2 text-sm"><span>Encontrar contatos que atendam</span>
<div className="w-52"><Pick label="Combinar condições" value={filter.match} onChange={v => onChange({ ...filter, match: v as 'all' | 'any' })} options={[{ id: 'all', name: 'Todas as condições' }, { id: 'any', name: 'Qualquer condição' }]} /></div>
    </div>
    {filter.rules.length > 0 && <ul aria-label="Condições aplicadas" className="flex flex-wrap gap-2">{filter.rules.map((r, i) => <li key={i} className="flex max-w-full items-center gap-2 rounded-md border border-border bg-surface-muted px-3 py-2 text-sm">
      <span className="min-w-0 break-words">{labelFor(r, options)}</span><button type="button" aria-label={`Remover condição ${i + 1}`} className="shrink-0 rounded p-1 hover:bg-border/40" onClick={() => onChange({ ...filter, rules: filter.rules.filter((_, j) => i !== j) })}><X className="size-4" aria-hidden="true" /></button>
    </li>)}</ul>}
    {catalog.error ? <div role="alert" className="space-y-2 text-sm"><p>Não foi possível carregar as opções do filtro.</p><Button size="sm" variant="secondary" onClick={catalog.reload}>Tentar novamente</Button></div> : <div className="grid items-end gap-3 sm:grid-cols-2">
      <div className="min-w-0 space-y-1 text-xs font-semibold"><span>Tipo de condição</span><Pick label="Tipo de condição" value={kind} onChange={v => { setKind(v); setTarget(''); setValue(''); setOperator(firstOperator(v)) }} options={[{ id: 'tag', name: 'Tag' }, { id: 'system', name: 'Campo do sistema' }, { id: 'field', name: 'Campo personalizado' }, { id: 'connection', name: 'Conta conectada' }, { id: 'channel', name: 'Inscrição no canal' }, { id: 'entry_trigger', name: 'Gatilho de entrada' }, { id: 'window24', name: 'Janela de 24 h' }]} /></div>
      <div className="min-w-0 space-y-1 text-xs font-semibold"><span>{kind === 'tag' ? 'Tag' : kind === 'entry_trigger' ? 'Gatilho' : kind === 'connection' ? 'Conta' : kind === 'window24' ? 'Conexão' : kind === 'channel' ? 'Canal' : 'Campo'}</span><Pick label={kind === 'tag' ? 'Tag da condição' : kind === 'entry_trigger' ? 'Gatilho da condição' : kind === 'connection' ? 'Conta da condição' : kind === 'window24' ? 'Conexão da condição' : kind === 'channel' ? 'Canal da condição' : 'Campo da condição'} placeholder="Escolha uma opção" disabled={!options} value={target}
        onChange={v => { setTarget(v); setValue(''); const next = fields.find(f => f.id === v); const allowed = kind === 'system' && next ? optionsFor(next.type) : []; setOperator(allowed.length && !allowed.includes('equals') ? allowed[0] : firstOperator(kind)) }}
        options={kind === 'tag' ? options?.tags.map(t => ({ id: t.id, name: t.name })) ?? [] : kind === 'entry_trigger' ? options?.triggers?.map(t => ({ id: t.id, name: t.name })) ?? [] : kind === 'connection' ? byChannelOrder(options?.accounts ?? []).map(c => ({ id: c.id, name: c.label, channel: c.channel })) : kind === 'window24' ? options?.connections.map(c => ({ id: c.id, name: c.label })) ?? [] : fields.map(f => ({ id: f.id, name: f.name }))} /></div>
      <div className="min-w-0 space-y-1 text-xs font-semibold"><span>Comparação</span><Pick label="Comparação da condição" value={operator} onChange={v => { setOperator(v); setValue('') }} options={operators.map(op => ({ id: op, name: comparisons[op] }))} /></div>
      {needsValue ? <label className="min-w-0 space-y-1 text-xs font-semibold">{operator === 'within_last_days' ? 'Quantidade de dias' : 'Valor'}
        {field?.type === 'boolean' || field?.type === 'status' || field?.type === 'gender' ? <Pick label="Valor da condição" placeholder="Escolha um valor" value={value} onChange={setValue} options={field.type === 'boolean' ? [{ id: 'true', name: 'Verdadeiro' }, { id: 'false', name: 'Falso' }] : field.type === 'gender' ? genderOptions : [{ id: 'subscribed', name: 'Inscrito' }, { id: 'unsubscribed', name: 'Descadastrado' }]} />
          : <Input aria-label="Valor da condição" type={numeric ? 'number' : field?.type === 'date' ? 'date' : 'text'} step={operator === 'within_last_days' ? 1 : 'any'} min={operator === 'within_last_days' ? 1 : undefined} max={operator === 'within_last_days' ? 36500 : undefined} placeholder={itemOfList ? 'produto' : field?.type === 'array' ? '["produto", "curso"]' : field?.type === 'datetime' && !numeric ? '2026-10-24T12:00:00-03:00' : undefined} value={value} onChange={e => setValue(e.target.value)} />}
      </label> : <div className="hidden sm:block" />}
      <Button variant="secondary" disabled={!canAdd} onClick={add}><Plus className="size-4" aria-hidden="true" />Adicionar condição</Button>
    </div>}
    {textual ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-accent" checked={caseSensitive} onChange={e => setCaseSensitive(e.target.checked)} />Diferenciar maiúsculas e minúsculas</label> : null}
    {kind === 'window24' && options?.connections.length === 0 && <p className="text-sm text-text-muted">Nenhuma conexão disponível declara janela de 24 horas.</p>}
  </section>
}
