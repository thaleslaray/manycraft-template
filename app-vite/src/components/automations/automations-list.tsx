import * as React from "react"
import { FieldSelect } from "@/components/ui/field-select"
import { Link, useNavigate, useParams, useSearchParams } from "react-router"
import { AtSign, ChevronRight, Copy, Download, Mail, MessageCircle, MessagesSquare, Send, Folder, FolderInput, FolderOpen, List, LayoutGrid, MoreHorizontal, Pause, Pencil, Play, Plus, RotateCcw, Search, Trash2, Workflow } from "lucide-react"
import { toast } from "sonner"
import { createAutomation, deleteFolder, libraryAction, listAutomationLibrary, listFolders, moveAutomation, renameAutomation, saveFolder, setAutomationStatus,
  type AutomationRow, type FolderRow, type LibraryFilter } from "@/data"
import { useAsync } from "@/hooks/use-async"
import { automationFoldersKey, automationLibraryFilter, automationLibraryKey } from "@/data/screen-keys"
import { apiRequest } from "@/data/api"
import { timeAgo, formatPercent } from "@/lib/time"
import { FlowThumbnail } from "./flow-thumbnail"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { RowMenu, RowMenuItem } from "@/components/ui/row-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { EmptyState } from "@/components/ui/empty-state"
import { Input } from "@/components/ui/input"
import { StatusBadge } from "@/components/ui/status-badge"

import { typeAndChannel } from "../../../../shared/trigger-types"
import { AutomationTemplateDialog } from "./automation-template-dialog"
import { QuickAutomationDialog } from "./quick-automation-dialog"
import { ConvertChannelDialog } from "./convert-channel-dialog"
import { ManychatImportDialog } from "./manychat-import-dialog"
import { manychatClipboardFrom } from "@/data/manychat-import"

type Edit = { kind: "newFolder" | "renameFolder" | "moveFolder" | "deleteFolder" | "rename" | "move" | "trash" | "delete"; id?: string; name?: string }
const rowGrid = "md:grid-cols-[minmax(0,1fr)_5.5rem_5.5rem_4.5rem_4rem_7rem_2.5rem]"
const dragType = "application/x-automation-library"

function folderPath(f: FolderRow, folders: FolderRow[], seen = new Set<string>()): string {
  if (seen.has(f.id)) return f.name
  seen.add(f.id)
  const parent = folders.find(p => p.id === f.parent_id)
  return parent ? `${folderPath(parent, folders, seen)} / ${f.name}` : f.name
}

