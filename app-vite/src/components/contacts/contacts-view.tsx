import * as React from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router"
import { Columns3, Filter, ListOrdered, Pause, Save, Search, UserMinus, X } from "lucide-react"
import { toast } from "sonner"
import { getContactFacets, listContacts, listFields, listTags, tagContacts, type Contact, type ContactFilter, type CustomField } from "@/data"
import type { ContactExportInput } from "@/data/contact-portability"
import { useAsync } from "@/hooks/use-async"
import { contactsKeys, contactsListFilter, contactsListKey } from "@/data/screen-keys"
import { useCan } from "@/hooks/use-role"
import { useWorkspaceSettings } from "@/hooks/use-workspace-settings"
import { emptyContactFilter, listSegments, queryContacts, saveSegment, type Segment } from "@/data/segments"
import { ContactFilterBuilder, labelFor, useFilterOptions } from "./contact-filter-builder"
import { PageHeader } from "@/components/shell/page-header"
import { cn } from "@/lib/utils"
import { timeAgo } from "@/lib/time"
import { AvatarInitials } from "@/components/ui/avatar-initials"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { EmptyState } from "@/components/ui/empty-state"
import { FacetPanel, ShowAllButton, FACET_VISIBLE, facetTitle } from "@/components/ui/facet-panel"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { BulkContactStatusDialog, downloadContactsCsv } from "./contact-portability-dialogs"
import { DeleteContactDialog } from "./delete-contact-dialog"
import { BulkSequenceDialog } from "./sequence-enrollment"
import { ContactEmailFilters, emailFilterChips, useEmailSegments, type EmailContactFilters } from "./contact-email-filters"
import { ContactProfile } from "./contact-profile"
import { CreateContactDialog } from "./create-contact-dialog"
import { ImportContactsDialog } from "./import-contacts-dialog"
import { contactName, statusLabel } from "./contact-name"
import { genderLabel } from "./gender"
import { CopyFieldDialog } from "./copy-field-dialog"
import { CleanupDialog } from "./cleanup-dialog"

const versionKey = (segment?: Segment) => segment ? `${segment.id}|${JSON.stringify(segment.filter)}` : "all"

type Extra = { key: string; rows: Contact[]; next: string | null } | null

