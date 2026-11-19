import { VariablePicker } from "@/components/editor/variable-picker"
import { listEditorFields } from "@/data"
import { InboxTemplateDialog } from "./inbox-template-dialog"
import { InboxComposerTools } from "./inbox-composer-tools"
import { InboxAttachButtons, InboxEmojiPicker, InboxStagedAttachment, type StagedAttachment } from "./inbox-composer-attach"
import { attachmentOptions, insertAtCursor, sendLabel } from "./inbox-compose"
import { useCan } from "@/hooks/use-role"
import * as React from "react"
import { ArrowLeft, CalendarClock, CheckCheck, Clock3, EllipsisVertical, FileText, Mail, PanelRight, Play, RotateCcw, Send, StickyNote, Trash2, UserRound, X } from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { isFakeMode } from "@/data/api"
import { resumeInboxAutomations, cachedInboxConversation, hasOlderInboxMessages, loadOlderInboxMessages, type InboxLiveEvent, type InboxConnectionState, assignInboxConversation, getInboxConversation, inboxMessageWindow, sendInboxAttachment, sendInboxMessage, sendInboxTemplate, setInboxReminder, setInboxStatus, setInboxUnread, type InboxConversation, type InboxMember } from "@/data"
import { useAsync } from "@/hooks/use-async"
import { cn } from "@/lib/utils"
import { AvatarInitials } from "@/components/ui/avatar-initials"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { inboxChannelLabels, InboxLoadError } from "./inbox-shared"
import { InboxTimelineItem } from "./inbox-timeline-item"
import { InboxReminder } from "./inbox-reminder"
import { InboxRunAutomation } from "./inbox-run-automation"
import { InboxScheduled } from "./inbox-scheduled"
import { ConversationLabels, LabelChips } from "./inbox-labels"
import { DeleteContactDialog } from "@/components/contacts/delete-contact-dialog"

type Mutation = () => Promise<InboxConversation>

