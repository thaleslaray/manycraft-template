import * as React from "react"
import { ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import { apiRequest, isFakeMode } from "@/data/api"
import { useAsync } from "@/hooks/use-async"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"

type DataRequest = { id: string; kind: string; note: string | null; requested_at: string; recorded_by: string }
const kinds: Record<string, string> = { access: "Acesso aos dados", export: "Cópia dos dados", correction: "Correção", deletion: "Exclusão", unsubscribe: "Descadastro", other: "Outro" }
const selectClass = "h-9 w-full rounded-md border border-border-input bg-surface px-2 text-sm"

/** Pedidos do titular (LGPD): o que a pessoa pediu, quando e quem registrou. */
export function DataRequests({ contactId }: { contactId: string }) {
  const list = useAsync(() => isFakeMode() ? Promise.resolve([] as DataRequest[]) : apiRequest<DataRequest[]>(`/contacts/${encodeURIComponent(contactId)}/data-requests`), contactId)
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true)
    try {
      const date = String(form.get("date"))
      await apiRequest(`/contacts/${encodeURIComponent(contactId)}/data-requests`, { method: "POST", body: JSON.stringify({
        kind: form.get("kind"), note: String(form.get("note")).trim() || undefined, ...(date ? { requested_at: new Date(`${date}T12:00:00`).toISOString() } : {}) }) })
      toast.success("Pedido registrado.")
      setOpen(false); list.reload()
    } catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível registrar o pedido.") } finally { setBusy(false) }
  }
  const rows = list.data ?? list.stale ?? []
  return <section aria-label="Pedidos do titular" className="space-y-2">
    <div className="flex items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 text-xs font-semibold text-text-muted"><ShieldCheck className="size-4" aria-hidden="true" />Pedidos do titular (LGPD)</h3>
      {!open && !isFakeMode() ? <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Registrar</Button> : null}
    </div>
    {open ? <form onSubmit={submit} className="space-y-2 rounded-md border border-border p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1"><Label htmlFor="dsr-kind">Pedido</Label><select id="dsr-kind" name="kind" className={selectClass} defaultValue="access">{Object.entries(kinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="space-y-1"><Label htmlFor="dsr-date">Data do pedido</Label><input id="dsr-date" name="date" type="date" className={selectClass} max={new Date().toISOString().slice(0, 10)} /></div>
      </div>
      <div className="space-y-1"><Label htmlFor="dsr-note">Observação</Label><textarea id="dsr-note" name="note" maxLength={1000} rows={2} className="w-full rounded-md border border-border-input bg-surface px-2 py-1 text-sm" placeholder="Canal do pedido, protocolo, prazo combinado…" /></div>
      <div className="flex gap-2"><Button size="sm" type="submit" loading={busy}>Salvar pedido</Button><Button size="sm" variant="secondary" type="button" onClick={() => setOpen(false)}>Cancelar</Button></div>
    </form> : null}
    {list.error ? <p className="text-sm text-danger">Não foi possível carregar os pedidos.</p> : rows.length === 0 ? <p className="text-sm text-text-muted">Nenhum pedido registrado.</p> : <ul className="divide-y divide-border rounded-md border border-border text-sm">
      {rows.map(r => <li key={r.id} className="p-2"><p className="font-semibold">{kinds[r.kind] ?? r.kind}</p><p className="text-xs text-text-muted">{new Date(r.requested_at).toLocaleDateString("pt-BR")} · registrado por {r.recorded_by}</p>{r.note ? <p className="text-xs break-words">{r.note}</p> : null}</li>)}
    </ul>}
  </section>
}
