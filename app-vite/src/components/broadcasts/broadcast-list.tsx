import { Mail, MessageCircle, Search, Send } from "lucide-react"
import { ChannelIcon as BrandChannelIcon, channelNames, type ChannelId } from "@/components/settings/settings-nav"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RowMenu, RowMenuItem } from "@/components/ui/row-menu"
import type { Broadcast, BroadcastAudience } from "@/data/broadcasts"
import { formatBroadcastDate, groupBroadcasts, hasHiddenRows, isOverdue, isPausedSchedule, rateCell, sectionLimit, visibleRows } from "./broadcast-list-logic"

const channelLabel = (channel: BroadcastAudience["channel"]) => ({ telegram: "Telegram", instagram: "Instagram", whatsapp: "WhatsApp", messenger: "Messenger", email: "E-mail", tiktok: "TikTok" })[channel]
/** O que cada canal avisa de volta. Onde o provedor não avisa, a coluna mostra um traço em vez de um zero que parece falha. */
const reports = (channel: BroadcastAudience["channel"]) => ({ delivered: channel !== "telegram" && channel !== "instagram", read: channel !== "telegram" })
const notReported = (channel: BroadcastAudience["channel"], what: string) => <span className="text-text-muted" title={`O ${channelLabel(channel)} não informa ${what}.`}>—<span className="sr-only"> ({channelLabel(channel)} não informa {what})</span></span>
const ChannelIcon = ({ channel }: { channel: BroadcastAudience["channel"] }) => channel === "email" ? <Mail className="size-3.5" aria-hidden="true" /> : channel === "telegram" ? <Send className="size-3.5" aria-hidden="true" /> : <MessageCircle className="size-3.5" aria-hidden="true" />
const editable = (item: Broadcast) => item.status === "draft" || item.status === "scheduled"

type Handlers = {
  busy: string | null
  progress: (item: Broadcast) => React.ReactNode
  onEdit: (item: Broadcast) => void
  onReport: (item: Broadcast) => void
  onToggle: (item: Broadcast) => void
  onCancel: (item: Broadcast) => void
  onDelete: (item: Broadcast) => void
}

const SECTIONS = [
  { key: "scheduled", slug: "agendado", title: "Agendado", dateHeader: "Iniciar", empty: "Nenhuma transmissão agendada." },
  { key: "drafts", slug: "rascunhos", title: "Rascunhos", dateHeader: "Última edição", empty: "Nenhum rascunho." },
  { key: "history", slug: "historico", title: "Histórico", dateHeader: "Iniciar", empty: "Nenhuma transmissão enviada ainda." },
] as const
export const sectionSlugs: string[] = SECTIONS.map(section => section.slug)

/** Seções Agendado, Rascunhos e Histórico: cada uma numa tabela com menu ⋮, tipo, nome e data; "Ver todas" abre a lista completa. */
export function BroadcastSections({ items, onSeeAll, ...handlers }: { items: Broadcast[]; onSeeAll: (slug: string) => void } & Handlers) {
  const groups = groupBroadcasts(items)
  return <div className="space-y-6">
    {SECTIONS.map(section => <Section key={section.key} section={section} rows={groups[section.key]} onSeeAll={() => onSeeAll(section.slug)} {...handlers} />)}
  </div>
}

/** Lista completa de uma seção, com a busca pelo nome. */
export function BroadcastFullList({ items, slug, search, onSearch, ...handlers }: { items: Broadcast[]; slug: string; search: string; onSearch: (value: string) => void } & Handlers) {
  const section = SECTIONS.find(candidate => candidate.slug === slug) ?? SECTIONS[0]
  const needle = search.trim().toLocaleLowerCase("pt-BR")
  const rows = groupBroadcasts(items)[section.key].filter(item => item.name.toLocaleLowerCase("pt-BR").includes(needle))
  return <Section section={section} rows={rows} full search={search} onSearch={onSearch} empty={needle ? "Nenhuma transmissão encontrada." : undefined} {...handlers} />
}