export function InboxConversationPanel({ workspace, conversationId, members, liveEvent, connection, onBack, onChanged, onUnread, onDeleted, anchorMessageId }: {
  /** Nota a destacar ao abrir (veio de uma menção). */
  anchorMessageId?: string | null
  workspace: string
  conversationId: string
  members: InboxMember[]
  liveEvent: InboxLiveEvent | null
  connection: InboxConnectionState
  onBack: () => void
  onChanged: () => void
  onUnread: () => void
  onDeleted: () => void
}) {
  const result = useAsync(() => getInboxConversation(workspace, conversationId), `${workspace}|${conversationId}`)
  const [updated, setUpdated] = React.useState<InboxConversation | null>(null)
  const [templateOpen, setTemplateOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  // Painel de dados do contato: aberto por padrão só em tela larga, onde cabe ao lado da conversa.
  const [panelOpen, setPanelOpen] = React.useState(() => typeof window !== "undefined" && window.matchMedia?.("(min-width: 1536px)").matches)
  // No celular o compositor fica enxuto; "Mais opções" abre o resto.
  const [toolsOpen, setToolsOpen] = React.useState(false)
  // Um formulário de cada vez no cabeçalho e na barra de agendamento; Esc fecha o aberto.
  const [form, setForm] = React.useState<"automation" | "reminder" | "scheduled" | null>(null)
  const fields = useAsync(() => listEditorFields(workspace), `inbox-fields:${workspace}`)
  const [busy, setBusy] = React.useState(false)
  const [mutationError, setMutationError] = React.useState<string | null>(null)
  const [mode, setMode] = React.useState<"reply" | "note">("reply")
  const [drafts, setDrafts] = React.useState({ reply: "", note: "" })
  const [attachment, setAttachment] = React.useState<StagedAttachment | null>(null)
  const [mentioned, setMentioned] = React.useState<InboxMember[]>([])
  const [clock, setClock] = React.useState(() => Date.now())
  const retryMutation = React.useRef<(() => void) | null>(null)
  const composerRef = React.useRef<HTMLTextAreaElement>(null)
  const canReply = useCan("inbox:reply")
  const anchorShown = React.useRef(false)
  const canEdit = useCan("edit")
  const focusInsertion = React.useRef(false)
  const historyRef = React.useRef<HTMLDivElement>(null)
  const atBottom = React.useRef(true)
  const loadingOlder = React.useRef(false)
  const headingRef = React.useRef<HTMLHeadingElement>(null)
  const initialReadDone = React.useRef(false)
  // Enquanto a conversa é devolvida a "não lida", o evento ao vivo dela não pode marcá-la como lida de novo.
  const leaving = React.useRef(false)
  const alive = React.useRef(true)
  const conversation = updated ?? result.data
  const onChangedRef = React.useRef(onChanged)
  onChangedRef.current = onChanged

  React.useLayoutEffect(() => {
    if (!focusInsertion.current) return
    focusInsertion.current = false
    const node = composerRef.current
    node?.focus()
    node?.setSelectionRange(node.value.length, node.value.length)
  }, [drafts])

  React.useEffect(() => {
    if (!form) return
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setForm(null) }
    document.addEventListener("keydown", close)
    return () => document.removeEventListener("keydown", close)
  }, [form])

  React.useEffect(() => {
    alive.current = true
    headingRef.current?.focus()
    const interval = window.setInterval(() => setClock(Date.now()), 30_000)
    return () => { alive.current = false; window.clearInterval(interval) }
  }, [])

  React.useEffect(() => {
    const container = historyRef.current
    if (container && atBottom.current && !loadingOlder.current) container.scrollTop = container.scrollHeight
  }, [conversation?.messages.length])

  React.useEffect(() => {
    if (!liveEvent || liveEvent.type === "contact_deleted" || liveEvent.conversation.id !== conversationId || leaving.current) return
    const next = cachedInboxConversation(conversationId)
    if (next) {
      setUpdated(next)
      if (next.unread) void setInboxUnread(workspace, conversationId, false).then(read => {
        if (alive.current) { setUpdated(read); onChangedRef.current() }
      }).catch(() => setMutationError("Não foi possível atualizar a leitura da conversa."))
    }
  }, [liveEvent, conversationId, workspace])

  // Só quando a conexão do tempo real volta; `result` muda a cada carga e recarregaria sem parar.
  const reloadRef = React.useRef(result.reload)
  reloadRef.current = result.reload
  React.useEffect(() => {
    if (connection === "connected") reloadRef.current()
  }, [connection])

  React.useEffect(() => {
    if (result.data) setUpdated(result.data)
    if (!result.data || initialReadDone.current) return
    initialReadDone.current = true
    headingRef.current?.focus()
    if (!result.data.unread) return
    setInboxUnread(workspace, conversationId, false).then(
      (next) => {
        if (!alive.current) return
        setUpdated(next)
        onChangedRef.current()
      },
      () => {
        if (!alive.current) return
        retryMutation.current = () => { void mutateRef.current(() => setInboxUnread(workspace, conversationId, false)) }
        setMutationError("Não foi possível atualizar a leitura da conversa.")
      },
    )
  }, [result.data, workspace, conversationId])

  // A nova tentativa guardada usa o mutate da renderização em que for clicada (estado de ocupado atual).
  const mutateRef = React.useRef(mutate)
  mutateRef.current = mutate
  async function mutate(action: Mutation, after?: () => void) {
    if (busy) return
    setBusy(true)
    setMutationError(null)
    retryMutation.current = () => { void mutate(action, after) }
    try {
      const next = await action()
      if (!alive.current) return
      setUpdated(next)
      setClock(Date.now())
      onChangedRef.current()
      after?.()
    } catch (error) {
      if (alive.current) setMutationError(error instanceof Error ? error.message : "Não foi possível salvar a alteração.")
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const windowState = conversation ? inboxMessageWindow(conversation, clock) : null
  const cannotReply = mode === "reply" && (conversation?.status === "closed" || !windowState?.can_reply)
  const body = drafts[mode]

  // Menção abre a conversa já na nota: rola até ela uma vez, quando o histórico chega.
  React.useEffect(() => {
    if (!anchorMessageId || anchorShown.current || !conversation) return
    const element = document.getElementById(`mensagem-${anchorMessageId}`)
    if (element) { element.scrollIntoView({ block: "center" }); anchorShown.current = true }
  }, [anchorMessageId, conversation])

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const staged = mode === "reply" ? attachment : null
    if (!(body.trim() || staged) || cannotReply || busy) return
    const sendingMode = mode
    atBottom.current = true
    if (staged && conversation?.connection_id) {
      // The file leaves first, then the text as its own message; a retry never sends the file twice.
      let fileSent = false
      void mutate(async () => {
        const connectionId = conversation.connection_id!
        if (!fileSent) { await sendInboxAttachment(workspace, conversationId, { file: staged.file, kind: staged.option.kind, connection_id: connectionId }); fileSent = true; if (alive.current) setAttachment(null) }
        return body.trim() ? sendInboxMessage(workspace, conversationId, { body, kind: "reply" }) : getInboxConversation(workspace, conversationId)
      }, () => setDrafts((value) => ({ ...value, reply: "" })))
      return
    }
    void mutate(() => sendInboxMessage(workspace, conversationId, { body, kind: sendingMode, ...(sendingMode === "note" ? { mention_member_ids: mentioned.filter(m => body.includes(`@${m.name}`)).map(m => m.id) } : {}) }), () => setDrafts((value) => ({ ...value, [sendingMode]: "" })))
  }

  function focusComposer() { requestAnimationFrame(() => composerRef.current?.focus()) }

  const insertEmoji = (emoji: string) => {
    const node = composerRef.current
    const at = insertAtCursor(body, node?.selectionStart ?? body.length, node?.selectionEnd ?? body.length, emoji)
    setDrafts(value => ({ ...value, [mode]: at.text }))
    requestAnimationFrame(() => { node?.focus(); node?.setSelectionRange(at.cursor, at.cursor) })
  }

  // Enter envia, Shift+Enter quebra a linha (como no Direct e no ManyChat). Com a lista de respostas salvas ou de menções aberta, Enter não envia.
  function onComposerKey(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
    if (mode === "reply" && body.startsWith("/")) return
    if (mode === "note" && /(?:^|\s)@[^\s@]*$/u.test(body)) return
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }

  // A caixa cresce com o texto até ~6 linhas; depois rola por dentro.
  React.useLayoutEffect(() => {
    const node = composerRef.current
    if (!node) return
    node.style.height = "auto"
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`
  }, [body, mode])

  const automationPaused = !!conversation?.automation_paused_until && Date.parse(conversation.automation_paused_until) > clock

  return (
    <div className="relative flex h-[calc(100dvh-var(--header))] min-w-0 flex-col overflow-hidden border-border bg-surface lg:h-full lg:rounded-lg lg:border">
      {result.error ? <div className="p-4"><Button size="sm" variant="ghost" className="mb-3 xl:hidden" onClick={onBack}><ArrowLeft className="size-4" aria-hidden="true" />Todas as conversas</Button><InboxLoadError onRetry={result.reload} /></div> : !conversation ? (
        <div className="space-y-5 p-4" role="status" aria-label="Carregando histórico"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-10 w-full" /><Skeleton className="h-24 w-3/4" /><Skeleton className="ml-auto h-24 w-3/4" /><Skeleton className="h-20 w-full" /></div>
      ) : (
        <>
          <header className="relative z-20 flex shrink-0 items-center gap-1 border-b sm:gap-2 border-border bg-surface px-2 py-2 sm:px-3">
            <Button size="icon" variant="ghost" className="size-8 shrink-0 xl:hidden" aria-label="Todas as conversas" onClick={onBack}><ArrowLeft className="size-4" aria-hidden="true" /></Button>
            <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left outline-offset-2" aria-label={`Ver dados de ${conversation.contact.name}`} aria-expanded={panelOpen} onClick={() => setPanelOpen(value => !value)}>
              <AvatarInitials name={conversation.contact.name} src={conversation.contact.avatar_url} className="size-9 shrink-0" />
              <span className="min-w-0 flex-1">
                <h2 ref={headingRef} tabIndex={-1} className="truncate rounded-sm text-sm font-semibold" title={conversation.contact.name}>{conversation.contact.name}</h2>
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-text-muted">
                  <span className={cn("size-1.5 shrink-0 rounded-full", conversation.status === "open" ? "bg-success" : "bg-text-muted")} aria-hidden="true" />
                  <span className="truncate">{conversation.connection_name || inboxChannelLabels[conversation.channel]} · {conversation.status === "open" ? "Em atendimento" : "Conversa encerrada"}{conversation.reminder_at ? ` · Lembrete ${new Date(conversation.reminder_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}` : ""}</span>
                </span>
              </span>
            </button>
            {conversation.labels?.length ? <span className="hidden min-w-0 max-w-48 shrink overflow-hidden 2xl:block"><LabelChips labels={conversation.labels} /></span> : null}
            <fieldset disabled={!canReply} className="flex shrink-0 items-center gap-1">
              <div className="hidden w-44 md:block">
                <Label htmlFor="inbox-assignee" className="sr-only">Responsável pelo atendimento</Label>
                <AssigneeSelect id="inbox-assignee" value={conversation.assignee_id} members={members} disabled={busy} onChange={value => { void mutate(() => assignInboxConversation(workspace, conversationId, value)) }} />
              </div>
              <Button size="sm" variant={conversation.status === "open" ? "secondary" : "primary"} className="h-8 px-2.5" disabled={busy} title={conversation.status === "open" ? "Encerrar o atendimento" : "Reabrir o atendimento"} onClick={() => { void mutate(() => setInboxStatus(workspace, conversationId, conversation.status === "open" ? "closed" : "open")) }}>
                {conversation.status === "open" ? <CheckCheck className="size-4" aria-hidden="true" /> : <RotateCcw className="size-4" aria-hidden="true" />}<span className="max-sm:sr-only">{conversation.status === "open" ? "Encerrar" : "Reabrir"}</span>
              </Button>
              <ConversationLabels compact conversationId={conversationId} current={conversation.labels ?? []} disabled={busy} onChanged={() => { result.reload(); onChangedRef.current() }} />
            </fieldset>
            <Button size="icon" variant={panelOpen ? "secondary" : "ghost"} className="size-8 shrink-0 max-sm:hidden" aria-label="Dados do contato" title="Dados do contato" aria-pressed={panelOpen} onClick={() => setPanelOpen(value => !value)}><PanelRight className="size-4" aria-hidden="true" /></Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="size-8 shrink-0" aria-label="Mais ações da conversa" title="Mais ações"><EllipsisVertical className="size-4" aria-hidden="true" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent className="min-w-56">
                {canReply && !isFakeMode() ? <DropdownMenuItem disabled={busy} onSelect={() => setForm("automation")}><Play className="size-4" aria-hidden="true" />Rodar automação</DropdownMenuItem> : null}
                {canReply ? <DropdownMenuItem disabled={busy} onSelect={() => setForm("reminder")}><Clock3 className="size-4" aria-hidden="true" />{conversation.reminder_at ? "Editar lembrete" : "Lembrete"}</DropdownMenuItem> : null}
                {canReply && !isFakeMode() ? <DropdownMenuItem disabled={busy} onSelect={() => setForm("scheduled")}><CalendarClock className="size-4" aria-hidden="true" />Agendar mensagem</DropdownMenuItem> : null}
                {canReply && automationPaused ? <DropdownMenuItem disabled={busy} onSelect={() => { void mutate(() => resumeInboxAutomations(workspace, conversationId)) }}><RotateCcw className="size-4" aria-hidden="true" />Retomar automações</DropdownMenuItem> : null}
                {canReply ? <DropdownMenuItem disabled={busy} onSelect={() => { leaving.current = true; void mutate(() => setInboxUnread(workspace, conversationId, true), onUnread).finally(() => { leaving.current = false }) }}><Mail className="size-4" aria-hidden="true" />Deixar não lida</DropdownMenuItem> : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={busy || !canEdit} className="text-danger" onSelect={() => setDeleting(true)}><Trash2 className="size-4" aria-hidden="true" />Excluir contato</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {canReply ? <>
              <InboxRunAutomation trigger={false} conversationId={conversationId} disabled={busy} open={form === "automation"} onOpenChange={open => setForm(open ? "automation" : null)} onDone={() => { result.reload(); onChangedRef.current() }} />
              <InboxReminder trigger={false} open={form === "reminder"} onOpenChange={open => setForm(open ? "reminder" : null)} at={conversation.reminder_at} note={conversation.reminder_note ?? null} busy={busy} onSave={(at, note) => { void mutate(() => setInboxReminder(workspace, conversationId, at, note)) }} />
            </> : null}
          </header>
          {deleting ? <DeleteContactDialog workspace={workspace} ids={[conversation.contact.id]} name={conversation.contact.name} onClose={() => setDeleting(false)} onDeleted={onDeleted} /> : null}
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              {conversation.connection_profile?.email && conversation.opted_in === false ? <div className="shrink-0 px-3 pt-3"><Banner variant="warning">Marketing por e-mail desativado. Respostas humanas continuam disponíveis.</Banner></div> : null}
              {mutationError ? <div className="shrink-0 px-3 pt-3"><Banner variant="danger"><p>{mutationError}</p><Button size="sm" variant="secondary" className="mt-2" onClick={() => retryMutation.current ? retryMutation.current() : result.reload()} disabled={busy}>Tentar de novo</Button></Banner></div> : null}
              <div ref={historyRef} onScroll={event => { const node = event.currentTarget; atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < node.clientHeight * 0.1 }} role="log" aria-label="Histórico da conversa" aria-live="polite" aria-relevant="additions" tabIndex={0} className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-surface-muted px-3 py-4 sm:px-5">
                {hasOlderInboxMessages(conversationId) ? <div className="flex justify-center"><Button size="sm" variant="secondary" disabled={busy} onClick={async () => {
                  const node = historyRef.current
                  const height = node?.scrollHeight ?? 0
                  const top = node?.scrollTop ?? 0
                  loadingOlder.current = true
                  await mutate(() => loadOlderInboxMessages(workspace, conversationId))
                  requestAnimationFrame(() => { if (node) node.scrollTop = top + node.scrollHeight - height; loadingOlder.current = false })
                }}>Carregar mensagens anteriores</Button></div> : null}
                {conversation.messages.length ? conversation.messages.map((message) => <div key={message.id} id={`mensagem-${message.id}`} className={cn("rounded-md transition-shadow", anchorMessageId === message.id && "ring-2 ring-accent")}><InboxTimelineItem message={message} busy={busy} onRetry={() => { void mutate(() => message.template ? sendInboxTemplate(workspace, conversationId, message.template) : sendInboxMessage(workspace, conversationId, { body: message.body, kind: message.source === "note" ? "note" : "reply" })) }} /></div>) : <p className="py-12 text-center text-sm text-text-muted">Este histórico ainda não tem mensagens.</p>}
              </div>
              {canReply ? <InboxScheduled compact conversationId={conversationId} disabled={busy} open={form === "scheduled"} onOpenChange={open => setForm(open ? "scheduled" : null)} /> : null}
              {!canReply ? <p role="note" className="shrink-0 border-t border-border p-4 text-sm text-text-muted">Seu papel permite ler as conversas, não responder.</p> : <form onSubmit={submit} className="shrink-0 space-y-2 border-t border-border bg-surface px-3 pt-2 pb-3">
                <div className="flex flex-wrap items-center gap-1">
                  <div className="flex rounded-md bg-surface-muted p-0.5" role="group" aria-label="Tipo de mensagem">
                    <button type="button" aria-pressed={mode === "reply"} onClick={() => { setMode("reply"); focusComposer() }} className={cn("flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-xs font-semibold text-text-muted transition-colors", mode === "reply" && "bg-surface text-text shadow-sm")}><Send className="size-3.5" aria-hidden="true" />Responder</button>
                    <button type="button" aria-pressed={mode === "note"} onClick={() => { setMode("note"); focusComposer() }} className={cn("flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-xs font-semibold text-text-muted transition-colors", mode === "note" && "bg-warning-soft text-text shadow-sm")}><StickyNote className="size-3.5" aria-hidden="true" />Nota da equipe</button>
                  </div>
                  {mode === "note" && windowState?.state !== "closed" && windowState?.state !== "manual_only" ? <p id="inbox-note-help" className="px-1 text-xs text-text-muted">Só a equipe vê. Digite @ para mencionar.</p> : null}
                  {automationPaused ? <p className="ml-auto flex items-center gap-1 text-xs text-text-muted"><Clock3 className="size-3 shrink-0" aria-hidden="true" />Automações pausadas até {new Date(conversation.automation_paused_until!).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</p> : null}
                </div>
                {windowState?.state === "closed" ? (
                  <Banner variant="warning"><span id="inbox-window-warning">{conversation.reply_policy ? <>A janela para texto livre terminou.{conversation.connection_profile?.window?.humanAgentDays ? ` Já passaram mais de ${conversation.connection_profile.window.humanAgentDays} dias desde a última mensagem do contato, o limite do atendimento humano neste canal, e o envio está bloqueado.` : ""} {conversation.reply_policy?.template_connection_id ? "Envie um modelo aprovado para continuar o contato." : "Aguarde uma nova mensagem do contato."} Você pode registrar uma nota interna.</> : <>{conversation.connection_profile?.window ? <>A janela de {conversation.connection_profile?.window?.standardHours ?? 24} horas está fechada. Aguarde uma nova mensagem do contato{conversation.connection_profile?.window?.outside === "template" ? " ou use um modelo aprovado nesta conexão" : ""}. Você pode registrar uma nota interna.</> : <>A conexão não permite responder nesta janela. Aguarde uma nova mensagem do contato. Você pode registrar uma nota interna.</>}</>}</span></Banner>
                ) : windowState?.state === "manual_only" ? (
                  <Banner variant="warning"><span id="inbox-window-warning">{conversation.reply_policy ? <>Atendimento humano estendido. Sua resposta será enviada com a etiqueta de atendimento humano até {windowState.expires_at ? new Date(windowState.expires_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "o fim da janela"}.</> : <>A janela de {conversation.connection_profile?.window?.standardHours ?? 24} horas está fechada. Nesta conexão, o atendimento humano pode continuar por até {conversation.connection_profile?.window?.humanAgentDays ?? 7} dias da última mensagem recebida; as automações ficam restritas.</>}</span></Banner>
                ) : null}
                {windowState?.state === "closed" && conversation.reply_policy?.template_connection_id && mode === "reply" ? <Button type="button" size="sm" variant="secondary" disabled={busy || conversation.status === "closed"} onClick={() => setTemplateOpen(true)}><FileText className="size-4" aria-hidden="true" />Enviar modelo aprovado</Button> : null}
                {templateOpen && conversation.reply_policy?.template_connection_id ? <InboxTemplateDialog connectionId={conversation.reply_policy.template_connection_id} busy={busy} onClose={() => setTemplateOpen(false)} onSend={async template => {
                  setBusy(true)
                  try {
                    const next = await sendInboxTemplate(workspace, conversationId, template)
                    if (alive.current) { setUpdated(next); setClock(Date.now()); onChangedRef.current() }
                  } finally { if (alive.current) setBusy(false) }
                }} /> : null}
                {conversation.status === "closed" && mode === "reply" ? <p id="inbox-closed-help" className="text-xs font-semibold text-warning">Reabra esta conversa para continuar o atendimento.</p> : null}
                <InboxComposerTools mode={mode} body={body} members={members} disabled={busy || cannotReply} onBody={text => { focusInsertion.current = true; setDrafts(value => ({ ...value, [mode]: text })) }} onMention={member => setMentioned(value => [...value.filter(m => m.id !== member.id), member])} />
                {mode === "reply" && attachment ? <InboxStagedAttachment attachment={attachment} disabled={busy} onRemove={() => setAttachment(null)} /> : null}
                <div className={cn("rounded-lg border border-border-input bg-surface focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20", mode === "note" && "bg-warning-soft", cannotReply && "opacity-70")}>
                  <Label htmlFor="inbox-message" className="sr-only">{mode === "note" ? "Anotação interna" : "Sua resposta"}</Label>
                  <Textarea ref={composerRef} id="inbox-message" rows={1} value={body} maxLength={4000} disabled={busy || cannotReply} onKeyDown={onComposerKey} onChange={(event) => setDrafts((value) => ({ ...value, [mode]: event.target.value }))} aria-describedby={["inbox-message-count", windowState?.state === "closed" || windowState?.state === "manual_only" ? "inbox-window-warning" : "", conversation.status === "closed" && mode === "reply" ? "inbox-closed-help" : "", mode === "note" && windowState?.state !== "closed" && windowState?.state !== "manual_only" ? "inbox-note-help" : ""].filter(Boolean).join(" ")} placeholder={mode === "note" ? "Escreva uma nota para a equipe…" : "Escreva sua resposta… (/ abre as respostas salvas)"} className="min-h-10 resize-none border-0 bg-transparent px-3 shadow-none focus-visible:ring-0 focus-visible:outline-none" />
                  <div className="flex items-end gap-1 px-1.5 pb-1.5">
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 [&_button]:h-8 [&_button]:px-2 [&_button]:text-xs">
                    <Button type="button" size="sm" variant="ghost" className="lg:hidden" aria-expanded={toolsOpen} onClick={() => setToolsOpen(value => !value)}>Mais opções</Button>
                    <div className={cn("contents", !toolsOpen && "max-lg:hidden")}>
                      <InboxEmojiPicker disabled={busy || cannotReply} onPick={insertEmoji} />
                      {mode === "reply" ? <InboxAttachButtons options={attachmentOptions(conversation.connection_profile)} disabled={busy || cannotReply} onPick={setAttachment} onError={setMutationError} /> : null}
                      {mode === "reply" ? <div className="min-w-0 has-[[role=group]]:basis-full"><VariablePicker fields={fields.data ?? []} loading={fields.loading && !fields.data} error={!!fields.error} onRetry={fields.reload} targetRef={composerRef} value={body} disabled={busy || cannotReply} onChange={text => setDrafts(value => ({ ...value, reply: text }))} /></div> : null}
                    </div>
                    </div>
                    <span id="inbox-message-count" className={cn("shrink-0 self-center px-1 text-xs text-text-muted tabular-nums", body.length < 3500 && !isFakeMode() && "sr-only")}>{body.length.toLocaleString("pt-BR")} / 4.000{isFakeMode() ? " · Demonstração: alterações somente nesta sessão." : ""}</span>
                    <Button type="submit" size="sm" className="h-8 shrink-0" loading={busy} disabled={!(body.trim() || mode === "reply" && attachment) || cannotReply}><Send className="size-4" aria-hidden="true" /><span className="max-sm:sr-only">{sendLabel(mode, conversation.channel)}</span></Button>
                  </div>
                </div>
              </form>}
            </div>
            {panelOpen ? <ContactPanel conversation={conversation} members={members} canReply={canReply} canEdit={canEdit} busy={busy} onClose={() => setPanelOpen(false)} onAssign={value => { void mutate(() => assignInboxConversation(workspace, conversationId, value)) }} onDelete={() => setDeleting(true)} /> : null}
          </div>
        </>
      )}
    </div>
  )
}

function AssigneeSelect({ id, value, members, disabled, onChange }: { id: string; value: string | null; members: InboxMember[]; disabled: boolean; onChange: (value: string | null) => void }) {
  return <Select value={value ?? "__none"} disabled={disabled} onValueChange={next => onChange(next === "__none" ? null : next)}>
    <SelectTrigger id={id} className="h-8 text-xs"><SelectValue /></SelectTrigger>
    <SelectContent><SelectItem value="__none">Ainda sem responsável</SelectItem>{members.map((member) => <SelectItem key={member.id} value={member.id}>{member.name}</SelectItem>)}</SelectContent>
  </Select>
}

/** Painel lateral recolhível: dados do contato, notas e a zona de perigo, fora da visão principal da conversa. */
function ContactPanel({ conversation, members, canReply, canEdit, busy, onClose, onAssign, onDelete }: { conversation: InboxConversation; members: InboxMember[]; canReply: boolean; canEdit: boolean; busy: boolean; onClose: () => void; onAssign: (value: string | null) => void; onDelete: () => void }) {
  const notes = conversation.messages.filter((message) => message.source === "note")
  return (
    <aside aria-label="Dados do contato" className="flex w-[min(20rem,100%)] shrink-0 flex-col overflow-y-auto border-l border-border bg-surface max-xl:absolute max-xl:inset-y-0 max-xl:right-0 max-xl:z-30 max-xl:shadow-pop xl:w-72">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <UserRound className="size-4 text-text-muted" aria-hidden="true" />
        <h3 className="flex-1 text-sm font-semibold">Dados do contato</h3>
        <Button size="icon" variant="ghost" className="size-8" aria-label="Fechar dados do contato" onClick={onClose}><X className="size-4" aria-hidden="true" /></Button>
      </div>
      <div className="flex-1 space-y-5 p-4">
        <div className="flex items-center gap-3">
          <AvatarInitials name={conversation.contact.name} src={conversation.contact.avatar_url} className="size-12" />
          <div className="min-w-0"><p className="font-semibold wrap-anywhere">{conversation.contact.name}</p><p className="text-xs text-text-muted wrap-anywhere">{conversation.contact.username}</p></div>
        </div>
        <fieldset disabled={!canReply} className="space-y-1 md:hidden">
          <Label htmlFor="inbox-assignee-panel">Responsável pelo atendimento</Label>
          <AssigneeSelect id="inbox-assignee-panel" value={conversation.assignee_id} members={members} disabled={busy} onChange={onAssign} />
        </fieldset>
        {conversation.labels?.length ? <div className="space-y-2"><h4 className="text-xs font-semibold text-text-muted">Etiquetas</h4><LabelChips labels={conversation.labels} /></div> : null}
        <dl className="grid min-w-0 gap-3 text-xs">
          <div className="min-w-0"><dt className="text-text-muted">E-mail</dt><dd className="mt-0.5 wrap-anywhere">{conversation.contact.email || "—"}</dd></div>
          <div className="min-w-0"><dt className="text-text-muted">Fuso horário</dt><dd className="mt-0.5 wrap-anywhere">{conversation.contact.timezone || "—"}</dd></div>
          {conversation.contact.fields.map((field) => <div key={field.name} className="min-w-0"><dt className="text-text-muted">{field.name}</dt><dd className="mt-0.5 wrap-anywhere">{field.value}</dd></div>)}
        </dl>
        <div className="space-y-2"><h4 className="text-xs font-semibold text-text-muted">Marcadores</h4>{conversation.contact.tags.length ? <div className="flex flex-wrap gap-1.5">{conversation.contact.tags.map((tag) => <span key={tag} className="rounded-pill border border-border bg-surface-muted px-2 py-0.5 text-xs">{tag}</span>)}</div> : <p className="text-xs text-text-muted">Nenhum marcador.</p>}</div>
        <div className="space-y-2"><h4 className="text-xs font-semibold text-text-muted">Notas da equipe ({notes.length})</h4>{notes.length ? notes.map((note) => <p key={note.id} className="rounded-md bg-warning-soft p-2 text-xs wrap-anywhere">{note.body}</p>) : <p className="text-xs text-text-muted">Ainda não há notas para este contato.</p>}</div>
      </div>
      <section aria-label="Zona de perigo" className="border-t border-border p-4">
        <h4 className="text-xs font-semibold text-danger">Zona de perigo</h4>
        <p className="mt-1 text-xs text-text-muted">Excluir o contato apaga a pessoa e todas as conversas dela, em todos os canais.</p>
        <Button size="sm" variant="secondary" className="mt-2 border-danger text-danger" disabled={busy || !canEdit} onClick={onDelete}><Trash2 className="size-4" aria-hidden="true" />Excluir contato</Button>
      </section>
    </aside>
  )
}
