import { ArrowRightLeft, Bot, Clock3, ListRestart, Mail, PauseCircle, StickyNote, Tag, UserRound, Zap } from "lucide-react"
import type { InboxMessage, InboxSystemEvent } from "@/data/inbox"
import { cn } from "@/lib/utils"
import { timeAgo } from "@/lib/time"
import { Button } from "@/components/ui/button"
import { InboxAttachments, InboxReaction } from "./inbox-attachments"

const dateAndTime = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
const fieldValue = (value: unknown) => value === null || value === undefined || value === "" ? "vazio" : typeof value === "boolean" ? value ? "sim" : "não" : typeof value === "object" ? JSON.stringify(value) : String(value)

function systemDescription(event?: InboxSystemEvent, body?: string) {
  if (!event) return { Icon: ListRestart, text: body || "Atividade registrada na conversa" }
  switch (event.kind) {
    case "tag_added": return { Icon: Tag, text: `Marcador incluído: ${event.tag_name}` }
    case "tag_removed": return { Icon: Tag, text: `Marcador retirado: ${event.tag_name}` }
    case "field_changed": return { Icon: ListRestart, text: `${event.field_name}: ${fieldValue(event.previous_value)} → ${fieldValue(event.value)}` }
    case "field_skipped": return { Icon: ListRestart, text: `${event.field_name}: operação ignorada, ${event.reason === "operand" ? "o valor informado não é um número" : "o valor atual do campo não é um número"}` }
    case "delay_started": return { Icon: Clock3, text: `${event.automation_name} aguarda até ${dateAndTime(event.ends_at)}` }
    case "trigger": {
      const origins: Record<string, string> = { ig_comment: "Entrada por comentário", dm_keyword: "Entrada por palavra-chave", keyword: "Entrada por palavra-chave", ref_url: "Entrada por link", story_mention: "Entrada por menção no story", story_mention_reply: "Entrada por menção no story", ig_story_mention: "Entrada por menção no story", ig_story_reply: "Entrada por resposta a story", welcome: "Entrada por boas-vindas", welcome_message: "Entrada por boas-vindas", another_flow: "Entrada por outra automação", manual: "Iniciada pela equipe" }
      return { Icon: Zap, text: `${origins[event.trigger_kind] ?? "Entrada na automação"}: ${event.automation_name}` }
    }
    case "status_changed": {
      const states = { open: "aberta", closed: "encerrada" }
      return { Icon: ArrowRightLeft, text: `Situação alterada: ${states[event.previous_status]} → ${states[event.status]}` }
    }
    case "automation_paused": return { Icon: PauseCircle, text: event.until ? `Atendimento humano: automações em pausa até ${dateAndTime(event.until)}` : "Automações liberadas após o atendimento humano" }
    default: return { Icon: ListRestart, text: "Atividade registrada na conversa" }
  }
}

/** O que o corpo mostra quando o contato mandou algo além de texto: só a legenda ou o texto do pedido; o resto (descrição automática) já está no cartão. */
const hasAttachments = (message: InboxMessage) => Boolean(message.media || message.location || message.shared_contacts?.length || message.order)
function bodyOf(message: InboxMessage) {
  if (message.media) return message.media.caption ?? ""
  if (message.location || message.shared_contacts?.length || message.order) return ""
  return message.body
}

export function InboxTimelineItem({ message, busy, onRetry, workspaceId }: { message: InboxMessage; busy: boolean; onRetry: () => void; workspaceId?: string }) {
  if (message.source === "system") {
    const { Icon, text } = systemDescription(message.event, message.body)
    return (
      <article data-inbox-event={message.event?.kind ?? "unknown"} aria-label="Atividade do sistema" className="flex justify-center py-1 text-center text-xs text-text-muted">
        <div className="flex min-w-0 max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1">
          <Icon className="size-3 shrink-0" aria-hidden="true" />
          <span className="min-w-0 wrap-anywhere">{text}</span>
          <time className="text-2xs" dateTime={message.created_at} title={new Date(message.created_at).toLocaleString("pt-BR")}>{new Date(message.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</time>
        </div>
      </article>
    )
  }
  // Origem desconhecida (ex.: transmissão) é tratada como automação, e autor ausente nunca derruba a linha do tempo.
  const kind = (["contact", "automation", "human", "note"] as const).find(value => value === message.source) ?? "automation"
  const outgoing = kind === "human" || kind === "automation"
  const sourceLabels = { contact: "Contato", automation: "Automação", human: "Atendimento humano", note: "Nota interna" }
  const label = sourceLabels[kind]
  const authorName = (message.author ?? "").trim()
  const author = kind !== "contact" && authorName.toLocaleLowerCase("pt-BR") !== label.toLocaleLowerCase("pt-BR") ? authorName : ""
  const Icon = { contact: UserRound, automation: Bot, human: UserRound, note: StickyNote }[kind]
  return (
    <article className={cn("max-w-full space-y-1", outgoing && "ml-auto w-5/6", kind === "contact" && "mr-auto w-5/6")}>
      <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-text-muted", outgoing && "justify-end")}><Icon className="size-3" aria-hidden="true" /><span>{label}</span>{author ? <span className="truncate" title={author}>{author}</span> : null}</div>
      <div className={cn("rounded-lg border border-border p-3 text-sm whitespace-pre-wrap wrap-anywhere", kind === "contact" && "bg-surface", kind === "automation" && "border-dashed bg-node-condition", kind === "human" && "border-accent/20 bg-accent-soft", kind === "note" && "border-warning/20 bg-warning-soft")}>
        {message.email_subject ? <p className="mb-2 flex items-center gap-2 font-semibold"><Mail className="size-4 shrink-0" aria-hidden="true" />E-mail enviado: {message.email_subject}</p> : null}
        {hasAttachments(message) ? <InboxAttachments message={message} workspaceId={workspaceId} own={outgoing} /> : null}
        {message.source === "automation" && message.email_subject ? null : hasAttachments(message) ? (bodyOf(message) ? <p className="mt-2">{bodyOf(message)}</p> : null) : bodyOf(message)}
        {message.buttons?.length ? <ul aria-label="Opções da automação" className="mt-3 space-y-2">{message.buttons.map(button => <li key={button.id} className="rounded-md border border-border bg-surface p-2 text-center text-xs">{button.title}</li>)}</ul> : null}
      </div>
      {message.status === "failed" ? <div role="alert" className="space-y-2 text-xs text-danger"><p>{message.error || "A mensagem não pôde ser enviada."}</p>{message.source !== "contact" && !message.media ? <Button size="sm" variant="secondary" disabled={busy} onClick={onRetry}>Tentar de novo</Button> : null}</div> : message.status ? <p className="text-2xs text-text-muted">{message.status === "delivered" ? "Entregue" : "Enviada"}</p> : null}
      {message.reaction ? <div className={cn(outgoing && "text-right")}><InboxReaction emoji={message.reaction.emoji} /></div> : null}
      <p className={cn("text-2xs text-text-muted", outgoing && "text-right")}><time dateTime={message.created_at} title={new Date(message.created_at).toLocaleString("pt-BR")}>{timeAgo(message.created_at)}</time></p>
    </article>
  )
}