type SectionDef = (typeof SECTIONS)[number]
function Section({ section, rows, full = false, search, onSearch, onSeeAll, empty, ...handlers }: { section: SectionDef; rows: Broadcast[]; full?: boolean; search?: string; onSearch?: (value: string) => void; onSeeAll?: () => void; empty?: string } & Handlers) {
  const shown = visibleRows(rows, full, sectionLimit(section.key))
  const history = section.key === "history"
  const headingId = `broadcast-section-${section.title}`
  return <section aria-labelledby={headingId} className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id={headingId} className="text-base font-medium">{section.title}</h2>
      {full ? <div className="relative w-full sm:w-64"><Label htmlFor="broadcast-search" className="sr-only">Buscar transmissão pelo nome</Label><Search className="pointer-events-none absolute top-3 left-3 size-4 text-text-muted" aria-hidden="true" /><Input id="broadcast-search" type="search" value={search ?? ""} onChange={event => onSearch?.(event.target.value)} placeholder="Buscar pelo nome" className="pl-9" /></div> : null}
    </div>
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      {rows.length === 0 ? <p className="px-4 py-6 text-sm text-text-muted">{empty ?? section.empty}</p> : <table className="w-full table-fixed text-left text-sm">
        <caption className="sr-only">{section.title}</caption>
        <thead className="border-b border-border text-text-muted"><tr>
          <th scope="col" className="w-12 px-2 py-4"><span className="sr-only">Ações</span></th>
          <th scope="col" className="w-14 px-2 py-4 font-medium sm:w-20">Tipo</th>
          <th scope="col" className={`px-2 py-4 font-medium ${history ? "sm:w-72" : "sm:w-64"}`}>Nome</th>
          <th scope="col" className="hidden px-2 py-4 font-medium sm:table-cell">{section.dateHeader}</th>
          {history ? ["Enviado", "Entregue (%)", "Lido (%)", "Clicado (%)"].map(label => <th key={label} scope="col" className="hidden w-40 px-2 py-4 font-medium lg:table-cell">{label}</th>) : null}
        </tr></thead>
        <tbody className="divide-y divide-border">{shown.map(item => <Row key={item.id} item={item} history={history} {...handlers} />)}</tbody>
      </table>}
      {!full && hasHiddenRows(rows.length, section.key)
        ? <div className="flex justify-center border-t border-border p-5"><Button variant="secondary" size="sm" onClick={onSeeAll}>{`Veja todas as ${rows.length.toLocaleString("pt-BR")} mensagens`}</Button></div> : null}
    </div>
  </section>
}

/** Selo da situação de uma agendada: pausada antes da hora ou com a hora vencida sem envio. */
function ScheduleBadge({ item }: { item: Broadcast }) {
  const label = isPausedSchedule(item) ? "Pausado" : isOverdue(item) ? "Atrasado" : null
  return label ? <span className="ml-2 inline-block rounded-full bg-warning-soft px-2 py-0.5 align-middle text-xs font-medium text-warning">{label}</span> : null
}

