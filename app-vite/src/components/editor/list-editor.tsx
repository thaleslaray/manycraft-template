import * as React from "react"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { LIST_BUTTON_TEXT_MAX, LIST_SECTION_TITLE_MAX } from "../../../../engine/src/schemas/message-list"
import { listRows, newListRowId, type ListBlock, type ListLimits } from "./list-block"

const count = (s: string | undefined) => [...(s ?? "")].length

/** Editor da lista de opções: texto do botão, seções (título opcional com uma só) e opções com título e descrição. Cada opção ganha uma saída no mapa. */
export function ListEditor({ block, limits, disabled, onChange, onRemoveRow }: { block: ListBlock; limits: ListLimits; disabled: boolean; onChange: (b: ListBlock) => void; onRemoveRow: (rowId: string) => void }) {
  const uid = React.useId()
  const rows = listRows(block)
  const position = new Map(rows.map((r, i) => [r.id, i + 1]))
  const setSection = (si: number, patch: Partial<ListBlock["sections"][number]>) => onChange({ ...block, sections: block.sections.map((s, i) => i === si ? { ...s, ...patch } : s) })
  const buttonOver = count(block.buttonText) > LIST_BUTTON_TEXT_MAX
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor={`${uid}-button`}>Texto do botão que abre a lista</Label>
        <Input id={`${uid}-button`} value={block.buttonText} disabled={disabled} aria-invalid={buttonOver || undefined} onChange={e => onChange({ ...block, buttonText: e.target.value })} />
        <p className={buttonOver ? "text-right text-xs text-danger" : "text-right text-xs text-text-muted"} aria-live="polite">{count(block.buttonText)} / {LIST_BUTTON_TEXT_MAX}</p>
      </div>
      <ol aria-label="Seções da lista" className="space-y-3">
        {block.sections.map((section, si) => (
          <li key={si} className="space-y-2 rounded-md border border-border p-2">
            <div className="flex items-end gap-1">
              <div className="min-w-0 flex-1 space-y-1">
                <Label htmlFor={`${uid}-s${si}`}>Título da seção {si + 1}{block.sections.length === 1 ? " (opcional)" : ""}</Label>
                <Input id={`${uid}-s${si}`} value={section.title ?? ""} disabled={disabled} aria-invalid={count(section.title) > LIST_SECTION_TITLE_MAX || undefined}
                  onChange={e => setSection(si, { title: e.target.value })} />
              </div>
              {block.sections.length > 1 ? <Button variant="ghost" size="sm" aria-label={`Remover seção ${si + 1}`} disabled={disabled}
                onClick={() => { section.rows.forEach(r => onRemoveRow(r.id)); onChange({ ...block, sections: block.sections.filter((_, i) => i !== si) }) }}><Trash2 className="size-4" aria-hidden="true" /></Button> : null}
            </div>
            <ol aria-label={`Opções da seção ${si + 1}`} className="space-y-2">
              {section.rows.map((row, ri) => {
                const n = position.get(row.id)
                return (
                  <li key={row.id} className="space-y-1 rounded-md bg-surface-muted p-2">
                    <div className="flex items-end gap-1">
                      <div className="min-w-0 flex-1 space-y-1">
                        <Label htmlFor={`${uid}-t${row.id}`}>Título da opção {n}</Label>
                        <Input id={`${uid}-t${row.id}`} value={row.title} disabled={disabled} aria-invalid={count(row.title) > limits.rowTitleMax || undefined}
                          onChange={e => setSection(si, { rows: section.rows.map((r, i) => i === ri ? { ...r, title: e.target.value } : r) })} />
                        <p className={count(row.title) > limits.rowTitleMax ? "text-right text-xs text-danger" : "text-right text-xs text-text-muted"} aria-live="polite">{count(row.title)} / {limits.rowTitleMax}</p>
                      </div>
                      <Button variant="ghost" size="sm" aria-label={`Remover opção ${n}`} disabled={disabled || rows.length <= 1}
                        onClick={() => { onRemoveRow(row.id); onChange({ ...block, sections: block.sections.map((s, i) => i === si ? { ...s, rows: s.rows.filter((_, j) => j !== ri) } : s).filter(s => s.rows.length) }) }}>
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`${uid}-d${row.id}`}>Descrição da opção {n} (opcional)</Label>
                      <Input id={`${uid}-d${row.id}`} value={row.description ?? ""} disabled={disabled} aria-invalid={count(row.description) > limits.rowDescMax || undefined}
                        onChange={e => setSection(si, { rows: section.rows.map((r, i) => i === ri ? { ...r, description: e.target.value || undefined } : r) })} />
                      <p className={count(row.description) > limits.rowDescMax ? "text-right text-xs text-danger" : "text-right text-xs text-text-muted"} aria-live="polite">{count(row.description)} / {limits.rowDescMax}</p>
                    </div>
                  </li>
                )
              })}
            </ol>
            <Button variant="secondary" size="sm" disabled={disabled || rows.length >= limits.maxRows}
              onClick={() => setSection(si, { rows: [...section.rows, { id: newListRowId(block), title: "" }] })}>
              <Plus className="size-4" aria-hidden="true" />Adicionar opção
            </Button>
          </li>
        ))}
      </ol>
      <Button variant="secondary" size="sm" disabled={disabled || block.sections.length >= limits.maxSections || rows.length >= limits.maxRows}
        onClick={() => onChange({ ...block, sections: [...block.sections, { title: "", rows: [{ id: newListRowId(block), title: "" }] }] })}>
        <Plus className="size-4" aria-hidden="true" />Adicionar seção
      </Button>
      <p className="text-xs text-text-muted">Até {limits.maxRows} opções no total, com título de até {limits.rowTitleMax} caracteres. Cada opção ganha uma saída no mapa: o fluxo continua por onde a pessoa escolher.</p>
    </div>
  )
}
