import * as React from "react"
import { Link, useParams } from "react-router"
import { toast } from "sonner"
import { apiRequest, isFakeMode } from "@/data/api"
import { listAutomations } from "@/data"
import { useAsync } from "@/hooks/use-async"
import { useCan } from "@/hooks/use-role"
import { Button } from "@/components/ui/button"
import { field } from "@/components/ui/input"
import { FieldSelect } from "@/components/ui/field-select"
import { AutomationPicker } from "@/components/automations/automation-picker"
import { TriggerMetrics } from "@/components/editor/trigger-metrics"

type Detail = { id: string; name: string; type_label: string; status: string; automation_id: string; automation_name: string; channel_id: string | null; channel_name: string | null; opt_in_status: "subscribe" | "do_not_send"; follow_up: string | null }

/** Página do gatilho (ex.: menção em story): métricas próprias (envios, únicos, e-mails, telefones) e Substituir a automação que ele dispara. */
export function TriggerPage() {
  const { workspace = "", triggerId = "" } = useParams()
  const canEdit = useCan("edit")
  const detail = useAsync(() => isFakeMode() ? Promise.reject(new Error("Página disponível com o motor conectado.")) : apiRequest<Detail>(`/triggers/${encodeURIComponent(triggerId)}`), `trigger|${triggerId}`)
  const automations = useAsync(() => listAutomations(workspace), `trigger-automations|${workspace}`)
  const [target, setTarget] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const d = detail.data
  if (detail.error) return <p role="alert" className="p-6">{detail.error.message}</p>
  if (!d) return <p role="status" className="p-6 text-text-muted">Carregando…</p>
  const options = (automations.data ?? []).filter(a => a.published_version_id && a.id !== d.automation_id && !a.deleted_at)
  return <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
    <header className="space-y-1">
      <Link to={`/${workspace}/automations/triggers`} className="text-sm text-accent hover:underline">← Gatilhos</Link>
      <h1 className="text-xl font-bold">{d.name}</h1>
      <p className="text-sm text-text-muted">{d.type_label}{d.channel_name ? ` · ${d.channel_name}` : ""} · {d.status === "active" ? "Ativo" : "Desligado"} · dispara <Link className="text-accent hover:underline" to={`/${workspace}/automations/${d.automation_id}`}>{d.automation_name}</Link></p>
    </header>
    {canEdit ? <section aria-label="Substituir" className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-surface p-4">
      <div className="min-w-0 flex-1 space-y-1"><p className="text-sm font-medium">Substituir a automação deste gatilho</p>
        <AutomationPicker workspace={workspace} automations={options} value={target} onChange={setTarget} clearLabel="Limpar a automação escolhida" buttonAriaLabel="Automação que vai substituir" /></div>
      <Button loading={busy} disabled={!target} onClick={async () => {
        setBusy(true)
        try { await apiRequest(`/triggers/${encodeURIComponent(d.id)}/replace`, { method: "POST", body: JSON.stringify({ automation_id: target }) }); toast.success("Gatilho agora dispara a nova automação."); setTarget(""); detail.reload() }
        catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível substituir.") } finally { setBusy(false) }
      }}>Substituir</Button>
    </section> : null}
    {canEdit ? <section aria-label="Inscrição" className="space-y-1 rounded-lg border border-border bg-surface p-4">
      <FieldSelect id="optin" label="Quem entra por este gatilho" value={d.opt_in_status} options={[{ value: "subscribe", label: "Fica inscrito (recebe transmissões)" }, { value: "do_not_send", label: "Não enviar transmissões (do_not_send)" }]}
        onChange={async opt_in_status => { try { await apiRequest(`/triggers/${encodeURIComponent(d.id)}/opt-in-status`, { method: "PUT", body: JSON.stringify({ opt_in_status }) }); toast.success("Inscrição do gatilho salva."); detail.reload() } catch (err) { toast.error(err instanceof Error ? err.message : "Falhou.") } }} />
      <p className="text-xs text-text-muted">Com "não enviar", a conversa e a automação seguem normalmente; a pessoa só entra nas transmissões quando se inscrever.</p>
    </section> : null}
    {canEdit ? <FollowUp workspace={workspace} trigger={d.id} current={d.follow_up ? JSON.parse(d.follow_up) : null} automations={(automations.data ?? []).filter(a => !a.deleted_at)} onSaved={detail.reload} /> : null}
    <TriggerMetrics automationId={d.automation_id} triggers={[{ id: d.id, name: d.name, channel_id: d.channel_id }]} workspace={workspace} />
  </div>
}

/** Follow-up: se o contato não escrever em X minutos depois do disparo, começa a automação escolhida. */
function FollowUp({ workspace, trigger, current, automations, onSaved }: { workspace: string; trigger: string; current: { after_minutes: number; automation_id: string } | null; automations: { id: string; name: string; published_version_id?: string | null }[]; onSaved: () => void }) {
  const [minutes, setMinutes] = React.useState(current?.after_minutes ?? 60)
  const [automation, setAutomation] = React.useState(current?.automation_id ?? "")
  const save = (follow_up: { after_minutes: number; automation_id: string } | null) => apiRequest(`/triggers/${encodeURIComponent(trigger)}/follow-up`, { method: "PUT", body: JSON.stringify({ follow_up }) })
    .then(() => { toast.success(follow_up ? "Follow-up salvo." : "Follow-up desligado."); onSaved() }).catch((e: Error) => toast.error(e.message))
  return <section aria-label="Follow-up" className="space-y-2 rounded-lg border border-border bg-surface p-4">
    <p className="text-sm font-medium">Follow-up</p>
    <p className="text-xs text-text-muted">Se a pessoa não responder depois do disparo, começa outra automação.</p>
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-sm">Depois de (min)<input type="number" min={1} max={10080} value={minutes} onChange={e => setMinutes(Number(e.target.value))} className={`${field} ml-2 h-10 w-24`} /></label>
      <div className="min-w-0 flex-1"><AutomationPicker workspace={workspace} automations={automations} value={automation} onChange={setAutomation} onlyPublished={false} clearLabel="Limpar a automação do follow-up" buttonAriaLabel="Automação do follow-up" /></div>
      <Button disabled={!automation || minutes < 1} onClick={() => void save({ after_minutes: minutes, automation_id: automation })}>Salvar</Button>
      {current ? <Button variant="ghost" onClick={() => void save(null)}>Desligar</Button> : null}
    </div>
  </section>
}
