import * as React from "react"
import { toast } from "sonner"
import { apiRequest, isFakeMode } from "@/data/api"
import type { CustomField } from "@/data"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"

const selectClass = "h-10 w-full rounded-md border border-border-input bg-surface px-3 text-sm"

/** Lote: copia um campo personalizado (texto) para o e-mail ou o telefone do contato. */
export function CopyFieldDialog({ ids, fields, onClose, onDone }: { ids: string[]; fields: CustomField[]; onClose: () => void; onDone: () => void }) {
  const textFields = fields.filter(f => f.scope === "contact" && f.type === "text")
  const [fieldId, setFieldId] = React.useState(textFields[0]?.id ?? "")
  const [target, setTarget] = React.useState<"email" | "phone">("phone")
  const [overwrite, setOverwrite] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (isFakeMode()) { toast.error("Disponível com o motor ligado."); return }
    setBusy(true)
    try {
      const result = await apiRequest<{ copied: number; skipped: number }>("/contacts/bulk-copy-field", { method: "POST", body: JSON.stringify({ ids, field_id: fieldId, target, overwrite }) })
      toast.success(`${result.copied} ${result.copied === 1 ? "contato atualizado" : "contatos atualizados"}${result.skipped ? `; ${result.skipped} pulados (sem valor, valor inválido, já preenchido ou usado por outro contato)` : ""}.`)
      onDone()
    } catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível copiar o campo.") } finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={open => !open && !busy && onClose()}>
    <DialogContent>
      <DialogHeader><DialogTitle>Copiar campo para e-mail ou telefone</DialogTitle><DialogDescription>{ids.length} {ids.length === 1 ? "contato selecionado" : "contatos selecionados"}. O valor passa pela mesma validação do cadastro.</DialogDescription></DialogHeader>
      {textFields.length === 0 ? <p className="text-sm text-text-muted">Nenhum campo de texto do contato para copiar.</p> : <form id="copy-field" className="space-y-4" onSubmit={submit}>
        <div className="space-y-1"><Label htmlFor="copy-field-source">Campo de origem</Label><select id="copy-field-source" className={selectClass} value={fieldId} onChange={e => setFieldId(e.target.value)}>{textFields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></div>
        <div className="space-y-1"><Label htmlFor="copy-field-target">Copiar para</Label><select id="copy-field-target" className={selectClass} value={target} onChange={e => setTarget(e.target.value as "email" | "phone")}><option value="phone">Telefone</option><option value="email">E-mail</option></select></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-accent" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} />Substituir quando o contato já tiver {target === "phone" ? "telefone" : "e-mail"}</label>
      </form>}
      <DialogFooter><Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button><Button type="submit" form="copy-field" loading={busy} disabled={!fieldId}>Copiar</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
