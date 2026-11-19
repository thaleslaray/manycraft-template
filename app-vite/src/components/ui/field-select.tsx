import type * as React from "react"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Info } from "lucide-react"
import { cn } from "@/lib/utils"

const NONE = "__nenhum__"

/**
 * Campo de escolha com rótulo, no seletor do sistema (nunca o `<select>` do navegador).
 * `none` adiciona uma opção que devolve "". `hideLabel` esconde o rótulo só da tela (continua no leitor de tela).
 * `hintPopover` põe a ajuda atrás de um botão de informação ao lado do campo (abre ao tocar, fecha com Esc ou ao clicar
 * fora), para campos que flutuam sobre outro conteúdo (o mapa da transmissão) e não podem cobri-lo com o texto.
 */
export function FieldSelect({ id, label, value, onChange, options, placeholder = "Escolha", none, hint, hintPopover, className, disabled, hideLabel, required }: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  /** `icon` vem antes do nome (e aparece no campo fechado); `detail` é um texto de apoio à direita, só na lista. */
  options: { value: string; label: string; icon?: React.ReactNode; detail?: string }[]
  placeholder?: string
  none?: string
  hint?: React.ReactNode
  hintPopover?: boolean
  className?: string
  disabled?: boolean
  hideLabel?: boolean
  required?: boolean
}) {
  const select = <Select value={value === "" && none ? NONE : value || undefined} onValueChange={next => onChange(next === NONE ? "" : next)} disabled={disabled} required={required}>
      <SelectTrigger id={id}><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        {none ? <SelectItem value={NONE}>{none}</SelectItem> : null}
        {options.map(option => <SelectItem key={option.value} value={option.value} detail={option.detail}>{option.icon ? <span className="flex min-w-0 items-center gap-2.5">{option.icon}<span className="truncate">{option.label}</span></span> : option.label}</SelectItem>)}
      </SelectContent>
    </Select>
  return <div className={cn("min-w-0 space-y-1", className)}>
    <Label htmlFor={id} className={hideLabel ? "sr-only" : undefined}>{label}</Label>
    {hint && hintPopover ? <div className="flex items-center gap-1">
      <div className="min-w-0 flex-1">{select}</div>
      <Popover>
        <PopoverTrigger aria-label={`Ajuda: ${label}`} title={`Ajuda: ${label}`}
          className="grid size-10 shrink-0 place-items-center rounded-md border border-border bg-surface text-text-muted hover:bg-surface-muted hover:text-text data-[state=open]:text-accent">
          <Info className="size-4" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent aria-label={`Ajuda: ${label}`} className="w-80 space-y-1 p-3 text-xs text-text-muted">{hint}</PopoverContent>
      </Popover>
    </div> : select}
    {hint && !hintPopover ? <p className="text-xs text-text-muted">{hint}</p> : null}
  </div>
}
