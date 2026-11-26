import { PageHeader } from "@/components/shell/page-header"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ComeceAqui } from "./comece-aqui"
import { abasDeCanal, proximosPassos, rotuloDaContagem } from "./inicio-logic"
import * as React from "react"
import { ArrowRight, AtSign, Check, ChevronRight, MessageCircle, Plus, RefreshCw, Sparkles, UserPlus, Users } from "lucide-react"
import { Link, useNavigate, useParams } from "react-router"
import { createAutomation } from "@/data"
import { getWorkspace } from "@/data/api"
import { getDashboard, reportFilters, type ReportChannel, type DashboardMetric, type DashboardSummary } from "@/data/dashboard"
import { useAsync } from "@/hooks/use-async"
import { dashboardDefaults, dashboardKey } from "@/data/screen-keys"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusBadge } from "@/components/ui/status-badge"
import { primeiroNome } from "@/data/pessoa"

const icons = {
  contacts: Users,
  new_contacts: UserPlus,
  open_conversations: MessageCircle,
  live_automations: Sparkles,
}
const number = (value: number) => value.toLocaleString("pt-BR")
const delta = (value: number) => `${value > 0 ? "+" : ""}${number(value)}`

function SummaryCard({ metric }: { metric: DashboardMetric }) {
  const Icon = icons[metric.key]
  return (
    <section aria-label={metric.label} className="min-w-0 rounded-lg border border-border bg-surface p-5 shadow-card">
      <div className="flex items-center justify-between gap-3 text-text-muted">
        <h2 className="text-sm font-medium">{metric.label}</h2>
        <Icon className="size-4 shrink-0" aria-hidden="true" />
      </div>
      <p className="mt-3 text-display font-bold tabular-nums">{number(metric.value)}</p>
      <p className="mt-2 text-xs text-text-muted">
        <span className="font-semibold text-text">{metric.delta === null ? "—" : delta(metric.delta)}</span>{" "}{metric.comparison}
      </p>
    </section>
  )
}

function DashboardSkeleton() {
  return (
    <div aria-busy="true" aria-label="Carregando resumo" className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="space-y-4 rounded-lg border border-border bg-surface p-5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-10 w-24" />
            <Skeleton className="h-4 w-full" />
          </div>
        ))}
      </div>
      <div className="space-y-4 rounded-lg border border-border bg-surface p-5">
        {Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-12 w-full" />)}
      </div>
    </div>
  )
}