export function ContactsView({ segment }: { segment?: Segment } = {}) {
  const navigate = useNavigate()
  const { workspace } = useParams() as { workspace: string }
  const [params, setParams] = useSearchParams()
  const contactId = params.get("contact")
  const [creating, setCreating] = React.useState(false)
  const [cleaning, setCleaning] = React.useState(false)
  const importId = params.get("import")
  const [importing, setImporting] = React.useState(false)

  const [advanced, setAdvanced] = React.useState(segment?.filterKind === "email" ? emptyContactFilter() : segment?.filter ?? emptyContactFilter())
  const [filterOpen, setFilterOpen] = React.useState(false)
  const [conditionOpen, setConditionOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [segmentError, setSegmentError] = React.useState(segment?.error)
  const [saveOpen, setSaveOpen] = React.useState(false)
  const [segmentName, setSegmentName] = React.useState("")
  const [tagId, setTagId] = React.useState<string | null>(null)
  const [emailFilters, setEmailFilters] = React.useState<EmailContactFilters>(segment?.filterKind === "email" ? { segment_id: segment.id } : {})
  const [search, setSearch] = React.useState("")
  const [version, setVersion] = React.useState(0)
  const segments = useAsync(listSegments, `${workspace}|segments|${versionKey(segment)}|${version}`, { cache: contactsKeys.segments(workspace) })
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [extra, setExtra] = React.useState<Extra>(null)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [bulk, setBulk] = React.useState<"add" | "remove" | "delete" | "sequence" | "pause" | "unsubscribe" | "copy" | null>(null)
  const q = React.useDeferredValue(search)

  const advancedKey = JSON.stringify(advanced)
  const prefs = useWorkspaceSettings()
  const [showUnsubscribed, setShowUnsubscribed] = React.useState(false)
  // Com "esconder descadastrados" ligado no espaço, a lista mostra só inscritos até a pessoa pedir os demais.
  const onlySubscribed = (prefs?.show_only_subscribed ?? false) && !showUnsubscribed
  const key = `${workspace}|${tagId}|${q}|${version}|${advancedKey}|${JSON.stringify(emailFilters)}|${onlySubscribed}`
  const filter: ContactFilter = contactsListFilter(tagId, q, emailFilters, onlySubscribed)
  const first = useAsync(() => advanced.rules.length ? queryContacts(advanced, null, q) : listContacts(workspace, null, filter), key, { cache: contactsListKey(workspace, { tagId, q, advanced, emailFilters, onlySubscribed }) })
  const tags = useAsync(() => listTags(workspace), `${workspace}|${version}`, { cache: contactsKeys.tags(workspace) })
  const facets = useAsync(getContactFacets, `${workspace}|facets|${version}`, { cache: contactsKeys.facets(workspace) })
  const fields = useAsync(() => listFields(workspace), workspace, { cache: contactsKeys.fields(workspace) })
  const contactFields = (fields.data ?? fields.stale ?? []).filter(f => f.scope === "contact")
  const [shownFields, setShownFields] = useShownFields(workspace)
  const canEdit = useCan("edit")

  const base = first.data ?? first.stale
  const more = extra && extra.key === key ? extra : null
  const rows = base ? [...base.rows, ...(more?.rows ?? [])] : []
  const nextCursor = more ? more.next : (first.data?.next_cursor ?? null)
  const filtered = advanced.rules.length > 0 || tagId !== null || q.trim() !== "" || !!(emailFilters.email_filter || emailFilters.contact_filter || emailFilters.segment_id)

  async function loadMore() {
    if (!nextCursor) return
    setLoadingMore(true)
    try {
      const page = await (advanced.rules.length ? queryContacts(advanced, nextCursor, q) : listContacts(workspace, nextCursor, filter))
      setExtra({ key, rows: [...(more?.rows ?? []), ...page.rows], next: page.next_cursor })
    } catch {
      toast.error("Não consegui carregar mais contatos.")
    } finally {
      setLoadingMore(false)
    }
  }

  async function persistSegment(update = false) {
    const name = update ? segment!.name : segmentName.trim()
    if (!name || !advanced.rules.length) return
    setSaving(true)
    try {
      const saved = await saveSegment(name, advanced, update ? segment!.id : undefined)
      setSaveOpen(false)
      toast.success(update ? "Segmento atualizado." : "Segmento salvo.")
      if (update) { setSegmentError(undefined); segments.reload(); first.reload() }
      else navigate(`/${workspace}/contacts/segments/${saved.id}`)
    } catch (error) { toast.error(error instanceof Error ? error.message : "Não foi possível salvar o segmento.") }
    finally { setSaving(false) }
  }

  function openContact(id: string | null) {
    const sp = new URLSearchParams(params.toString())
    if (id) sp.set("contact", id)
    else sp.delete("contact")
    setParams(sp)
  }

  const columns: Column<Contact>[] = [
    {
      key: "photo",
      header: "Imagem do perfil",
      className: "w-14 max-w-14 md:w-[5.85rem] md:max-w-[5.85rem]",
      cell: (c) => <AvatarInitials name={contactName(c)} src={c.profile_pic_url ?? undefined} className="size-8 text-xs md:size-[3.125rem] md:text-sm" />,
    },
    {
      key: "name",
      header: "Nome",
      className: "min-w-0 max-w-[7rem] md:w-[12.4rem] md:max-w-[12.4rem]",
      cell: (c) => (
        <button
          type="button"
          aria-haspopup="dialog"
          title={contactName(c)}
          onClick={() => openContact(c.id)}
          className="line-clamp-2 min-w-0 rounded-sm text-left hover:underline"
        >
          {contactName(c)}
        </button>
      ),
    },
    { key: "gender", header: "Gênero", className: "hidden w-[6.25rem] md:table-cell", cell: (c) => genderLabel(c.gender) },
    { key: "status", header: "Status", className: "md:w-[20.8rem] md:max-w-[20.8rem]", cell: (c) => c.conversation_deleted && c.status !== "deleted" ? <span title="O contato bloqueou a conta ou apagou a conversa em todas as conexões">Conversa apagada</span> : statusLabel[c.status] },
    { key: "since", header: "Inscrito", className: "hidden whitespace-nowrap md:table-cell", cell: (c) => timeAgo(c.subscribed_at) },
    ...contactFields.filter(f => shownFields.includes(f.id)).map((f): Column<Contact> => ({
      key: `field:${f.id}`, header: f.name, className: "hidden max-w-48 truncate md:table-cell", cell: (c) => fieldText(f, c.fields?.[f.id]),
    })),
  ]

  const tagList = tags.data ?? tags.stale ?? []
  const facetData = facets.data ?? facets.stale
  const emailSegments = useEmailSegments()
  const filterOptions = useFilterOptions()
  const [allSegments, setAllSegments] = React.useState(false)
  const facetLabel = !tagId ? undefined
    : tagId.startsWith("trigger:") ? `Gatilho: ${facetData?.triggers.find(t => `trigger:${t.id}` === tagId)?.name ?? "indisponível"}`
    : tagId.startsWith("sequence:") ? `Sequência: ${facetData?.sequences.find(t => `sequence:${t.id}` === tagId)?.name ?? "indisponível"}`
    : `Tag: ${tagList.find(t => t.id === tagId)?.name ?? "indisponível"}`
  const chips: { key: string; label: string; remove: () => void }[] = [
    ...advanced.rules.map((r, i) => ({ key: `rule-${i}`, label: labelFor(r, filterOptions), remove: () => { setAdvanced({ ...advanced, rules: advanced.rules.filter((_, j) => j !== i) }); setSelected(new Set()) } })),
    ...(facetLabel ? [{ key: "tag", label: facetLabel, remove: () => { setTagId(null); setSelected(new Set()) } }] : []),
    ...emailFilterChips(emailFilters, emailSegments.data?.find(s => s.id === emailFilters.segment_id)?.name).map(c => ({ key: c.key, label: c.label, remove: () => { setEmailFilters(c.clear); setSelected(new Set()) } })),
    ...(showUnsubscribed && prefs?.show_only_subscribed ? [{ key: "unsub", label: "Descadastrados visíveis", remove: () => { setShowUnsubscribed(false); setSelected(new Set()) } }] : []),
  ]
  // O contador do botão conta tudo o que filtra a lista: condições, tag/gatilho/sequência da lateral e os filtros de e-mail.
  const filterCount = chips.filter(chip => chip.key !== "unsub").length
  function clearFilters() { setAdvanced(emptyContactFilter()); setTagId(null); setEmailFilters({}); setShowUnsubscribed(false); setSelected(new Set()) }
  /** O que o botão Exportar manda ao motor: os selecionados, ou exatamente o que a lista está filtrando agora. */
  function exportInput(ids?: string[]): ContactExportInput {
    if (ids?.length) return { ids }
    if (advanced.rules.length) return { filter: advanced, ...(q.trim() ? { search: q.trim() } : {}) }
    return { query: Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== undefined && value !== "")) as Record<string, string> }
  }
  const visibleSegments = allSegments ? segments.data ?? [] : (segments.data ?? []).slice(0, FACET_VISIBLE)

  return (
    <div className="space-y-6">
      <PageHeader
        title={segment?.name ?? "Contatos"}
        crumbs={segment ? [{ label: "Segmentos", to: `/${workspace}/contacts/segments` }] : undefined}
        actions={[
          { label: "Exportar", onSelect: () => void downloadContactsCsv(exportInput()) },
          ...(canEdit ? [{ label: "Criar novo contato", onSelect: () => setCreating(true) }] : []),
          ...(canEdit && prefs?.import_enabled !== false ? [{ label: "Importar", primary: true, onSelect: () => setImporting(true) }] : []),
        ]}
        menu={canEdit ? [{ label: "Limpar lista", onSelect: () => setCleaning(true) }] : []}
        menuLabel="Mais ações da lista"
      />
      {segmentError && <Banner variant="warning">{segmentError} Remova ou substitua as condições indisponíveis e atualize o segmento.</Banner>}
      <div className="grid gap-6 md:grid-cols-[14rem_1fr] lg:grid-cols-[25rem_1fr] lg:gap-[30px]">
      <aside className="order-last min-w-0 space-y-8 md:order-none">
        <nav aria-label="Segmentos salvos">
          <h2 className={facetTitle}>Segmentos</h2>
          {segments.error ? <Button variant="ghost" size="sm" onClick={segments.reload}>Recarregar segmentos</Button> : segments.loading ? <p className="text-sm text-text-muted">Carregando…</p> : !segments.data?.length ? <p className="text-sm text-text-muted">Salve um filtro para começar.</p> : <ul className="flex flex-col">{visibleSegments.map(s => <li key={s.id}><Link aria-current={segment?.id === s.id ? 'page' : undefined} title={s.total === undefined ? undefined : `${s.total} contatos`} className="flex h-5 items-center gap-3 text-sm text-text-muted hover:text-text hover:underline aria-[current=page]:font-semibold aria-[current=page]:text-text" to={`/${workspace}/contacts/segments/${s.id}`}><span className="min-w-0 truncate">{s.name}</span></Link></li>)}</ul>}
          {(segments.data?.length ?? 0) > FACET_VISIBLE ? <ShowAllButton all={allSegments} onToggle={() => setAllSegments(!allSegments)} /> : null}
          {allSegments || (segments.data?.length ?? 0) <= FACET_VISIBLE ? <Link className="mt-2 block text-center text-sm font-semibold text-link hover:underline" to={`/${workspace}/contacts/segments`}>Todos os segmentos</Link> : null}
        </nav>
        {segment && <Link className="block text-xs font-semibold text-link hover:underline" to={`/${workspace}/contacts`}>Todos os contatos</Link>}
      <FacetPanel
        label="Filtros rápidos"
        loading={tags.loading && !tags.stale}
        activeId={tagId}
        onSelect={(id) => {
          setAdvanced(emptyContactFilter())
          setTagId(id)
          setSelected(new Set())
        }}
        groups={[
          {
            title: "Tags",
            emptyText: "Nenhuma tag ainda",
            items: tagList.map((t) => ({ id: t.id, label: t.name, count: t.contact_count })),
          },
          {
            title: "Gatilhos de entrada",
            emptyText: "Nenhum contato entrou por gatilho",
            items: facetData?.triggers.map(t => ({ id: `trigger:${t.id}`, label: t.name, count: t.count })) ?? [],
          },
          {
            title: "Sequências",
            emptyText: "Nenhuma sequência",
            items: facetData?.sequences.map(t => ({ id: `sequence:${t.id}`, label: t.name, count: t.count })) ?? [],
          },
        ]}
      />
      </aside>

      <section aria-label="Lista de contatos" className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" aria-label="Filtrar contatos" aria-expanded={filterOpen} onClick={() => setFilterOpen(open => !open)} className={cn("h-12 gap-3 px-3 text-base text-text-muted", filterOpen && "bg-accent-soft text-accent")}><Filter className="size-7 stroke-[1.5]" aria-hidden="true" />Filtro{filterCount ? ` (${filterCount})` : ''}</Button>
          <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-7 stroke-[1.5] text-text-muted" aria-hidden="true" />
            <Input
              aria-label="Buscar contato"
              placeholder="Pesquisar"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setSelected(new Set())
              }}
              className="h-12 border-transparent bg-transparent pl-14 text-base placeholder:text-text-muted hover:border-border-input focus:border-border-input focus:bg-surface"
            />
          </div>
          <div className="ml-auto flex w-full items-center gap-2 sm:w-auto">
            {canEdit && <p role="status" className="mr-auto whitespace-nowrap text-xs text-text-muted sm:mr-0">{selected.size} {selected.size === 1 ? "selecionado" : "selecionados"}<span className="sr-only sm:not-sr-only"> do total</span> de {(base?.total ?? rows.length).toLocaleString("pt-BR")}</p>}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Colunas" title="Colunas" disabled={contactFields.length === 0}>
                  <Columns3 className="size-5" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="max-h-80 overflow-y-auto">
                <DropdownMenuLabel>Campos na lista</DropdownMenuLabel>
                {contactFields.map(f => (
                  <DropdownMenuCheckboxItem key={f.id} checked={shownFields.includes(f.id)} onSelect={e => e.preventDefault()}
                    onCheckedChange={on => setShownFields(on ? [...shownFields, f.id] : shownFields.filter(id => id !== f.id))}>
                    <span className="truncate">{f.name}</span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {canEdit && <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" disabled={selected.size === 0}>
                  Ações em lote
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => void downloadContactsCsv(exportInput([...selected]))}>Exportar selecionados (CSV)</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setBulk("add")}>Adicionar tag…</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setBulk("remove")}>Remover tag…</DropdownMenuItem>
                <DropdownMenuItem disabled={selected.size > 100} onSelect={() => setBulk("sequence")}><ListOrdered className="size-4" aria-hidden="true" />Inscrever em sequência…</DropdownMenuItem>
                <DropdownMenuItem disabled={selected.size > 100} onSelect={() => setBulk("copy")}>Copiar campo para e-mail ou telefone…</DropdownMenuItem>
                <DropdownMenuItem disabled={selected.size > 100} onSelect={() => setBulk("pause")}><Pause className="size-4" aria-hidden="true" />Pausar automações…</DropdownMenuItem>
                <DropdownMenuItem disabled={selected.size > 100} onSelect={() => setBulk("unsubscribe")}><UserMinus className="size-4" aria-hidden="true" />Descadastrar contatos…</DropdownMenuItem>
                <DropdownMenuItem className="text-danger" disabled={selected.size > 100} onSelect={() => setBulk("delete")}>Excluir contatos…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>}
          </div>
        </div>

        {filterOpen && <section aria-label="Filtro de contatos" className="space-y-3 pt-2">
          <button type="button" aria-expanded={conditionOpen || advanced.rules.length > 0} onClick={() => setConditionOpen(open => !open)} className="flex h-[2.875rem] w-full items-center justify-center rounded-md border border-dashed border-border-input text-sm text-text-muted hover:bg-surface-muted hover:text-text">+ Condição</button>
          {(conditionOpen || advanced.rules.length > 0 || emailFilters.email_filter || emailFilters.contact_filter || emailFilters.segment_id) ? <div className="space-y-4 rounded-lg border border-border bg-surface p-4">
            <ContactFilterBuilder filter={advanced} onChange={next => { setAdvanced(next); setConditionOpen(true); setEmailFilters({}); setTagId(null); setSelected(new Set()) }} />
            {!advanced.rules.length && <ContactEmailFilters value={emailFilters} onChange={filters => { setEmailFilters(filters); setSelected(new Set()) }} />}
            <div className="flex flex-wrap items-end gap-4">
              <div className="w-52 space-y-1">
                <Label htmlFor="filtro-tag">Tag</Label>
                <Select
                  value={tagId && !tagId.includes(":") ? tagId : "__todas"}
                  onValueChange={(v) => {
                    setAdvanced(emptyContactFilter())
                    setTagId(v === "__todas" ? null : v)
                    setSelected(new Set())
                  }}
                >
                  <SelectTrigger id="filtro-tag" aria-label="Filtrar por tag"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__todas">Todas as tags</SelectItem>
                    {tagList.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {prefs?.show_only_subscribed && !advanced.rules.length ? (
                <label className="flex h-10 cursor-pointer items-center gap-2 text-sm text-text-muted">
                  <input type="checkbox" className="size-4 accent-accent" checked={showUnsubscribed} onChange={e => { setShowUnsubscribed(e.target.checked); setSelected(new Set()) }} />
                  Mostrar descadastrados
                </label>
              ) : null}
            </div>
            {advanced.rules.length > 0 && <div className="flex flex-wrap justify-end gap-2">{segment && <Button variant="secondary" disabled={saving} onClick={() => persistSegment(true)}>Atualizar segmento</Button>}<Button variant="secondary" disabled={!!first.error || first.loading} onClick={() => setSaveOpen(true)}><Save className="size-4" aria-hidden="true" />Salvar como segmento</Button></div>}
          </div> : null}
        </section>}

        {chips.length > 0 && <div className="flex flex-wrap items-center gap-2">
          <p role="status" aria-label="Contagem do filtro" className="mr-1 text-sm text-text-muted">{first.loading ? 'Contando contatos…' : first.error ? 'Contagem indisponível' : `${base?.total ?? 0} ${(base?.total ?? 0) === 1 ? 'contato encontrado' : 'contatos encontrados'}`}</p>
          <ul aria-label="Filtros ativos" className="contents">{chips.map(c => <li key={c.key} className="flex max-w-full items-center gap-1 rounded-pill border border-border bg-surface py-0.5 pr-1 pl-3 text-sm"><span className="min-w-0 truncate">{c.label}</span><button type="button" aria-label={`Remover filtro ${c.label}`} className="shrink-0 rounded-pill p-1 text-text-muted hover:bg-border/40 hover:text-text" onClick={c.remove}><X className="size-3.5" aria-hidden="true" /></button></li>)}</ul>
          <button type="button" className="text-sm font-semibold text-link hover:underline" onClick={clearFilters}>Limpar filtros</button>
        </div>}
        {first.error ? (
          <Banner variant="danger">
            <span className="mr-3">Não consegui carregar os contatos.</span>
            <Button size="sm" variant="secondary" onClick={first.reload}>
              Tentar de novo
            </Button>
          </Banner>
        ) : (
          <DataTable
            caption="Contatos"
            columns={columns}
            rows={rows}
            getId={(c) => c.id}
            rowLabel={contactName}
            selectable={canEdit}
            selected={selected}
            onSelectedChange={setSelected}
            total={base?.total}
            hideSelectionStatus
            headRowClassName="h-[5.15rem]"
            loading={!base}
            hasMore={nextCursor !== null}
            loadingMore={loadingMore}
            onLoadMore={loadMore}
            empty={
              filtered ? (
                <EmptyState
                  title="Nenhum contato com esse filtro"
                  description="Tente outra tag ou outro nome."
                  action={
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setAdvanced(emptyContactFilter())
                        setTagId(null)
                        setSearch("")
                        setEmailFilters({})
                      }}
                    >
                      Limpar busca e filtros
                    </Button>
                  }
                />
              ) : (
                <EmptyState title="Nenhum contato ainda" description="Quem interagir com suas automações aparece aqui." />
              )
            }
          />
        )}
      </section>
      </div>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}><DialogContent><DialogHeader><DialogTitle>Salvar filtro como segmento</DialogTitle><DialogDescription>Os contatos serão selecionados novamente a cada uso.</DialogDescription></DialogHeader><Label htmlFor="segment-name">Nome do segmento</Label><Input id="segment-name" value={segmentName} maxLength={160} onChange={e => setSegmentName(e.target.value)} /><DialogFooter><Button variant="secondary" onClick={() => setSaveOpen(false)}>Cancelar</Button><Button loading={saving} disabled={!segmentName.trim() || !advanced.rules.length} onClick={() => persistSegment()}>Salvar segmento</Button></DialogFooter></DialogContent></Dialog>
      {creating && <CreateContactDialog onClose={() => setCreating(false)} onCreated={id => {
        setCreating(false); setExtra(null); setVersion(value => value + 1); openContact(id)
      }} />}
      {(importing || importId) && <ImportContactsDialog workspace={workspace} jobId={importId} onStarted={id => {
        const next = new URLSearchParams(params); next.set('import', id); setParams(next)
      }} onClose={() => {
        setImporting(false); const next = new URLSearchParams(params); next.delete('import'); setParams(next)
        setExtra(null); setVersion(value => value + 1)
      }} />}

      {cleaning ? <CleanupDialog tags={tags.data ?? tags.stale ?? []} onClose={() => setCleaning(false)} onDone={() => { setCleaning(false); setSelected(new Set()); setExtra(null); setVersion(v => v + 1) }} /> : null}
      {bulk === "copy" ? <CopyFieldDialog ids={[...selected]} fields={fields.data ?? fields.stale ?? []} onClose={() => setBulk(null)} onDone={() => { setBulk(null); setSelected(new Set()); setVersion(v => v + 1) }} /> : null}
      {bulk === "pause" || bulk === "unsubscribe" ? <BulkContactStatusDialog action={bulk} ids={[...selected]} onClose={() => setBulk(null)} onDone={() => { setBulk(null); setSelected(new Set()); setExtra(null); setVersion(v => v + 1) }} /> : bulk === "sequence" ? <BulkSequenceDialog workspace={workspace} ids={[...selected]} onClose={() => setBulk(null)} onDone={() => { setBulk(null); setSelected(new Set()); setVersion(v => v + 1) }} /> : bulk === "delete" ? <DeleteContactDialog workspace={workspace} ids={[...selected]} bulk onClose={() => setBulk(null)} onDeleted={() => {
        setBulk(null)
        setSelected(new Set())
        setExtra(null)
        setVersion(value => value + 1)
      }} /> : bulk === "add" || bulk === "remove" ? (
        <BulkTagDialog
          mode={bulk}
          ids={[...selected]}
          tags={tags.data ?? tags.stale ?? []}
          onClose={() => setBulk(null)}
          onDone={() => {
            setBulk(null)
            setSelected(new Set())
            setExtra(null)
            setVersion((v) => v + 1)
          }}
        />
      ) : null}

      {contactId ? (
        <ContactProfile
          key={contactId}
          contactId={contactId}
          onClose={() => openContact(null)}
          onChanged={() => {
            setVersion((v) => v + 1)
          }}
        />
      ) : null}
    </div>
  )
}