export function AutomationsList() {
  const { workspace } = useParams() as { workspace: string }
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [revision, refresh] = React.useReducer(n => n + 1, 0)
  const [templatePicker, setTemplatePicker] = React.useState(false)
  const [quick, setQuick] = React.useState(false)
  const [importing, setImporting] = React.useState(false)
  const [pasted, setPasted] = React.useState<unknown>(null)
  const catcher = React.useRef<HTMLTextAreaElement>(null)
  const [edit, setEdit] = React.useState<Edit | null>(null)
  const [name, setName] = React.useState("")
  const [destination, setDestination] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [movingItems, setMovingItems] = React.useState(false)
  const [converting, setConverting] = React.useState<string | null>(null)
  // Na Lixeira o número do botão é o da lista inteira já carregada; o da pasta pode vir de uma leitura mais velha.
  const [trashCount, setTrashCount] = React.useState<number | null>(null)
  const [dialogError, setDialogError] = React.useState<string>()
  const foldersQuery = useAsync(() => listFolders(workspace), `${workspace}|${revision}`, { cache: automationFoldersKey(workspace) })
  const folders = foldersQuery.data?.folders ?? foldersQuery.stale?.folders ?? []
  const folder = params.get("folder") ?? "all", trash = params.get("view") === "trash"
  const selectedFolder = folders.find(f => f.id === folder)
  const [layout, setLayoutState] = React.useState<"cards" | "list">(() => { try { return localStorage.getItem("automacoes-layout") === "list" ? "list" : "cards" } catch { return "cards" } })
  function setLayout(next: "cards" | "list") { setLayoutState(next); try { localStorage.setItem("automacoes-layout", next) } catch { /* sem armazenamento, só vale nesta visita */ } }
  // Na raiz, como no original, a lista traz só as automações soltas; busca e filtros varrem todas.
  const filtering = ["search", "status", "trigger_type", "trigger_status"].some(k => params.get(k))
  // "Ver todas as automações": lista tudo, de qualquer pasta (a raiz traz só as soltas).
  const showAll = params.get("view") === "all"
  const canEdit = Boolean((foldersQuery.data ?? foldersQuery.stale)?.can_edit)
  const canCreate = canEdit && !foldersQuery.loading && !trash && (folder === "all" || folder === "none" || Boolean(selectedFolder))
  // Cmd+V com blocos copiados na ManyChat (fora de campos de texto) vira automação em rascunho.
  React.useEffect(() => {
    if (!canCreate) return
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target !== catcher.current && target?.closest("input, textarea, [contenteditable=''], [contenteditable='true']")) return
      const clipboard = manychatClipboardFrom(event.clipboardData)
      if (!clipboard) return
      event.preventDefault()
      setPasted(clipboard)
    }
    // No Chrome do Mac, Cmd+V só dispara a colagem com um campo editável em foco: um campo invisível fica em foco
    // ao abrir a lista e a cada clique numa área vazia (como faz o editor da ManyChat).
    const focusCatcher = () => { if (!document.querySelector("[role=dialog]")) catcher.current?.focus({ preventScroll: true }) }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest("input, textarea, select, button, a, [role], [contenteditable], label")) return
      setTimeout(focusCatcher, 0)
    }
    if (!document.activeElement || document.activeElement === document.body) focusCatcher()
    document.addEventListener("paste", onPaste)
    document.addEventListener("pointerdown", onPointerDown)
    return () => { document.removeEventListener("paste", onPaste); document.removeEventListener("pointerdown", onPointerDown) }
  }, [canCreate])
  const filter = automationLibraryFilter(params)
  function param(key: string, value: string) {
    setParams(previous => { const next = new URLSearchParams(previous); if (value) next.set(key, value); else next.delete(key); return next }, { replace: true })
  }
  function openFolder(id: string, isTrash = false) {
    if (trash && !isTrash) { setTrashCount(null); refresh() }
    setParams(previous => {
      const next = new URLSearchParams(previous)
      next.delete("search"); next.delete("folder"); next.delete("view")
      if (isTrash) next.set("view", "trash")
      else if (id !== "all") next.set("folder", id)
      return next
    })
  }
  function openEdit(next: Edit) {
    setEdit(next); setName(next.name ?? ""); setDialogError(undefined)
    setDestination(next.kind === "moveFolder" ? folders.find(f => f.id === next.id)?.parent_id ?? "" : "")
  }
  async function run(operation: () => Promise<unknown>, message: string) {
    setBusy(true)
    try { await operation(); refresh(); toast.success(message); return true }
    catch (error) { toast.error(error instanceof Error ? error.message : "Não foi possível concluir. Tente novamente."); return false }
    finally { setBusy(false) }
  }
  async function create() {
    if (!canCreate) return
    setBusy(true)
    try {
      const a = await createAutomation(workspace, "Nova automação", selectedFolder?.id ?? null)
      navigate(`/${workspace}/automations/${a.id}`)
    } catch (error) { toast.error(error instanceof Error ? error.message : "Não consegui criar a automação."); setBusy(false) }
  }
  async function submit(event: { preventDefault(): void }, moveItems = false) {
    event.preventDefault()
    if (!edit) return
    setBusy(true); setDialogError(undefined)
    try {
      if (edit.kind === "newFolder") await saveFolder(workspace, { name: name.trim(), parent_id: selectedFolder?.id ?? null })
      if (edit.kind === "renameFolder") await saveFolder(workspace, { name: name.trim() }, edit.id)
      if (edit.kind === "moveFolder") await saveFolder(workspace, { parent_id: destination || null }, edit.id)
      if (edit.kind === "deleteFolder") await deleteFolder(edit.id!, moveItems)
      if (edit.kind === "rename") await renameAutomation(edit.id!, name.trim())
      if (edit.kind === "move") await moveAutomation(edit.id!, destination || null)
      if (edit.kind === "trash" || edit.kind === "delete") await libraryAction(edit.id!, edit.kind)
      setEdit(null); refresh(); toast.success("Alteração salva")
    } catch (error) { setDialogError(error instanceof Error ? error.message : "Não consegui salvar. Tente novamente.") }
    finally { setBusy(false) }
  }
  function drag(event: React.DragEvent, kind: "folder" | "automation", id: string) {
    event.dataTransfer.setData(dragType, JSON.stringify({ kind, id })); event.dataTransfer.effectAllowed = "move"
  }
  async function drop(event: React.DragEvent, target: string | null) {
    event.preventDefault()
    if (busy || !canEdit) return
    try {
      const item = JSON.parse(event.dataTransfer.getData(dragType)) as { kind: string; id: string }
      if (item.kind === "folder" && item.id !== target) await run(() => saveFolder(workspace, { parent_id: target }, item.id), "Pasta movida")
      else if (item.kind === "automation") await run(() => moveAutomation(item.id, target), "Automação movida")
    } catch { /* Arrastes de fora da biblioteca não alteram o conteúdo. */ }
  }
  const dropProps = (id: string | null) => ({
    onDragOver: (event: React.DragEvent) => { if (event.dataTransfer.types.includes(dragType)) { event.preventDefault(); event.dataTransfer.dropEffect = "move" } },
    onDrop: (event: React.DragEvent) => void drop(event, id),
  })
  const breadcrumb: FolderRow[] = []
  let current = selectedFolder
  while (current && !breadcrumb.some(f => f.id === current!.id)) { breadcrumb.unshift(current); current = folders.find(f => f.id === current!.parent_id) }
  const childFolders = folders.filter(f => f.parent_id === (selectedFolder?.id ?? null))
  const movingFolder = edit?.kind === "moveFolder" ? edit.id : undefined
  const destinations = folders.filter(f => {
    let current: FolderRow | undefined = f
    const seen = new Set<string>()
    while (current && !seen.has(current.id)) {
      if (current.id === movingFolder) return false
      seen.add(current.id); current = folders.find(p => p.id === current!.parent_id)
    }
    return true
  })
  const title = !edit ? "" : ({ newFolder: "Criar pasta", renameFolder: "Renomear pasta", moveFolder: "Mover pasta", deleteFolder: "Excluir pasta", rename: "Renomear automação", move: "Mover automação", trash: "Enviar à lixeira", delete: "Excluir definitivamente" })[edit.kind]
  const saveLabel = !edit ? "" : ({ newFolder: "Salvar pasta", renameFolder: "Salvar pasta", moveFolder: "Mover pasta", deleteFolder: "Confirmar exclusão da pasta", rename: "Salvar nome", move: "Mover automação", trash: "Confirmar envio à lixeira", delete: "Confirmar exclusão definitiva" })[edit.kind]
  const deletingFolder = edit?.kind === "deleteFolder" ? folders.find(f => f.id === edit.id) : undefined
  const subfolderCount = deletingFolder ? folders.filter(f => f.parent_id === deletingFolder.id).length : 0
  const folderHasItems = Boolean(deletingFolder && (deletingFolder.count > 0 || subfolderCount > 0))
  const folderContent = [deletingFolder?.count ? `${deletingFolder.count} ${deletingFolder.count === 1 ? "automação" : "automações"}` : "", subfolderCount ? `${subfolderCount} ${subfolderCount === 1 ? "subpasta" : "subpastas"}` : ""].filter(Boolean).join(" e ")
  const editsName = edit && ["newFolder", "renameFolder", "rename"].includes(edit.kind)
  const editsDestination = edit && ["moveFolder", "move"].includes(edit.kind)
  return (
    <section aria-label="Lista de automações" className="min-w-0 space-y-6">
      <textarea ref={catcher} aria-hidden="true" tabIndex={-1} value="" onChange={() => undefined} className="pointer-events-none fixed top-0 left-0 size-px opacity-0" data-testid="manychat-paste-catcher" />
      {converting ? <ConvertChannelDialog automationId={converting} onClose={() => setConverting(null)} /> : null}
      {quick ? <QuickAutomationDialog workspace={workspace} onClose={() => setQuick(false)} /> : null}
      {templatePicker ? <AutomationTemplateDialog workspace={workspace} folderId={selectedFolder?.id ?? null} blankBusy={busy} onBlank={create} onQuick={() => { setTemplatePicker(false); setQuick(true) }} onImport={() => { setTemplatePicker(false); setImporting(true) }} onClose={() => setTemplatePicker(false)} /> : null}
      {pasted ? <ManychatImportDialog workspace={workspace} folders={[]} folderId={selectedFolder?.id ?? null} pasted={pasted} onImported={refresh} onClose={() => setPasted(null)} /> : null}
      {importing ? <ManychatImportDialog workspace={workspace} folders={folders.map(f => ({ id: f.id, label: folderPath(f, folders) }))} folderId={selectedFolder?.id ?? null} onImported={refresh} onClose={() => setImporting(false)} /> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Pastas" className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
          {!selectedFolder && !trash ? <h2 className="text-xl font-bold" {...dropProps(null)}>{showAll ? "Todas as automações" : folder === "none" ? "Sem pasta" : "Minhas automações"}</h2> : <>
            <button className="rounded-sm text-text-muted hover:text-text hover:underline" onClick={() => openFolder("all")} {...dropProps(null)}>Minhas automações</button>
            {breadcrumb.map((f, i) => <React.Fragment key={f.id}>
              <ChevronRight className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
              {i < breadcrumb.length - 1 || trash
                ? <button className="max-w-40 truncate rounded-sm text-text-muted hover:text-text hover:underline" onClick={() => openFolder(f.id)} {...dropProps(f.id)}>{f.name}</button>
                : <h2 className="flex min-w-0 items-center gap-1.5 text-xl font-bold"><span className="max-w-56 truncate border-b border-border">{f.name}</span>{canEdit ? <button aria-label={`Renomear pasta ${f.name}`} className="grid size-6 place-items-center rounded-sm text-text-muted hover:text-text" onClick={() => openEdit({ kind: "renameFolder", id: f.id, name: f.name })}><Pencil className="size-4" aria-hidden="true" /></button> : null}</h2>}
            </React.Fragment>)}
            {trash ? <><ChevronRight className="size-4 shrink-0 text-text-muted" aria-hidden="true" /><h2 className="text-xl font-bold">Lixeira</h2></> : null}
          </>}
        </nav>
        {!trash && canEdit ? <div className="flex flex-wrap items-center gap-2"><Button variant="secondary" onClick={() => setImporting(true)} disabled={!canCreate}><Download className="size-4" />Importar da ManyChat</Button><Button onClick={() => setTemplatePicker(true)} loading={busy} disabled={!canCreate}><Plus className="size-4" />Nova automação</Button></div> : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative min-w-0"><Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-text-muted" aria-hidden="true" /><Input aria-label="Buscar automação" placeholder={selectedFolder ? "Pesquisar na pasta" : "Pesquisar todas as automações"} value={params.get("search") ?? ""} onChange={e => param("search", e.target.value)} className="h-9 pl-9" /></div>
        <FilterSelect label="Tipo de gatilho" value={params.get("trigger_type") ?? ""} onChange={v => param("trigger_type", v)} all="Qualquer gatilho" options={[["dm_keyword","Palavra-chave"],["ig_comment","Comentário"],["ig_story_reply","Resposta a story"],["ig_story_mention","Menção em story"],["welcome","Boas-vindas"],["default_reply","Resposta padrão"],["ref_url","Link de referência"],["ig_live_comment","Comentário em live"],["ig_share_to_dm","Compartilhamento em story"],["api","Entrada externa"]]} />
        <FilterSelect label="Estado do gatilho" value={params.get("trigger_status") ?? ""} onChange={v => param("trigger_status", v)} all="Estados do gatilho" options={[["active","Ativo"],["inactive","Desligado"],["draft","Rascunho"],["initial","Inicial"]]} />
      </div>
      {foldersQuery.error ? <Banner variant="danger">Não consegui carregar as pastas. <Button variant="link" onClick={foldersQuery.reload}>Tentar de novo</Button></Banner> : null}
      {!trash && folder !== "none" ? <div className="grid grid-cols-1 gap-x-3 gap-y-4 min-[520px]:grid-cols-2 sm:grid-cols-3 xl:grid-cols-4" aria-label="Pastas de automações">
        {childFolders.map(f => <div key={f.id} className="group relative flex min-w-0 items-center rounded-lg border border-border bg-surface shadow-sm" title={`${f.count} ${f.count === 1 ? "automação" : "automações"}`} {...dropProps(f.id)}>
          <button className="flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 text-left text-sm font-medium" aria-label={`Abrir pasta ${f.name}`} draggable={canEdit} onDragStart={e => drag(e, "folder", f.id)} onClick={() => openFolder(f.id)}><Folder className="size-4 shrink-0 text-accent" /><span className="truncate">{f.name}</span></button>
          {canEdit ? <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="absolute top-1 right-1 h-8 shrink-0 bg-surface px-1.5 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100" aria-label={`Ações da pasta ${f.name}`} disabled={busy}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent>
            <DropdownMenuItem onSelect={() => openEdit({ kind: "renameFolder", id: f.id, name: f.name })}><Pencil className="size-4" />Renomear</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openEdit({ kind: "moveFolder", id: f.id, name: f.name })}><FolderInput className="size-4" />Mover</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openEdit({ kind: "deleteFolder", id: f.id, name: f.name })}><Trash2 className="size-4" />Excluir pasta</DropdownMenuItem>
          </DropdownMenuContent></DropdownMenu> : null}
        </div>)}
        {canEdit ? <button className="flex h-10 items-center justify-center gap-2 rounded-lg border border-dashed border-accent px-3 text-sm font-medium text-accent hover:bg-accent-soft" onClick={() => openEdit({ kind: "newFolder" })} disabled={busy || !canCreate}><Plus className="size-4" />Nova pasta</button> : null}
      </div> : null}
      <div className="-mt-3 flex justify-end gap-1">
        {!trash && !selectedFolder ? <Button variant="ghost" size="sm" className="h-7 text-xs text-accent" aria-pressed={folder === "none"} onClick={() => openFolder(folder === "none" ? "all" : "none")} {...dropProps(null)}><FolderOpen className="size-4" />Sem pasta</Button> : null}
        <Button variant="ghost" size="sm" className="h-7 text-xs text-accent" onClick={() => openFolder("all", !trash)} aria-label={trash ? "Voltar às automações" : "Lixeira"}>{trash ? <FolderOpen className="size-4" /> : <Trash2 className="size-4" />}{trash ? "Voltar às automações" : "Lixeira"}{!trash && (trashCount ?? foldersQuery.data?.trashed) ? <span>{trashCount ?? foldersQuery.data?.trashed}</span> : null}</Button>
      </div>
      <div className="flex items-center justify-end gap-4 pt-3 pb-4">
        <FilterSelect label="Filtrar por status" compact value={params.get("status") ?? ""} onChange={v => param("status", v)} all="Todos os status" options={[["live","Ao vivo"],["stopped","Parada"],["draft","Rascunho"]]} />
        <button className="flex items-center gap-1.5 rounded-sm text-xs text-text-muted hover:text-text" aria-pressed={layout === "list"} onClick={() => setLayout(layout === "list" ? "cards" : "list")}>{layout === "list" ? <LayoutGrid className="size-4" aria-hidden="true" /> : <List className="size-4" aria-hidden="true" />}{layout === "list" ? "Visualização em cartões" : "Visualização no formato de lista"}</button>
      </div>
      {trash ? <Banner className="bg-accent-soft">Restaurar mantém gatilhos e palavras-chave desligados. A exclusão definitiva não pode ser desfeita.</Banner> : null}
      <LibraryRows key={`${workspace}|${params}|${revision}`} workspace={workspace} filter={filter} layout={layout} root={folder === "all" && !filtering && !showAll && !trash} hasFolders={childFolders.length > 0} busy={busy} canEdit={canEdit} onEdit={openEdit} onDrag={drag} onTrashCount={setTrashCount} onConvert={setConverting}
        onAction={(a, action) => void run(() => libraryAction(a.id, action), action === "duplicate" ? "Cópia criada com gatilhos desligados" : "Automação restaurada com gatilhos desligados")}
        onStatus={a => void run(() => setAutomationStatus(a.id, a.status === "stopped" ? "live" : "stopped"), a.status === "stopped" ? "Automação retomada" : "Automação pausada")}
        onReset={showAll && !filtering && folder === "all" ? undefined : () => setParams({ view: "all" })} />
      <Dialog open={edit !== null} onOpenChange={open => { if (!open && !busy) setEdit(null) }}>
        <DialogContent><form onSubmit={submit} className="space-y-5">
          <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{edit?.kind === "trash" ? "Os gatilhos e as palavras-chave serão desligados. Você pode restaurar a automação depois." : edit?.kind === "delete" ? `“${edit.name}” será removida permanentemente. Esta ação não pode ser desfeita.` : edit?.kind === "deleteFolder" ? (folderHasItems ? `“${edit.name}” tem ${folderContent}. Para excluir a pasta, mova esse conteúdo antes, ou deixe que ele vá para Sem pasta.` : `“${edit.name}” está vazia e será excluída.`) : "Organize suas automações. A alteração fica salva no seu espaço."}</DialogDescription></DialogHeader>
          {editsName ? <label className="grid gap-2 text-sm font-semibold">{edit.kind === "rename" ? "Nome da automação" : "Nome da pasta"}<Input required maxLength={100} value={name} onChange={e => setName(e.target.value)} /></label> : null}
          {editsDestination ? <FieldSelect id="folder-destination" label="Pasta de destino" value={destination} none={edit.kind === "moveFolder" ? "Nível principal" : "Sem pasta"} options={destinations.map(f => ({ value: f.id, label: folderPath(f, folders) }))} onChange={setDestination} /> : null}
          {dialogError ? <p role="alert" className="text-sm text-danger">{dialogError}</p> : null}
          <DialogFooter><Button type="button" variant="secondary" disabled={busy} onClick={() => setEdit(null)}>Cancelar</Button><Button type="submit" variant={edit?.kind === "delete" || edit?.kind === "trash" || edit?.kind === "deleteFolder" ? "danger" : "primary"} disabled={Boolean(editsName && !name.trim()) || folderHasItems} loading={busy && !movingItems}>{saveLabel}</Button>{edit?.kind === "deleteFolder" && (folderHasItems || dialogError) ? <Button type="button" variant="danger" disabled={busy} loading={busy && movingItems} onClick={event => { setMovingItems(true); void submit(event, true).finally(() => setMovingItems(false)) }}>Mover itens para Sem pasta e excluir</Button> : null}</DialogFooter>
        </form></DialogContent>
      </Dialog>
    </section>
  )
}

