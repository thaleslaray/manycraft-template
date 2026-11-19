import * as React from "react"
import { Link, useNavigate, useParams } from "react-router"
import { Copy, FilePenLine, Pencil, Plus, Trash2 } from "lucide-react"
import { deleteSequence, duplicateSequence, listSequenceFlows, listSequences, updateSequence, type Sequence } from "@/data/sequences"
import { useAsync } from "@/hooks/use-async"
import { cn } from "@/lib/utils"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { Input } from "@/components/ui/input"
import { RowMenu, RowMenuItem } from "@/components/ui/row-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { percent } from "./sequence-metrics"

export function SequencesPage() {
  const { workspace = "demo" } = useParams()
  return <SequencesWorkspace key={workspace} workspace={workspace} />
}

function SequencesWorkspace({ workspace }: { workspace: string }) {
  const result = useAsync(async () => ({ sequences: await listSequences(workspace), flows: await listSequenceFlows(workspace) }), workspace, { cache: `sequences-page|${workspace}` })
  const [renaming, setRenaming] = React.useState<Sequence | null>(null)
  const [newName, setNewName] = React.useState("")
  const [listError, setListError] = React.useState("")
  const [notice, setNotice] = React.useState("")
  const [deleting, setDeleting] = React.useState<Sequence | null>(null)
  const [pending, setPending] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState("")
  const data = result.data
  const navigate = useNavigate()

  const rowGrid = "md:grid-cols-[minmax(0,1fr)_6.2rem_6rem_6rem_4.2rem_3.5rem]"
  const base = `/${workspace}/automations/sequences`
  return (
    <div className="min-w-0 space-y-4">
      <title>Sequências</title>
      <div className="flex flex-wrap items-center justify-between gap-4"><h2 className="text-xl font-bold">Sequências</h2><Button disabled={!data || pending} onClick={() => navigate(`${base}/new`)}><Plus className="size-4" aria-hidden="true" />Nova sequência</Button></div>
      {listError ? <Banner variant="danger">{listError}</Banner> : null}
      {notice ? <p role="status" className="text-sm text-success">{notice}</p> : null}
      {result.error ? <Banner variant="danger"><p>Não foi possível carregar as sequências.</p><Button variant="secondary" size="sm" onClick={result.reload}>Tentar de novo</Button></Banner>
        : !data ? <div role="status" aria-label="Carregando sequências" className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}</div>
        : !data.sequences.length ? <EmptyState title="Comece uma nova jornada" description="Adicione passos para organizar as próximas mensagens dos seus inscritos." action={<Button onClick={() => navigate(`${base}/new`)}>Criar primeira sequência</Button>} />
        : <div role="table" aria-label="Sequências" className="space-y-3">
          <div role="rowgroup"><div role="row" className={cn("hidden px-4 pt-1.5 pb-1 text-xs whitespace-nowrap text-text-muted md:grid md:items-center md:gap-x-0", rowGrid)}>
            <div role="columnheader">Nome</div><div role="columnheader" className="text-center">Assinantes</div><div role="columnheader" className="text-center">Mensagens</div><div role="columnheader" className="text-center">Taxa de abertura</div><div role="columnheader" className="text-center">CTR</div><div role="columnheader"><span className="sr-only">Ações</span></div>
          </div></div>
          <div role="rowgroup" className="space-y-4">{data.sequences.map((sequence) => <div role="row" key={sequence.id} className={cn("grid min-h-[3.25rem] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg bg-surface px-4 py-1.5 shadow-card md:gap-x-0", rowGrid)}>
            <div role="cell" className="min-w-0"><Link to={`${base}/${sequence.id}`} title={sequence.name} className="block truncate text-sm text-text hover:underline">{sequence.name}</Link><p className="mt-0.5 text-2xs text-text-muted md:hidden">{sequence.subscribers.toLocaleString("pt-BR")} assinantes · {sequence.steps.length} mensagens · abertura {percent(sequence.stats?.open_rate)} · CTR {percent(sequence.stats?.ctr)}</p></div>
            <div role="cell" className="hidden text-center text-sm tabular-nums md:block">{sequence.subscribers.toLocaleString("pt-BR")}</div>
            <div role="cell" className="hidden text-center text-sm tabular-nums md:block">{sequence.steps.length}</div>
            <div role="cell" className="hidden text-center text-sm tabular-nums md:block">{percent(sequence.stats?.open_rate)}</div>
            <div role="cell" className="hidden text-center text-sm tabular-nums md:block">{percent(sequence.stats?.ctr)}</div>
            <div role="cell" className="flex items-center justify-end gap-1">
              {sequence.steps.some(step => step.status === "draft" || !step.automation_id) ? <span title="Tem passos em rascunho" className="shrink-0 text-text-muted"><FilePenLine className="size-4" aria-hidden="true" /><span className="sr-only">Tem passos em rascunho</span></span> : null}
              <RowMenu item={sequence.name}>
                <RowMenuItem disabled={pending} onSelect={() => { setRenaming(sequence); setNewName(sequence.name); setListError("") }}><Pencil className="size-4" />Renomear</RowMenuItem>
                <RowMenuItem disabled={pending} onSelect={async () => { setPending(true); setListError(""); try { const { turnedOff } = await duplicateSequence(workspace, sequence); setNotice(turnedOff ? `Cópia criada sem inscrições ou estatísticas anteriores. ${turnedOff === 1 ? "Um passo foi" : `${turnedOff} passos foram`} para rascunho porque a automação ainda não está publicada.` : "Cópia criada sem inscrições ou estatísticas anteriores."); result.reload() } catch (reason) { setListError(reason instanceof Error ? reason.message : "Não foi possível duplicar.") } finally { setPending(false) } }}><Copy className="size-4" />Duplicar</RowMenuItem>
                <RowMenuItem disabled={pending} className="text-danger" onSelect={() => { setDeleteError(""); setDeleting(sequence) }}><Trash2 className="size-4" />Excluir</RowMenuItem>
              </RowMenu>
            </div>
          </div>)}</div>
        </div>}
      <Dialog open={renaming !== null} onOpenChange={(open) => { if (!open && !pending) setRenaming(null) }}>
        <DialogContent>
          <DialogTitle>Renomear sequência</DialogTitle><DialogDescription>Atualize o nome para reconhecer esta jornada na lista.</DialogDescription>
          <form className="space-y-4" onSubmit={async event => { event.preventDefault(); if (!renaming) return; setPending(true); setListError(""); try { await updateSequence(workspace, renaming.id, { name: newName, steps: renaming.steps }); setRenaming(null); setNotice("Nome atualizado."); result.reload() } catch (reason) { setListError(reason instanceof Error ? reason.message : "Não foi possível renomear.") } finally { setPending(false) } }}>
            <label className="block space-y-1 text-sm">Novo nome<Input required maxLength={120} autoFocus disabled={pending} value={newName} onChange={event => setNewName(event.target.value)} /></label>
            {listError ? <Banner variant="danger">{listError}</Banner> : null}
            <div className="flex justify-end gap-2"><Button type="button" variant="secondary" disabled={pending} onClick={() => setRenaming(null)}>Cancelar</Button><Button type="submit" loading={pending}>Salvar nome</Button></div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={deleting !== null} onOpenChange={(open) => { if (!open && !pending) setDeleting(null) }}>
        <DialogContent>
          <DialogTitle>Excluir sequência?</DialogTitle>
          <DialogDescription className="break-words">A sequência {deleting?.name} será removida e seus próximos envios serão cancelados. As automações vinculadas serão preservadas.</DialogDescription>
          {deleteError && <Banner variant="danger">{deleteError} Tente de novo pelo botão de excluir.</Banner>}
          <div className="flex justify-end gap-2"><Button variant="secondary" disabled={pending} onClick={() => setDeleting(null)}>Cancelar</Button><Button loading={pending} onClick={async () => { if (!deleting) return; setPending(true); setDeleteError(""); try { await deleteSequence(workspace, deleting.id); setDeleting(null); setNotice("Sequência excluída."); result.reload() } catch (reason) { setDeleteError(reason instanceof Error ? reason.message : "Não foi possível excluir a sequência.") } finally { setPending(false) } }}>Excluir sequência</Button></div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
