import { useId, useState } from 'react'
import { Link, useParams } from 'react-router'
import { Camera, Copy, Mail, MessageCircle, MessagesSquare, Music2, Pencil, Plus, Send, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { getInsights, listConnections, listContacts, type ChannelType, type Connection, type InsightsChannel, type InsightsPeriod, type InsightsPoint } from '@/data'
import { cn } from '@/lib/utils'
import { useWorkspaceSettings } from '@/hooks/use-workspace-settings'
import { AccountAvatar } from '@/components/ui/account-avatar'
import { AvatarInitials } from '@/components/ui/avatar-initials'
import { getInboxInsights } from '@/data/insights'
import { useAsync } from '@/hooks/use-async'
import { insightsDefaults, insightsInboxKey, insightsKey } from '@/data/screen-keys'
import { passoDoEixo, rotuloDoEixo } from './insights-logic'
import { Banner } from '@/components/ui/banner'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { MetricCard } from '@/components/ui/metric-card'
import { Skeleton } from '@/components/ui/skeleton'

const number = (n: number) => n.toLocaleString('pt-BR')
const percent = (n: number | null) => n === null ? '—' : n.toLocaleString('pt-BR', { style: 'percent', maximumFractionDigits: 1 })
const dayLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' })

export function InsightsPage() {
  const { workspace = 'demo' } = useParams()
  const [period, setPeriod] = useState<InsightsPeriod>(insightsDefaults.period)
  const [channel, setChannel] = useState<InsightsChannel>(insightsDefaults.channel)
  const [metric, setMetric] = useState<Metric>('contacts')
  const inbox = useAsync(() => getInboxInsights(period), `${workspace}|inbox|${period}`, { cache: insightsInboxKey(workspace, period) })
  const query = useAsync(() => getInsights(workspace, period, channel), `${workspace}|${period}|${channel}`, { cache: insightsKey(workspace, period, channel) })
  const data = query.data
  const hasActivity = !!data && data.points.length > 0 && !!(data.totals.messages || data.totals.contacts || data.totals.clicks)
  return <div className="mx-auto min-w-0 max-w-[930px] space-y-8 pt-12">
    <title>Insights</title>
    <AccountHeader workspace={workspace} />
    <ChannelCards workspace={workspace} week={period === 7 && channel === 'all' ? { data: query.data } : undefined} />
    <section aria-labelledby="contatos-titulo" className="min-w-0 space-y-4 pt-4">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h2 id="contatos-titulo" className="text-2xl font-bold"><select aria-label="Métrica do gráfico" className="cursor-pointer rounded-sm border-b-2 border-text bg-transparent pr-1 font-bold" value={metric} onChange={(event) => setMetric(event.target.value as Metric)}>{(Object.keys(metricLabels) as Metric[]).map(key => <option key={key} value={key}>{metricLabels[key]}</option>)}</select></h2>
        <div className="flex flex-wrap gap-3">
      <div><label htmlFor="insights-period" className="sr-only">Período</label><select id="insights-period" className="h-9 w-full rounded-md border border-border-input bg-surface px-3 text-sm" value={period} onChange={(event) => setPeriod(Number(event.target.value) as InsightsPeriod)}>{[7, 14, 30, 90].map((days) => <option key={days} value={days}>Últimos {days} dias</option>)}</select></div>
      <div><label htmlFor="insights-channel" className="sr-only">Canal</label><select id="insights-channel" className="h-9 w-full rounded-md border border-border-input bg-surface px-3 text-sm" value={channel} onChange={(event) => setChannel(event.target.value as InsightsChannel)}><option value="all">Todos os canais</option><option value="telegram">Telegram</option><option value="email">E-mail</option><option value="tiktok">TikTok</option><option value="instagram">Instagram</option><option value="whatsapp">WhatsApp</option></select></div></div>
      </header>
      {query.error ? <Banner variant="danger"><p>Não foi possível carregar as análises.</p><Button variant="secondary" onClick={query.reload}>Tentar de novo</Button></Banner> :
      <section aria-label="Evolução diária" className="grid min-w-0 overflow-hidden rounded-lg bg-surface shadow-card md:grid-cols-[1fr_240px]">
        <div className="min-w-0 space-y-3 p-6">
          {query.loading ? <div role="status" aria-label="Carregando série e automações" className="space-y-4"><Skeleton className="h-64 w-full" /></div> : !hasActivity ? <EmptyState title="Ainda não há atividade neste período" description="As conversas e os resultados das automações aparecerão aqui." /> : data && <>
            <Series points={data.points} metric={metric} />
            <details className="text-sm"><summary className="cursor-pointer rounded-sm font-semibold">Consultar valores por dia</summary><div className="mt-3 max-h-64 overflow-auto"><table className="w-full text-left"><caption className="sr-only">Valores diários usados no gráfico</caption><thead><tr className="border-b border-border"><th scope="col" className="p-2">Dia</th><th scope="col" className="p-2 text-right">Contatos</th><th scope="col" className="p-2 text-right">Mensagens</th></tr></thead><tbody>{data.points.map((point) => <tr key={point.date} className="border-b border-border"><th scope="row" className="p-2 font-normal">{dayLabel(point.date)}</th><td className="p-2 text-right">{number(point.contacts)}</td><td className="p-2 text-right">{number(point.messages)}</td></tr>)}</tbody></table></div></details>
          </>}
        </div>
        <div className="border-t border-border p-6 md:border-t-0 md:border-l"><p className="text-sm">{metricLabels[metric]}</p>
          {query.loading ? <Skeleton className="mt-2 h-8 w-24" /> : <p className="mt-1 text-3xl font-bold">{number(data?.totals[metric] ?? 0)}</p>}
          {hasActivity && data ? <p className="mt-2 text-xs text-text-muted">{dayLabel(data.points[0].date)} a {dayLabel(data.points[data.points.length - 1].date)}</p> : null}</div>
      </section>}
    </section>
    {query.error ? null : <section aria-labelledby="desempenho-titulo" className="min-w-0 space-y-6">
      <h2 id="desempenho-titulo" className="text-2xl font-bold">Desempenho</h2>
      <Banner>Contatos únicos com atividade e envios confirmados no período, em UTC. Uma pessoa pode aparecer em vários dias. A tabela mede etapas enviadas pelas automações; esses valores não equivalem ao total de mensagens.</Banner>
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4"><MetricCard label="Contatos com atividade" loading={query.loading} value={data && number(data.totals.contacts)} /><MetricCard label="Mensagens enviadas" loading={query.loading} value={data && number(data.totals.messages)} /><MetricCard label="Cliques recebidos" loading={query.loading} value={data && number(data.totals.clicks)} /><MetricCard label="Cliques por mensagem" loading={query.loading} value={data && percent(data.totals.clickRate)} /></div>
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4"><MetricCard label="Novos contatos" loading={query.loading} value={data && number(data.totals.new_contacts ?? 0)} /><MetricCard label="Saldo (novos − descadastros)" loading={query.loading} value={data && number(data.totals.net ?? 0)} /><MetricCard label="Inscritos sem atividade" loading={query.loading} value={data && number(data.totals.inactive ?? 0)} /><MetricCard label="Execuções de automação" loading={query.loading} value={data && number(data.totals.runs ?? 0)} /></div>
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4"><MetricCard label="Entregues" loading={query.loading} value={data && number(data.totals.delivered ?? 0)} /><MetricCard label="Lidas" loading={query.loading} value={data && number(data.totals.read ?? 0)} /><MetricCard label="E-mails coletados" loading={query.loading} value={data && number(data.totals.emails_collected ?? 0)} /><MetricCard label="Descadastros" loading={query.loading} value={data && number(data.totals.unsubscribed ?? 0)} /></div>
      {query.loading ? null : hasActivity && data && <>
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <section aria-label="Por canal" className="min-w-0 space-y-3 rounded-lg border border-border bg-surface p-4"><h2 className="text-lg font-semibold">Por canal</h2>
            {data.by_channel?.length ? <table className="w-full text-left text-sm"><thead className="text-xs text-text-muted"><tr><th scope="col" className="p-2">Canal</th><th scope="col" className="p-2 text-right">Contatos</th><th scope="col" className="p-2 text-right">Enviadas</th></tr></thead><tbody>{data.by_channel.map(row => <tr key={row.channel} className="border-t border-border"><th scope="row" className="p-2 font-medium">{channelNames[row.channel] ?? row.channel}</th><td className="p-2 text-right tabular-nums">{number(row.contacts)}</td><td className="p-2 text-right tabular-nums">{number(row.messages)}</td></tr>)}</tbody></table> : <p className="text-sm text-text-muted">Sem conversas no período.</p>}
          </section>
          <section aria-label="Conversões e receita" className="min-w-0 space-y-3 rounded-lg border border-border bg-surface p-4"><h2 className="text-lg font-semibold">Conversões e receita</h2>
            {data.conversions?.revenue.length ? <p className="flex flex-wrap gap-3 text-base font-semibold">{data.conversions.revenue.map(r => <span key={r.currency}>{r.value.toLocaleString('pt-BR', { style: 'currency', currency: r.currency })}</span>)}</p> : null}
            {data.conversions?.events.length ? <ul className="space-y-1 text-sm">{data.conversions.events.map(e => <li key={e.name} className="flex justify-between gap-2"><span className="break-words">{e.name}</span><span className="tabular-nums">{number(e.count)}</span></li>)}</ul> : <p className="text-sm text-text-muted">Use a ação Registrar conversão nas automações para medir eventos e receita.</p>}
          </section>
        </div>
        <section aria-label="Resultados por automação" className="min-w-0 space-y-3"><h2 className="text-lg font-semibold">Resultados por automação</h2><div className="overflow-x-auto rounded-lg border border-border bg-surface"><table className="w-full text-left text-sm"><caption className="sr-only">Resultados das automações no período selecionado</caption><thead className="bg-surface-muted text-xs text-text-muted"><tr><th scope="col" className="p-3">Automação</th><th scope="col" className="p-3 text-right">Contatos</th><th scope="col" className="p-3 text-right">Etapas enviadas</th><th scope="col" className="p-3 text-right">Cliques</th><th scope="col" className="p-3 text-right">Taxa</th><th scope="col" className="p-3 text-right">Conversões</th><th scope="col" className="p-3 text-right">Receita</th></tr></thead><tbody>{data.automations.map((automation) => <tr key={automation.id} className="border-t border-border"><th scope="row" className="min-w-40 max-w-xs break-words p-3 font-medium">{automation.name}</th><td className="p-3 text-right tabular-nums">{number(automation.contacts)}</td><td className="p-3 text-right tabular-nums">{number(automation.messages)}</td><td className="p-3 text-right tabular-nums">{number(automation.clicks)}</td><td className="p-3 text-right tabular-nums">{percent(automation.messages ? automation.clicks / automation.messages : null)}</td><td className="p-3 text-right tabular-nums">{number(automation.conversions ?? 0)}</td><td className="p-3 text-right tabular-nums">{number(automation.revenue ?? 0)}</td></tr>)}</tbody></table></div></section>
      </>}
    </section>}
    <section aria-label="Caixa de entrada" className="min-w-0 space-y-3"><h2 className="text-lg font-semibold">Caixa de entrada</h2>
      {inbox.error ? <Banner variant="danger">Não foi possível carregar a análise da caixa de entrada.</Banner> : <>
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4"><MetricCard label="Conversas com mensagem" loading={inbox.loading} value={inbox.data && number(inbox.data.conversations)} /><MetricCard label="Taxa de resposta" loading={inbox.loading} value={inbox.data && percent(inbox.data.response_rate)} /><MetricCard label="Primeira resposta (média)" loading={inbox.loading} value={inbox.data && duration(inbox.data.first_response_seconds)} /><MetricCard label="Até encerrar (média)" loading={inbox.loading} value={inbox.data && duration(inbox.data.close_seconds)} /></div>
        {inbox.data?.agents.length ? <div className="overflow-x-auto rounded-lg border border-border bg-surface"><table className="w-full text-left text-sm"><caption className="sr-only">Conversas por atendente</caption><thead className="bg-surface-muted text-xs text-text-muted"><tr><th scope="col" className="p-3">Atendente</th><th scope="col" className="p-3 text-right">Atribuídas com atividade</th><th scope="col" className="p-3 text-right">Encerradas</th></tr></thead><tbody>{inbox.data.agents.map(a => <tr key={a.member_id} className="border-t border-border"><th scope="row" className="p-3 font-medium">{a.name}</th><td className="p-3 text-right tabular-nums">{number(a.assigned)}</td><td className="p-3 text-right tabular-nums">{number(a.closed)}</td></tr>)}</tbody></table></div> : null}
      </>}
    </section>
  </div>
}

type Metric = 'contacts' | 'new_contacts' | 'net' | 'unsubscribed' | 'messages'
const metricLabels: Record<Metric, string> = { contacts: 'Contatos ativos', new_contacts: 'Novos contatos', net: 'Saldo', unsubscribed: 'Descadastros', messages: 'Mensagens' }
const channelNames: Record<string, string> = { telegram: 'Telegram', instagram: 'Instagram', whatsapp: 'WhatsApp', messenger: 'Messenger', email: 'E-mail', tiktok: 'TikTok' }
function duration(seconds: number | null) {
  if (seconds === null) return '—'
  if (seconds < 60) return `${seconds} s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  if (seconds < 86400) return `${(seconds / 3600).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} h`
  return `${(seconds / 86400).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} dias`
}

/** As coordenadas do viewBox são unidades do desenho, não dimensões CSS: 40 unidades entre uma linha de grade e a seguinte. */
function Series({ points, metric }: { points: InsightsPoint[]; metric: Metric }) {
  const id = useId()
  const value = (point: InsightsPoint) => point[metric] ?? 0
  const max = Math.max(...points.map(value), 1), min = Math.min(...points.map(value), 0)
  const passo = passoDoEixo(max), topo = passo * 7, linhas = Array.from({ length: 8 }, (_, i) => i)
  const base = 20 + 40 * 7, esquerda = 64, direita = 620
  const coords = points.map((point, index) => [esquerda + 16 + index / Math.max(points.length - 1, 1) * (direita - esquerda - 32), base - (value(point) - Math.min(min, 0)) / (topo - Math.min(min, 0) || 1) * 280])
  const path = coords.map(([x, y], index) => `${index ? 'L' : 'M'}${x},${y}`).join(' ')
  return <svg viewBox={`0 0 640 ${base + 34}`} role="img" aria-labelledby={`${id}-title ${id}-desc`} className="h-auto w-full overflow-visible text-accent"><title id={`${id}-title`}>{metricLabels[metric]} por dia</title><desc id={`${id}-desc`}>De {dayLabel(points[0].date)} a {dayLabel(points[points.length - 1].date)}. Maior valor: {number(max)}. Os valores completos estão na tabela abaixo.</desc>
    {linhas.map(i => { const y = 20 + 40 * i; return <g key={i}><line x1={esquerda} x2={direita} y1={y} y2={y} stroke="var(--color-border)" /><text x={esquerda - 10} y={y + 4} textAnchor="end" className="fill-text-muted text-xs">{rotuloDoEixo(passo * (7 - i))}</text></g> })}
    <path d={path} fill="none" stroke="currentColor" strokeWidth="3" vectorEffect="non-scaling-stroke" />
    {coords.map(([x, y], index) => <circle key={points[index].date} cx={x} cy={y} r="4" fill="currentColor"><title>{dayLabel(points[index].date)}: {number(value(points[index]))}</title></circle>)}
    <text x={esquerda} y={base + 26} className="fill-text-muted text-xs">{dayLabel(points[0].date)}</text><text x={direita} y={base + 26} textAnchor="end" className="fill-text-muted text-xs">{dayLabel(points[points.length - 1].date)}</text>
  </svg>
}

/** Topo: foto, nome da conta (o lápis leva a Configurações › Geral) e descrição. */
function AccountHeader({ workspace }: { workspace: string }) {
  const settings = useWorkspaceSettings()
  const name = settings?.name ?? ''
  const shown = settings?.photo_url
  return <header className="flex items-center gap-5">
    <span role="img" aria-label={shown ? 'Foto da conta' : `Conta sem foto, inicial ${(name.trim()[0] ?? '?').toUpperCase()}`}><AccountAvatar className="size-18 text-2xl" /></span>
    <div className="min-w-0 space-y-1">
      <h1 className="flex items-center gap-2 text-2xl font-bold"><span className="min-w-0 truncate">{name}</span>
        <Link to={`/${workspace}/settings?editar=conta`} aria-label="Editar conta" title="Editar conta em Configurações › Geral" className="grid size-6 shrink-0 place-items-center rounded-sm text-text-muted hover:text-text"><Pencil className="size-4" aria-hidden="true" /></Link></h1>
      {settings?.description ? <p className="truncate text-sm text-text-muted">{settings.description}</p> : null}
    </div>
  </header>
}

const channelIcons: Record<string, LucideIcon> = { instagram: Camera, whatsapp: MessageCircle, telegram: Send, messenger: MessagesSquare, email: Mail, tiktok: Music2 }
const contactTypes: ChannelType[] = ['instagram', 'whatsapp', 'messenger', 'telegram', 'email', 'tiktok']

/** Endereço público da conta quando o motor guarda o usuário (@nome); sem ele, o cartão fica sem link. */
function publicLink(c: Connection): { label: string; url: string } | null {
  const user = c.displayName?.startsWith('@') ? c.displayName.slice(1) : null
  if (!user || !/^[\w.]+$/.test(user)) return null
  if (c.kind === 'telegram') return { label: 'Link do bot', url: `https://t.me/${user}` }
  if (c.kind === 'instagram') return { label: 'Link da página', url: `https://instagram.com/${user}` }
  return null
}

/** Total de contatos por conexão (duas contas do mesmo canal mostram números diferentes). O engine já manda `contactTotal` em cada conexão da lista;
 * esta busca (um pedido por conexão) só roda quando o campo falta (modo de demonstração). */
async function contactTotals(workspace: string, connectionIds: string[]): Promise<Record<string, number>> {
  const totals = await Promise.all([...new Set(connectionIds)].map(async id => [id, (await listContacts(workspace, null, { connection_id: id })).total] as const))
  return Object.fromEntries(totals)
}

/** `week`: quando a página já está mostrando os últimos 7 dias de todos os canais, os cartões usam essa mesma resposta em vez de buscar de novo. */
function ChannelCards({ workspace, week: shared }: { workspace: string; week?: { data: Awaited<ReturnType<typeof getInsights>> | undefined } }) {
  const connections = useAsync(() => listConnections(workspace), `${workspace}|connections`, { cache: `insights-connections|${workspace}` })
  const ids = connections.data?.map(c => c.id).join(',') ?? ''
  const fromList = connections.data?.every(c => typeof c.contactTotal === 'number') ? Object.fromEntries(connections.data.map(c => [c.id, c.contactTotal ?? 0])) : null
  const fetched = useAsync(() => fromList || !ids ? Promise.resolve(null) : contactTotals(workspace, ids.split(',')), `${workspace}|totals|${fromList ? 'lista' : ids}`)
  const totals = fromList ? { data: fromList, error: null } : fetched
  const own = useAsync(() => shared ? Promise.resolve(null) : getInsights(workspace, 7, 'all'), `${workspace}|cards-activity|${shared ? 'shared' : 'own'}`)
  const activity = { data: shared ? shared.data : own.data }
  return <section aria-labelledby="canais-titulo" className="space-y-4">
    <h2 id="canais-titulo" className="text-2xl font-bold">Canais</h2>
    {connections.error ? <Banner variant="danger"><p>Não foi possível carregar os canais.</p><Button variant="secondary" onClick={connections.reload}>Tentar de novo</Button></Banner> :
    <>
    {fetched.error && !fromList ? <Banner variant="danger"><p>Não foi possível carregar o total de contatos.</p><Button variant="secondary" onClick={fetched.reload}>Tentar de novo</Button></Banner> : null}
    <ul className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {connections.loading ? [0, 1].map(i => <li key={i}><Skeleton className="h-[267px] w-full" /></li>) : [...connections.data ?? []].sort((a, b) => contactTypes.indexOf(a.kind as ChannelType) - contactTypes.indexOf(b.kind as ChannelType)).map(c => {
        const name = c.displayName ?? c.label, Icon = channelIcons[c.kind] ?? MessageCircle, link = publicLink(c), withPhoto = c.kind === 'instagram' || c.kind === 'messenger' || c.kind === 'tiktok'
        const week = activity.data ? activity.data.by_channel?.find(row => row.channel === c.kind) ?? { contacts: 0, messages: 0 } : null
        return <li key={c.id}>
          <article aria-label={name} className="flex h-[267px] flex-col rounded-lg bg-surface p-5 shadow-card">
            <p className="flex items-center gap-2 text-base font-semibold"><Icon className="size-5 shrink-0 text-accent" aria-hidden="true" /><span className="truncate">{channelNames[c.kind] ?? c.label}</span></p>
            <div className={cn('min-w-0 flex-1 space-y-1.5 text-xs', withPhoto ? 'flex flex-col justify-center' : 'pt-3')}>
              {withPhoto ? <p className="flex items-center gap-2"><AvatarInitials name={name} className="size-9" /><span className="min-w-0 truncate">{name}</span></p> : <p className="truncate">{name}</p>}
              {link ? <p className="flex items-center gap-1"><a href={link.url} target="_blank" rel="noreferrer" className="text-link hover:underline">{link.label}</a>
                <button type="button" aria-label={`Copiar ${link.label.toLowerCase()} de ${name}`} className="grid size-6 place-items-center rounded-sm text-link hover:bg-surface-muted"
                  onClick={() => { if (!navigator.clipboard) { toast.error('Não foi possível copiar o link.'); return } navigator.clipboard.writeText(link.url).then(() => toast.success('Link copiado.'), () => toast.error('Não foi possível copiar o link.')) }}><Copy className="size-4" aria-hidden="true" /></button></p> : null}
              {c.status !== 'connected' ? <p className="text-warning">Canal desconectado</p> : null}
              {week ? <><p className="text-text-muted">Enviadas (7 dias): {number(week.messages)}</p></> : null}
            </div>
            <div role="group" aria-label="Contatos"><p className="text-xs text-text-muted">Contatos</p>
              <p className="text-2xl font-bold">{totals.data ? number(totals.data[c.id] ?? 0) : totals.error ? '—' : '…'}</p></div>
          </article>
        </li>
      })}
      <li><Link to={`/${workspace}/settings/channels`} className="flex h-[267px] items-center justify-center gap-1 rounded-lg border border-dashed border-border p-4 text-base font-semibold hover:bg-surface"><Plus className="size-4" aria-hidden="true" />Adicionar canal</Link></li>
    </ul></>}
  </section>
}
