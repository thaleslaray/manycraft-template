import { listInboxMentions, readInboxMention } from "@/data/inbox-team"
import { useFilterOptions } from "@/components/contacts/contact-filter-builder"
import { byChannelOrder, ChannelIcon, channelNames, type ChannelId } from "@/components/settings/settings-nav"
import * as React from "react"
import { useNavigate, useParams } from "react-router"
import { ArrowDownUp, AtSign, ChevronDown, ChevronUp, Clock3, Inbox, MessageCircle, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings, SlidersHorizontal, TriangleAlert, UserRound, UsersRound } from "lucide-react"
import { isFakeMode } from "@/data/api"
import { subscribeInbox, type InboxConnectionState, type InboxLiveEvent, listInbox, type InboxFilter, type InboxFolder, type InboxOverview, type InboxRow } from "@/data"
import { useAsync } from "@/hooks/use-async"
import { inboxDefaults, inboxLabelsKey, inboxListFilter, inboxListKey, inboxMentionsKey } from "@/data/screen-keys"
import { useCan } from "@/hooks/use-role"
import { LabelChips, listInboxLabels } from "./inbox-labels"
import { emptyContactFilter, type ContactQueryFilter } from "@/data/segments"
import { ContactFilterBuilder } from "@/components/contacts/contact-filter-builder"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { timeAgo } from "@/lib/time"
import { cn } from "@/lib/utils"
import { AvatarInitials } from "@/components/ui/avatar-initials"
import { PageHeader } from "@/components/shell/page-header"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { InboxConversationPanel } from "./inbox-conversation"
import { InboxNewConversation } from "./inbox-new-conversation"
import { InboxIllustration } from "./inbox-illustration"
import { shortAgo } from "./inbox-format"
import { inboxChannelLabels, InboxLoadError, InboxPanelBoundary } from "./inbox-shared"

export function InboxPage() {
  const { workspace = "demo", conversationId } = useParams()
  return <InboxWorkspace key={workspace} workspace={workspace} selected={conversationId ?? null} />
}

