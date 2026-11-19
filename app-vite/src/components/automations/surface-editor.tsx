import * as React from "react"
import { useParams } from "react-router"
import { GripVertical, List, MessageCircleQuestion, Plus, Smartphone } from "lucide-react"
import { listAutomations } from "@/data"
import { getSurface, publishSurface, saveSurface, type BasicConnection, type SurfaceConfig, type SurfaceKind } from "@/data/basic"
import { useAsync } from "@/hooks/use-async"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PanelFooterBar } from "@/components/ui/panel-footer-bar"
import { RowMenu, RowMenuItem } from "@/components/ui/row-menu"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { AutomationPicker } from "./automation-picker"

export const surfaceDefinitions = [
  { kind: "conversation_starters" as const, title: "Iniciadores de conversa", icon: MessageCircleQuestion, description: "Ofereça perguntas para quem está começando uma conversa." },
  { kind: "main_menu" as const, title: "Menu principal", icon: List, description: "Deixe os caminhos mais úteis sempre ao alcance do contato." },
]
export function surfaceCap(connection: BasicConnection, kind: SurfaceKind) {
  return kind === "conversation_starters" ? connection.profile.conversationStarters : connection.profile.mainMenu
}

export function SurfaceEditor({ connection, kind, onClose }: { connection: BasicConnection; kind: SurfaceKind; onClose: () => void }) {
  const { workspace } = useParams() as { workspace: string }
  const data = useAsync(() => getSurface(connection.id, kind), `${connection.id}:${kind}`)
  const automations = useAsync(() => listAutomations(workspace), workspace)
  const [draft, setDraft] = React.useState<SurfaceConfig | null>(null)
  const [saved, setSaved] = React.useState<SurfaceConfig | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [dragFrom, setDragFrom] = React.useState<number | null>(null)
  React.useEffect(() => { if (data.data) { setDraft(data.data.draft); setSaved(data.data.draft) } }, [data.data])
  const canEdit = data.data?.can_edit ?? false
  const cap = surfaceCap(connection, kind)!
  const title = surfaceDefinitions.find(def => def.kind === kind)!.title
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const unpublished = !data.data?.published || JSON.stringify(data.data.published.items.map(({ payload: _payload, ...item }) => item)) !== JSON.stringify(saved?.items) || data.data.published.enabled !== saved?.enabled
  function update(index: number, change: Partial<SurfaceConfig["items"][number]>) {
    setDraft(value => value && ({ ...value, items: value.items.map((item, i) => i === index ? { ...item, ...change } : item) }))
  }
  function move(index: number, to: number) {
    setDraft(value => {
      if (!value || to < 0 || to >= value.items.length || to === index) return value
      const items = [...value.items]; const [item] = items.splice(index, 1); items.splice(to, 0, item)
      return { ...value, items }
    })
  }
  async function save(publish = false) {
    if (!draft) return
    setBusy(true); setError("")
    try {
      if (draft.items.some(item => !item.title.trim() || !item.automation_id)) throw new Error("Preencha o título e escolha uma automação para cada item.")
      if (draft.enabled && !draft.items.length) throw new Error("Adicione um item antes de ativar.")
      await saveSurface(connection.id, kind, draft)
      setSaved(draft)
      if (publish) await publishSurface(connection.id, kind)
      data.reload()
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar a configuração.") }
    finally { setBusy(false) }
  }
  const locked = busy || !canEdit
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent className="flex max-h-[calc(100dvh-1.5rem)] flex-col gap-0 p-0 sm:max-w-4xl">
    <DialogHeader className="border-b border-border p-6"><DialogTitle>{title}</DialogTitle><DialogDescription>{connection.displayName} · Configure os itens e publique para atualizar a conversa.</DialogDescription></DialogHeader>
    {data.error ? <div className="p-6"><Banner variant="danger">Não foi possível carregar a configuração. <button className="underline" onClick={data.reload}>Tentar novamente</button></Banner></div> : !draft ? <p role="status" className="p-6">Carregando configuração…</p> : <>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_16rem]">
          <div className="min-w-0 space-y-3">
            <div className="flex justify-between gap-3 text-xs font-semibold uppercase tracking-wide text-text-muted"><span>{kind === "conversation_starters" ? "Perguntas" : "Botões do menu"}</span><span role="status" className="font-normal normal-case tracking-normal">{dirty ? "Alterações não salvas" : unpublished ? "Rascunho salvo" : "Publicado"}</span></div>
            <div className="space-y-2">{draft.items.map((item, index) => <section key={item.id} aria-label={`Item ${index + 1}`}
              onDragOver={event => { if (dragFrom !== null) event.preventDefault() }}
              onDrop={event => { event.preventDefault(); if (dragFrom !== null) move(dragFrom, index); setDragFrom(null) }}
              className={`flex min-w-0 flex-wrap items-center gap-2 rounded-lg border sm:flex-nowrap bg-surface p-2 ${dragFrom === index ? "border-accent opacity-60" : "border-border"}`}>
              <button type="button" draggable={!locked} aria-label={`Arrastar item ${index + 1}`} disabled={locked}
                onDragStart={event => { setDragFrom(index); event.dataTransfer.effectAllowed = "move"; const row = event.currentTarget.parentElement; if (row) event.dataTransfer.setDragImage(row, 16, 16) }}
                onDragEnd={() => setDragFrom(null)}
                onKeyDown={event => { if (event.key === "ArrowUp") { event.preventDefault(); move(index, index - 1) } else if (event.key === "ArrowDown") { event.preventDefault(); move(index, index + 1) } }}
                className="grid size-8 shrink-0 cursor-grab place-items-center rounded-md text-text-muted hover:bg-border/40 active:cursor-grabbing disabled:cursor-default"><GripVertical className="size-4" aria-hidden="true" /></button>
              <label className="order-last min-w-0 basis-full sm:order-none sm:basis-0 sm:flex-1"><span className="sr-only">Título do item {index + 1}</span><Input value={item.title} maxLength={cap.titleMax} placeholder={kind === "conversation_starters" ? "Escreva uma pergunta" : "Nome do botão"} disabled={locked} onChange={event => update(index, { title: event.target.value })} /></label>
              <div className="min-w-0 flex-1 sm:w-56 sm:flex-none"><AutomationPicker workspace={workspace} automations={automations.data ?? undefined} value={item.automation_id} onChange={id => update(index, { automation_id: id })} onlyPublished={false} buttonAriaLabel={`Automação do item ${index + 1}`} clearLabel={`Remover automação do item ${index + 1}`} disabled={locked} /></div>
              <span className="w-6 shrink-0 text-center text-sm text-text-muted" title="Cliques">{data.data?.clicks[item.id] ?? 0}</span>
              <RowMenu item={`item ${index + 1}`}>
                <RowMenuItem disabled={locked || index === 0} onSelect={() => move(index, index - 1)}>Subir</RowMenuItem>
                <RowMenuItem disabled={locked || index === draft.items.length - 1} onSelect={() => move(index, index + 1)}>Descer</RowMenuItem>
                <RowMenuItem className="text-danger" disabled={locked} onSelect={() => setDraft({ ...draft, items: draft.items.filter((_, i) => i !== index) })}>Remover</RowMenuItem>
              </RowMenu>
            </section>)}</div>
            {!draft.items.length ? <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-muted">Adicione o primeiro item para orientar seus contatos.</div> : null}
            <Button variant="secondary" disabled={locked || draft.items.length >= cap.maxItems} onClick={() => setDraft({ ...draft, items: [...draft.items, { id: crypto.randomUUID(), title: "", automation_id: "" }] })}><Plus className="size-4" aria-hidden="true" />{kind === "conversation_starters" ? "Adicionar pergunta" : "Adicionar item"}</Button>
            <p className="text-xs text-text-muted">{draft.items.length} de {cap.maxItems} itens. Arraste pela alça (ou use as setas nela) para mudar a ordem.</p>
            {automations.error ? <Banner variant="danger">Não foi possível carregar as automações. <button className="underline" onClick={automations.reload}>Tentar novamente</button></Banner> : null}
            {error ? <Banner variant="danger">{error}</Banner> : null}
          </div>
          <aside aria-label="Prévia da conversa" className="mx-auto w-full max-w-64 self-start"><p className="mb-3 flex items-center justify-center gap-2 text-xs text-text-muted"><Smartphone className="size-4" aria-hidden="true" />Prévia da conversa</p><div className="relative overflow-hidden rounded-3xl border border-border bg-bg shadow-node"><div className="flex items-center justify-between border-b border-border bg-surface px-4 py-4 text-sm font-semibold"><span className="min-w-0 truncate">{connection.displayName}</span>{kind === "main_menu" ? <button type="button" aria-label="Abrir menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)} className="grid size-8 place-items-center rounded-md hover:bg-border/40"><List className="size-5" aria-hidden="true" /></button> : null}</div>
            {kind === "main_menu" && menuOpen ? <ul aria-label="Itens do menu" className="absolute inset-x-3 top-14 z-10 divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface text-sm shadow-pop">{draft.items.length ? draft.items.map(item => <li key={item.id} className="break-words px-3 py-2.5">{item.title || "Novo item"}</li>) : <li className="px-3 py-2.5 text-text-muted">Nenhum item.</li>}</ul> : null}
            <div className="flex min-h-52 flex-col justify-end gap-2 p-4">{kind === "conversation_starters" ? draft.items.map(item => <div key={item.id} className="break-words rounded-xl border border-border bg-surface p-3 text-sm text-accent">{item.title || "Novo item"}</div>) : null}</div><div className="border-t border-border bg-surface p-4 text-xs text-text-muted">Escreva uma mensagem…</div></div><p className="mt-3 text-center text-xs text-text-muted">A prévia mostra o rascunho. A publicação atualiza o provedor.</p></aside>
        </div>
      </div>
      <div className="border-t border-border p-4">
        <PanelFooterBar switchLabel="Ativado" checked={draft.enabled} disabled={locked} onCheckedChange={enabled => setDraft({ ...draft, enabled })}>
          <Button variant="secondary" className="max-sm:hidden" disabled={busy} onClick={onClose}>Fechar</Button>
          <Button variant="secondary" disabled={locked || !dirty} aria-label="Salvar rascunho" onClick={() => save()}><span className="max-sm:hidden">Salvar rascunho</span><span className="sm:hidden">Salvar</span></Button>
          <Button disabled={locked || data.loading} loading={busy} onClick={() => save(true)}>{kind === "main_menu" ? "Atualizar menu" : "Publicar perguntas"}</Button>
        </PanelFooterBar>
      </div>
    </>}
  </DialogContent></Dialog>
}
