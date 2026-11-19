import { useEffect, useRef, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router"
import { ArrowLeft, Plus } from "lucide-react"
import { toast } from "sonner"
import {
  createBroadcastFromAutomation, cancelBroadcast, deleteBroadcast, getBroadcastOptions, loadBroadcastsPage, pauseBroadcast, resumeBroadcast,
  type Broadcast,
} from "@/data/broadcasts"
import { useAsync } from "@/hooks/use-async"
import { broadcastsKey } from "@/data/screen-keys"
import { PageHeader } from "@/components/shell/page-header"
import { BroadcastFullList, BroadcastSections, sectionSlugs } from "./broadcast-list"
import { Button } from "@/components/ui/button"
import { ChooseExisting } from "@/components/ui/choose-existing"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { listAutomations, getAutomation } from "@/data"
import { FieldSelect } from "@/components/ui/field-select"
import { BroadcastProgress, GraphPreview } from "./broadcast-parts"

type Options = Awaited<ReturnType<typeof getBroadcastOptions>>

export function BroadcastsPage() {
  const { workspace = "demo" } = useParams()
  return <BroadcastsWorkspace key={workspace} workspace={workspace} />
}

function BroadcastsWorkspace({ workspace }: { workspace: string }) {
  const [search, setSearch] = useState("")
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const [picker, setPicker] = useState(false)
  const [actionError, setActionError] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  function rememberFocus() { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null }
  function openEditor(value: Broadcast | "new") { navigate(value === "new" ? `/${workspace}/broadcasts/new` : `/${workspace}/broadcasts/${value.id}`) }
  function openReport(value: Broadcast) { navigate(`/${workspace}/broadcasts/${value.id}/report`) }
  const result = useAsync(() => loadBroadcastsPage(workspace), `broadcasts:${workspace}`, { cache: broadcastsKey(workspace) })
  const reloadRef = useRef(result.reload)
  reloadRef.current = result.reload
  const active = result.data?.items.some((item) => item.status === "sending" || item.status === "scheduled") ?? false
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => reloadRef.current(), 10_000)
    return () => window.clearInterval(timer)
  }, [active])
  async function changeStatus(item: Broadcast) {
    setBusy(item.id); setActionError("")
    try {
      const changed = item.status === "paused" ? await resumeBroadcast(workspace, item.id) : await pauseBroadcast(workspace, item.id)
      void changed; result.reload()
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "Não foi possível alterar o envio.") }
    finally { setBusy(null) }
  }
  async function cancel(item: Broadcast) {
    setBusy(item.id); setActionError("")
    try { await cancelBroadcast(item.id); result.reload(); toast.success("Agendamento cancelado.") }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : "Não foi possível cancelar.") }
    finally { setBusy(null) }
  }
  const [toDelete, setToDelete] = useState<Broadcast | null>(null)
  async function confirmDelete() {
    const item = toDelete
    if (!item) return
    setBusy(item.id); setActionError("")
    try { await deleteBroadcast(item.id); setToDelete(null); result.reload(); toast.success("Transmissão excluída.") }
    catch (cause) { setToDelete(null); setActionError(cause instanceof Error ? cause.message : "Não foi possível excluir.") }
    finally { setBusy(null) }
  }
  const rows = result.data?.items ?? []
  const canCreate = !!result.data?.options.channels.length
  const full = params.get("lista")
  const handlers = { busy, progress: (item: Broadcast) => <BroadcastProgress metrics={item.metrics} />, onEdit: openEditor, onReport: openReport, onToggle: changeStatus, onCancel: cancel, onDelete: (item: Broadcast) => { rememberFocus(); setToDelete(item) } }

  return <div className="space-y-6 px-3 pt-10">
    <title>Mensagem em massa</title>
    <PageHeader title="Mensagem em massa" actions={canCreate ? [
      { label: "Transmissão a partir de uma automação", onSelect: () => { rememberFocus(); setPicker(true) } },
      { label: "Nova transmissão", icon: Plus, primary: true, onSelect: () => openEditor("new") },
    ] : []} />
    {actionError ? <p role="alert" className="text-sm text-danger">{actionError}</p> : null}
    {result.loading ? <div role="status" aria-label="Carregando transmissões" className="space-y-3">{[1, 2, 3].map((n) => <Skeleton key={n} className="h-24 w-full" />)}</div>
      : result.error ? <div role="alert" className="space-y-3 rounded-lg border border-border bg-surface p-6"><p>Não foi possível carregar as transmissões.</p><Button variant="secondary" onClick={result.reload}>Tentar de novo</Button></div>
      : !canCreate && rows.length === 0 ? <EmptyState title="Ainda não há transmissões" description="Conecte um canal nas configurações antes de criar um envio." />
      : full && sectionSlugs.includes(full) ? <div className="space-y-3">
        <Link to={`/${workspace}/broadcasts`} className="inline-flex items-center gap-1 text-sm font-medium text-text-muted hover:text-text"><ArrowLeft className="size-4" aria-hidden="true" />Voltar à mensagem em massa</Link>
        <BroadcastFullList items={rows} slug={full} search={search} onSearch={setSearch} {...handlers} />
      </div>
      : <BroadcastSections items={rows} onSeeAll={slug => { setSearch(""); setParams({ lista: slug }) }} {...handlers} />}
    <Dialog open={!!toDelete} onOpenChange={open => { if (!open) setToDelete(null) }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Excluir transmissão?</DialogTitle><DialogDescription>{toDelete ? `"${toDelete.name}" será apagada e não poderá ser recuperada.${toDelete.status === "draft" ? "" : " O envio agendado não vai acontecer."}` : ""}</DialogDescription></DialogHeader>
        <DialogFooter><DialogClose asChild><Button variant="secondary">Cancelar</Button></DialogClose><Button variant="danger" loading={busy === toDelete?.id} onClick={() => void confirmDelete()}>Excluir</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    {picker && result.data && <AutomationPicker workspace={workspace} options={result.data.options} onClose={() => { setPicker(false); opener.current?.focus() }} onPicked={item => { setPicker(false); navigate(`/${workspace}/broadcasts/${item.id}`) }} />}
  </div>
}