function InboxWorkspace({ workspace, selected }: { workspace: string; selected: string | null }) {
  const navigate = useNavigate()
  // A conversa aberta vive na URL (/:workspace/inbox/:conversationId): endereço direto e botão voltar funcionam.
  const setSelected = React.useCallback((next: string | null | ((current: string | null) => string | null)) => {
    const id = typeof next === "function" ? next(selected) : next
    if (id === selected) return
    void navigate(`/${encodeURIComponent(workspace)}/inbox${id ? `/${encodeURIComponent(id)}` : ""}`)
  }, [navigate, workspace, selected])
  // A assinatura do tempo real vive enquanto o espaço não muda: lê sempre o setSelected atual (com a conversa aberta de agora).
  const setSelectedRef = React.useRef(setSelected)
  setSelectedRef.current = setSelected
  const [folder, setFolder] = React.useState<InboxFolder>(inboxDefaults.folder)
  const [status, setStatus] = React.useState<"all" | "open" | "closed">(inboxDefaults.status)
  const [channel, setChannel] = React.useState<NonNullable<InboxFilter["channel"]>>(inboxDefaults.channel)
  const [unread, setUnread] = React.useState(inboxDefaults.unread)
  const [sort, setSort] = React.useState<"newest" | "oldest">(inboxDefaults.sort)
  const [search, setSearch] = React.useState(inboxDefaults.search)
  const [anchor, setAnchor] = React.useState<string | null>(null)
  const [labelId, setLabelId] = React.useState(inboxDefaults.labelId)
  const labels = useAsync(listInboxLabels, "inbox-labels", { cache: inboxLabelsKey(workspace) })
  const [contactFilter, setContactFilter] = React.useState<ContactQueryFilter>(emptyContactFilter)
  const [filterOpen, setFilterOpen] = React.useState(false)
  const [foldersOpen, setFoldersOpen] = React.useState(true)
  const [mobileFolders, setMobileFolders] = React.useState(false)
  // Iniciar conversa com quem nunca escreveu é edição (o motor pede o papel de editor).
  const canStart = useCan("edit")
  const [deletedConversations, setDeletedConversations] = React.useState<Set<string>>(new Set())
  const [mentionError, setMentionError] = React.useState("")
  const [version, setVersion] = React.useState(0)
  const [newConversation, setNewConversation] = React.useState(false)
  const [liveEvent, setLiveEvent] = React.useState<InboxLiveEvent | null>(null)
  const [connection, setConnection] = React.useState<InboxConnectionState>("connecting")
  React.useEffect(() => {
    // Só RECONEXÃO rebusca (já esteve conectado, caiu e voltou): a primeira conexão chega com os dados recém-carregados.
    let wasConnected = false
    return subscribeInbox(event => {
    if (event.type === "contact_deleted") {
      setDeletedConversations(previous => new Set([...previous, ...event.conversation_ids]))
      setSelectedRef.current(current => current && event.conversation_ids.includes(current) ? null : current)
    }
    setLiveEvent(event)
    setVersion(value => value + 1)
  }, state => {
    setConnection(state)
    if (state === "connected") {
      if (wasConnected) setVersion(value => value + 1)
      wasConnected = true
    }
  })
  }, [workspace])
  const mentions = useAsync(listInboxMentions, `${workspace}|${version}`, { cache: inboxMentionsKey(workspace) })
  const q = React.useDeferredValue(search)
  const accounts = byChannelOrder(useFilterOptions()?.accounts ?? [])
  const filter: InboxFilter = inboxListFilter({ folder, status, channel, unread, sort, search: q, labelId, contactFilter })
  const result = useAsync(() => listInbox(workspace, filter), `${workspace}|${JSON.stringify(filter)}|${version}`, { cache: inboxListKey(workspace, filter) })
  const overview = result.data ?? result.stale
  const visibleRows = overview?.rows.filter(row => !deletedConversations.has(row.id)) ?? []
  const counts = overview?.counts ?? result.stale?.counts
  const members = overview?.members ?? result.stale?.members ?? []

  function chooseFolder(next: InboxFolder) {
    setFolder(next)
    setSelected(null)
    setMobileFolders(false)   // no celular, escolher a pasta fecha o painel e mostra a lista
  }

  function clearFilters() {
    setFolder("all")
    setStatus("open")
    setChannel("all")
    setUnread(false)
    setSearch("")
    setContactFilter(emptyContactFilter())
    setLabelId("all")
  }

  const filtered = folder !== "all" || status !== "open" || channel !== "all" || unread || q.trim() !== "" || contactFilter.rules.length > 0 || labelId !== "all"
  const folders = (
    <InboxFolders folder={folder} onSelect={chooseFolder} counts={counts} members={members} currentMemberId={overview?.current_member_id ?? null} />
  )

  return (
    <div className="flex min-h-[calc(100dvh-var(--header))] min-w-0 flex-col lg:h-[calc(100dvh-var(--header))] lg:overflow-hidden">
      <title>Caixa de entrada</title>
      <PageHeader title="Caixa de entrada" badge={<span role="status" className={cn("shrink-0 rounded-pill bg-surface-muted px-2 py-0.5 text-xs text-text-muted", connection === "connected" && "sr-only")}>{({ connecting: "Conectando ao atendimento ao vivo…", connected: "Ao vivo", reconnecting: "Reconectando…", offline: "Sem conexão", fake: "Dados de demonstração" })[connection]}</span>} center={<div className="relative mx-auto w-full max-w-96 lg:absolute lg:top-1/2 lg:left-1/2 lg:-translate-x-1/2 lg:-translate-y-1/2"><Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-text-muted" aria-hidden="true" /><Input aria-label="Buscar conversa por nome, usuário ou e-mail" placeholder="Pesquisar em conversas na caixa de entrada" value={search} onChange={(event) => setSearch(event.target.value)} className="h-9 border-border pl-9" /></div>} actions={[...(!isFakeMode() && canStart ? [{ label: "Nova conversa", onSelect: () => setNewConversation(true) }] : []), { label: "Configurações da caixa de entrada", icon: Settings, iconOnly: true, onSelect: () => void navigate(`/${encodeURIComponent(workspace)}/settings/inbox`) }]} />
      {filterOpen && <CustomFilterDialog value={contactFilter} onApply={next => { setContactFilter(next); setSelected(null); setFilterOpen(false) }} onClose={() => setFilterOpen(false)} />}
      {newConversation && <InboxNewConversation workspace={workspace} onClose={() => setNewConversation(false)} onStarted={id => { setNewConversation(false); setVersion(value => value + 1); setSelected(id) }} />}
      {mentionError && <p role="alert" className="px-3 pt-3 text-sm text-danger">{mentionError}</p>}
      {(mentions.data?.length ?? 0) > 0 && <aside aria-label="Avisos de menção" className="m-3 space-y-2 rounded-lg border border-border bg-warning-soft p-3"><p role="status" className="text-sm font-semibold">Você foi mencionado em uma nota</p>{mentions.data!.map(mention => <Button key={mention.id} variant="ghost" size="sm" className="h-auto max-w-full whitespace-normal text-left wrap-anywhere" aria-label={`Menção: ${mention.text}`} onClick={async () => { try { setMentionError(""); await readInboxMention(mention.id); setAnchor(mention.message_id); setSelected(mention.conversation_id); setVersion(v => v + 1) } catch { setMentionError("Não foi possível marcar a menção como lida. Clique no aviso para tentar novamente.") } }}><AtSign className="size-4 shrink-0" />{mention.text}</Button>)}</aside>}
      <div className={cn("p-3 lg:hidden", selected && "hidden")}>
        <details open={mobileFolders} onToggle={event => setMobileFolders(event.currentTarget.open)} className="rounded-lg border border-border bg-surface">
          <summary className="flex cursor-pointer items-center gap-2 rounded-lg p-3 font-semibold">
            <SlidersHorizontal className="size-4" aria-hidden="true" /> Pastas de atendimento
          </summary>
          <div className="border-t border-border p-3">{folders}</div>
        </details>
      </div>
      <div className={cn("grid min-h-0 min-w-0 flex-1 lg:grid-rows-[minmax(0,1fr)]", foldersOpen ? "lg:grid-cols-[calc(var(--spacing)*75)_minmax(0,1fr)]" : "lg:grid-cols-[calc(var(--spacing)*12)_minmax(0,1fr)]")}>
        <aside aria-label="Pastas de atendimento" className="relative hidden min-w-0 border-r border-border bg-bg lg:block">
          {foldersOpen ? <div className="p-4 pb-14">{folders}</div> : null}
          <Button variant="ghost" size="icon" aria-label={foldersOpen ? "Recolher pastas" : "Mostrar pastas"} aria-expanded={foldersOpen} onClick={() => setFoldersOpen(value => !value)} className={cn("absolute bottom-3 size-8 text-text-muted", foldersOpen ? "right-3" : "left-2")}>
            {foldersOpen ? <PanelLeftClose className="size-4" aria-hidden="true" /> : <PanelLeftOpen className="size-4" aria-hidden="true" />}
          </Button>
        </aside>
        <div className="flex min-h-0 min-w-0 flex-col bg-surface">
        <div role="toolbar" aria-label="Filtros das conversas" className={cn("flex-wrap items-center gap-2 border-b border-border py-3.5 pr-4 pl-4 lg:pl-16 ",selected ? "hidden xl:flex" : "flex") + " [&_button[role=combobox]]:h-8 [&_button[role=combobox]]:border-border [&_button[role=combobox]]:w-auto [&_button[role=combobox]]:gap-2 [&_button[role=combobox]]:text-xs"}>
          <div className="relative min-w-48 flex-1 sm:hidden">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-text-muted" aria-hidden="true" />
            <Input aria-label="Buscar conversa por nome, usuário ou e-mail" placeholder="Buscar conversa" value={search} onChange={(event) => setSearch(event.target.value)} className="h-9 pl-9" />
          </div>
          <div className="min-w-0"><Label htmlFor="inbox-status" className="sr-only">Situação</Label>
                <Select value={status} onValueChange={(value) => setStatus(value as typeof status)}>
                  <SelectTrigger id="inbox-status"><MessageCircle className="size-4 shrink-0" aria-hidden="true" /><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">Conversas abertas</SelectItem>
                    <SelectItem value="closed">Conversas encerradas</SelectItem>
                    <SelectItem value="all">Todas as conversas</SelectItem>
                  </SelectContent>
                </Select></div>
          <Button size="sm" variant="secondary" aria-pressed={unread} onClick={() => setUnread(value => !value)} className={cn("h-8 border-border text-xs font-normal", unread && "border-accent bg-accent-soft")}>Não lidas</Button>
          <div className="min-w-0"><Label htmlFor="inbox-sort" className="sr-only">Ordenar</Label>
                <Select value={sort} onValueChange={(value) => setSort(value as typeof sort)}>
                  <SelectTrigger id="inbox-sort"><ArrowDownUp className="size-4 shrink-0" aria-hidden="true" /><span className="text-text-muted">Classificar:</span><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="newest">Mais recentes</SelectItem>
                    <SelectItem value="oldest">Mais antigas</SelectItem>
                  </SelectContent>
                </Select></div>
          <div className="min-w-0"><Label htmlFor="inbox-channel" className="sr-only">Canal</Label>
                <Select value={channel} onValueChange={(value) => setChannel(value as typeof channel)}>
                  <SelectTrigger id="inbox-channel"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos os canais</SelectItem>
                    {accounts.length ? <>
                      {accounts.map(account => <SelectItem key={account.id} value={`conn:${account.id}`} detail={account.channel in channelNames && channelNames[account.channel as ChannelId] !== account.label ? channelNames[account.channel as ChannelId] : undefined}>
                        {account.channel in channelNames ? <span className="flex min-w-0 items-center gap-2.5"><ChannelIcon channel={account.channel as ChannelId} className="size-6" /><span className="truncate">{account.label}</span></span> : account.label}</SelectItem>)}
                      {/* Canal inteiro só faz diferença onde há mais de uma conta dele. */}
                      {Object.entries(inboxChannelLabels).filter(([value]) => accounts.filter(account => account.channel === value).length > 1).map(([value, name]) => <SelectItem key={value} value={value}>{value in channelNames ? <span className="flex min-w-0 items-center gap-2.5"><ChannelIcon channel={value as ChannelId} className="size-6" /><span className="truncate">{name}: todas as contas</span></span> : `${name}: todas as contas`}</SelectItem>)}
                    </> : Object.entries(inboxChannelLabels).map(([value, name]) => <SelectItem key={value} value={value}>{name}</SelectItem>)}
                  </SelectContent>
                </Select></div>
          {(labels.data ?? []).length ? <div className="min-w-0"><Label htmlFor="inbox-label" className="sr-only">Etiqueta</Label>
                <Select value={labelId} onValueChange={setLabelId}>
                  <SelectTrigger id="inbox-label"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="all">Todas as etiquetas</SelectItem>{labels.data!.map(l => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}</SelectContent>
                </Select></div> : null}
          {!isFakeMode() && (
            <Button size="sm" variant={contactFilter.rules.length ? "primary" : "secondary"} aria-haspopup="dialog" onClick={() => setFilterOpen(true)} className="h-8 border-border text-xs font-normal">
              <Plus className="size-4" aria-hidden="true" />
              {contactFilter.rules.length ? `Filtro (${contactFilter.rules.length})` : "Filtro"}
            </Button>
          )}
        </div>
        <div className="grid min-h-0 min-w-0 flex-1 lg:grid-rows-[minmax(0,1fr)] xl:grid-cols-[calc(var(--spacing)*77.5)_minmax(0,1fr)]">
        <section aria-label="Conversas" className={cn("min-h-0 min-w-0 overflow-hidden xl:overflow-y-auto xl:border-r xl:border-border", selected && "hidden xl:block")}>
          <div className={cn("flex items-center justify-between text-xs text-text-muted", filtered || result.error ? "border-b border-border px-4 py-2" : "sr-only")} aria-live="polite">
            <span>{overview ? `${overview.total} ${overview.total === 1 ? "conversa" : "conversas"}` : result.error ? "Lista indisponível" : "Carregando conversas…"}</span>
            {filtered ? <button type="button" onClick={clearFilters} className="rounded-sm font-semibold text-accent hover:underline">Limpar filtros</button> : null}
          </div>
          {result.error ? (
            <div className="p-3"><InboxLoadError onRetry={result.reload} /></div>
          ) : result.loading && !overview ? (
            <div className="space-y-4 p-4" role="status" aria-label="Carregando conversas">
              {Array.from({ length: 4 }, (_, index) => <div key={index} className="flex gap-3"><Skeleton className="size-8 rounded-pill" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-1/2" /></div></div>)}
            </div>
          ) : visibleRows.length ? (
            <ul className="divide-y divide-border">
              {visibleRows.map((row) => <ConversationItem key={row.id} row={row} selected={row.id === selected} onOpen={() => setSelected(row.id)} />)}
            </ul>
          ) : (
            <EmptyState className="m-3 border-0 px-2 py-8" title={filtered ? "Nenhuma conversa por aqui" : "O atendimento começa aqui"} description={filtered ? "Mude a pasta ou os filtros para encontrar outras conversas." : "As mensagens recebidas nos canais deste espaço aparecerão nesta lista."} action={filtered ? <Button size="sm" variant="secondary" onClick={clearFilters}>Limpar filtros</Button> : undefined} />
          )}
        </section>
        <section aria-label="Conversa e contato" className={cn("min-h-0 min-w-0 lg:overflow-hidden lg:p-3", selected ? "block" : "hidden xl:block")}>
          {selected ? (
            <InboxPanelBoundary key={selected} onBack={() => setSelected(null)}><InboxConversationPanel anchorMessageId={anchor} workspace={workspace} conversationId={selected} members={members} liveEvent={liveEvent} connection={connection} onBack={() => setSelected(null)} onChanged={() => setVersion((value) => value + 1)} onUnread={() => { setSelected(null); setVersion((value) => value + 1) }} onDeleted={() => { setSelected(null); setVersion(value => value + 1) }} /></InboxPanelBoundary>
          ) : (
            <div className="flex h-full min-h-96 flex-col items-center justify-center gap-3 p-6 pb-4 text-center">
              <InboxIllustration />
              <h2 className="max-w-xs text-base font-semibold">Este é um espaço para conversar com seus contatos de todos os canais conectados</h2>
              <p className="max-w-xs text-sm text-text-muted">Toda mensagem que você receber será exibida aqui. Você pode fazer ajustes nas configurações da caixa de entrada.</p>
              <Button onClick={() => void navigate(`/${encodeURIComponent(workspace)}/settings/inbox`)}>Ir para as configurações da caixa de entrada</Button>
            </div>
          )}
        </section>
        </div>
        </div>
      </div>
    </div>
  )
}

function ConversationItem({ row, selected, onOpen }: { row: InboxRow; selected: boolean; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} aria-current={selected ? "true" : undefined} aria-label={`${row.contact.name}, ${inboxChannelLabels[row.channel]}${row.unread ? ", não lida" : ""}`} className={cn("flex min-h-18 w-full min-w-0 items-center gap-3 px-4 py-3 text-left hover:bg-surface-muted", selected && "bg-surface-muted")}>
        <AvatarInitials name={row.contact.name} src={row.contact.avatar_url} className="size-10 text-sm" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span title={row.contact.name} className={cn("min-w-0 flex-1 truncate text-sm", row.unread ? "font-bold" : "font-semibold")}>{row.contact.name}</span>
            {row.unread ? <span className="size-1.5 shrink-0 rounded-pill bg-accent" aria-hidden="true" /> : null}
            <time dateTime={row.updated_at} title={timeAgo(row.updated_at)} className={cn("shrink-0 text-xs", row.unread ? "text-accent" : "text-text-muted")}>{shortAgo(row.updated_at)}</time>
          </div>
          <p className="truncate text-xs text-text-muted">{row.status === "closed" ? <span className="mr-1 font-semibold text-success">Encerrada ·</span> : null}{row.preview}</p>
          {row.reminder_at ? <p className="flex items-center gap-1 text-2xs text-warning"><Clock3 className="size-3" aria-hidden="true" />Lembrete {timeAgo(row.reminder_at)}</p> : null}
          {row.labels?.length ? <LabelChips labels={row.labels} /> : null}
        </div>
      </button>
    </li>
  )
}

function FolderButton({ active, onClick, icon, label, count, title }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count: number | string | undefined; title?: string }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={cn("flex h-9 w-full min-w-0 items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-surface-muted", active && "bg-surface-muted font-semibold")}>
      {icon}<span className="min-w-0 flex-1 truncate" title={title ?? label}>{label}</span><span className="text-xs text-text-muted">{count ?? "—"}</span>
    </button>
  )
}

function InboxFolders({ folder, onSelect, counts, members, currentMemberId }: { folder: InboxFolder; onSelect: (folder: InboxFolder) => void; counts?: InboxOverview["counts"]; members: InboxOverview["members"]; currentMemberId: string | null }) {
  const [teamOpen, setTeamOpen] = React.useState(true)
  const icon = (Icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>) => <Icon className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
  const entries = [
    { id: "all", name: "Todas as conversas", icon: Inbox, count: counts?.all },
    { id: "unassigned", name: "Não atribuído", icon: TriangleAlert, count: counts?.unassigned },
    { id: "mine", name: "Atribuídas a mim", icon: UserRound, count: counts?.mine },
    ...((counts?.mentions ?? 0) > 0 || folder === "mentions" ? [{ id: "mentions", name: "Menções não lidas", icon: AtSign, count: counts?.mentions ?? 0 }] as const : []),
    { id: "reminders", name: "Lembretes", icon: Clock3, count: counts?.reminders },
  ] as const
  const me = members.find(member => member.id === currentMemberId)
  const others = members.filter(member => member.id !== currentMemberId)
  return (
    <nav aria-label="Filtrar conversas por pasta" className="space-y-4 pt-1">
      <div>
        {entries.map(({ id, name, icon: Icon, count }) => <FolderButton key={id} active={folder === id} onClick={() => onSelect(id)} icon={icon(Icon)} label={name} count={count} />)}
      </div>
      <div>
        <button type="button" aria-expanded={teamOpen} onClick={() => setTeamOpen(value => !value)} className="flex h-8 w-full items-center gap-1.5 rounded-md px-3 text-left text-xs text-text-muted hover:bg-surface-muted">
          {teamOpen ? <ChevronUp className="size-3.5" aria-hidden="true" /> : <ChevronDown className="size-3.5" aria-hidden="true" />}Equipe
        </button>
        {teamOpen ? (
          members.length ? <>
            <FolderButton active={folder === "assigned"} onClick={() => onSelect("assigned")} icon={icon(UsersRound)} label="Todos" count={counts ? counts.all - counts.unassigned : undefined} />
            {me ? <FolderButton active={folder === `member:${me.id}`} onClick={() => onSelect(`member:${me.id}`)} icon={<AvatarInitials name={me.name} className="size-5 text-2xs" />} label="Você" title={me.name} count={counts?.members[me.id]} /> : null}
            {others.map(member => <FolderButton key={member.id} active={folder === `member:${member.id}`} onClick={() => onSelect(`member:${member.id}`)} icon={<AvatarInitials name={member.name} className="size-5 text-2xs" />} label={member.name} count={counts?.members[member.id]} />)}
          </> : <p className="px-3 text-xs text-text-muted">Nenhuma pessoa neste espaço.</p>
        ) : null}
      </div>
    </nav>
  )
}


/** Monta o filtro num rascunho e só aplica ao confirmar, para a lista não recarregar a cada condição. */
function CustomFilterDialog({ value, onApply, onClose }: { value: ContactQueryFilter; onApply: (filter: ContactQueryFilter) => void; onClose: () => void }) {
  const [draft, setDraft] = React.useState(value)
  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-(--modal-lg)">
        <DialogHeader>
          <DialogTitle>Filtro personalizado</DialogTitle>
          <DialogDescription>Mostra só as conversas cujo contato atende às condições: tags, campos, canal e as demais da lista de contatos.</DialogDescription>
        </DialogHeader>
        <ContactFilterBuilder filter={draft} onChange={setDraft} />
        <DialogFooter>
          <Button variant="ghost" disabled={!draft.rules.length} onClick={() => onApply(emptyContactFilter())}>Remover filtro</Button>
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => onApply(draft)}>Aplicar filtro</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
