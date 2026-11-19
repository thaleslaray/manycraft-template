import * as React from "react"
import { Checkbox } from "./checkbox"
import { Button } from "./button"
import { Skeleton } from "./skeleton"
import { EmptyState } from "./empty-state"
import { cn } from "@/lib/utils"

export type Column<T> = {
  key: string
  header: string
  cell: (row: T) => React.ReactNode
  className?: string
}

type Props<T> = {
  columns: Column<T>[]
  rows: T[]
  getId: (row: T) => string
  caption: string
  selectable?: boolean
  selected?: Set<string>
  onSelectedChange?: (next: Set<string>) => void
  loading?: boolean
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
  empty?: React.ReactNode
  total?: number
  /** Esconde o contador de selecionados (a página mostra o dela na barra). */
  hideSelectionStatus?: boolean
  /** Rótulo acessível da linha (checkbox). Padrão: o id. */
  rowLabel?: (row: T) => string
  /** Classes da linha do cabeçalho (ex.: altura). */
  headRowClassName?: string
}

function DataTable<T>({
  columns,
  rows,
  getId,
  caption,
  selectable,
  selected = new Set<string>(),
  onSelectedChange,
  loading,
  hasMore,
  loadingMore,
  onLoadMore,
  empty,
  total,
  hideSelectionStatus,
  rowLabel,
  headRowClassName,
}: Props<T>) {
  const ids = rows.map(getId)
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id))
  const someSelected = ids.some((id) => selected.has(id))
  const headState: boolean | "indeterminate" = allSelected ? true : someSelected ? "indeterminate" : false

  function toggleAll() {
    onSelectedChange?.(allSelected ? new Set() : new Set(ids))
  }
  function toggleOne(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onSelectedChange?.(next)
  }

  if (!loading && rows.length === 0) {
    return <>{empty ?? <EmptyState title="Nada aqui ainda" />}</>
  }

  return (
    <div className="space-y-3">
      {selectable && !hideSelectionStatus ? (
        <p role="status" className="text-xs text-text-muted">
          {selected.size} selecionados{total !== undefined ? ` de ${total}` : ""}
        </p>
      ) : null}
      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="text-xs text-text-muted">
            <tr className={headRowClassName}>
              {selectable ? (
                <th scope="col" className="w-12 p-3">
                  <Checkbox checked={headState} onCheckedChange={toggleAll} aria-label="Selecionar todos" />
                </th>
              ) : null}
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cn("p-3 font-semibold", c.className)}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-t border-border">
                    {selectable ? <td className="p-3"><Skeleton className="size-5" /></td> : null}
                    {columns.map((c) => (
                      <td key={c.key} className="p-3"><Skeleton className="h-4 w-3/4" /></td>
                    ))}
                  </tr>
                ))
              : rows.map((row) => {
                  const id = getId(row)
                  const isSel = selected.has(id)
                  return (
                    <tr
                      key={id}
                      aria-selected={selectable ? isSel : undefined}
                      className={cn("border-t border-border hover:bg-surface-muted", isSel && "bg-accent-soft")}
                    >
                      {selectable ? (
                        <td className="p-3">
                          <Checkbox checked={isSel} onCheckedChange={() => toggleOne(id)} aria-label={`Selecionar ${rowLabel ? rowLabel(row) : `linha ${id}`}`} />
                        </td>
                      ) : null}
                      {columns.map((c) => (
                        <td key={c.key} className={cn("p-3", c.className)}>{c.cell(row)}</td>
                      ))}
                    </tr>
                  )
                })}
          </tbody>
        </table>
      </div>
      {hasMore && !loading ? (
        <Button variant="link" onClick={onLoadMore} loading={loadingMore}>
          Carregar mais
        </Button>
      ) : null}
    </div>
  )
}

export { DataTable }
