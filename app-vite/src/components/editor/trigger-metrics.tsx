import * as React from "react"
import { Link } from "react-router"
import { Activity, ChevronRight, Megaphone, CheckCheck, Eye, Loader2, MousePointer2, Percent, Send, UserPlus, Users } from "lucide-react"
import { listConnections, type Connection } from "@/data/connections"
import type { Trigger } from "@/data/types"
import { getMetricContacts, getTriggerMetrics, type MetricContactsPage, type TriggerMetric, type TriggerMetricsData } from "@/data/trigger-metrics"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CalledByList } from "./called-by"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"

const metrics = [
  { key: "runs", label: "Execuções", icon: Activity },
  { key: "optins", label: "Opt-ins", icon: UserPlus },
  { key: "sent", label: "Enviadas", icon: Send },
  { key: "delivered", label: "Entregues", icon: CheckCheck },
  { key: "read", label: "Lidas", icon: Eye },
  { key: "clicked", label: "Clicadas", icon: MousePointer2 },
  { key: "ctr", label: "CTR", icon: Percent },
] as const

type ReceiptProfile = { receipts?: { delivered?: boolean; read?: boolean } }
/** No desktop, `showMore` e `showCalled` vêm do menu ⋮ do editor: a lateral abre só com o filtro de gatilho e os quatro cartões, como no original.
 *  Sem eles (celular, onde não há menu), "Mais métricas" é um botão na própria lateral e "Chamada por" fica sempre à vista. */
type Props = { automationId: string; triggers: Pick<Trigger, "id" | "name" | "channel_id">[]; workspace: string; showMore?: boolean; showCalled?: boolean }
const number = new Intl.NumberFormat("pt-BR")
const percent = new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 1 })
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Não foi possível carregar os dados."

/** Recibos dependem da ficha efetiva. Um vínculo ausente não declara suporte. */
function receiptSupport(ids: (string | null)[], connections: Connection[], receipt: "delivered" | "read"): boolean | undefined {
  if (!ids.length) return undefined
  const support = ids.map(id => (connections.find(connection => connection.id === id)?.profile as ReceiptProfile | undefined)?.receipts?.[receipt])
  if (support.some(value => value === true)) return true
  return support.every(value => value === false) ? false : undefined
}

