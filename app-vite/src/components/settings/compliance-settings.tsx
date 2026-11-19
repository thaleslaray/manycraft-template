import { useParams } from "react-router"
import { apiRequest, isFakeMode } from "@/data/api"
import { useAsync } from "@/hooks/use-async"
import { settingsKeys } from "@/data/screen-keys"
import { Button } from "@/components/ui/button"

type Report = { status: "ok" | "attention" | "at_risk"; issues: { severity: "high" | "medium" | "low"; kind: string; title: string; detail: string }[]; metrics: { contacts: number; unsubscribed_7d: number; sent_7d: number; failed_7d: number } }
const statusText = { ok: "Tudo em ordem", attention: "Pede atenção", at_risk: "Em risco" } as const
const severityText = { high: "Alto", medium: "Médio", low: "Baixo" } as const

/** Configurações > Conformidade: conexões com erro, modelos rejeitados ou pausados, descadastro e falhas de envio da última semana. */
export const loadCompliance = () => isFakeMode() ? Promise.resolve<Report>({ status: "ok", issues: [], metrics: { contacts: 0, unsubscribed_7d: 0, sent_7d: 0, failed_7d: 0 } }) : apiRequest<Report>("/compliance")
export function ComplianceSettings() {
  const { workspace = "" } = useParams()
  const report = useAsync(loadCompliance, "compliance", { cache: settingsKeys.compliance(workspace) })
  const r = report.data
  return <section aria-label="Conformidade" className="min-w-0 space-y-4 rounded-lg border border-border bg-surface p-6">
    <div className="flex items-center justify-between gap-2"><h2 className="text-lg font-semibold">Conformidade</h2><Button size="sm" variant="secondary" onClick={() => report.reload()}>Atualizar</Button></div>
    {report.loading ? <p role="status" className="text-sm text-text-muted">Verificando…</p>
      : report.error || !r ? <p role="alert" className="text-sm text-danger">Não foi possível verificar.</p>
      : <>
        <p className={`text-sm font-semibold ${r.status === "at_risk" ? "text-danger" : r.status === "attention" ? "text-warning" : "text-success"}`}>{statusText[r.status]}</p>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          {([["Contatos", r.metrics.contacts], ["Descadastros 7d", r.metrics.unsubscribed_7d], ["Envios 7d", r.metrics.sent_7d], ["Falhas 7d", r.metrics.failed_7d]] as const).map(([k, v]) => <div key={k} className="rounded-md bg-surface-muted p-3"><dt className="text-text-muted">{k}</dt><dd className="text-lg font-semibold">{v}</dd></div>)}
        </dl>
        {r.issues.length ? <ul className="divide-y divide-border">{r.issues.map((i, n) => <li key={n} className="py-3 text-sm">
          <p className="font-medium"><span className={`mr-2 rounded px-2 py-0.5 text-xs ${i.severity === "high" ? "bg-danger-soft text-danger" : "bg-surface-muted"}`}>{severityText[i.severity]}</span>{i.title}</p>
          <p className="text-text-muted">{i.detail}</p></li>)}</ul> : <p className="text-sm text-text-muted">Nenhum risco encontrado.</p>}
      </>}
  </section>
}