function BulkTagDialog({
  mode,
  ids,
  tags,
  onClose,
  onDone,
}: {
  mode: "add" | "remove"
  ids: string[]
  tags: { id: string; name: string }[]
  onClose: () => void
  onDone: () => void
}) {
  const [tag, setTag] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  async function apply() {
    setBusy(true)
    try {
      const r = await tagContacts(ids, tag, mode)
      toast.success(`${mode === "add" ? "Tag adicionada a" : "Tag removida de"} ${r.count} ${r.count === 1 ? "contato" : "contatos"}`)
      onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui aplicar a tag.")
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "add" ? "Adicionar tag" : "Remover tag"}</DialogTitle>
          <DialogDescription>
            {ids.length} {ids.length === 1 ? "contato selecionado" : "contatos selecionados"}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="bulk-tag">Tag</Label>
          <Select value={tag} onValueChange={setTag}>
            <SelectTrigger id="bulk-tag">
              <SelectValue placeholder="Escolha uma tag" />
            </SelectTrigger>
            <SelectContent>
              {tags.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={apply} disabled={!tag} loading={busy}>
            Aplicar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function fieldText(field: CustomField, value: unknown): string {
  if (value === undefined || value === null || value === "") return "—"
  if (field.type === "boolean") return value ? "Sim" : "Não"
  if (field.type === "date" && typeof value === "string") return new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString("pt-BR")
  if (field.type === "datetime" && typeof value === "string") return new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })
  if (Array.isArray(value)) return value.join(", ")
  return String(value)
}

/** Colunas de campo escolhidas ficam no navegador de quem escolheu, por espaço. */
function useShownFields(workspace: string): [string[], (ids: string[]) => void] {
  const key = `contatos-colunas:${workspace}`
  const [ids, setIds] = React.useState<string[]>(() => {
    try { const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "[]"); return Array.isArray(saved) ? saved.filter((x): x is string => typeof x === "string") : [] } catch { return [] }
  })
  return [ids, next => { setIds(next); try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* sem armazenamento: vale só nesta visita */ } }]
}
