import * as React from "react"
import { useParams } from "react-router"
import { listWorkspaceLogs, type ExternalLog } from "@/data/external-requests"
import { useAsync } from "@/hooks/use-async"
import { settingsKeys } from "@/data/screen-keys"
import { Button } from "@/components/ui/button"
import { field } from "@/components/ui/input"
import { apiRequest, isFakeMode } from "@/data/api"
import { useCan } from "@/hooks/use-role"
import { viaLabel, type ActivityVia } from "@/data/profile-keys"
import { ListFilter } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { SettingsTabs } from "./settings-rows"

const kindLabel = { external_request: "Requisição externa", dynamic: "Bloco dinâmico" } as const
const levelOf = (row: ExternalLog) => row.level === "warning" ? "warning" : row.outcome === "error" ? "error" : "success"
const levelText = { error: "Erro", warning: "Aviso", success: "Sucesso" } as const
const levelBar = { error: "bg-danger", warning: "bg-warning", success: "bg-success" } as const
const relative = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" })
function ago(time: number) {
  const seconds = Math.round((time - Date.now()) / 1000), abs = Math.abs(seconds)
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute")
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), "hour")
  return relative.format(Math.round(seconds / 86400), "day")
}

/** Configurações > Registros: aba Geral (tentativas de requisição externa e de bloco dinâmico das últimas 2 semanas) e aba Atividade da conta. */
export function LogsSettings({ tab = "general" }: { tab?: "general" | "activity" }) {
  const { workspace = "demo" } = useParams()
  const admin = useCan("team")
  const tabs = [{ to: `/${workspace}/settings/logs`, label: "Geral" }, ...(admin ? [{ to: `/${workspace}/settings/logs/activity`, label: "Atividade da conta" }] : [])]
  return <section aria-label="Registros" className="min-w-0">
    <h2 className="sr-only">Registros</h2>
    <SettingsTabs label="Registros" tabs={tabs} />
    {tab === "activity" && admin ? <ActivityLog /> : <RequestLogs />}
  </section>
}

