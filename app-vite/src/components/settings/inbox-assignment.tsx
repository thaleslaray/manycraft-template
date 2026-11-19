import * as React from "react"
import { Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { apiRequest, isFakeMode } from "@/data/api"
import { getInboxContext } from "@/data/inbox-team"
import { emptyContactFilter, type ContactQueryFilter } from "@/data/segments"
import { useAsync } from "@/hooks/use-async"
import { useCan } from "@/hooks/use-role"
import { useDraft, useFormKey } from "@/hooks/use-draft"
import { settingsKeys } from "@/data/screen-keys"
import { useParams } from "react-router"
import { ContactFilterBuilder } from "@/components/contacts/contact-filter-builder"
import { Button } from "@/components/ui/button"
import { Input, field } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { SettingsCard, SettingsRow, SettingsRows } from "./settings-rows"

type Mode = "off" | "basic" | "advanced"
type Assignment = { auto_assign: Mode; assign_limit: number | null }
type Group = { id: string; name: string; member_ids: string[] }
type Rule = { name: string; condition: ContactQueryFilter; target_kind: "member" | "group"; target_id: string }

export const loadAssignment = async () => isFakeMode() ? null : {
  assignment: await apiRequest<Assignment>("/inbox/assignment"), groups: await apiRequest<Group[]>("/inbox/groups"),
  rules: await apiRequest<Rule[]>("/inbox/assignment-rules"), members: (await getInboxContext()).members,
}
function useAssignmentData() {
  const { workspace = "" } = useParams()
  return useAsync(loadAssignment, "inbox-assignment", { cache: settingsKeys.assignment(workspace) })
}

const modes: { id: Mode; title: string; text: string }[] = [
  { id: "off", title: "Desligado", text: "Os membros da equipe escolhem as conversas manualmente a partir da pasta Não atribuída." },
  { id: "basic", title: "Básico", text: "Distribui conversas para quem tem menos conversas abertas." },
  { id: "advanced", title: "Avançado", text: "Atribui conversas a grupos ou membros da equipe com as regras abaixo; sem regra, como no básico." },
]

/** Atribuição automática: três modos lado a lado, limite por atendente e regras em ordem. */
export function InboxAssignmentSettings() {
  const editable = useCan("team")
  const data = useAssignmentData()
  const [mode, setMode] = React.useState<Mode | null>(null)
  const [busy, setBusy] = React.useState(false)
  const snapshot = data.data ?? data.stale
  // Regras e limite nascem do dado (às vezes do cache) e acompanham a revalidação enquanto ninguém mexeu neles.
  const [rules, setRules] = useDraft<Rule[] | null>(snapshot?.rules ?? null)
  const limitForm = useFormKey(String(snapshot?.assignment.assign_limit ?? "sem-limite"))
  if (isFakeMode() || !snapshot) return <p role="status" className="text-sm text-text-muted">{isFakeMode() ? "A atribuição automática vale só com o motor ligado." : "Carregando…"}</p>
  async function run(task: () => Promise<unknown>, success: string) {
    setBusy(true)
    try { await task(); toast.success(success); data.reload(); return true } catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível salvar."); return false } finally { setBusy(false) }
  }
  const chosen = mode ?? snapshot.assignment.auto_assign
  return <fieldset disabled={busy || !editable} className="min-w-0 space-y-6">
    <section aria-label="Atribuição automática" className="rounded-lg border border-border bg-surface px-6 pb-7 pt-7">
      <h2 className="text-xl font-semibold">Atribuição automática</h2>
      <p className="mt-3 text-sm text-text-muted">Use a atribuição automática para distribuir conversas entre agentes. O sistema atribui conversas aos membros da equipe quando uma conversa sem responsável recebe mensagem. Defina o limite de conversas por atendente logo abaixo e as regras do modo avançado na última seção.</p>
      <div role="radiogroup" aria-label="Modo de atribuição" className="mt-4 grid gap-3 lg:grid-cols-3">
        {modes.map(item => <label key={item.id} className={cn("flex cursor-pointer items-start gap-3 rounded-md border bg-surface p-4", chosen === item.id ? "border-accent" : "border-border-input")}>
          <input type="radio" name="mode" value={item.id} checked={chosen === item.id} onChange={() => { setMode(item.id); void run(() => apiRequest("/inbox/assignment", { method: "PUT", body: JSON.stringify({ auto_assign: item.id, assign_limit: snapshot.assignment.assign_limit }) }), "Atribuição salva.") }} className="mt-1 size-4 accent-accent" />
          <span><span className="block text-sm font-medium">{item.title}</span><span className="mt-0.5 block text-xs text-text-muted">{item.text}</span></span>
        </label>)}
      </div>
    </section>
    <SettingsRows label="Limite por atendente">
      <form key={limitForm.key} onChange={limitForm.touch} onSubmit={e => {
        e.preventDefault(); const limit = String(new FormData(e.currentTarget).get("limit"))
        void run(() => apiRequest("/inbox/assignment", { method: "PUT", body: JSON.stringify({ auto_assign: chosen, assign_limit: limit ? Number(limit) : null }) }), "Atribuição salva.").then(ok => { if (ok) limitForm.release() })
      }}>
        <SettingsRow label="Limite de conversas abertas por atendente" htmlFor="assign-limit" help="Quem chegou no limite não recebe novas conversas.">
          <div className="flex gap-2"><Input id="assign-limit" name="limit" type="number" min={1} max={1000} defaultValue={snapshot.assignment.assign_limit ?? ""} placeholder="Sem limite" /><Button type="submit" loading={busy}>Salvar limite</Button></div>
        </SettingsRow>
      </form>
    </SettingsRows>
    <SettingsCard title="Regras de atribuição">
      <div className="space-y-3 px-4 pb-5 sm:px-6">
        <p className="text-sm text-text-muted">Valem no modo avançado, em ordem: a primeira regra cujo contato casa decide para quem vai.</p>
        {(rules ?? []).map((rule, i) => <div key={i} className="space-y-2 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-40 flex-1 space-y-1 text-xs font-semibold">Nome<Input value={rule.name} maxLength={80} onChange={e => setRules(rules!.map((r, j) => j === i ? { ...r, name: e.target.value } : r))} /></label>
            <label className="space-y-1 text-xs font-semibold">Para<select className={`${field} h-10`} value={`${rule.target_kind}:${rule.target_id}`} onChange={e => { const [kind, ...id] = e.target.value.split(":"); setRules(rules!.map((r, j) => j === i ? { ...r, target_kind: kind as Rule["target_kind"], target_id: id.join(":") } : r)) }}>
              <option value=":">Escolha</option>
              <optgroup label="Grupos">{snapshot.groups.map(g => <option key={g.id} value={`group:${g.id}`}>{g.name}</option>)}</optgroup>
              <optgroup label="Pessoas">{snapshot.members.map(m => <option key={m.id} value={`member:${m.id}`}>{m.name}</option>)}</optgroup>
            </select></label>
            <Button variant="ghost" size="sm" aria-label={`Remover regra ${rule.name}`} onClick={() => setRules(rules!.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
          </div>
          <ContactFilterBuilder filter={rule.condition} onChange={condition => setRules(rules!.map((r, j) => j === i ? { ...r, condition } : r))} />
        </div>)}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setRules([...(rules ?? []), { name: `Regra ${(rules?.length ?? 0) + 1}`, condition: emptyContactFilter(), target_kind: "group", target_id: snapshot.groups[0]?.id ?? "" }])}><Plus className="size-4" />Adicionar regra</Button>
          <Button size="sm" loading={busy} onClick={() => void run(() => apiRequest("/inbox/assignment-rules", { method: "PUT", body: JSON.stringify(rules ?? []) }), "Regras salvas.")}>Salvar regras</Button>
        </div>
      </div>
    </SettingsCard>
  </fieldset>
}

/** Grupos de equipe (aba Grupos de Membros da equipe): quem atende junto, usados como destino das regras. */
export function InboxGroups() {
  const editable = useCan("team")
  const data = useAssignmentData()
  const [busy, setBusy] = React.useState(false)
  const snapshot = data.data ?? data.stale
  if (isFakeMode() || !snapshot) return <p role="status" className="text-sm text-text-muted">{isFakeMode() ? "Os grupos valem só com o motor ligado." : "Carregando…"}</p>
  async function run(task: () => Promise<unknown>, success: string) {
    setBusy(true)
    try { await task(); toast.success(success); data.reload(); return true } catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível salvar."); return false } finally { setBusy(false) }
  }
  const nameOf = (id: string) => snapshot.members.find(m => m.id === id)?.name ?? "Pessoa removida"
  return <fieldset disabled={busy || !editable} className="min-w-0">
    <SettingsCard title="Grupos de equipe">
      <div className="space-y-3 px-4 pb-5 sm:px-6">
        {snapshot.groups.length ? <ul className="divide-y divide-border">{snapshot.groups.map(g => <li key={g.id} className="flex items-start gap-2 py-3"><div className="min-w-0 flex-1"><p className="text-sm font-semibold">{g.name}</p><p className="text-xs text-text-muted">{g.member_ids.map(nameOf).join(", ") || "Sem pessoas"}</p></div>
          <Button variant="ghost" size="sm" aria-label={`Excluir grupo ${g.name}`} onClick={() => void run(() => apiRequest(`/inbox/groups/${encodeURIComponent(g.id)}`, { method: "DELETE" }), "Grupo excluído.")}><Trash2 className="size-4" /></Button></li>)}</ul>
          : <p className="text-sm text-text-muted">Nenhum grupo ainda.</p>}
        <form className="space-y-2 border-t border-border pt-4" onSubmit={async e => {
          e.preventDefault(); const el = e.currentTarget, form = new FormData(el)
          if (await run(() => apiRequest("/inbox/groups", { method: "POST", body: JSON.stringify({ name: String(form.get("name")), member_ids: form.getAll("member").map(String) }) }), "Grupo criado.")) el.reset()
        }}>
          <div className="max-w-sm space-y-1"><Label htmlFor="group-name">Novo grupo</Label><Input id="group-name" name="name" required maxLength={80} placeholder="Vendas" /></div>
          <div className="flex flex-wrap gap-3">{snapshot.members.map(m => <label key={m.id} className="flex items-center gap-2 text-sm"><input type="checkbox" name="member" value={m.id} className="size-4 accent-accent" />{m.name}</label>)}</div>
          <Button type="submit" variant="secondary" size="sm">Criar grupo</Button>
        </form>
      </div>
    </SettingsCard>
  </fieldset>
}
