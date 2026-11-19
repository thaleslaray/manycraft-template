import { useEffect, useRef, useState } from "react"
import { useNavigate, useParams } from "react-router"
import { Copy, Info } from "lucide-react"
import { toast } from "sonner"
import { broadcastReasonLabel, broadcastRecipientStatusLabel, getBroadcast, getBroadcastOptions, saveBroadcast, type Broadcast, type BroadcastStatus } from "@/data/broadcasts"
import { useAsync } from "@/hooks/use-async"
import { PageHeader } from "@/components/shell/page-header"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { MessagePreview, channelLabel } from "./broadcast-parts"
import { FlowMap } from "@/components/editor/flow-editor"
import { reportFlow, reportStats } from "./broadcast-editor-logic"
import { formatBroadcastDate } from "./broadcast-list-logic"

const statuses: { value: BroadcastStatus; label: string }[] = [
  { value: "draft", label: "Rascunhos" }, { value: "scheduled", label: "Agendadas" }, { value: "sending", label: "Em envio" },
  { value: "paused", label: "Pausadas" }, { value: "sent", label: "Concluídas" }, { value: "cancelled", label: "Canceladas" },
]

/** Relatório de uma transmissão enviada: página própria, aberta pela linha do Histórico. */
export function BroadcastReportPage() {
  const { workspace = "demo", id = "" } = useParams()
  const navigate = useNavigate()
  const loaded = useAsync(async () => {
    const [item, options] = await Promise.all([getBroadcast(workspace, id), getBroadcastOptions(workspace)])
    return { item, options }
  }, `broadcast-report:${workspace}:${id}`)
  // Recarga (a cada 3 s enquanto envia) mantém o último relatório desta transmissão na tela em vez de voltar ao esqueleto.
  const snapshot = loaded.data ?? (loaded.stale?.item.id === id ? loaded.stale : undefined)
  const reload = useRef(loaded.reload)
  reload.current = loaded.reload
  const sending = snapshot?.item.status === "sending"
  useEffect(() => {
    if (!sending) return
    const timer = window.setInterval(() => reload.current(), 3000)
    return () => window.clearInterval(timer)
  }, [sending])
  const [copying, setCopying] = useState(false)
  const [error, setError] = useState("")
  const [byMessage, setByMessage] = useState(false)
  const [recipientsOpen, setRecipientsOpen] = useState(false)
  const current = snapshot?.item
  const crumbs = [{ label: "Mensagem em massa", to: `/${workspace}/broadcasts` }, { label: "Histórico", to: `/${workspace}/broadcasts?lista=historico` }]
  async function copyAndEdit() {
    if (!current) return
    setCopying(true); setError("")
    try {
      // A cópia nasce da própria transmissão (texto, e-mail, modelo ou o mapa de passos), sem procurar a automação de origem.
      const hasMap = !current.email && !current.template && !!current.flow?.nodes.length
      const copy = await saveBroadcast(workspace, { name: `Cópia de ${current.name}`.slice(0, 160), content: current.content, audience: current.audience, timezone: current.timezone, scheduled_local: "", status: "draft", email: current.email ?? undefined, template: current.template ?? undefined, window_kind: current.window_kind, flow: hasMap ? current.flow ?? undefined : undefined })
      toast.success("Cópia criada como rascunho.")
      navigate(`/${workspace}/broadcasts/${copy.id}`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível copiar a transmissão."); setCopying(false) }
  }
  const header = <PageHeader title={current?.name ?? "Relatório da transmissão"} crumbs={crumbs} actions={current ? [{ label: "Copiar e editar", icon: Copy, onSelect: () => void copyAndEdit() }] : []}
    menu={current ? [
      ...(current.metrics?.messages?.length ? [{ label: "Ver por mensagem", onSelect: () => setByMessage(true) }] : []),
      ...(current.recipients?.length ? [{ label: "Consultar destinatários", onSelect: () => setRecipientsOpen(true) }] : []),
      { label: "Atualizar relatório", onSelect: () => loaded.reload() },
    ] : []} />
  if (loaded.loading && !snapshot) return <div className="space-y-4 px-3"><title>Relatório da transmissão</title>{header}<div role="status" aria-label="Carregando relatório" className="space-y-3"><Skeleton className="h-32 w-full" /><Skeleton className="h-48 w-full" /></div></div>
  if (loaded.error || !current) return <div className="space-y-4 px-3">{header}<div role="alert" className="space-y-3 rounded-lg border border-border bg-surface p-6"><p>Não foi possível carregar o relatório.</p><Button variant="secondary" onClick={loaded.reload}>Tentar de novo</Button></div></div>
  const { options } = snapshot!
  const metrics = current.metrics
  const email = current.audience.channel === "email"
  const sentCount = metrics?.sent ?? 0
  const conditions = [
    `Canal: ${channelLabel(current.audience.channel)}`,
    current.audience.segment_id ? `Segmento: ${options.segments?.find(segment => segment.id === current.audience.segment_id)?.name ?? "indisponível"}` : `Grupo: ${options.tags.find(tag => tag.value === current.audience.tag)?.label ?? "Todos os inscritos"}`,
  ]
  const cards: [string, string, string?][] = [["Envios", (metrics?.total ?? sentCount).toLocaleString("pt-BR"), "vezes"], ["Contatos únicos", sentCount.toLocaleString("pt-BR")], ["E-mails", email ? sentCount.toLocaleString("pt-BR") : "0"], ["Telefones", current.audience.channel === "whatsapp" ? sentCount.toLocaleString("pt-BR") : "0"]]
  const opens = metrics?.opened !== undefined
  return <div className="-m-3">
    <title>{current.name}</title>
    {header}
    <div className="grid min-w-0 lg:h-[calc(100dvh-var(--header))] lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside aria-label="Principais métricas" className="min-w-0 space-y-5 border-border bg-surface p-5 lg:h-full lg:overflow-y-auto lg:border-r">
        <div className="flex items-center gap-2"><h2 className="text-lg font-bold">Principais métricas</h2>
          <Popover><PopoverTrigger asChild><button type="button" aria-label="Situação e como ler os resultados" className="grid size-6 place-items-center rounded-full text-text-muted hover:text-text"><Info className="size-4" aria-hidden="true" /></button></PopoverTrigger>
            <PopoverContent align="start" className="w-80 space-y-2 text-xs text-text-muted"><p><strong>Situação:</strong> {statuses.find(status => status.value === current.status)?.label}{current.pause_reason ? ` · ${broadcastReasonLabel(current.pause_reason, current.pause_detail)}` : ""}</p>
              {opens ? <><p><strong>Entregue:</strong> aceito pelo servidor destinatário, quando informado pelo provedor.</p><p><strong>Aberto:</strong> Pixel carregado pelo cliente de e-mail; imagens bloqueadas não são contadas.</p><p><strong>CTR:</strong> contatos únicos que clicaram divididos pelos destinatários únicos do primeiro nó desta transmissão.</p></> : null}</PopoverContent></Popover>
        </div>
        <dl className="grid grid-cols-2 gap-3">{cards.map(([label, value, unit]) => <div key={label} className="rounded-md border border-border p-3"><dt className="text-xs text-text-muted">{label}</dt><dd className="mt-2 text-xl font-bold">{value}{unit ? <span className="ml-1 text-xs font-normal text-text-muted">{unit}</span> : null}</dd></div>)}</dl>
        {current.stalled ? <p role="alert" className="rounded-md bg-warning-soft p-3 text-sm text-warning">O envio está parado em {current.stalled.percent}% desde {new Date(current.stalled.since).toLocaleString("pt-BR")}. Transmissões grandes saem aos poucos; se não andar, pause e retome ou fale com o suporte.</p> : null}
        {current.retry_at ? <p className="text-sm text-text-muted">Retomada permitida a partir de {new Date(current.retry_at).toLocaleString("pt-BR", { timeZone: current.timezone })} ({current.timezone}).</p> : null}
        {(metrics?.outside_window ?? 0) > 0 ? <p role="status" className="text-sm text-text-muted">{metrics!.outside_window!.toLocaleString("pt-BR")} {metrics!.outside_window === 1 ? "contato foi pulado" : "contatos foram pulados"} por estar fora da janela de 24 h. Eles não contam como falha.</p> : null}
        {(metrics?.uncertain ?? 0) > 0 ? <p className="text-sm text-warning">{metrics!.uncertain.toLocaleString("pt-BR")} envios aguardam confirmação; não são reenviados automaticamente.</p> : null}
        <section aria-label="Público" className="space-y-1"><h3 className="text-sm font-semibold">Público</h3><ul className="space-y-1 text-sm text-text-muted">{conditions.map(line => <li key={line} className="wrap-anywhere">{line}</li>)}</ul></section>
        <section aria-label="Enviada em" className="space-y-1"><h3 className="text-sm font-semibold">Enviada em</h3><p className="text-sm text-text-muted">{formatBroadcastDate(current.scheduled_at ?? current.updated_at, current.timezone)}</p></section>
        <section aria-label="Fuso horário" className="space-y-1"><h3 className="text-sm font-semibold">Fuso horário</h3><p className="text-sm text-text-muted">{current.timezone}</p></section>
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      </aside>
      <div className="relative min-w-0 lg:h-full">
        <p className="absolute top-2 left-1/2 z-10 w-max max-w-[calc(100%-1rem)] -translate-x-1/2 rounded-md bg-accent-soft px-4 py-2 text-center text-sm text-text">Você está vendo uma transmissão enviada · <button type="button" className="font-semibold text-accent underline" disabled={copying} onClick={() => void copyAndEdit()}>Copiar e editar</button></p>
        {current.flow && current.flow.nodes.length ? <div className="h-[34rem] overflow-hidden bg-surface-muted lg:h-full"><FlowMap workspace={workspace} host={{ graph: reportFlow(current.flow, current.audience.channel), label: "Mapa do fluxo enviado", readOnly: true, stats: reportStats(current.flow, metrics), onChange: () => {} }} /></div>
          : <div className="p-3"><MessagePreview content={current.content} channel={current.audience.channel} /></div>}
      </div>
    </div>
    <Dialog open={byMessage} onOpenChange={setByMessage}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader><DialogTitle>Resultados por mensagem</DialogTitle><DialogDescription>Números de cada mensagem enviada nesta transmissão.</DialogDescription></DialogHeader>
        {metrics?.messages?.length ? <MessageMetrics messages={metrics.messages} /> : null}
        <DialogFooter><DialogClose asChild><Button variant="secondary">Fechar</Button></DialogClose></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={recipientsOpen} onOpenChange={setRecipientsOpen}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader><DialogTitle>Destinatários</DialogTitle><DialogDescription>Até 200 registros.</DialogDescription></DialogHeader>
        <ul aria-label="Destinatários" className="space-y-2 text-sm">{current.recipients?.map(recipient => <li key={recipient.contact_channel_id ?? recipient.contact_id} className="wrap-anywhere">{recipient.name?.trim() || "Contato sem nome"}: {broadcastRecipientStatusLabel(recipient.status)}{recipient.reason ? ` · ${broadcastReasonLabel(recipient.reason, current.pause_detail)}` : ""}</li>)}</ul>
        <DialogFooter><DialogClose asChild><Button variant="secondary">Fechar</Button></DialogClose></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}

function MessageMetrics({ messages }: { messages: NonNullable<NonNullable<Broadcast["metrics"]>["messages"]> }) {
  const number = (value: number) => value.toLocaleString("pt-BR")
  return <section aria-label="Resultados por mensagem" className="space-y-2">
    <ol className="space-y-2">{messages.map((message, index) => <li key={message.node_id} className="rounded-md border border-border p-3 text-sm">
      <p className="font-medium wrap-anywhere"><span className="text-text-muted">Mensagem {index + 1}</span> · {message.summary}</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-4">{([["sent", "Enviadas"], ["delivered", "Entregues"], ["read", "Lidas"], ["clicked", "Cliques únicos"]] as const).map(([key, label]) => <div key={key}><dt className="text-xs text-text-muted">{label}</dt><dd className="font-semibold">{number(message[key])}</dd></div>)}</dl>
    </li>)}</ol>
    <p className="text-xs text-text-muted">O total e o CTR continuam contando só a primeira mensagem, por contato único. Entregas e leituras dependem dos recibos do canal.</p>
  </section>
}