export function TriggerMetrics({ automationId, triggers, workspace, showMore, showCalled }: Props) {
  const [trigger, setTrigger] = React.useState("")
  const [period, setPeriod] = React.useState(30)
  const [retry, setRetry] = React.useState(0)
  const [data, setData] = React.useState<TriggerMetricsData | null>(null)
  const [connections, setConnections] = React.useState<Connection[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [metric, setMetricKey] = React.useState<TriggerMetric | null>(null)
  // Envios e Contatos únicos listam os mesmos contatos (os das execuções), mas cada card abre a lista com o próprio título.
  const [heading, setHeading] = React.useState<string | null>(null)
  const setMetric = (key: TriggerMetric | null, title: string | null = null) => { setMetricKey(key); setHeading(title) }

  React.useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    Promise.all([getTriggerMetrics(automationId, { trigger_id: trigger || undefined, period_days: period }), listConnections(workspace)])
      .then(([stats, rows]) => { if (active) { setData(stats); setConnections(rows) } })
      .catch(cause => { if (active) setError(errorMessage(cause)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [automationId, trigger, period, retry, workspace])

  const ids = [...new Set(triggers.filter(row => !trigger || row.id === trigger).map(row => row.channel_id))]
  function value(key: TriggerMetric): string {
    if (loading) return "…"
    if (!data || error) return "—"
    if (key === "delivered" || key === "read") {
      const supported = receiptSupport(ids, connections, key)
      if (supported !== true) return supported === false ? "Sem suporte" : "Não informado"
    }
    const count = key === "ctr" ? data.ctr : data[key]
    return count === null ? "—" : key === "ctr" ? percent.format(count) : number.format(count)
  }

  const impressionsValue = loading ? "…" : !data || error || data.impressions == null ? "—" : number.format(data.impressions)

  const [moreOwn, setMoreOwn] = React.useState(false)
  const more = showMore ?? moreOwn
  const extras = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => { if (showMore || showCalled) extras.current?.scrollIntoView({ block: "nearest" }) }, [showMore, showCalled])
  const ready = !loading && data && !error
  const plain = (text: string, count: number | undefined) => loading ? "…" : !ready ? "—" : text.replace("#", number.format(count ?? 0))

  return (
    <section aria-label="Métricas por gatilho" className="w-full shrink-0 overflow-y-auto border-border bg-surface p-5 md:w-95 md:border-r">
      <h2 className="mb-7 text-lg font-semibold">Principais métricas</h2>
      <div className="mb-6 flex gap-2">
        <Select value={trigger || "all"} onValueChange={value => { setTrigger(value === "all" ? "" : value); setMetric(null) }}>
          <SelectTrigger aria-label="Filtrar métricas por gatilho" className="w-auto min-w-0 max-w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os gatilhos</SelectItem>
            {triggers.map(row => <SelectItem key={row.id} value={row.id}>{row.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {error ? <div role="alert" className="mb-4 space-y-2 text-sm text-danger"><p>{error}</p><Button variant="secondary" size="sm" onClick={() => setRetry(retry + 1)}>Tentar novamente</Button></div> : null}
      {loading ? <p role="status" className="mb-3 flex items-center gap-2 text-xs text-text-muted"><Loader2 className="size-3 animate-spin" aria-hidden="true" />Carregando métricas…</p> : null}
      <div className="grid grid-cols-2 gap-2.5" aria-busy={loading}>
        <button type="button" disabled={!ready} onClick={() => setMetric("runs", "Envios")} aria-label={`Envios: ${plain("# vezes", data?.runs)}`}
          className="flex min-h-28 flex-col justify-between rounded-md border border-border bg-surface p-3 text-left transition-colors hover:bg-surface-muted focus-visible:outline-accent disabled:opacity-60">
          <span className="text-xs text-text-muted">Envios</span>
          <span className="flex items-center justify-between gap-1"><span><span className="text-xl">{plain("#", data?.runs)}</span>{ready ? <span className="ml-1 text-xs"> vezes</span> : null}</span><ChevronRight className="size-4 shrink-0 text-text-muted" aria-hidden="true" /></span>
        </button>
        <button type="button" disabled={!ready} onClick={() => setMetric("runs", "Contatos únicos")} aria-label={`Contatos únicos: ${plain("#", data?.unique_contacts)}`}
          className="flex min-h-28 flex-col justify-between rounded-md border border-border bg-surface p-3 text-left transition-colors hover:bg-surface-muted focus-visible:outline-accent disabled:opacity-60">
          <span className="text-xs text-text-muted">Contatos únicos</span>
          <span className="flex items-center justify-between gap-1"><span className="text-xl">{plain("#", data?.unique_contacts)}</span><ChevronRight className="size-4 shrink-0 text-text-muted" aria-hidden="true" /></span>
        </button>
        <div aria-label={`E-mails: ${plain("#", data?.emails)}`} className="flex min-h-24 flex-col justify-between rounded-md border border-border bg-surface p-3">
          <span className="text-xs text-text-muted">E-mails</span><span className="text-xl">{plain("#", data?.emails)}</span>
        </div>
        <div aria-label={`Telefones: ${plain("#", data?.phones)}`} className="flex min-h-24 flex-col justify-between rounded-md border border-border bg-surface p-3">
          <span className="text-xs text-text-muted">Telefones</span><span className="text-xl">{plain("#", data?.phones)}</span>
        </div>
      </div>
      <div ref={extras} />
      {showMore === undefined ? <button type="button" aria-expanded={more} onClick={() => setMoreOwn(!moreOwn)} className="mt-4 flex items-center gap-1 text-sm text-text-muted hover:text-text">
        <ChevronRight className={`size-4 transition-transform ${more ? "rotate-90" : ""}`} aria-hidden="true" />Mais métricas
      </button> : null}
      {more ? <div className="mt-6" role="group" aria-label="Mais métricas">
      <h3 className="mb-3 text-sm font-semibold">Mais métricas</h3>
      <div className="mb-3 flex">
          <Select value={String(period)} onValueChange={value => { setPeriod(Number(value)); setMetric(null) }}>
          <SelectTrigger aria-label="Período das métricas" className="w-full whitespace-nowrap"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="7">7 dias</SelectItem>
            <SelectItem value="30">30 dias</SelectItem>
            <SelectItem value="90">90 dias</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3" aria-busy={loading}>
        <div aria-label={`Impressões: ${impressionsValue}`} className="col-span-2 flex flex-col gap-1 rounded-lg border border-border bg-surface p-3">
          <span className="flex items-center gap-2 text-xs text-text-muted"><Megaphone className="size-3.5" aria-hidden="true" />Impressões</span>
          <span className="text-2xl font-semibold">{impressionsValue}</span>
          {!loading && data && !error && data.impressions == null ? <span className="text-xs leading-relaxed text-text-muted">Este tipo de gatilho não permite medir impressões: o canal só avisa quando um link de referência é aberto.</span> : null}
        </div>
        {metrics.map(({ key, label, icon: Icon }) => <button key={key} type="button" aria-label={`${label}: ${value(key)}`}
          disabled={loading || !!error} onClick={() => setMetric(key)}
          className="flex min-h-28 flex-col justify-between rounded-lg border border-border bg-surface p-3 text-left transition-colors hover:bg-surface-muted focus-visible:outline-accent disabled:opacity-60">
          <span className="flex items-center gap-2 text-xs text-text-muted"><Icon className="size-3.5" aria-hidden="true" />{label}</span>
          <span className="mt-4 flex items-center justify-between gap-1"><span className={value(key).length > 8 ? "text-sm font-medium" : "text-2xl font-semibold"}>{value(key)}</span><ChevronRight className="size-4 shrink-0 text-text-muted" aria-hidden="true" /></span>
        </button>)}
      </div>
      <div className="mt-5 space-y-2 text-xs leading-relaxed text-text-muted">
        <p>Período pelo início das execuções. Cada execução conta uma vez; as demais métricas contam contatos únicos.</p>
        <p>Opt-ins são os contatos que iniciaram a conexão na entrada atribuída ao gatilho. O histórico anterior à medição não é estimado.</p>
        <p>Impressões: quantas vezes o gatilho foi exibido, contadas quando o link de referência é aberto no período. Onde o canal não informa isso, aparece um traço.</p>
        <p>CTR: contatos que clicaram ÷ contatos com envio. Estes números são dos gatilhos; as métricas de cada botão ficam no próprio bloco.</p>
      </div>
      </div> : null}
      {showCalled ?? true ? <CalledByList automationId={automationId} workspace={workspace} /> : null}
      {metric ? <MetricContactsDialog key={`${automationId}:${trigger}:${period}:${metric}:${heading}`} automationId={automationId} trigger={trigger}
        period={period} metric={metric} title={heading} workspace={workspace} onClose={() => setMetric(null)} /> : null}
    </section>
  )
}

function MetricContactsDialog({ automationId, trigger, period, metric, title, workspace, onClose }: {
  automationId: string; trigger: string; period: number; metric: TriggerMetric; title: string | null; workspace: string; onClose: () => void
}) {
  const [page, setPage] = React.useState<MetricContactsPage>({ contacts: [], next_cursor: null })
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [retry, setRetry] = React.useState(0)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const label = title ?? metrics.find(item => item.key === metric)!.label

  React.useEffect(() => {
    let active = true
    setLoading(true); setError(null)
    getMetricContacts(automationId, metric, { trigger_id: trigger || undefined, period_days: period })
      .then(result => { if (active) setPage(result) })
      .catch(cause => { if (active) setError(errorMessage(cause)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [automationId, trigger, period, metric, retry])

  async function loadMore() {
    if (!page.next_cursor || loadingMore) return
    setLoadingMore(true); setError(null)
    try {
      const result = await getMetricContacts(automationId, metric, { trigger_id: trigger || undefined, period_days: period, cursor: page.next_cursor })
      setPage(previous => ({ contacts: [...previous.contacts, ...result.contacts], next_cursor: result.next_cursor }))
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setLoadingMore(false) }
  }

  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent>
      <DialogHeader><DialogTitle>Contatos · {label}</DialogTitle><DialogDescription>Contatos únicos das execuções iniciadas nos últimos {period} dias.{metric === "ctr" ? " Na CTR, são os contatos que clicaram." : ""}</DialogDescription></DialogHeader>
      {loading ? <p role="status" className="flex items-center gap-2 text-sm text-text-muted"><Loader2 className="size-4 animate-spin" aria-hidden="true" />Carregando contatos…</p> : null}
      {error ? <div role="alert" className="space-y-2 text-sm text-danger"><p>{error}</p><Button variant="secondary" size="sm" onClick={() => page.next_cursor ? void loadMore() : setRetry(retry + 1)}>Tentar novamente</Button></div> : null}
      {!loading && !error && !page.contacts.length ? <p className="py-6 text-center text-sm text-text-muted">Nenhum contato nesta métrica.</p> : null}
      <ul className="max-h-80 divide-y divide-border overflow-y-auto">
        {page.contacts.map(contact => <li key={contact.id}><Link to={`/${encodeURIComponent(workspace)}/contacts?contact=${encodeURIComponent(contact.id)}`} className="flex items-center gap-3 rounded-md py-3 text-sm hover:bg-surface-muted">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-muted"><Users className="size-4 text-text-muted" aria-hidden="true" /></span>
          <span className="min-w-0 flex-1 truncate">{[contact.first_name, contact.last_name].filter(Boolean).join(" ") || "Contato sem nome"}</span><ChevronRight className="size-4 text-text-muted" aria-hidden="true" />
        </Link></li>)}
      </ul>
      {!loading && page.next_cursor ? <Button variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>Carregar mais</Button> : null}
    </DialogContent>
  </Dialog>
}
