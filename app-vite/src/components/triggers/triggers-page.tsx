import { Link, useParams } from "react-router"
import { getTriggersOverview, targetPath, type OverviewFamily } from "@/data/triggers-overview"
import { ApiError } from "@/data/api"
import { useAsync } from "@/hooks/use-async"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { Skeleton } from "@/components/ui/skeleton"

const number = (n: number) => n.toLocaleString("pt-BR")

export function TriggersPage() {
  const { workspace } = useParams() as { workspace: string }
  const overview = useAsync(getTriggersOverview, workspace, { cache: `triggers-overview|${workspace}` })
  const families = overview.data?.families ?? overview.stale?.families
  const forbidden = overview.error instanceof ApiError && overview.error.status === 403
  return <div className="min-w-0 space-y-6">
    <div>
      <h2 className="text-xl font-bold">Gatilhos da conta</h2>
      <p className="mt-1 text-sm text-text-muted">Tudo o que começa uma automação, agrupado por tipo. Execuções dos últimos 30 dias.</p>
    </div>
    {overview.loading && !families ? <div role="status" aria-label="Carregando gatilhos" className="space-y-3">
      {[0, 1, 2].map(i => <Skeleton key={i} className="h-24 w-full" />)}
    </div>
      : forbidden ? <Banner variant="warning">Seu papel não permite ver os gatilhos da conta. Peça acesso a quem administra o espaço.</Banner>
      : overview.error && !families ? <Banner variant="danger">Não consegui carregar os gatilhos.<Button variant="secondary" size="sm" onClick={overview.reload}>Tentar de novo</Button></Banner>
      : !families?.some(f => f.total > 0) ? <EmptyState title="Nenhum gatilho ainda" description="Crie uma automação e escolha como ela começa: palavra-chave, comentário, story, link de referência e mais." action={<Button asChild variant="secondary"><Link to={`/${workspace}/automations`}>Ver automações</Link></Button>} />
      : <div className="space-y-4">{families.map(family => <FamilyCard key={family.id} family={family} workspace={workspace} />)}</div>}
  </div>
}

function FamilyCard({ family, workspace }: { family: OverviewFamily; workspace: string }) {
  const titleId = `family-${family.id}`
  return <section aria-labelledby={titleId} className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface shadow-node">
    <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-border px-4 py-3 sm:px-5">
      <h3 id={titleId} className="text-sm font-semibold">{family.label}</h3>
      <p className="text-xs text-text-muted"><span data-testid={`${family.id}-active`}>{number(family.active)} de {number(family.total)} {family.total === 1 ? "ativo" : "ativos"}</span> · {number(family.runs_30d)} {family.runs_30d === 1 ? "execução" : "execuções"} em 30 dias</p>
    </header>
    {family.total === 0 ? <p className="px-4 py-3 text-sm text-text-muted sm:px-5">Nenhum gatilho nesta família ainda.</p> : null}
    <ul className="divide-y divide-border">
      {family.items.map(item => <li key={item.id}>
        <Link to={item.target.kind === "automation" && family.id !== "surfaces" ? `/${workspace}/automations/triggers/${encodeURIComponent(item.id)}` : targetPath(workspace, item.target)} className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-surface-muted focus-visible:-outline-offset-2 sm:px-5">
          <span className="min-w-0 flex-1 basis-48">
            <span className="block truncate text-sm font-semibold" title={item.name}>{item.name}</span>
            <span className="block truncate text-xs text-text-muted" title={item.type_channel}>{item.type_channel}{item.target.kind === "automation" ? ` · ${item.target.automation_name}` : ""}</span>
          </span>
          <span className={item.active ? "text-xs font-semibold text-success" : "text-xs text-text-muted"}>{item.active ? "Ativo" : "Desligado"}</span>
          <span className="w-24 text-right text-xs tabular-nums text-text-muted">{number(item.runs_30d)} em 30 dias</span>
        </Link>
      </li>)}
    </ul>
    {family.total > family.items.length ? <p className="border-t border-border px-4 py-2 text-xs text-text-muted sm:px-5">Mostrando {family.items.length} de {number(family.total)}.</p> : null}
  </section>
}