function FilterSelect({ label, value, onChange, all, options, compact }: { label: string; value: string; onChange: (value: string) => void; all: string; options: [string, string][]; compact?: boolean }) {
  return <Select value={value || "all"} onValueChange={v => onChange(v === "all" ? "" : v)}>
    <SelectTrigger aria-label={label} className={compact ? "h-7 w-auto gap-1 border-transparent bg-transparent px-1 text-xs text-text-muted hover:border-transparent hover:text-text" : "h-9"}><SelectValue /></SelectTrigger>
    <SelectContent><SelectItem value="all">{all}</SelectItem>{options.map(([v, t]) => <SelectItem key={v} value={v}>{t}</SelectItem>)}</SelectContent>
  </Select>
}

function LibraryRows({ workspace, filter, layout, root, hasFolders, busy, canEdit, onEdit, onAction, onStatus, onDrag, onReset, onTrashCount, onConvert }: {
  workspace: string; filter: LibraryFilter; layout: "cards" | "list"; root: boolean; hasFolders: boolean; busy: boolean; canEdit: boolean; onEdit: (edit: Edit) => void
  onAction: (a: AutomationRow, action: "duplicate" | "restore") => void; onStatus: (a: AutomationRow) => void
  onDrag: (event: React.DragEvent, kind: "automation", id: string) => void; onReset?: () => void; onTrashCount?: (count: number) => void; onConvert: (id: string) => void
}) {
  // Volta à lista e abertura pelo menu sem esqueleto. Depois de uma gravação, data/api descarta este cache antes de a lista remontar.
  const first = useAsync(() => listAutomationLibrary(workspace, filter), "first", { cache: automationLibraryKey(workspace, filter) })
  const [more, setMore] = React.useState<AutomationRow[]>([])
  const [next, setNext] = React.useState<string | null | undefined>()
  const [loadingMore, setLoadingMore] = React.useState(false)
  const cursor = next === undefined ? first.data?.next_cursor : next
  async function loadMore() {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    try { const page = await listAutomationLibrary(workspace, filter, cursor); setMore(previous => [...previous, ...page.items]); setNext(page.next_cursor) }
    catch (error) { toast.error(error instanceof Error ? error.message : "Não consegui carregar mais automações.") }
    finally { setLoadingMore(false) }
  }
  const rows = [...(first.data?.items ?? []), ...more]
  const countReady = Boolean(filter.trash && first.data && !cursor && !filter.search && !filter.status && !filter.trigger_type && !filter.trigger_status)
  React.useEffect(() => { if (countReady) onTrashCount?.(rows.length) }, [countReady, rows.length]) // eslint-disable-line react-hooks/exhaustive-deps
  if (first.error) return <Banner variant="danger">Não consegui carregar as automações. <Button variant="link" onClick={first.reload}>Tentar de novo</Button></Banner>
  if (!first.loading && rows.length === 0) {
    if (root && hasFolders) return <p className="py-6 text-center text-sm text-text-muted">Nenhuma automação solta aqui. Abra uma pasta ou crie uma nova.</p>
    return <EmptyState title={filter.trash ? "A lixeira está vazia" : "Nada encontrado"} description={filter.trash ? "As automações excluídas aparecem aqui." : "Nenhuma automação corresponde a esta pasta ou aos filtros."} action={onReset ? <Button variant="secondary" onClick={onReset}>Ver todas as automações</Button> : undefined} />
  }
  const menu = (a: AutomationRow) => canEdit ? <RowMenu item={a.name}>
    {filter.trash ? <>
      <RowMenuItem disabled={busy} onSelect={() => onAction(a, "restore")}><RotateCcw className="size-4" />Restaurar</RowMenuItem>
      <RowMenuItem disabled={busy} className="text-danger" onSelect={() => onEdit({ kind: "delete", id: a.id, name: a.name })}><Trash2 className="size-4" />Excluir definitivamente</RowMenuItem>
    </> : <>
      {a.published_version_id ? <RowMenuItem disabled={busy} onSelect={() => onStatus(a)}>{a.status === "stopped" ? <Play className="size-4" /> : <Pause className="size-4" />}{a.status === "stopped" ? "Retomar" : "Pausar"}</RowMenuItem> : null}
      <RowMenuItem onSelect={() => onEdit({ kind: "rename", id: a.id, name: a.name })}><Pencil className="size-4" />Renomear</RowMenuItem>
      <RowMenuItem onSelect={() => onAction(a, "duplicate")}><Copy className="size-4" />Duplicar</RowMenuItem>
      <RowMenuItem onSelect={() => void copyToAccount(a.id)}><Copy className="size-4" />Duplicar para outra conta</RowMenuItem>
      <RowMenuItem onSelect={() => onConvert(a.id)}><Copy className="size-4" />Duplicar e converter para outro canal</RowMenuItem>
      <RowMenuItem onSelect={() => onEdit({ kind: "move", id: a.id, name: a.name })}><FolderInput className="size-4" />Mover</RowMenuItem>
      <RowMenuItem className="text-danger" onSelect={() => onEdit({ kind: "trash", id: a.id, name: a.name })}><Trash2 className="size-4" />Enviar à lixeira</RowMenuItem>
    </>}
  </RowMenu> : null
  if (layout === "cards") return <div className="space-y-3">
    <ul aria-label="Automações" className="grid grid-cols-1 gap-4 min-[520px]:grid-cols-2 sm:grid-cols-3 xl:grid-cols-4">
      {first.loading ? Array.from({ length: 8 }).map((_, i) => <li key={i}><Skeleton className="h-44 w-full rounded-lg" /></li>) : rows.map(a => {
        const gatilho = a.trigger_type ? `${typeAndChannel(a.trigger_type, a.trigger_channel)}${a.trigger_count > 1 ? ` +${a.trigger_count - 1}` : ""} · ${a.trigger_summary}` : a.trigger_summary
        const thumb = <>
          {a.flow_preview ? <FlowThumbnail preview={a.flow_preview} /> : a.trigger_type
            ? <span className="flex w-full min-w-0 items-start gap-1.5 rounded-md border border-border bg-surface px-2 py-1.5 text-left text-2xs leading-snug text-text-muted shadow-sm"><ChannelIcon kind={a.trigger_channel} /><span className="line-clamp-3 min-w-0">{gatilho}</span></span>
            : <><Workflow className="size-6 text-text-muted/60" aria-hidden="true" /><span className="mt-1 text-2xs text-text-muted">{a.trigger_summary}</span></>}
          {a.has_unpublished_changes ? <span className="mt-1 text-2xs text-warning">Alterações não publicadas</span> : null}
        </>
        const thumbClass = "flex h-[8.5rem] w-full flex-col items-center justify-center bg-bg px-3"
        return <li key={a.id} className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface shadow-sm" draggable={canEdit && !filter.trash} onDragStart={e => onDrag(e, "automation", a.id)}>
          {filter.trash ? <div className={thumbClass}>{thumb}</div> : <Link to={`/${workspace}/automations/${a.id}`} aria-hidden="true" tabIndex={-1} draggable={false} className={thumbClass}>{thumb}</Link>}
          <div className="flex min-w-0 items-center gap-2 py-1.5 pr-1 pl-3">
            <StatusDot status={a.status} />
            {filter.trash ? <span className="min-w-0 flex-1 truncate text-sm font-bold" title={a.name}>{a.name}</span> : <Link to={`/${workspace}/automations/${a.id}`} title={a.name} className="min-w-0 flex-1 truncate text-sm font-bold text-text hover:underline">{a.name}</Link>}
            {menu(a)}
          </div>
        </li>
      })}
    </ul>
    {cursor && !first.loading ? <Button variant="link" onClick={loadMore} loading={loadingMore}>Carregar mais</Button> : null}
  </div>
  return <div className="space-y-3">
    <div role="table" aria-label="Automações" className="space-y-2">
      <div role="rowgroup">
        <div role="row" className={cn("hidden px-4 pb-1 text-xs font-semibold text-text-muted md:grid md:items-center md:gap-x-3", rowGrid)}>
          <div role="columnheader">Automação</div>
          <div role="columnheader" className="text-right">Execuções</div>
          <div role="columnheader" className="text-right">Entregues</div>
          <div role="columnheader" className="text-right">Lidas</div>
          <div role="columnheader" className="text-right">CTR</div>
          <div role="columnheader">Editado</div>
          <div role="columnheader"><span className="sr-only">Ações</span></div>
        </div>
      </div>
      <div role="rowgroup" className="space-y-2">
        {first.loading ? Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />) : rows.map(a => <div role="row" key={a.id} className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg border border-border bg-surface px-4 py-3 shadow-sm md:gap-x-3", rowGrid)}>
          <div role="cell" className="min-w-0">
            <div className="flex min-w-0 flex-col items-start gap-1 md:flex-row md:gap-3">
              <StatusBadge status={a.status} className="mt-0.5 shrink-0" />
              <div className="w-full min-w-0">
                {filter.trash ? <span className="block truncate font-semibold" title={a.name}>{a.name}</span> : <Link to={`/${workspace}/automations/${a.id}`} draggable={canEdit} onDragStart={e => onDrag(e, "automation", a.id)} title={a.name} className="block truncate font-semibold text-text hover:underline">{a.name}</Link>}
                <p className="flex min-w-0 items-center gap-1 text-xs text-text-muted" title={a.trigger_summary}>
                  <ChannelIcon kind={a.trigger_channel} />
                  <span className="truncate">{a.trigger_type ? `${typeAndChannel(a.trigger_type, a.trigger_channel)}${a.trigger_count > 1 ? ` +${a.trigger_count - 1}` : ""} · ` : ""}{a.trigger_summary}</span>
                  {a.has_unpublished_changes ? <span className="shrink-0 text-warning">· Alterações não publicadas</span> : null}
                </p>
                <p className="mt-1 text-2xs text-text-muted md:hidden">Execuções {a.runs.toLocaleString("pt-BR")} · Entregues {a.delivered ?? 0} · Lidas {a.read ?? 0} · CTR {formatPercent(a.ctr)}</p>
              </div>
            </div>
          </div>
          <div role="cell" className="hidden text-right text-sm tabular-nums md:block">{a.runs.toLocaleString("pt-BR")}</div>
          <div role="cell" className="hidden text-right text-sm tabular-nums md:block">{(a.delivered ?? 0).toLocaleString("pt-BR")}</div>
          <div role="cell" className="hidden text-right text-sm tabular-nums md:block">{(a.read ?? 0).toLocaleString("pt-BR")}</div>
          <div role="cell" className="hidden text-right text-sm tabular-nums md:block">{formatPercent(a.ctr)}</div>
          <div role="cell" className="hidden whitespace-nowrap text-sm text-text-muted md:block">{timeAgo(a.updated_at)}</div>
          {canEdit ? <div role="cell" className="flex justify-end">{menu(a)}</div> : null}
        </div>)}
      </div>
    </div>
    {cursor && !first.loading ? <Button variant="link" onClick={loadMore} loading={loadingMore}>Carregar mais</Button> : null}
  </div>
}

