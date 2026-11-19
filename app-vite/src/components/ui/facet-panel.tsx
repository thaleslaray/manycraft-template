import * as React from "react"
import { ChevronDown } from "lucide-react"
import { Skeleton } from "./skeleton"
import { cn } from "@/lib/utils"

export type FacetItem = { id: string; label: string; count?: number }
export type FacetGroup = { title: string; items: FacetItem[]; emptyText?: string }

const VISIBLE = 5

/** Título de cada bloco da lateral. */
const facetTitle = "pb-[0.9rem] text-lg leading-6 font-semibold"

/** Botão "Mostrar todos" / "Mostrar menos" dos grupos da lateral. */
function ShowAllButton({ all, onToggle }: { all: boolean; onToggle: () => void }) {
  return (
    <button type="button" aria-expanded={all} onClick={onToggle} className="mx-auto mt-3 flex min-h-6 items-center gap-1 text-sm text-link hover:underline">
      {all ? "Mostrar menos" : "Mostrar todos"}
      <ChevronDown className={cn("size-4 transition-transform", all && "rotate-180")} aria-hidden="true" />
    </button>
  )
}

/** Filtros rápidos em grupos: título + coluna "Contatos" com contagem. */
function FacetPanel({
  label,
  groups,
  activeId,
  onSelect,
  loading,
}: {
  label: string
  groups: FacetGroup[]
  activeId: string | null
  onSelect: (id: string | null) => void
  loading?: boolean
}) {
  return (
    <aside aria-label={label} className="space-y-8">
      {groups.map((g) => (
        <Group key={g.title} g={g} activeId={activeId} onSelect={onSelect} loading={loading} />
      ))}
    </aside>
  )
}

function Group({ g, activeId, onSelect, loading }: { g: FacetGroup; activeId: string | null; onSelect: (id: string | null) => void; loading?: boolean }) {
  const [all, setAll] = React.useState(false)
  // O item escolhido continua visível mesmo além dos primeiros.
  const items = all ? g.items : g.items.filter((it, i) => i < VISIBLE || it.id === activeId)
  const heading = React.useId()
  return (
    <section aria-labelledby={heading}>
      <div className="flex items-baseline justify-between">
        <h2 id={heading} className={facetTitle}>{g.title}</h2>
        <span className="text-sm text-text-muted italic">Contatos</span>
      </div>
      {loading ? (
        <div className="space-y-2 pt-1" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      ) : g.items.length === 0 ? (
        <p className="py-1 text-xs text-text-muted">{g.emptyText ?? "Nada aqui ainda"}</p>
      ) : (
        <ul className="flex flex-col">
          {items.map((it) => (
            <li key={it.id}>
              <button
                type="button"
                aria-pressed={activeId === it.id}
                onClick={() => onSelect(activeId === it.id ? null : it.id)}
                className={cn(
                  "relative flex h-5 w-full items-center gap-3 text-left text-sm after:absolute after:inset-x-0 after:-inset-y-0.5 after:content-['']",  // a linha segue com 20px; a área de toque chega a 24px
                  activeId === it.id ? "font-semibold text-text underline" : "text-text-muted hover:text-text hover:underline"
                )}
              >
                <span className="min-w-0 truncate">{it.label}</span>
                {it.count !== undefined ? <span className="ml-auto shrink-0 text-right text-xs tabular-nums">{it.count}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {g.items.length > VISIBLE ? <ShowAllButton all={all} onToggle={() => setAll(!all)} /> : null}
    </section>
  )
}

export { FacetPanel, ShowAllButton, VISIBLE as FACET_VISIBLE, facetTitle }