function Row({ item, history, busy, progress, onEdit, onReport, onToggle, onCancel, onDelete }: { item: Broadcast; history: boolean } & Handlers) {
  const pausedSchedule = isPausedSchedule(item)
  const date = item.status === "scheduled" || pausedSchedule ? item.scheduled_at : item.updated_at
  const formatted = formatBroadcastDate(date, item.timezone)
  return <tr className="align-middle">
    <td className="px-2 py-3.5"><RowMenu item={item.name}>
      {editable(item) || pausedSchedule ? <RowMenuItem onSelect={() => onEdit(item)}>Continuar edição</RowMenuItem> : null}
      {item.status !== "draft" ? <RowMenuItem onSelect={() => onReport(item)}>Ver relatório</RowMenuItem> : null}
      {item.status === "sending" || item.status === "paused" ? <RowMenuItem disabled={busy === item.id} onSelect={() => onToggle(item)}>{item.status === "paused" ? "Retomar envio" : "Pausar envio"}</RowMenuItem> : null}
      {item.status === "scheduled" ? <RowMenuItem disabled={busy === item.id} onSelect={() => onToggle(item)}>Pausar envio</RowMenuItem> : null}
      {item.status === "scheduled" || pausedSchedule ? <RowMenuItem className="text-danger" disabled={busy === item.id} onSelect={() => onCancel(item)}>Cancelar agendamento</RowMenuItem> : null}
      {editable(item) || pausedSchedule ? <RowMenuItem className="text-danger" disabled={busy === item.id} onSelect={() => onDelete(item)}>Excluir</RowMenuItem> : null}
    </RowMenu></td>
    <td className="px-2 py-3.5"><span title={channelLabel(item.audience.channel)}>{item.audience.channel in channelNames ? <BrandChannelIcon channel={item.audience.channel as ChannelId} className="size-9" /> : <span className="grid size-9 place-items-center rounded-full bg-accent-soft text-accent"><ChannelIcon channel={item.audience.channel} /></span>}<span className="sr-only">{channelLabel(item.audience.channel)}</span></span></td>
    <td className="min-w-0 px-2 py-3.5">
      <button type="button" className="block max-w-full truncate text-left font-medium hover:underline" title={item.name} aria-label={`${editable(item) || pausedSchedule ? "Editar" : "Ver relatório de"} ${item.name}`} onClick={() => editable(item) || pausedSchedule ? onEdit(item) : onReport(item)}>{item.name}</button>
      <p className="mt-0.5 text-xs text-text-muted">{channelLabel(item.audience.channel)}</p>
      <p className="mt-0.5 text-xs text-text-muted sm:hidden">{formatted}<ScheduleBadge item={item} /></p>
      {history && item.status === "sent" ? <MobileMetrics item={item} /> : null}
      {item.status === "sending" ? <div className="mt-2">{progress(item)}</div> : null}
    </td>
    <td className="hidden px-2 py-3.5 text-text-muted sm:table-cell">{formatted}<ScheduleBadge item={item} />{item.status === "paused" && !pausedSchedule ? <span className="block text-xs">Pausada</span> : item.status === "sent" ? null : item.status === "cancelled" ? <span className="block text-xs">Cancelada</span> : null}</td>
    {history ? <HistoryCells item={item} /> : null}
  </tr>
}

/** No celular as colunas do Histórico somem; os mesmos números ficam numa linha sob o nome. */
function MobileMetrics({ item }: { item: Broadcast }) {
  const sent = item.metrics?.sent ?? 0
  const can = reports(item.audience.channel)
  const parts = [["Enviado", sent.toLocaleString("pt-BR")], ...(can.delivered ? [["Entregue", rateCell(item.metrics?.delivered, sent).percent]] : []), ...(can.read ? [["Lido", rateCell(item.metrics?.opened ?? item.metrics?.read, sent).percent]] : []), ["Clicado", rateCell(item.metrics?.clicked, sent).percent]]
  return <p className="mt-0.5 text-xs text-text-muted lg:hidden">{parts.map(([label, value]) => `${label} ${value.replace(/[()]/g, "")}`).join(" · ")}</p>
}

function HistoryCells({ item }: { item: Broadcast }) {
  const sent = item.metrics?.sent ?? 0
  const can = reports(item.audience.channel)
  const cells = [rateCell(item.metrics?.delivered, sent), rateCell(item.metrics?.opened ?? item.metrics?.read, sent), rateCell(item.metrics?.clicked, sent)]
  return <>
    <td className="hidden px-2 py-3.5 lg:table-cell">{sent.toLocaleString("pt-BR")}</td>
    {cells.map((cell, index) => <td key={index} className="hidden px-2 py-3.5 lg:table-cell">{index === 0 && !can.delivered ? notReported(item.audience.channel, "entrega") : index === 1 && !can.read ? notReported(item.audience.channel, "leitura") : <>{cell.value} <span className="text-text-muted">{cell.percent}</span></>}</td>)}
  </>
}
