import * as React from "react"
import { Plus, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { moveTagActive, tagOptions, type TagOption } from "./tag-combobox-logic"

/** "Adicionar tag" do perfil: busca, lista dentro do pop-up e "Criar tag «nome»". Enter escolhe só o item destacado. */
export function TagCombobox({ tags, taken, onPick, onCreate }: {
  tags: { id: string; name: string }[]
  taken: string[]
  onPick: (tag: { id: string; name: string }) => void
  onCreate: (name: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [touched, setTouched] = React.useState<number | null>(null)
  const uid = React.useId()
  const options = tagOptions(tags, taken, query)
  // Sem ninguém navegando: a opção de criar fica destacada quando o nome é novo; nada fica destacado com a busca vazia.
  const fallback = query.trim() ? options.findIndex(o => o.kind === "create" || o.name.toLowerCase() === query.trim().toLowerCase()) : -1
  const active = touched !== null ? Math.min(touched, options.length - 1) : fallback
  const optionId = (option: TagOption) => `${uid}-${option.id}`

  function close() { setOpen(false); setQuery(""); setTouched(null) }
  function choose(option: TagOption | undefined) {
    if (!option) return
    if (option.kind === "create") onCreate(option.name)
    else onPick({ id: option.id, name: option.name })
    close()
  }

  return (
    <Popover open={open} onOpenChange={(next) => { if (!next) close(); else setOpen(true) }}>
      <PopoverTrigger asChild>
        <Button variant="link" size="sm" className="h-auto p-0"><Plus className="size-4" aria-hidden="true" />Adicionar tag</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(20rem,calc(100vw-1.5rem))] space-y-2 p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted" aria-hidden="true" />
          <Input
            role="combobox"
            aria-label="Buscar ou criar tag"
            aria-expanded="true"
            aria-controls={`${uid}-lista`}
            aria-activedescendant={options[active] ? optionId(options[active]) : undefined}
            placeholder="Buscar ou criar tag"
            maxLength={120}
            value={query}
            autoFocus
            className="pl-9"
            onChange={(e) => { setQuery(e.target.value); setTouched(null) }}
            onKeyDown={(e) => {
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
                e.preventDefault()
                setTouched(moveTagActive(active, options.length, e.key))
              } else if (e.key === "Enter") {
                e.preventDefault()
                choose(options[active])
              }
            }}
          />
        </div>
        <ul id={`${uid}-lista`} role="listbox" aria-label="Tags" className="max-h-56 space-y-0.5 overflow-y-auto">
          {options.map((option, index) => (
            <li
              key={option.id}
              id={optionId(option)}
              role="option"
              aria-selected={index === active}
              onMouseEnter={() => setTouched(index)}
              onClick={() => choose(option)}
              className={cn("flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm", index === active ? "bg-accent-soft font-semibold" : "hover:bg-border/40")}
            >
              {option.kind === "create" ? <Plus className="size-4 shrink-0" aria-hidden="true" /> : null}
              <span className="min-w-0 break-words">{option.label}</span>
            </li>
          ))}
          {options.length === 0 ? <li role="presentation" className="px-3 py-2 text-sm text-text-muted">{tags.length === taken.length ? "O contato já tem todas as tags. Digite um nome para criar outra." : "Nenhuma tag encontrada."}</li> : null}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
