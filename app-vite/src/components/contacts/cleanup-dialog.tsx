import * as React from "react"
import { toast } from "sonner"
import { apiRequest } from "@/data/api"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type Action = "tag" | "unsubscribe" | "delete"
const selectClass = "h-10 w-full rounded-md border border-border-input bg-surface px-3 text-sm"
const verbs: Record<Action, string> = { tag: "marcar com a tag", unsubscribe: "descadastrar", delete: "excluir" }

/** Limpeza da lista: todos os contatos sem interação há N dias, não só os carregados na tela. Mostra a contagem antes de agir. */
export function CleanupDialog({ tags, onClose, onDone }: { tags: { id: string; name: string }[]; onClose: () => void; onDone: () => void }) {
  const [days, setDays] = React.useState(90)
  const [action, setAction] = React.useState<Action>("tag")
  const [tagId, setTagId] = React.useState(tags[0]?.id ?? "")
  const [count, setCount] = React.useState<number | null>(null)
  const [confirm, setConfirm] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const body = (apply: boolean) => JSON.stringify({ inactive_days: days, action, ...(action === "tag" ? { tag_id: tagId } : {}), apply })
  React.useEffect(() => {
    setCount(null)
    if (!Number.isInteger(days) || days < 7 || days > 3650 || (action === "tag" && !tagId)) return
    let live = true
    const timer = setTimeout(() => apiRequest<{ count: number }>("/contacts/cleanup", { method: "POST", body: body(false) }).then(r => { if (live) setCount(r.count) }).catch(() => {}), 300)
    return () => { live = false; clearTimeout(timer) }
  }, [days, action, tagId]) // eslint-disable-line react-hooks/exhaustive-deps
  const needsWord = action === "delete"
  async function apply() {
    setBusy(true)
    try {
      let result = await apiRequest<{ count: number; done: number; remaining: number }>("/contacts/cleanup", { method: "POST", body: body(true) })
      let done = result.done
      while (result.remaining > 0 && action === "delete") { result = await apiRequest("/contacts/cleanup", { method: "POST", body: body(true) }); done += result.done }
      toast.success(`${done} ${done === 1 ? "contato" : "contatos"}: ${verbs[action]} concluído.`)
      onDone()
    } catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível limpar a lista.") } finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={open => !open && !busy && onClose()}>
    <DialogContent>
      <DialogHeader><DialogTitle>Limpar lista</DialogTitle><DialogDescription>Age em todos os contatos sem interação no período, não só nos que aparecem na tela.</DialogDescription></DialogHeader>
      <div className="space-y-4">
        <div className="space-y-1"><Label htmlFor="cleanup-days">Sem interação há mais de (dias)</Label><Input id="cleanup-days" type="number" min={7} max={3650} value={days} onChange={e => setDays(Number(e.target.value))} /></div>
        <div className="space-y-1"><Label htmlFor="cleanup-action">O que fazer</Label><select id="cleanup-action" className={selectClass} value={action} onChange={e => setAction(e.target.value as Action)}><option value="tag">Marcar com uma tag</option><option value="unsubscribe">Descadastrar</option><option value="delete">Excluir</option></select></div>
        {action === "tag" ? <div className="space-y-1"><Label htmlFor="cleanup-tag">Tag</Label><select id="cleanup-tag" className={selectClass} value={tagId} onChange={e => setTagId(e.target.value)}>{tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div> : null}
        <p role="status" className="text-sm">{count === null ? "Contando contatos…" : `${count} ${count === 1 ? "contato será afetado" : "contatos serão afetados"}.`}</p>
        {needsWord ? <div className="space-y-1"><Label htmlFor="cleanup-confirm">Digite EXCLUIR para confirmar</Label><Input id="cleanup-confirm" value={confirm} onChange={e => setConfirm(e.target.value)} /></div> : null}
      </div>
      <DialogFooter><Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button><Button variant={action === "delete" ? "danger" : "primary"} loading={busy} disabled={!count || (needsWord && confirm !== "EXCLUIR")} onClick={apply}>Aplicar a {count ?? 0}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
