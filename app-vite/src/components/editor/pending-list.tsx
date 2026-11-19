import { AlertCircle, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { Pending } from "./pending"

/** Lista de pendências ao clicar em Publicar: um item por passo com erro; tocar leva ao passo. */
export function PendingList({ items, onPick, onClose }: { items: Pending[]; onPick: (id: string) => void; onClose: () => void }) {
  if (!items.length) return null
  return (
    <section aria-label="Pendências para publicar" className="absolute right-3 top-3 z-10 w-80 max-w-[calc(100%-1.5rem)] rounded-lg border border-border bg-surface shadow-node">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <AlertCircle className="size-4 shrink-0 text-danger" aria-hidden="true" />
        <h3 className="mr-auto text-sm font-semibold">{items.length === 1 ? "1 passo a corrigir" : `${items.length} passos a corrigir`}</h3>
        <Button variant="ghost" size="sm" aria-label="Fechar pendências" onClick={onClose}><X className="size-4" aria-hidden="true" /></Button>
      </header>
      <ul className="max-h-72 divide-y divide-border overflow-y-auto">
        {items.map(item => (
          <li key={item.id}>
            <button type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-surface-muted" onClick={() => onPick(item.id)}>
              <span className="block font-semibold">{item.title}</span>
              <span className="block text-xs text-text-muted">{item.issue}{item.more ? ` (+${item.more})` : ""}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
