import * as React from 'react'
import { CalendarClock, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { moveActive } from '@/components/ui/choose-existing-logic'
import { cn } from '@/lib/utils'
import { Choice } from './logic-panels'
import type { EditorField } from './graph'
import { dateFields, defaultOffset, timezoneChoices, weekdays, type DateOffset, type DateSource, type TimeWindow } from './temporal'

export function TimeWindowControls({ id, value, disabled, onChange }: { id: string; value: TimeWindow; disabled: boolean; onChange: (value: TimeWindow) => void }) {
  return <div className="min-w-0 space-y-3">
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1"><Label htmlFor={`${id}-from`}>Continuar a partir de</Label><Input id={`${id}-from`} type="time" value={value.from} disabled={disabled} onChange={e => onChange({ ...value, from: e.target.value })} /></div>
      <div className="space-y-1"><Label htmlFor={`${id}-to`}>Continuar até</Label><Input id={`${id}-to`} type="time" value={value.to} disabled={disabled} onChange={e => onChange({ ...value, to: e.target.value })} /></div>
    </div>
    <div role="group" aria-label="Dias permitidos" className="grid grid-cols-7 gap-1">{weekdays.map((day, index) => <Button key={day} size="sm" variant={value.days.includes(index) ? 'primary' : 'secondary'} className="min-w-0 px-0" disabled={disabled} aria-pressed={value.days.includes(index)} onClick={() => onChange({ ...value, days: value.days.includes(index) ? value.days.filter(d => d !== index) : [...value.days, index].sort() })}>{day}</Button>)}</div>
    <p className="text-xs text-text-muted">Se o período atravessar a meia-noite, o dia selecionado é o dia em que ele começa.</p>
  </div>
}

/** Fuso horário num seletor com busca: o nome técnico (America/Sao_Paulo) continua sendo o valor salvo. */
export function TimezoneControl({ id, value, disabled, onChange, contact = false }: { id: string; value?: string; disabled: boolean; onChange: (timezone?: string) => void; contact?: boolean }) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [active, setActive] = React.useState(0)
  const options = React.useMemo(() => [...(query.trim() ? [] : [{ id: '', label: 'Automático' }]), ...timezoneChoices(query)], [query])
  const pick = (zone: string) => { onChange(zone || undefined); setOpen(false) }
  const atual = value ? value.replace(/_/g, ' ') : 'Automático'
  return <div className="space-y-1">
    <Label htmlFor={id}>Fuso horário</Label>
    <Popover open={open} onOpenChange={next => { setOpen(next); if (next) { setQuery(''); setActive(0) } }}>
      <PopoverTrigger asChild>
        <button id={id} type="button" role="combobox" aria-expanded={open} aria-controls={`${id}-lista`} disabled={disabled} title={value}
          className="flex h-10 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 text-left text-sm disabled:opacity-50">
          <span className="truncate">{atual}</span><ChevronDown className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) space-y-2 p-2">
        <Input type="search" role="searchbox" aria-label="Buscar fuso horário" placeholder="Buscar fuso horário" value={query} aria-controls={`${id}-lista`} aria-activedescendant={options[active] ? `${id}-op-${active}` : undefined}
          onChange={e => { setQuery(e.target.value); setActive(0) }}
          onKeyDown={e => {
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) { e.preventDefault(); setActive(moveActive(active, options.length, e.key)) }
            else if (e.key === 'Enter' && options[active]) { e.preventDefault(); pick(options[active].id) }
          }} />
        <div id={`${id}-lista`} role="listbox" aria-label="Fusos horários" className="max-h-60 overflow-y-auto">
          {options.map((o, i) => <button key={o.id || 'auto'} id={`${id}-op-${i}`} type="button" role="option" aria-selected={(value ?? '') === o.id} onClick={() => pick(o.id)} onMouseEnter={() => setActive(i)}
            className={cn('flex min-h-9 w-full items-center rounded-md px-2 py-1.5 text-left text-sm', i === active && 'bg-surface-muted', (value ?? '') === o.id && 'font-semibold')}>{o.label}</button>)}
          {!options.length ? <p className="p-2 text-sm text-text-muted">Nenhum fuso encontrado.</p> : null}
        </div>
      </PopoverContent>
    </Popover>
    <p className="text-xs text-text-muted">{contact ? 'Usa o fuso do contato e, se ausente, o da conta.' : 'Usa o fuso da conta.'} Para fixar outro, procure pelo nome da cidade, por exemplo São Paulo.</p>
  </div>
}
export function DateSourceControls({ id, source, fields, disabled, onChange, comparison = false }: { id: string; source: DateSource; fields: EditorField[]; disabled: boolean; onChange: (source: DateSource) => void; comparison?: boolean }) {
  return <div className="space-y-3">
    <Choice id={`${id}-kind`} label={comparison ? 'Origem da data comparada' : 'Origem da data'} value={source.kind} disabled={disabled} options={[{ id: 'specific', name: 'Data definida' }, { id: 'field', name: 'Campo de data' }]} onChange={kind => onChange(kind === 'field' ? { kind, field_id: '' } : { kind: 'specific', at: '' })} />
    {source.kind === 'field' ? <Choice id={`${id}-field`} label={comparison ? 'Campo de data comparada' : 'Campo de data'} value={source.field_id} options={dateFields(fields)} disabled={disabled} onChange={field_id => onChange({ ...source, field_id })} /> : <div className="space-y-1"><Label htmlFor={`${id}-at`}><CalendarClock className="mr-1 inline size-4" aria-hidden="true" />Data e hora</Label><Input id={`${id}-at`} type="datetime-local" value={source.at} disabled={disabled} onChange={e => onChange({ ...source, at: e.target.value })} /></div>}
  </div>
}
export function OffsetControls({ id, value = defaultOffset, disabled, onChange }: { id: string; value?: DateOffset; disabled: boolean; onChange: (value: DateOffset) => void }) {
  return <div className="min-w-0 space-y-3">
    <p className="text-sm font-semibold">Ajustar a data</p>
    <div className="grid grid-cols-2 gap-3"><div className="space-y-1"><Label htmlFor={`${id}-value`}>Deslocamento</Label><Input id={`${id}-value`} type="number" min={0} max={525600} step={1} value={value.value} disabled={disabled} onChange={e => onChange({ ...value, value: Number(e.target.value) })} /></div><Choice id={`${id}-unit`} label="Unidade do deslocamento" value={value.unit} disabled={disabled} options={[{ id: 'minutes', name: 'minutos' }, { id: 'hours', name: 'horas' }, { id: 'days', name: 'dias' }]} onChange={unit => onChange({ ...value, unit: unit as DateOffset['unit'] })} /></div>
    <Choice id={`${id}-direction`} label="Aplicar deslocamento" value={value.direction} disabled={disabled} options={[{ id: 'before', name: 'Antes' }, { id: 'after', name: 'Depois' }]} onChange={direction => onChange({ ...value, direction: direction as DateOffset['direction'] })} />
  </div>
}
