import * as React from "react"
import { Folder, FolderPlus, Plus, Search } from "lucide-react"
import { saveSettingsFolder, deleteSettingsFolder, saveSettingsItem, deleteSettingsItem, archiveSettingsItem, getSettingsFieldUsage, type SettingsSnapshot, type SettingsKind, type SettingsItem, type SettingsFolder } from "@/data"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { Input, field } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RowMenu, RowMenuItem } from "@/components/ui/row-menu"
import { DropdownMenuCheckboxItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { SettingsCard, SettingsTabs } from "./settings-rows"

export type Action = (task: () => Promise<unknown>, success: string) => Promise<boolean>
export type Confirm = (title: string, description: string, action: () => Promise<unknown>) => void

const typeLabels = { text: "Texto", number: "Número", date: "Data", datetime: "Data e hora", boolean: "Sim ou não", array: "Lista" }
function NativeSelect(props: React.ComponentProps<"select">) { return <select {...props} className={cn(field, "h-10", props.className)} /> }

/** Campos e Tags: busca no topo, pastas em grade, tabela com seleção e menu por linha. */
export function ItemsPanel({ snapshot, kind, workspace, run, busy, confirm, scope, scopeTabs }: {
  snapshot: SettingsSnapshot; kind: SettingsKind; workspace: string; run: Action; busy: boolean; confirm: Confirm
  scope?: "contact" | "bot"; scopeTabs?: { to: string; label: string }[]
}) {
  const [search, setSearch] = React.useState("")
  const [folderId, setFolderId] = React.useState("all")
  const [status, setStatus] = React.useState("active")
  const [picked, setPicked] = React.useState<Set<string>>(new Set())
  const [itemEditor, setItemEditor] = React.useState<Partial<SettingsItem> | null>(null)
  const [folderEditor, setFolderEditor] = React.useState<Partial<SettingsFolder> | null>(null)
  const folders = snapshot.folders.filter(row => row.kind === kind)
  // Com dezenas de pastas a lista abre bem abaixo da tela: ao escolher uma pasta, a página rola até o aviso que antecede a lista.
  const folderNote = React.useRef<HTMLParagraphElement>(null)
  React.useEffect(() => { if (folderId !== "all") folderNote.current?.scrollIntoView({ block: "start", behavior: "smooth" }) }, [folderId])
  const all = snapshot.items.filter(row => row.kind === kind && (!scope || row.scope === scope))
  const rows = all.filter(row => (status === "archived" ? row.archived : !row.archived) && (folderId === "all" || row.folder_id === folderId) && row.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const singular = kind === "fields" ? "campo" : "tag"
  const title = kind === "tags" ? "Tags" : scope === "bot" ? "Campos do bot" : "Campos do usuário"
  const newLabel = kind === "tags" ? "Nova tag" : scope === "bot" ? "Novo campo do bot" : "Novo campo do usuário"
  const visiblePicked = rows.filter(row => picked.has(row.id))
  const allPicked = rows.length > 0 && visiblePicked.length === rows.length
  const requestDelete = async (row: SettingsItem) => {
    if (kind === "fields") {
      await run(async () => {
        const { automations } = await getSettingsFieldUsage(workspace, row.id)
        const warning = automations.length ? ` Usado nas automações publicadas: ${automations.map(item => item.name).join(", ")}. Excluir pode interromper esses fluxos.` : ""
        confirm("Excluir campo?", `“${row.name}” e seus valores serão removidos permanentemente.${warning}`, () => deleteSettingsItem(workspace, kind, row.id, true))
      }, "")
    } else confirm("Excluir tag?", `“${row.name}” será removida dos contatos e deste espaço de trabalho.`, () => deleteSettingsItem(workspace, kind, row.id))
  }
  const cols = kind === "fields" ? "sm:grid-cols-[2rem_minmax(0,1.75fr)_minmax(0,1fr)_minmax(0,2.4fr)_2rem]" : "sm:grid-cols-[2rem_minmax(0,1fr)_2rem]"
  const searchBox = <div className="relative w-full sm:w-52">
    <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted" />
    <Input aria-label={kind === "fields" ? "Buscar campos" : "Buscar tags"} className="pl-9" value={search} onChange={event => setSearch(event.target.value)} placeholder={kind === "fields" ? "Pesquisar por nome de campo" : "Pesquisar por nome da tag"} />
  </div>
  const archivedCount = all.filter(row => row.archived).length
  return <div className="space-y-4 lg:-mt-5">
    {scopeTabs ? <SettingsTabs label="Tipos de campo" tabs={scopeTabs} trailing={searchBox} /> : <div className="flex justify-start">{searchBox}</div>}
    <SettingsCard title={title} action={<div className="flex items-center gap-1">
      <RowMenu item={title}>
        <DropdownMenuCheckboxItem checked={status === "archived"} onCheckedChange={on => { setStatus(on ? "archived" : "active"); setPicked(new Set()) }}>Mostrar arquivados ({archivedCount})</DropdownMenuCheckboxItem>
      </RowMenu>
      <Button disabled={busy} onClick={() => setItemEditor({ folder_id: folderId === "all" ? null : folderId, scope: scope ?? "contact" })}><Plus aria-hidden="true" className="size-4" />{newLabel}</Button>
    </div>}>
      <ul aria-label="Pastas" className="grid gap-x-4 gap-y-3.5 px-4 pb-6 pt-6 sm:grid-cols-2 sm:px-6 xl:grid-cols-4">
        {folders.map(folder => <li key={folder.id} className="flex min-h-11 min-w-0 items-center rounded-md border border-border bg-surface pr-1">
          <button type="button" aria-pressed={folderId === folder.id} onClick={() => setFolderId(folderId === folder.id ? "all" : folder.id)}
            className={cn("flex min-w-0 flex-1 items-center gap-2 rounded-md px-3 py-2 text-left text-sm", folderId === folder.id && "font-semibold text-accent")}>
            <Folder aria-hidden="true" className="size-4 shrink-0 text-text-muted" /><span className="truncate" title={folder.name}>{folder.name}</span>
          </button>
          <RowMenu item={`pasta ${folder.name}`}>
            <RowMenuItem onSelect={() => setFolderEditor(folder)}>Renomear</RowMenuItem>
            <RowMenuItem className="text-danger" onSelect={() => confirm("Excluir pasta?", "Os itens desta pasta serão mantidos em Sem pasta.", async () => { await deleteSettingsFolder(workspace, kind, folder.id); if (folderId === folder.id) setFolderId("all") })}>Excluir</RowMenuItem>
          </RowMenu>
        </li>)}
        <li><button type="button" disabled={busy} onClick={() => setFolderEditor({})} className="flex min-h-11 w-full items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-text-muted hover:text-text"><FolderPlus aria-hidden="true" className="size-4" />Nova pasta</button></li>
      </ul>
      {folderId !== "all" && folders.some(folder => folder.id === folderId) ? <p ref={folderNote} role="status" className="flex flex-wrap items-center gap-x-3 border-t border-border px-4 py-2 text-sm text-text-muted scroll-mt-20 sm:px-6">Mostrando só a pasta <strong className="font-semibold text-text">{folders.find(folder => folder.id === folderId)?.name}</strong>.
        <button type="button" onClick={() => setFolderId("all")} className="font-semibold text-link hover:underline">Mostrar todas</button></p> : null}
      {status === "archived" ? <p role="status" className="border-t border-border px-4 py-2 text-sm text-text-muted sm:px-6">Mostrando só os {kind === "fields" ? "campos" : "tags"} arquivados.</p> : null}
      {visiblePicked.length > 0 ? <div className="flex items-center gap-3 border-t border-border px-4 py-2 sm:px-6">
        <p className="text-sm text-text-muted" aria-live="polite">{visiblePicked.length} selecionados</p>
        <Button size="sm" variant="secondary" disabled={busy} className="ml-auto"
          onClick={() => void run(async () => { for (const row of visiblePicked) await archiveSettingsItem(workspace, kind, row.id, !row.archived); setPicked(new Set()) }, status === "archived" ? "Itens desarquivados." : "Itens arquivados.")}>
          {status === "archived" ? "Desarquivar" : "Arquivar"} selecionados ({visiblePicked.length})</Button></div> : null}
      {rows.length === 0 ? <div className="border-t border-border p-6"><EmptyState title={`Nenhum ${singular} encontrado`} description="Crie um item ou ajuste a busca e a pasta." action={<Button variant="secondary" onClick={() => { setSearch(""); setFolderId("all"); setStatus("active"); setPicked(new Set()) }}>Limpar filtros</Button>} /></div>
        : <div>
          <div className={cn("hidden items-center gap-4 border-b border-border px-4 py-4 text-sm font-semibold sm:grid sm:px-6", cols)}>
            <Checkbox aria-label={`Selecionar todos os ${kind === "fields" ? "campos" : "tags"}`} checked={allPicked ? true : visiblePicked.length ? "indeterminate" : false} onCheckedChange={on => setPicked(on ? new Set(rows.map(row => row.id)) : new Set())} />
            <span>Nome</span>{kind === "fields" ? <><span>Tipo</span><span>Descrição</span></> : null}<span />
          </div>
          <ul>{rows.map(row => {
            const folderName = folders.find(folder => folder.id === row.folder_id)?.name ?? "Sem pasta"
            return <li key={row.id} className={cn("grid items-center gap-x-4 gap-y-1 border-b border-border px-4 last:border-b-0 sm:px-6", kind === "fields" ? "py-3.5" : "py-1.5", cols)}>
              <Checkbox aria-label={`Selecionar ${singular} ${row.name}`} checked={picked.has(row.id)} onCheckedChange={on => setPicked(current => { const next = new Set(current); if (on) next.add(row.id); else next.delete(row.id); return next })} />
              <p className="min-w-0 break-words text-sm">{row.name}</p>
              {kind === "fields" ? <>
                <p className="text-sm">{typeLabels[row.field_type]}</p>
                <button type="button" aria-label={`${row.description ? "Editar" : "Adicionar"} descrição de ${row.name}`} onClick={() => setItemEditor(row)} className="min-w-0 truncate text-left text-sm text-text-muted hover:text-text">{row.description || "Adicionar descrição"}</button>
              </> : null}
              <RowMenu item={`${singular} ${row.name}`}>
                <DropdownMenuLabel>{kind === "tags" ? `${row.contact_count} ${row.contact_count === 1 ? "contato" : "contatos"} · ` : ""}{folderName}</DropdownMenuLabel>
                <RowMenuItem onSelect={() => setItemEditor(row)}>Editar</RowMenuItem>
                <RowMenuItem onSelect={() => void run(() => archiveSettingsItem(workspace, kind, row.id, !row.archived), row.archived ? "Item desarquivado." : "Item arquivado.")}>{row.archived ? "Desarquivar" : "Arquivar"}</RowMenuItem>
                <RowMenuItem className="text-danger" onSelect={() => void requestDelete(row)}>Excluir</RowMenuItem>
              </RowMenu>
            </li>
          })}</ul>
        </div>}
    </SettingsCard>
    {folderEditor && <Dialog open onOpenChange={open => !open && setFolderEditor(null)}><DialogContent>
      <DialogHeader><DialogTitle>{folderEditor.id ? "Renomear pasta" : "Nova pasta"}</DialogTitle><DialogDescription>Organize seus {kind === "fields" ? "campos" : "marcadores"} em grupos.</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={async event => { event.preventDefault(); const name = String(new FormData(event.currentTarget).get("name")); if (await run(() => saveSettingsFolder(workspace, kind, name, folderEditor.id), "Pasta salva.")) setFolderEditor(null) }}>
        <div className="space-y-2"><Label htmlFor="folder-name">Nome da pasta</Label><Input id="folder-name" name="name" required maxLength={120} defaultValue={folderEditor.name} /></div>
        <DialogFooter><Button variant="secondary" type="button" onClick={() => setFolderEditor(null)}>Cancelar</Button><Button type="submit" loading={busy}>Salvar pasta</Button></DialogFooter>
      </form></DialogContent></Dialog>}
    {itemEditor && <Dialog open onOpenChange={open => !open && setItemEditor(null)}><DialogContent>
      <DialogHeader><DialogTitle>{itemEditor.id ? "Editar" : "Criar"} {singular}</DialogTitle><DialogDescription>Campos e tags ficam salvos neste espaço de trabalho. O tipo e o escopo são definidos na criação.</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={async event => {
        event.preventDefault(); const form = new FormData(event.currentTarget)
        if (await run(() => saveSettingsItem(workspace, { name: String(form.get("name")), kind, folder_id: String(form.get("folder")) || null, field_type: (form.get("field_type") ?? itemEditor.field_type ?? "text") as SettingsItem["field_type"], scope: (form.get("scope") ?? itemEditor.scope ?? "contact") as SettingsItem["scope"], description: kind === "fields" ? String(form.get("description") ?? "") : undefined }, itemEditor.id), `${kind === "fields" ? "Campo salvo" : "Tag salva"}.`)) setItemEditor(null)
      }}>
        <div className="space-y-2"><Label htmlFor="item-name">Nome</Label><Input id="item-name" name="name" required maxLength={120} defaultValue={itemEditor.name} /></div>
        <div className="space-y-2"><Label htmlFor="item-folder">Pasta</Label><NativeSelect id="item-folder" name="folder" defaultValue={itemEditor.folder_id ?? ""}><option value="">Sem pasta</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</NativeSelect></div>
        {kind === "fields" && <>
          <div className="space-y-2"><Label htmlFor="item-description">Descrição</Label><Input id="item-description" name="description" maxLength={2000} defaultValue={itemEditor.description ?? ""} placeholder="Para que serve este campo" /></div>
          <div className="space-y-2"><Label htmlFor="item-type">Tipo de dado</Label><NativeSelect id="item-type" name="field_type" disabled={!!itemEditor.id} defaultValue={itemEditor.field_type ?? "text"}>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</NativeSelect></div>
          <div className="space-y-2"><Label htmlFor="item-scope">Pertence a</Label><NativeSelect id="item-scope" name="scope" disabled={!!itemEditor.id} defaultValue={itemEditor.scope ?? "contact"}><option value="contact">Cada contato</option><option value="bot">Espaço de trabalho</option></NativeSelect></div>
        </>}
        <DialogFooter><Button variant="secondary" type="button" onClick={() => setItemEditor(null)}>Cancelar</Button><Button type="submit" loading={busy}>Salvar {singular}</Button></DialogFooter>
      </form></DialogContent></Dialog>}
  </div>
}
