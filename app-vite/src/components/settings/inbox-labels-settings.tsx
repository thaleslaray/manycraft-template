import * as React from "react"
import { useParams } from "react-router"
import { Trash2 } from "lucide-react"
import { toast } from "sonner"
import { apiRequest, isFakeMode } from "@/data/api"
import { emptyContactFilter, type ContactQueryFilter } from "@/data/segments"
import { useAsync } from "@/hooks/use-async"
import { settingsKeys } from "@/data/screen-keys"
import { useCan } from "@/hooks/use-role"
import { ContactFilterBuilder } from "@/components/contacts/contact-filter-builder"
import { LabelChips, listInboxLabels } from "@/components/inbox/inbox-labels"
import { Button } from "@/components/ui/button"
import { Input, field } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const colors = { neutral: "Neutra", accent: "Destaque", success: "Verde", warning: "Amarela", danger: "Vermelha" }

/** Etiquetas da Caixa de entrada: manuais (a equipe põe) ou automáticas (condição sobre o contato, aplicada quando chega mensagem). */
export function InboxLabelsSettings() {
  const { workspace = "" } = useParams()
  const editable = useCan("edit")
  const labels = useAsync(listInboxLabels, "inbox-labels-settings", { cache: settingsKeys.inboxLabels(workspace) })
  const [auto, setAuto] = React.useState(false)
  const [condition, setCondition] = React.useState<ContactQueryFilter>(emptyContactFilter())
  const [busy, setBusy] = React.useState(false)
  if (isFakeMode()) return null
  return <fieldset disabled={!editable || busy} className="space-y-3 rounded-lg border border-border bg-surface p-5">
    <h3 className="font-semibold">Etiquetas</h3>
    <p className="text-sm text-text-muted">Marcam conversas para a equipe filtrar. As automáticas entram sozinhas quando o contato atende à condição ao mandar mensagem.</p>
    <ul className="divide-y divide-border">{(labels.data ?? []).map(l => <li key={l.id} className="flex items-center gap-2 py-2">
      <div className="min-w-0 flex-1"><LabelChips labels={[l]} /><p className="text-xs text-text-muted">{l.condition ? "Automática" : "Manual"} · {l.conversations ?? 0} conversas</p></div>
      <Button variant="ghost" size="sm" aria-label={`Excluir etiqueta ${l.name}`} onClick={async () => { try { await apiRequest(`/inbox/labels/${encodeURIComponent(l.id)}`, { method: "DELETE" }); labels.reload() } catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível excluir.") } }}><Trash2 className="size-4" /></Button>
    </li>)}</ul>
    <form className="space-y-3 border-t border-border pt-3" onSubmit={async e => {
      e.preventDefault(); const el = e.currentTarget, form = new FormData(el)
      setBusy(true)
      try {
        await apiRequest("/inbox/labels", { method: "POST", body: JSON.stringify({ name: String(form.get("name")), color: form.get("color"), condition: auto && condition.rules.length ? condition : null }) })
        toast.success("Etiqueta criada."); el.reset(); setAuto(false); setCondition(emptyContactFilter()); labels.reload()
      } catch (err) { toast.error(err instanceof Error ? err.message : "Não foi possível criar a etiqueta.") } finally { setBusy(false) }
    }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1"><Label htmlFor="label-name">Nova etiqueta</Label><Input id="label-name" name="name" required maxLength={40} placeholder="Orçamento" /></div>
        <div className="space-y-1"><Label htmlFor="label-color">Cor</Label><select id="label-color" name="color" className={`${field} h-10`}>{Object.entries(colors).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-accent" checked={auto} onChange={e => setAuto(e.target.checked)} />Aplicar sozinha quando o contato atender a uma condição</label>
      {auto ? <ContactFilterBuilder filter={condition} onChange={setCondition} /> : null}
      <Button type="submit" variant="secondary" size="sm" loading={busy}>Criar etiqueta</Button>
    </form>
  </fieldset>
}