/** Ponto de estado do cartão; o texto fica para leitores de tela. */
function StatusDot({ status }: { status: AutomationRow["status"] }) {
  const label = { live: "Ao vivo", stopped: "Parada", draft: "Rascunho", error: "Com erro" }[status]
  const color = { live: "bg-success", stopped: "bg-text-muted/50", draft: "bg-warning", error: "bg-danger" }[status]
  return <span className="inline-flex shrink-0 items-center" title={label}><span aria-hidden="true" className={cn("size-2 rounded-full", color)} /><span className="sr-only">{label}</span></span>
}

/** Ícone do canal da automação (o primeiro gatilho decide); sem conexão, nada. */
function ChannelIcon({ kind }: { kind?: string | null }) {
  const Icon = kind === "instagram" ? AtSign : kind === "whatsapp" ? MessageCircle : kind === "telegram" ? Send : kind === "messenger" ? MessagesSquare : kind === "email" ? Mail : null
  return Icon ? <Icon className="size-4 shrink-0 text-text-muted" aria-hidden="true" /> : null
}

/** Duplicar para outra conta do usuário (rascunho no destino). Pergunta a conta pelo nome quando há mais de uma. */
async function copyToAccount(id: string) {
  try {
    const { current, items } = await apiRequest<{ current: string; items: { id: string; name: string }[] }>("/workspaces/mine")
    const others = items.filter(w => w.id !== current)
    if (!others.length) { toast.error("Você não participa de outra conta."); return }
    const answer = others.length === 1 ? others[0].name : window.prompt(`Copiar para qual conta?\n${others.map(w => w.name).join("\n")}`, others[0].name)
    const target = others.find(w => w.name === answer)
    if (!target) return
    await apiRequest(`/automations/${encodeURIComponent(id)}/copy-to`, { method: "POST", body: JSON.stringify({ workspace_id: target.id }) })
    toast.success(`Cópia criada em rascunho na conta ${target.name}.`)
  } catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível copiar.") }
}