export function DashboardPage() {
  const { workspace = "demo" } = useParams()
  const navigate = useNavigate()
  const [period, setPeriod] = React.useState(dashboardDefaults.period)
  const [channel, setChannel] = React.useState<ReportChannel>(dashboardDefaults.channel)
  const summary = useAsync(() => getDashboard(workspace, reportFilters(period, channel)), `${workspace}|${period}|${channel}`, { cache: dashboardKey(workspace, period, channel) })
  const [creating, setCreating] = React.useState(false)
  const [createError, setCreateError] = React.useState(false)
  const data = summary.data
  // As abas saem direto dos canais da resposta (a anterior vale enquanto a nova chega, para as abas não piscarem).
  const channels = (data ?? summary.stale)?.channels
  const tabs = React.useMemo(() => abasDeCanal(channels), [channels])
  const firstName = primeiroNome(useAsync(() => getWorkspace(), "inicio-workspace").data?.user_name)

  async function onCreate() {
    setCreating(true)
    setCreateError(false)
    try {
      const automation = await createAutomation(workspace)
      navigate(`/${workspace}/automations/${automation.id}`)
    } catch {
      setCreateError(true)
    } finally {
      setCreating(false)
    }
  }

  const createAction = <Button onClick={onCreate} loading={creating}><Plus className="size-4" aria-hidden="true" />Criar automação</Button>

  const connectedCount = data?.channels?.filter(c => c.status === "connected").length ?? 0
  const contactCount = data?.metrics.find(m => m.key === "contacts")?.value ?? 0
  return (
    <div className="mx-auto min-w-0 max-w-[945px] space-y-6 2xl:max-w-[1200px]">
      <title>Início</title>
      <PageHeader title="Início" actions={[{ label: "Atualizar resumo", icon: RefreshCw, onSelect: summary.reload }]} />
      <div className="min-w-0 space-y-2 pt-8 sm:pt-14">
        <h2 className="break-words text-3xl font-extrabold sm:text-4xl">{firstName ? `Olá, ${firstName}!` : "Olá!"}</h2>
        {data ? <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
          <span><strong className="font-bold">{connectedCount}</strong> {rotuloDaContagem(connectedCount, "canal conectado", "canais conectados")}</span>
          <span><strong className="font-bold">{number(contactCount)}</strong> {rotuloDaContagem(contactCount, "contato", "contatos")}</span>
          <Link className="text-accent hover:underline" to={`/${workspace}/insights`}>Ver Insights</Link>
        </p> : null}
      </div>

      <div className="mt-8 border-b border-border">
        <Tabs value={channel} onValueChange={(value) => setChannel(value as ReportChannel)} className="min-w-0 max-w-full">
          <TabsList scrollable aria-label="Canal" className="border-b-0">
            {tabs.map(({ value, label }) => <TabsTrigger key={value} value={value} className="shrink-0">{label}</TabsTrigger>)}
          </TabsList>
        </Tabs>
      </div>

      <ComeceAqui workspace={workspace} blankBusy={creating} onBlank={onCreate} />
      {data ? <NextActions data={data} workspace={workspace} /> : null}

      {createError ? <Banner variant="danger"><span className="mr-3">Não foi possível criar a automação.</span><Button variant="secondary" size="sm" onClick={onCreate} loading={creating}>Tentar de novo</Button></Banner> : null}

      {summary.error ? (
        <Banner variant="danger"><span className="mr-3">O resumo não carregou.</span><Button variant="secondary" size="sm" onClick={summary.reload}>Tentar de novo</Button></Banner>
      ) : !data ? (
        <DashboardSkeleton />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 pt-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="text-xl font-bold">Seus últimos {data.period_days} dias</h2>
              <span className="text-xs text-text-muted">Até {new Date(data.reference_at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}</span>
            </div>
            <Select value={String(period)} onValueChange={(value) => setPeriod(Number(value))}>
              <SelectTrigger aria-label="Período" className="w-auto min-w-40"><SelectValue /></SelectTrigger>
              <SelectContent>{[7, 14, 30].map((days) => <SelectItem key={days} value={String(days)}>Últimos {days} dias</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {data.metrics.map((metric) => <SummaryCard key={metric.key} metric={metric} />)}
          </div>
          <DashboardExtras data={data} workspace={workspace} />

          {data.empty ? (
            <EmptyState title="Seu espaço está começando" description="Crie uma automação para receber os primeiros contatos e acompanhar os resultados por aqui." action={createAction} />
          ) : (
            <section aria-labelledby="most-used-title" className="min-w-0 rounded-lg border border-border bg-surface shadow-card">
              <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5">
                <div>
                  <h2 id="most-used-title" className="text-lg font-semibold">Automações com mais atividade</h2>
                  <p className="mt-1 text-xs text-text-muted">Execuções registradas nos últimos {data.period_days} dias.</p>
                </div>
                <Button asChild variant="link"><Link to={`/${workspace}/automations`}>Ver automações<ArrowRight className="size-4" aria-hidden="true" /></Link></Button>
              </header>
              {data.most_used.length === 0 ? (
                <EmptyState className="m-4" title="Ainda sem execuções" description="Suas automações aparecerão aqui quando começarem a receber atividade." action={createAction} />
              ) : (
                <ol className="divide-y divide-border">
                  {data.most_used.map((automation, index) => (
                    <li key={automation.id} className="flex min-w-0 flex-wrap items-center gap-3 p-5">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-muted font-semibold text-text-muted" aria-hidden="true">{index + 1}</span>
                      <div className="min-w-0 flex-1 basis-1/2">
                        <Link className="block break-words font-semibold hover:underline" to={`/${workspace}/automations/${automation.id}`}>{automation.name}</Link>
                        <p className="mt-1 text-xs text-text-muted">{number(automation.unique_contacts)} contatos alcançados</p>
                      </div>
                      <StatusBadge status={automation.status} />
                      <div className="ml-auto text-right tabular-nums">
                        <p className="font-semibold">{number(automation.runs)}</p>
                        <p className="text-xs text-text-muted">execuções</p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
          <p className="text-xs text-text-muted">Contagens calculadas a partir dos registros deste espaço. O traço indica comparação histórica indisponível.</p>
        </>
      )}
    </div>
  )
}

const savedLabels = { dm: "Mensagens diretas", comment: "Comentários", story: "Stories", other: "Outras entradas" }
const channelStatus: Record<string, string> = { connected: "Conectado", disconnected: "Desconectado", error: "Com erro", pending: "Pendente", connecting: "Conectando", restricted: "Restrito" }

/** Primeiros passos, canais, tempo economizado, contatos mais engajados. */
function DashboardExtras({ data, workspace }: { data: DashboardSummary; workspace: string }) {
  const hours = (data.time_saved?.minutes ?? 0) / 60
  return <div className="grid min-w-0 gap-4 lg:grid-cols-2">
    <section aria-labelledby="channels-title" className="min-w-0 rounded-lg border border-border bg-surface p-5 shadow-card">
      <div className="flex items-center justify-between gap-2"><h2 id="channels-title" className="text-lg font-semibold">Canais</h2><Button asChild variant="link"><Link to={`/${workspace}/settings/channels`}>Gerenciar</Link></Button></div>
      {data.channels?.length ? <ul className="mt-2 divide-y divide-border">{data.channels.map(c => <li key={c.id} className="flex items-center justify-between gap-2 py-2 text-sm"><span className="min-w-0 truncate">{c.name}</span><span className={c.status === "connected" ? "text-xs text-success" : "text-xs text-warning"}>{channelStatus[c.status] ?? c.status}</span></li>)}</ul> : <p className="mt-2 text-sm text-text-muted">Nenhum canal conectado ainda.</p>}
    </section>
    <section aria-labelledby="saved-title" className="min-w-0 rounded-lg border border-border bg-surface p-5 shadow-card">
      <h2 id="saved-title" className="text-lg font-semibold">Tempo economizado</h2>
      <p className="mt-1 text-2xl font-bold tabular-nums">{hours >= 1 ? `${hours.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} h` : `${data.time_saved?.minutes ?? 0} min`}</p>
      <p className="text-xs text-text-muted">Estimativa: cada mensagem enviada pelas automações conta 1 minuto de atendimento.</p>
      <ul className="mt-3 space-y-1 text-sm">{data.time_saved?.by_type.map(t => <li key={t.type} className="flex justify-between gap-2"><span>{savedLabels[t.type]}</span><span className="tabular-nums">{number(t.messages)}</span></li>)}</ul>
    </section>
    <section aria-labelledby="engaged-title" className="min-w-0 rounded-lg border border-border bg-surface p-5 shadow-card">
      <h2 id="engaged-title" className="text-lg font-semibold">Contatos mais engajados</h2>
      {data.most_engaged?.length ? <ol className="mt-2 space-y-1 text-sm">{data.most_engaged.map(c => <li key={c.contact_id} className="flex justify-between gap-2"><Link className="min-w-0 truncate hover:underline" to={`/${workspace}/contacts?contact=${encodeURIComponent(c.contact_id)}`}>{c.name}</Link><span className="tabular-nums text-text-muted">{number(c.messages)} mensagens</span></li>)}</ol> : <p className="mt-2 text-sm text-text-muted">Sem mensagens de contatos no período.</p>}
    </section>
  </div>
}

/** "Suas próximas melhores ações": dica e primeiros passos (este some quando tudo foi feito). */
const stepRoutes: Record<string, string> = { connect: "settings/channels", automation: "automations", publish: "automations", first_contact: "contacts", team: "settings/team" }

function NextActions({ data, workspace }: { data: DashboardSummary; workspace: string }) {
  const { linhas, concluidos, total, pendente: pending } = proximosPassos(data.checklist)
  return <section aria-labelledby="next-title" className="mt-12 mb-[53px] min-w-0 space-y-4">
    <h2 id="next-title" className="text-xl font-bold">Suas próximas melhores ações</h2>
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      <article aria-labelledby="tip-title" className="flex min-h-[375px] min-w-0 flex-col rounded-lg bg-surface p-3 shadow-card">
        <p className="text-2xs text-text-muted">Dica de engajamento</p>
        <h3 id="tip-title" className="mt-1 text-base font-semibold">Transforme comentários em conversas: responda por mensagem direta, sem esforço</h3>
        <TipIllustration />
        <Button asChild size="sm" className="mt-3 self-start"><Link to={`/${workspace}/automations`}>Ver modelos</Link></Button>
      </article>
      {pending ? <article aria-labelledby="checklist-title" className="flex min-h-[375px] min-w-0 flex-col rounded-lg bg-surface p-3 shadow-card">
        <p className="text-2xs text-text-muted">Primeiros passos</p>
        <h3 id="checklist-title" className="mt-1 text-base font-semibold">Conclua a configuração do seu espaço</h3>
        <div role="progressbar" aria-label="Progresso dos primeiros passos" aria-valuemin={0} aria-valuemax={total} aria-valuenow={concluidos} className="mt-auto h-2 overflow-hidden rounded-pill bg-border/40"><div className="h-full bg-accent" style={{ width: `${(concluidos / total) * 100}%` }} /></div>
        <p className="mt-2 text-2xs text-text-muted">{concluidos} de {total} concluídos</p>
        <ul className="mt-3 space-y-3">{linhas.map(step => <li key={step.key}>
          <Link to={`/${workspace}/${stepRoutes[step.key] ?? "automations"}`} className="flex items-center gap-2 rounded-md border border-border px-2 py-2 text-sm hover:bg-surface-muted">
            <span aria-hidden="true" className={step.done ? "flex size-4 shrink-0 items-center justify-center rounded-full bg-success text-on-accent" : "size-4 shrink-0 rounded-full border border-border"}>{step.done ? <Check className="size-3" /> : null}</span>
            <span className={step.done ? "min-w-0 flex-1 truncate text-text-muted line-through" : "min-w-0 flex-1 truncate"}>{step.label}</span>
            <span className="sr-only">{step.done ? "feito" : "a fazer"}</span>
            <ChevronRight className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
          </Link>
        </li>)}</ul>
      </article> : null}
    </div>
  </section>
}

/** Ilustração própria da dica: um perfil de exemplo, o comentário recebido e a resposta por mensagem direta. */
function TipIllustration() {
  return <div aria-hidden="true" className="mt-3 flex flex-1 flex-col justify-center gap-3 rounded-md bg-accent-soft px-4 py-3">
    <span className="flex items-center gap-3">
      <span className="grid size-14 shrink-0 place-items-center rounded-pill bg-accent text-on-accent"><AtSign className="size-7" /></span>
      <span className="min-w-0"><strong className="block truncate text-sm">@sualoja</strong><span className="block text-xs text-text-muted">12 mil seguidores</span></span>
    </span>
    <span className="max-w-[80%] self-start rounded-pill border border-text-muted/40 bg-surface px-3 py-2 text-sm shadow-card">Quero o link!</span>
    <span className="max-w-[80%] self-end rounded-pill bg-accent px-3 py-2 text-sm text-on-accent shadow-card">Oi! Já enviei por mensagem.</span>
  </div>
}