function AutomationPicker({ workspace, options, onPicked, onClose }: { workspace: string; options: Options; onPicked: (item: Broadcast) => void; onClose: () => void }) {
  const automations = useAsync(() => listAutomations(workspace), `broadcast-automations:${workspace}`)
  const [connection, setConnection] = useState(options.channels[0]?.id ?? "")
  const [error, setError] = useState("")
  async function pick(automationId: string) {
    setError("")
    try { onPicked(await createBroadcastFromAutomation(automationId, connection)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível criar a cópia.") }
  }
  return <>
    <ChooseExisting
      open
      onOpenChange={open => { if (!open) onClose() }}
      title="Transmissão a partir de automação"
      searchLabel="Buscar automação"
      chooseLabel="Usar esta automação"
      closeOnChoose={false}
      error={error}
      emptyText={automations.loading ? "Carregando automações…" : "Crie uma automação antes de iniciar a transmissão."}
      items={(automations.data ?? []).map(automation => ({ id: automation.id, label: automation.name }))}
      onChoose={item => void pick(item.id)}
      renderPreview={item => <div className="space-y-4">
        <FieldSelect id="output-connection" label="Conexão de saída" value={connection} onChange={setConnection} options={options.channels.map(channel => ({ value: channel.id, label: channel.label }))} hint="A cópia fica independente da automação original." />
        <AutomationPreview workspace={workspace} id={item.id} />
      </div>}
    />
    {automations.error ? <p role="alert" className="sr-only">Não foi possível carregar automações.</p> : null}
  </>
}

function AutomationPreview({ workspace, id }: { workspace: string; id: string }) {
  const detail = useAsync(() => getAutomation(workspace, id), `broadcast-automation:${id}`)
  const graph = detail.data?.automation.draft_graph
  if (detail.loading) return <Skeleton className="h-48 w-full" />
  if (detail.error) return <p role="alert">Não foi possível carregar a prévia. <Button variant="link" onClick={detail.reload}>Tentar novamente</Button></p>
  return graph ? <GraphPreview graph={graph} label="Prévia da automação" /> : <p className="text-sm text-text-muted">Esta automação ainda não tem etapas.</p>
}