function RequestLogs() {
  const { workspace = "" } = useParams()
  const [errors, setErrors] = React.useState(true)
  const [kind, setKind] = React.useState<"" | keyof typeof kindLabel>("")
  const [level, setLevel] = React.useState<"" | "error" | "warning" | "info">("")
  const list = useAsync(() => listWorkspaceLogs({ errors, kind: kind || undefined, level: level || undefined }), `logs-settings|${errors}|${kind}|${level}`, { cache: settingsKeys.logs(workspace, errors, kind, level) })
  const rows = list.data ?? list.stale ?? []
  // O contador é do total das duas semanas, não do que os filtros deixaram na tela.
  const totals = useAsync(() => listWorkspaceLogs({ errors: false }), "logs-settings|totais", { cache: settingsKeys.logsTotals(workspace) })
  const everything = totals.data ?? totals.stale ?? []
  const count = (wanted: keyof typeof levelText) => everything.filter(row => levelOf(row) === wanted).length
  const active = (errors ? 0 : 1) + (kind ? 1 : 0) + (level ? 1 : 0)
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-text-muted" aria-live="polite">{count("success")} sucessos | {count("error")} erros | {count("warning")} avisos</p>
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xs text-text-muted">Os registros ficam guardados por duas semanas</p>
        <Popover>
          <PopoverTrigger asChild><Button variant="secondary" size="sm"><ListFilter className="size-4" aria-hidden="true" />Filtros{active ? ` (${active})` : ""}</Button></PopoverTrigger>
          <PopoverContent className="w-72 space-y-3" align="end">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-accent" checked={errors} onChange={e => setErrors(e.target.checked)} />Só erros</label>
            <select aria-label="Origem" value={kind} onChange={e => setKind(e.target.value as typeof kind)} className={cn(field, "h-9")}>
              <option value="">Todas as origens</option><option value="external_request">{kindLabel.external_request}</option><option value="dynamic">{kindLabel.dynamic}</option>
            </select>
            <select aria-label="Nível" value={level} onChange={e => { setLevel(e.target.value as typeof level); if (e.target.value) setErrors(false) }} className={cn(field, "h-9")}>
              <option value="">Todos os níveis</option><option value="error">Erro</option><option value="warning">Aviso</option><option value="info">Informação</option>
            </select>
            <Button variant="secondary" size="sm" onClick={() => { list.reload(); totals.reload() }}>Atualizar</Button>
          </PopoverContent>
        </Popover>
      </div>
    </div>
    {list.error && !rows.length ? <p role="alert" className="text-sm text-danger">Não foi possível carregar os registros.</p>
      : rows.length ? <div role="table" aria-label="Registros" className="overflow-hidden rounded-lg border border-border bg-surface">
        <div role="row" className="hidden grid-cols-[7rem_11rem_minmax(0,1fr)_9rem] gap-4 border-b border-border px-5 py-3 text-sm font-semibold md:grid"><span role="columnheader">Nível</span><span role="columnheader">Tipo</span><span role="columnheader">Descrição</span><span role="columnheader">Data</span></div>
        {rows.map((row: ExternalLog) => {
          const lv = levelOf(row)
          return <div role="row" key={row.id} className="grid gap-x-4 gap-y-1 border-b border-border px-5 py-2.5 text-sm last:border-b-0 md:grid-cols-[7rem_11rem_minmax(0,1fr)_9rem]">
            <span role="cell" className="flex items-center gap-2"><span aria-hidden="true" className={cn("h-4 w-0.5 rounded-full", levelBar[lv])} />{levelText[lv]}</span>
            <span role="cell" className="font-medium">{kindLabel[row.kind ?? "external_request"]}</span>
            <div role="cell" className="min-w-0">
              <p className="break-words">{row.message || `${row.method} ${row.target}`}</p>
              <p className="break-words text-xs text-text-muted">{row.method} {row.target}{row.status ? ` · ${row.status}` : ""} · {row.duration_ms} ms · {row.source === "test" ? "Teste" : "Automação"}{row.automation_name ? ` ${row.automation_name}` : ""}{row.node_id ? ` · passo ${row.node_id}` : ""}{row.contact_name ? ` · ${row.contact_name}` : ""}</p>
            </div>
            <time role="cell" dateTime={new Date(row.created_at).toISOString()} title={new Date(row.created_at).toLocaleString("pt-BR")} className="text-text-muted">{ago(row.created_at)}</time>
          </div>
        })}
      </div>
      : <p className="rounded-lg border border-border bg-surface p-5 text-sm text-text-muted">{list.loading ? "Carregando…" : "Nenhum registro no período."}</p>}
  </div>
}

type Activity = { id: number; method: string; path: string; status: number; created_at: number; user_name: string | null } & ActivityVia
const verbs: Record<string, string> = { POST: "Criou ou executou", PUT: "Salvou", PATCH: "Alterou", DELETE: "Excluiu" }
/** Log de atividade da conta (dono e administrador): quem mudou o quê nos últimos 90 dias. */
function ActivityLog() {
  const { workspace = "" } = useParams()
  const log = useAsync(() => isFakeMode() ? Promise.resolve({ items: [] as Activity[] }) : apiRequest<{ items: Activity[] }>("/activity-log"), "activity-log", { cache: `activity-log|${workspace}` })
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">Atividade da conta</h3><p className="text-xs text-text-muted">Quem mudou o quê nos últimos 90 dias</p></div>
    <div className="rounded-lg border border-border bg-surface px-5">
      {(log.data?.items ?? []).length ? <ul className="divide-y divide-border text-sm">{log.data!.items.map(a => <li key={a.id} className="flex flex-wrap gap-x-2 py-3">
        <span className="font-semibold">{a.user_name ?? "Alguém"}</span><span>{verbs[a.method] ?? a.method}</span><span className="break-all font-mono text-xs text-text-muted">{a.path.replace(/^\/api\//, "")}</span>{viaLabel(a) ? <span className="text-text-muted">{viaLabel(a)}</span> : null}
        <span className="ml-auto text-xs text-text-muted">{new Date(a.created_at).toLocaleString("pt-BR")}</span></li>)}</ul>
        : <p className="py-4 text-sm text-text-muted">{log.loading ? "Carregando…" : "Nenhuma alteração registrada."}</p>}
    </div>
  </div>
}
