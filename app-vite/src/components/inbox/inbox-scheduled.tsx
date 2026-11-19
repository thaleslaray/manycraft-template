import * as React from "react"
import { CalendarClock, X } from "lucide-react"
import { toast } from "sonner"
import { apiRequest, isFakeMode } from "@/data/api"
import { useAsync } from "@/hooks/use-async"
import { Button } from "@/components/ui/button"
import { closeOnEscape, useOpenState } from "./inbox-shared"

type Scheduled = { id: string; text: string; send_at: string; status: "scheduled" | "sending" | "sent" | "failed"; error: string | null; created_by_name: string | null; mine: boolean }
const statusText = { scheduled: "Agendada", sending: "Enviando", sent: "Enviada", failed: "Não saiu" }

/** Mensagem agendada na conversa: sai no horário pelas regras do canal daquele momento (janela e opt-in). */
export function InboxScheduled({ conversationId, disabled, open: controlled, onOpenChange, compact = false }: { conversationId: string; disabled: boolean; open?: boolean; onOpenChange?: (open: boolean) => void; compact?: boolean }) {
  const path = `/inbox/conversations/${encodeURIComponent(conversationId)}/scheduled`
  const list = useAsync(() => isFakeMode() ? Promise.resolve([] as Scheduled[]) : apiRequest<Scheduled[]>(path), conversationId)
  const [open, setOpen] = useOpenState(controlled, onOpenChange)
  const [text, setText] = React.useState("")
  const [when, setWhen] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  if (isFakeMode()) return null
  const rows = list.data ?? list.stale ?? []
  const min = new Date(Date.now() + 120_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
  async function schedule(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      await apiRequest(path, { method: "POST", body: JSON.stringify({ text: text.trim(), send_at: new Date(when).toISOString() }) })
      toast.success("Mensagem agendada.")
      setOpen(false); setText(""); setWhen(""); list.reload()
    } catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível agendar.") } finally { setBusy(false) }
  }
  async function cancel(id: string) {
    try { await apiRequest(`${path}/${encodeURIComponent(id)}`, { method: "DELETE" }); list.reload() }
    catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível cancelar.") }
  }
  // Compacto: some quando não há agendamento nem formulário aberto (o menu ⋮ abre o formulário).
  if (compact && !open && !rows.some(r => r.status !== "sent")) return null
  return <section aria-label="Mensagens agendadas" className="max-h-56 space-y-2 overflow-y-auto border-t border-border px-4 py-2">
    <div className="flex items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 text-xs font-semibold text-text-muted"><CalendarClock className="size-4" aria-hidden="true" />Mensagens agendadas</h3>
      {!open && !compact ? <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setOpen(true)}>Agendar</Button> : null}
    </div>
    {open ? <form onSubmit={schedule} onKeyDown={closeOnEscape(() => setOpen(false))} className="space-y-2">
      <textarea required maxLength={4000} rows={2} value={text} onChange={e => setText(e.target.value)} aria-label="Texto da mensagem agendada" placeholder="Escreva a mensagem que sai no horário" className="w-full rounded-md border border-border-input bg-surface px-2 py-1 text-sm" />
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-xs font-semibold">Enviar em<input type="datetime-local" required min={min} value={when} onChange={e => setWhen(e.target.value)} className="h-9 rounded-md border border-border-input bg-surface px-2 text-sm font-normal" /></label>
        <Button size="sm" type="submit" loading={busy} disabled={!text.trim() || !when}>Agendar mensagem</Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>Cancelar</Button>
      </div>
      <p className="text-xs text-text-muted">No horário valem as regras do canal: com a janela fechada ou sem autorização, a mensagem não sai e o aviso aparece no histórico.</p>
    </form> : null}
    {rows.length ? <ul className="space-y-1">{rows.map(r => <li key={r.id} className="flex items-start gap-2 rounded-md bg-surface-muted p-2 text-xs">
      <div className="min-w-0 flex-1"><p className="break-words">{r.text}</p><p className="text-text-muted">{statusText[r.status]} · {new Date(r.send_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}{r.created_by_name ? ` · por ${r.created_by_name}` : ""}{r.error ? ` · ${r.error}` : ""}</p></div>
      {r.status === "scheduled" ? <Button size="icon" variant="ghost" className="size-7" aria-label="Cancelar agendamento" onClick={() => cancel(r.id)}><X className="size-4" aria-hidden="true" /></Button> : null}
    </li>)}</ul> : null}
  </section>
}
