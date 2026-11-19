import { useMemo, useState } from "react"
import { ChannelIcon, channelNames, type ChannelId } from "@/components/settings/settings-nav"
import { Link, useNavigate, useParams } from "react-router"
import { ArrowLeft, Check, ChevronDown, ChevronUp, Clock, Eye, Pencil, Plus, Save, Send, X } from "lucide-react"
import { toast } from "sonner"
import {
  deleteBroadcast, estimateBroadcastAudience, getBroadcast, getBroadcastOptions, saveBroadcast, testBroadcast, broadcastTemplateVariables, broadcastWindowRule, hasBroadcastWindow, defaultBroadcastWindowKind,
  type BroadcastAudienceCondition, type BroadcastInput, type BroadcastWindowKind,
} from "@/data/broadcasts"
import { getEmailDrafts, getEmailSettings } from "@/data/email"
import { listContacts } from "@/data"
import { useAsync } from "@/hooks/use-async"
import { PageHeader } from "@/components/shell/page-header"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input, Textarea } from "@/components/ui/input"
import { stepChannels, type StepChannel } from "@/components/editor/step-channel"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { FieldSelect } from "@/components/ui/field-select"
import { MessagePreview } from "./broadcast-parts"
import { FlowMap } from "@/components/editor/flow-editor"
import { AudiencePreviewList } from "./audience-preview-list"
import { isPausedSchedule } from "./broadcast-list-logic"
import { flowContent, flowStart, newBroadcastFlow, recipientsLabel, retargetFlow, withoutTrigger } from "./broadcast-editor-logic"

type Options = Awaited<ReturnType<typeof getBroadcastOptions>>

/** Rota própria do editor: `/broadcasts/new` cria, `/broadcasts/:id` edita rascunho ou agendada. */
export function BroadcastEditorPage() {
  const { workspace = "demo", id } = useParams()
  const loaded = useAsync(async () => {
    const [options, item] = await Promise.all([getBroadcastOptions(workspace), id ? getBroadcast(workspace, id) : Promise.resolve(null)])
    return { options, item }
  }, `broadcast-editor:${workspace}:${id ?? "new"}`)
  const back = <Link to={`/${workspace}/broadcasts`} className="inline-flex items-center gap-1 text-sm font-medium text-text-muted hover:text-text"><ArrowLeft className="size-4" aria-hidden="true" />Voltar às transmissões</Link>
  if (loaded.loading) return <div className="space-y-4"><title>Transmissão</title><PageHeader title="Transmissão" />{back}<div role="status" aria-label="Carregando transmissão" className="space-y-3"><Skeleton className="h-32 w-full" /><Skeleton className="h-48 w-full" /></div></div>
  if (loaded.error || !loaded.data) return <div className="space-y-4"><PageHeader title="Transmissão" />{back}<div role="alert" className="space-y-3 rounded-lg border border-border bg-surface p-6"><p>Não foi possível carregar a transmissão.</p><Button variant="secondary" onClick={loaded.reload}>Tentar de novo</Button></div></div>
  const { options, item } = loaded.data
  if (item && item.status !== "draft" && item.status !== "scheduled" && !isPausedSchedule(item)) return <div className="space-y-4"><PageHeader title={item.name} />{back}<p className="rounded-lg border border-border bg-surface p-6 text-sm text-text-muted">Esta transmissão já foi enviada e não pode mais ser editada. <Link to={`/${workspace}/broadcasts/${item.id}/report`} className="font-medium text-accent underline underline-offset-2">Ver o relatório</Link>.</p></div>
  return <BroadcastEditor key={item?.id ?? "new"} workspace={workspace} item={item} options={options} />
}

