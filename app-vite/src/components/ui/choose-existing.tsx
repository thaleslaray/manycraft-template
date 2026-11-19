import * as React from "react"
import { Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { filterChoices, moveActive, type Choice } from "./choose-existing-logic"

type Props<T extends Choice> = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  items: T[]
  renderPreview: (item: T) => React.ReactNode
  onChoose: (item: T) => void
  searchLabel?: string
  chooseLabel?: string
  emptyText?: string
  /** Falso: o pop-up fica aberto depois de escolher (quem chama fecha quando der certo). */
  closeOnChoose?: boolean
  /** Aviso de erro visível no rodapé do pop-up. */
  error?: string
}

/** Pop-up "Escolher existente": lista pesquisável à esquerda, prévia à direita. Teclado: setas, Enter escolhe, Esc fecha. */
function ChooseExisting<T extends Choice>({
  open,
  onOpenChange,
  title,
  items,
  renderPreview,
  onChoose,
  searchLabel = "Buscar",
  chooseLabel = "Escolher",
  emptyText = "Nada encontrado.",
  closeOnChoose = true,
  error,
}: Props<T>) {
  const [query, setQuery] = React.useState("")
  const [active, setActive] = React.useState(0)
  const uid = React.useId()
  const shown = filterChoices(items, query)
  const current = shown[Math.min(active, shown.length - 1)]

  function reset(next: boolean) {
    if (!next) {
      setQuery("")
      setActive(0)
    }
    onOpenChange(next)
  }

  function choose(item: T | undefined) {
    if (!item) return
    onChoose(item)
    if (closeOnChoose) reset(false)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault()
      setActive(moveActive(active, shown.length, e.key))
    } else if (e.key === "Enter") {
      e.preventDefault()
      choose(current)
    }
  }

  const optionId = (id: string) => `${uid}-${id}`

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent className="max-w-(--modal-lg) gap-0 p-0">
        <DialogHeader className="border-b border-border p-6">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">Pesquise na lista, veja a prévia e escolha.</DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[min(28rem,calc(100dvh-14rem))] overflow-y-auto md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:overflow-visible">
          <div className="flex min-h-0 flex-col gap-3 border-b border-border p-4 md:border-r md:border-b-0">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted" aria-hidden="true" />
              <Input
                role="combobox"
                aria-expanded={shown.length > 0}
                aria-controls={`${uid}-lista`}
                aria-activedescendant={current ? optionId(current.id) : undefined}
                aria-label={searchLabel}
                placeholder={searchLabel}
                value={query}
                onChange={(e) => { setQuery(e.target.value); setActive(0) }}
                onKeyDown={onKeyDown}
                className="pl-9"
                autoFocus
              />
            </div>
            <ul id={`${uid}-lista`} role="listbox" aria-label={title} className="min-h-0 flex-1 space-y-1 overflow-y-auto">
              {shown.map((item) => {
                const selected = item.id === current?.id
                return (
                  <li
                    key={item.id}
                    id={optionId(item.id)}
                    role="option"
                    aria-selected={selected}
                    onClick={() => setActive(shown.indexOf(item))}
                    onDoubleClick={() => choose(item)}
                    className={cn("cursor-default rounded-md px-3 py-2 text-sm", selected ? "bg-accent-soft font-semibold" : "hover:bg-border/40")}
                  >
                    {item.label}
                    {item.hint ? <span className="block text-xs font-normal text-text-muted">{item.hint}</span> : null}
                  </li>
                )
              })}
              {shown.length === 0 ? <li role="presentation" className="px-3 py-2 text-sm text-text-muted">{emptyText}</li> : null}
            </ul>
          </div>
          <div aria-label="Prévia" role="region" className="min-h-40 overflow-y-auto bg-surface-muted p-6">
            {current ? renderPreview(current) : null}
          </div>
        </div>
        {error ? <p role="alert" className="border-t border-border px-4 pt-3 text-sm text-danger">{error}</p> : null}
        <DialogFooter className="border-t border-border p-4">
          <DialogClose asChild><Button type="button" variant="secondary">Cancelar</Button></DialogClose>
          <Button type="button" disabled={!current} onClick={() => choose(current)}>{chooseLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export { ChooseExisting }