function BroadcastEditor({ workspace, item, options }: { workspace: string; item: Awaited<ReturnType<typeof getBroadcast>> | null; options: Options }) {
  const navigate = useNavigate()
  const kindFor = (channelId: string): BroadcastWindowKind => { const connection = options.channels.find(channel => channel.id === channelId); return defaultBroadcastWindowKind({ windowChannel: !connection?.profile?.email && hasBroadcastWindow(connection?.profile) && !item?.copied_graph, canUseTemplates: !!connection?.profile?.templates, approvedTemplates: options.templates.filter(template => template.channel_id === channelId).length, isNew: !item }) }
  const baseStatus: "draft" | "scheduled" = item?.status === "scheduled" || (item && isPausedSchedule(item)) ? "scheduled" : "draft"
  const [input, setInput] = useState<BroadcastInput>(() => ({ id: item?.id, name: item?.name ?? "", content: item?.content ?? "", audience: item?.audience ?? { tag: "all", channel: options.channels[0]?.value ?? "telegram", channel_id: options.channels[0]?.id ?? "" }, email: item?.email ?? undefined, template: item?.template ?? undefined, flow: item?.flow ? withoutTrigger(item.flow) : newBroadcastFlow(options.channels[0]?.value ?? "telegram", item?.content ?? ""), status: baseStatus, timezone: item?.timezone ?? "America/Sao_Paulo", scheduled_local: item?.scheduled_local ?? "", window_kind: item?.window_kind }))
  // O mapa usa as etiquetas que /broadcasts/options já trouxe (só id e nome importam no editor), sem esperar um GET /tags.
  const mapTags = useMemo(() => options.tags.map(tag => ({ id: tag.value, name: tag.label, workspace_id: workspace, contact_count: 0, created_at: "" })), [options.tags, workspace])
  const [testContact, setTestContact] = useState("")
  const [testSearch, setTestSearch] = useState("")
  const [testing, setTesting] = useState(false)
  const [messageMode, setMessageMode] = useState<"text" | "template">(item?.template || (!item && kindFor(options.channels[0]?.id ?? "") === "promotional") ? "template" : "text")
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  // Contatos de teste só valem na janela de prévia: nada é pedido na abertura do editor.
  const contacts = useAsync(() => previewOpen ? listContacts(workspace, null, { search: testSearch }) : Promise.resolve(null), `broadcast-test:${workspace}:${testSearch}:${previewOpen}`)
  const [audiencePreviewOpen, setAudiencePreviewOpen] = useState(false)
  // As condições abertas ficam no próprio público (audience.conditions) e voltam como foram salvas; sem isso, deduz pelos valores.
  const conditions: Condition[] = input.audience.conditions ?? [...(input.audience.tag !== "all" ? ["tag" as const] : []), ...(input.audience.segment_id ? ["segment" as const] : []), ...(input.audience.email_filter && input.audience.email_filter !== "defined" ? ["email" as const] : [])]
  const [contentOpen, setContentOpen] = useState(true)
  const [audienceOpen, setAudienceOpen] = useState(conditions.length > 0)
  const [saved, setSaved] = useState(() => JSON.stringify(input))
  const [confirmOpen, setConfirmOpen] = useState(false)
  const selectedConnection = options.channels.find(channel => channel.id === input.audience.channel_id)
  const emailCapability = selectedConnection?.profile?.email
  const windowChannel = !emailCapability && hasBroadcastWindow(selectedConnection?.profile) && !item?.copied_graph
  const windowKind: BroadcastWindowKind = windowChannel ? (input.window_kind ?? kindFor(input.audience.channel_id)) : "automatic"
  const windowRule = broadcastWindowRule(windowKind)
  // Texto livre sem e-mail é montado no mapa de fluxo; e-mail e modelo seguem pelos campos, que não têm passos.
  const mapMode = !emailCapability && messageMode === "text"
  const content = mapMode ? flowContent(input.flow!) : input.content
  const update = <K extends keyof BroadcastInput>(key: K, value: BroadcastInput[K]) => setInput(current => ({ ...current, [key]: value }))
  function pickWindowKind(kind: BroadcastWindowKind) { update("window_kind", kind); if (kind === "in_window") { update("template", undefined); setMessageMode("text") } if (kind === "promotional") setMessageMode("template") }
  const emailData = useAsync(async () => emailCapability ? { drafts: await getEmailDrafts(), settings: await getEmailSettings() } : null, `broadcast-email:${input.audience.channel_id}`)
  const [designId, setDesignId] = useState("")
  const changeEmail = (patch: Partial<NonNullable<BroadcastInput["email"]>>) => update("email", { subject: "", ...input.email, ...patch })
  const templates = options.templates.filter(template => template.channel_id === input.audience.channel_id)
  const selectedTemplate = templates.find(template => template.id === input.template?.id)
  const variables = selectedTemplate ? broadcastTemplateVariables(selectedTemplate) : []
  const audience = useAsync(() => estimateBroadcastAudience(workspace, input.audience, messageMode === "template" ? input.template : undefined, windowKind), `${windowKind}|${workspace}|${input.audience.channel_id}|${input.audience.tag}|${input.audience.email_filter ?? ""}|${input.audience.segment_id ?? ""}|${messageMode}|${input.template?.id ?? ""}`)
  const count = recipientsLabel(audience.data, audience.loading)

  function payload(status: BroadcastInput["status"]): BroadcastInput {
    if (!input.name.trim()) throw new Error("Dê um nome à transmissão.")
    if (messageMode === "template" && !selectedTemplate) throw new Error("Escolha um modelo aprovado para este canal.")
    if (emailCapability && !input.email?.subject?.trim()) throw new Error("Escreva o assunto do e-mail.")
    if (mapMode && !flowStart(input.flow!)) throw new Error("Ligue os passos: o envio começa em um passo só.")
    if (messageMode === "text" && !content.trim() && !(mapMode && (flowStart(input.flow!)!.config.blocks as { kind: string }[] | undefined)?.some(block => block.kind !== "text"))) throw new Error("Escreva a mensagem.")
    if (status === "scheduled" && !input.scheduled_local) throw new Error("Escolha a data e a hora do envio.")
    return { ...input, status, window_kind: windowKind, content: messageMode === "template" ? selectedTemplate!.body : content, flow: mapMode ? input.flow : undefined, email: emailCapability ? input.email : undefined, template: !emailCapability && messageMode === "template" ? input.template : undefined }
  }
  async function submit(status: BroadcastInput["status"]) {
    setSaving(true); setError("")
    try {
      const saved = await saveBroadcast(workspace, payload(status))
      toast.success(saved.status === "scheduled" ? "Agendamento salvo." : saved.status === "sending" ? "Envio colocado na fila." : "Rascunho salvo.")
      navigate(`/${workspace}/broadcasts`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar. Tente de novo."); setSaving(false); setScheduleOpen(false); setConfirmOpen(false) }
  }
  async function sendTest() {
    setTesting(true); setError("")
    try {
      // O motor testa uma transmissão gravada. Se a pessoa ainda não salvou, o rascunho existe só durante o teste e é apagado em seguida.
      const temporary = !input.id
      const saved = await saveBroadcast(workspace, payload(baseStatus === "scheduled" && input.scheduled_local ? "scheduled" : "draft"))
      try {
        await testBroadcast(saved.id, testContact)
        toast.success("Teste enviado.")
      } finally {
        if (temporary) await deleteBroadcast(saved.id).catch(() => {})
        else { setSaved(JSON.stringify({ ...input, id: saved.id })) }
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível enviar o teste.") }
    finally { setTesting(false) }
  }
  function saveOnly() {
    if (saving || testing) return
    if (!input.audience.channel_id) { setError("Escolha o canal conectado."); return }
    if (audience.error) { setError("Não foi possível calcular o público. Revise a seleção."); return }
    void submit(baseStatus)
  }
  function openSend() { setError(""); try { payload("sending"); setConfirmOpen(true) } catch (cause) { setError(cause instanceof Error ? cause.message : "Revise a transmissão.") } }
  function openSchedule() { setError(""); try { payload("draft"); setScheduleOpen(true) } catch (cause) { setError(cause instanceof Error ? cause.message : "Revise a transmissão.") } }

  const dirty = (!item && !input.id) || JSON.stringify(input) !== saved
  function addCondition(kind: Condition) { update("audience", { ...input.audience, conditions: [...conditions, kind] }) }
  function removeCondition(kind: Condition) {
    const rest = conditions.filter(value => value !== kind)
    const base = { ...input.audience, conditions: rest.length ? rest : undefined }
    if (kind === "tag") update("audience", { ...base, tag: "all" })
    else if (kind === "segment") update("audience", { ...base, segment_id: undefined })
    else update("audience", { ...base, email_filter: undefined })
  }
  // Só o nome da conexão não diz por onde a mensagem sai: cada linha leva o ícone do canal e o nome dele, na ordem do menu de configurações.
  const channelOrder = Object.keys(channelNames)
  const rank = (value: string) => { const at = channelOrder.indexOf(value); return at < 0 ? channelOrder.length : at }
  const channelOptions = [...options.channels].sort((a, b) => rank(a.value) - rank(b.value)).map(option => ({ value: option.id, label: option.label,
    icon: option.value in channelNames ? <ChannelIcon channel={option.value as ChannelId} className="size-6" /> : undefined,
    detail: option.value in channelNames && channelNames[option.value as ChannelId] !== option.label ? channelNames[option.value as ChannelId] : undefined }))
  return <div className="space-y-3">
    <title>{item ? "Editar transmissão" : "Criar transmissão"}</title>
    <PageHeader title={input.name || "Nova transmissão"} crumbs={[{ label: "Mensagem em massa", to: `/${workspace}/broadcasts` }, { label: baseStatus === "scheduled" ? "Agendado" : "Rascunhos", to: `/${workspace}/broadcasts?lista=${baseStatus === "scheduled" ? "agendado" : "rascunhos"}` }]}
      titleSlot={<span className="inline-flex min-w-0 items-center gap-1"><Input aria-label="Nome da transmissão" value={input.name} placeholder="Nome da transmissão" onChange={event => update("name", event.target.value)} maxLength={160} className="h-9 min-w-0 max-w-sm border-0 border-b border-border bg-transparent px-1 text-lg font-bold shadow-none" /><Pencil className="size-4 shrink-0 text-text-muted" aria-hidden="true" /></span>}
      status={!dirty && item ? <span className="hidden items-center gap-1 text-sm text-text-muted sm:inline-flex"><Check className="size-4" aria-hidden="true" />Salvo</span> : null}
      actions={[
        ...(dirty ? [{ label: baseStatus === "scheduled" ? "Salvar alterações" : "Salvar rascunho", icon: Save, onSelect: saveOnly }] : []),
        { label: "Prévia", icon: Eye, onSelect: () => setPreviewOpen(true) },
        { label: "Enviar agora", icon: Send, primary: true, onSelect: openSend },
        { label: "Agendar", icon: Clock, iconOnly: true, onSelect: openSchedule },
      ]} />
    <div className="space-y-4">
      <Collapsible id="broadcast-content" title="Conteúdo" open={contentOpen} onToggle={() => setContentOpen(!contentOpen)}>
        <div className={mapMode ? "relative -mx-5 -mb-3 md:h-[max(26rem,calc(100dvh-var(--header)-9rem))] overflow-hidden border-t border-border" : "space-y-4"}>
        <div className={mapMode ? "z-10 flex flex-col gap-2 p-3 md:absolute md:flex-row md:flex-wrap md:items-start md:left-3 md:top-3 md:max-w-[calc(100%-7rem)] md:p-0 md:[&_p]:rounded-md md:[&_p]:bg-surface md:[&_p]:p-2 md:[&_p]:shadow-sm [&>*]:w-full md:[&>*]:w-64" : "contents"}>
        <FieldSelect id="broadcast-channel" label="Canal conectado" hideLabel={mapMode} value={input.audience.channel_id} options={channelOptions} onChange={next => { const channel = options.channels.find(option => option.id === next)!; update("audience", { ...input.audience, channel: channel.value, channel_id: channel.id }); update("template", undefined); update("email", undefined); update("window_kind", undefined); update("flow", retargetFlow(input.flow!, channel.value)); setMessageMode(kindFor(channel.id) === "promotional" ? "template" : "text"); setDesignId("") }} />
        {emailCapability ? <div className="min-w-0 space-y-4">
          <FieldSelect id="broadcast-email-design" label="Design de e-mail" value={designId} none="Escrever mensagem" onChange={next => { setDesignId(next); const draft = emailData.data?.drafts.find(row => row.id === next); if (draft) { const { subject, preheader, html, senderId, onOpen, linkActions } = draft; update("email", { subject, preheader, html, senderId, onOpen, linkActions }); update("content", draft.text) } }} options={(emailData.data?.drafts ?? []).flatMap(draft => draft.id ? [{ value: draft.id, label: draft.name }] : [])} hint={<Link className="underline" to={`/${workspace}/settings/email/design?voltar=${encodeURIComponent(item ? `/${workspace}/broadcasts/${item.id}` : `/${workspace}/broadcasts/new`)}`}>Criar ou editar design</Link>} />
          {emailData.error && <p role="alert" className="text-sm text-danger">Não foi possível carregar os designs. <Button type="button" variant="link" onClick={emailData.reload}>Tentar novamente</Button></p>}
          <FieldSelect id="broadcast-email-sender" label="Remetente" value={input.email?.senderId ?? emailData.data?.settings.defaultSenderId ?? ""} onChange={next => changeEmail({ senderId: next })} options={(emailData.data?.settings.senders ?? []).filter(sender => sender.status === "verified").map(sender => ({ value: sender.id, label: `${sender.name} · ${sender.address}` }))} />
          <div className="space-y-1"><Label htmlFor="broadcast-email-subject">Assunto</Label><Input id="broadcast-email-subject" maxLength={emailCapability.subjectMaxLength} value={input.email?.subject ?? ""} onChange={event => changeEmail({ subject: event.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="broadcast-email-preheader">Prévia</Label><Input id="broadcast-email-preheader" maxLength={1000} value={input.email?.preheader ?? ""} onChange={event => changeEmail({ preheader: event.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="broadcast-content">Conteúdo da mensagem</Label><Textarea id="broadcast-content" rows={4} maxLength={100000} value={input.content} onChange={event => update("content", event.target.value)} /></div>
          {input.email?.html && <iframe title="Prévia do design de e-mail" className="h-48 w-full rounded border border-border bg-surface" sandbox="" srcDoc={input.email.html} />}
          <p className="text-xs text-text-muted">Somente contatos com endereço e opt-in de e-mail recebem marketing. Esta conexão não exige janela de atendimento. O descadastro aparece no rodapé.</p>
        </div> : <>
          {windowChannel && <FieldSelect id="broadcast-window-kind" label="Tipo da transmissão" hideLabel={mapMode} hintPopover={mapMode} value={windowKind} onChange={next => pickWindowKind(next as BroadcastWindowKind)} options={[...(item?.window_kind === "automatic" ? [{ value: "automatic", label: "Automático (o envio decide por contato)" }] : []), { value: "in_window", label: "Dentro da janela de 24h" }, ...(selectedConnection?.profile?.templates ? [{ value: "promotional", label: "Fora da janela / promocional" }] : [])]} hint={<>
            {!selectedConnection?.profile?.templates ? <span className="block">Este canal só entrega a quem escreveu nas últimas 24 horas. Os outros contatos são pulados e aparecem no relatório como fora da janela de 24 h. A estimativa já conta só quem está dentro da janela.</span> : null}
            {windowRule.note ? <span className="block">{windowRule.note}</span> : null}
            {!item && !!selectedConnection?.profile?.templates && templates.length === 0 && windowKind !== "promotional" ? <span role="status" className="block">Esta conta ainda não tem modelos aprovados, então a transmissão começa dentro da janela de 24h. Para falar com quem não conversa há mais de 24 horas, crie e aprove um modelo em <Link className="underline" to={`/${workspace}/settings/message-templates`}>Modelos de mensagem</Link>.</span> : null}
          </>} />}
          {!(windowChannel && windowKind !== "automatic") && <FieldSelect id="broadcast-message-mode" label="Tipo de conteúdo" hideLabel={mapMode} value={messageMode} onChange={next => setMessageMode(next as "text" | "template")} options={[{ value: "text", label: "Texto livre" }, ...(!item?.copied_graph && selectedConnection?.profile?.templates ? [{ value: "template", label: "Modelo aprovado" }] : [])]} />}
        </>}
        </div>
        {!emailCapability ? <>
          {mapMode ? null : <p className="col-span-full text-xs text-text-muted">O sistema verifica a janela, o consentimento e os modelos aceitos pela conexão. Quem não puder receber aparece no relatório.</p>}
          {messageMode === "template" ? <div className="space-y-3">
            <FieldSelect id="broadcast-template" label="Modelo do canal" value={input.template?.id ?? ""} placeholder="Escolha um modelo" onChange={next => update("template", { id: next, params: {} })} options={templates.map(template => ({ value: template.id, label: `${template.name} · ${template.language}` }))} />
            {templates.length === 0 ? <p className="text-sm text-text-muted">Este canal ainda não tem modelos aprovados.</p> : null}
            {variables.map(({ key, label }) => <div key={key} className="space-y-1"><Label htmlFor={`broadcast-var-${key}`}>{label}</Label><Input id={`broadcast-var-${key}`} value={input.template?.params[key] ?? ""} onChange={event => update("template", { id: input.template!.id, params: { ...input.template!.params, [key]: event.target.value } })} /></div>)}
          </div> : null}
          {mapMode ? <div className="h-[30rem] md:h-full">
            <FlowMap key={input.audience.channel_id} workspace={workspace} host={{ graph: input.flow!, channel: stepChannelFor(input.audience.channel), label: "Mapa do conteúdo da transmissão", tags: mapTags, onChange: graph => update("flow", graph) }} />
          </div> : null}
        </> : null}
        </div>
      </Collapsible>
      <Collapsible id="broadcast-audience" title="Público alvo" open={audienceOpen} onToggle={() => setAudienceOpen(!audienceOpen)} aside={audience.error ? <span className="text-danger">Não foi possível estimar o público.</span> : <><strong>{count.value}</strong> {count.text}</>}>
        <div className="grid gap-4 lg:grid-cols-[calc(25.9%-1rem)_39.7%_minmax(0,1fr)] lg:items-start">
          <p className="text-sm text-text-muted">Para tornar o direcionamento mais relevante, estabeleça condições adicionais ou selecione uma lista.</p>
          <div className={conditions.length ? "min-w-0 space-y-3 rounded-md border border-border p-3" : "min-w-0"}>
            {conditions.includes("tag") && <div className="flex items-end gap-2"><div className="min-w-0 flex-1"><FieldSelect id="broadcast-audience" label="Grupo de inscritos" value={input.audience.tag} options={options.tags} onChange={next => update("audience", { ...input.audience, tag: next })} /></div><Button type="button" variant="ghost" size="icon" aria-label="Remover condição Grupo de inscritos" onClick={() => removeCondition("tag")}><X className="size-4" aria-hidden="true" /></Button></div>}
            {conditions.includes("segment") && <div className="flex items-end gap-2"><div className="min-w-0 flex-1"><FieldSelect id="broadcast-segment" label="Segmento salvo" value={input.audience.segment_id ?? ""} none="Sem segmento adicional" onChange={next => update("audience", { ...input.audience, segment_id: next || undefined })} options={[...(input.audience.segment_id && !options.segments?.some(segment => segment.id === input.audience.segment_id) ? [{ value: input.audience.segment_id, label: "Segmento indisponível" }] : []), ...(options.segments ?? []).map(segment => ({ value: segment.id, label: segment.name }))]} hint="As regras do segmento são combinadas com o grupo e a conexão escolhidos." /></div><Button type="button" variant="ghost" size="icon" aria-label="Remover condição Segmento salvo" onClick={() => removeCondition("segment")}><X className="size-4" aria-hidden="true" /></Button></div>}
            {conditions.includes("email") && <div className="flex items-end gap-2"><div className="min-w-0 flex-1"><FieldSelect id="broadcast-email-filter" label="Atividade de e-mail" value={input.audience.email_filter ?? "defined"} onChange={next => update("audience", { ...input.audience, email_filter: next })} options={([["defined", "E-mail definido"], ["opened", "Abriu e-mail"], ["clicked", "Clicou em e-mail"], ["opened_clicked", "Abriu e clicou"], ["opened_not_clicked", "Abriu e não clicou"], ["not_opened", "Não abriu"]] as const).map(([value, label]) => ({ value, label }))} /></div><Button type="button" variant="ghost" size="icon" aria-label="Remover condição Atividade de e-mail" onClick={() => removeCondition("email")}><X className="size-4" aria-hidden="true" /></Button></div>}
            <DropdownMenu>
              <DropdownMenuTrigger asChild><button type="button" className="flex h-9 w-full items-center justify-center gap-1 rounded-md border border-dashed border-border text-sm font-medium text-accent hover:bg-accent-soft"><Plus className="size-4" aria-hidden="true" />Condição</button></DropdownMenuTrigger>
              <DropdownMenuContent>{(["tag", "segment", ...(emailCapability ? ["email" as const] : [])] as Condition[]).filter(kind => !conditions.includes(kind)).map(kind => <DropdownMenuItem key={kind} onSelect={() => addCondition(kind)}>{conditionLabels[kind]}</DropdownMenuItem>)}</DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="flex items-center gap-3 text-sm"><span className="flex -space-x-2" aria-hidden="true">{[0, 1, 2].map(n => <span key={n} className="size-5 rounded-full border-2 border-surface bg-surface-muted" />)}</span><button type="button" className="font-medium text-accent hover:underline" onClick={() => setAudiencePreviewOpen(true)}>{`Visualização prévia de ${count.value} ${count.value === "1" ? "contato" : "contatos"}`}</button></div>
        </div>
      </Collapsible>
    </div>
    <p role="status" aria-live="polite" className="sr-only">{audience.error ? "Não foi possível estimar o público." : `${count.value} ${count.text}`}</p>
    {audience.error ? <p role="alert" className="text-sm text-danger">Não foi possível estimar o público. <Button type="button" variant="link" onClick={audience.reload}>Tentar de novo</Button></p> : null}
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}

    <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader><DialogTitle>Prévia</DialogTitle><DialogDescription>Veja a mensagem como o contato recebe e envie um teste.</DialogDescription></DialogHeader>
        <MessagePreview content={messageMode === "template" ? selectedTemplate?.body ?? "" : content} channel={input.audience.channel} />
        <div className="space-y-3 border-t border-border pt-4">
          <h3 className="text-sm font-semibold">Enviar uma prévia</h3>
          <p className="text-xs text-text-muted">O teste vai somente para o contato escolhido e não entra nas métricas da transmissão.</p>
          <div className="space-y-1"><Label htmlFor="test-search">Buscar contato de teste</Label><Input id="test-search" value={testSearch} onChange={event => setTestSearch(event.target.value)} placeholder="Nome, telefone ou e-mail" /></div>
          <FieldSelect id="test-contact" label="Contato de teste" value={testContact} placeholder="Escolha seu contato" onChange={setTestContact} options={(contacts.data?.rows ?? []).map(contact => ({ value: contact.id, label: [contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.id }))} />
          {contacts.error && <p role="alert" className="text-sm text-danger">Não foi possível carregar contatos. <Button type="button" variant="link" onClick={contacts.reload}>Tentar novamente</Button></p>}
          <Button type="button" variant="secondary" disabled={!testContact || (messageMode === "template" ? !selectedTemplate : !content.trim()) || !input.name.trim() || saving} loading={testing} onClick={sendTest}><Send className="size-4" aria-hidden="true" />Enviar teste</Button>
        </div>
        <DialogFooter><DialogClose asChild><Button variant="secondary">Fechar</Button></DialogClose></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={audiencePreviewOpen} onOpenChange={setAudiencePreviewOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>Prévia do público</DialogTitle><DialogDescription>{audience.data === undefined ? "Calculando o público." : `${count.value} ${count.text}. A lista fecha no início do envio e a elegibilidade é verificada individualmente.`}</DialogDescription></DialogHeader>
        <ul className="space-y-1 text-sm text-text-muted"><li>Canal: {selectedConnection?.label ?? "—"}</li>{conditions.length ? conditions.map(kind => <li key={kind}>{conditionLabels[kind]}</li>) : <li>Sem condições adicionais.</li>}</ul>
        {audiencePreviewOpen && input.audience.channel_id && !audience.error ? <AudiencePreviewList workspace={workspace} audience={input.audience} template={messageMode === "template" ? input.template : undefined} windowKind={windowKind} /> : null}
        <DialogFooter><DialogClose asChild><Button variant="secondary">Fechar</Button></DialogClose></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>Agendar envio</DialogTitle><DialogDescription>A lista de destinatários fecha na hora do envio, não agora.</DialogDescription></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1"><Label htmlFor="broadcast-time">Data e horário no fuso escolhido</Label><Input id="broadcast-time" type="datetime-local" className="min-w-0" value={input.scheduled_local} onChange={event => update("scheduled_local", event.target.value)} /></div>
          <FieldSelect id="broadcast-timezone" label="Fuso horário" value={input.timezone} onChange={next => update("timezone", next)} options={options.timezones.map(timezone => ({ value: timezone, label: timezone }))} />
        </div>
        <DialogFooter><DialogClose asChild><Button variant="secondary">Cancelar</Button></DialogClose><Button loading={saving} disabled={!input.audience.channel_id || !!audience.error} onClick={() => void submit("scheduled")}>Salvar agendamento</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>Enviar agora?</DialogTitle><DialogDescription>{audience.data === undefined ? "O envio começa assim que você confirmar." : `${count.value} ${count.text}. O envio começa assim que você confirmar.`}</DialogDescription></DialogHeader>
        <DialogFooter><DialogClose asChild><Button variant="secondary">Cancelar</Button></DialogClose><Button loading={saving} disabled={!input.audience.channel_id || !!audience.error} onClick={() => void submit("sending")}>Confirmar envio</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}

const stepChannelFor = (channel: string): StepChannel | undefined => (stepChannels as readonly string[]).includes(channel) ? channel as StepChannel : undefined
type Condition = BroadcastAudienceCondition
const conditionLabels: Record<Condition, string> = { tag: "Grupo de inscritos", segment: "Segmento salvo", email: "Atividade de e-mail" }

/** Cartão recolhível em largura total; fechado, mostra à direita o resumo (`aside`). */
function Collapsible({ id, title, open, onToggle, aside, children }: { id: string; title: string; open: boolean; onToggle: () => void; aside?: React.ReactNode; children: React.ReactNode }) {
  return <section aria-labelledby={`${id}-title`} className="min-w-0 rounded-lg border border-border bg-surface px-5 py-3">
    <div className="flex items-center justify-between gap-3">
      <h2 id={`${id}-title`} className="shrink-0 text-base font-semibold whitespace-nowrap"><button type="button" aria-expanded={open} aria-controls={`${id}-body`} onClick={onToggle} className="inline-flex items-center gap-1">{title}{open ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}</button></h2>
      {aside && !open ? <div className="min-w-0 text-right text-xs text-text-muted sm:text-sm">{aside}</div> : null}
    </div>
    <div id={`${id}-body`} hidden={!open} className="pt-3">{children}</div>
  </section>
}
