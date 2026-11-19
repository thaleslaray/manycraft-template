import { toast } from "sonner"
import { CardsEditor, cardsProfiles, isCards, cardsIssue } from "./cards-block"
import { MediaEditor, mediaIcons } from "./media-block"
import { QuickReplyEditor, QuickReplySettings, isQuickReply, quickRepliesError, quickReplyProfiles, sharedQuickReplyLimits, SKIP_LABEL } from "./quick-reply-block"
import { ListEditor } from "./list-editor"
import { emptyList, isListBlock, listError, listProfiles, sharedListLimits } from "./list-block"
import { mediaKinds, mediaLabels, mediaError, mediaProfiles } from "./media"
import { PENDING_CHANNEL, availableStepChannels, stepChannelLabels, stepChannelOf, stepConnections, stepOffer, textSize, unstableNotice, type StepChannel } from "./step-channel"
import * as React from "react"
import { cn } from "@/lib/utils"
import { useParams } from "react-router"
import { listConnections } from "@/data/connections"
import { useAsync } from "@/hooks/use-async"
import { EmailMessagePanel } from "./email-message-panel"
import { ArrowDown, ArrowUp, Plus, Trash2, Info, Type, Clock, ClipboardList, Ellipsis, ListChecks, Image as ImageIcon, FileText, GalleryHorizontal, RectangleHorizontal, Link2, CornerDownRight, Workflow, Tag, Tags, SquarePen, Eraser } from "lucide-react"
import type { MessageBlock } from "@/data"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { Input, Textarea } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SidePanel } from "@/components/ui/side-panel"
import {
  FIRST_MSG_MAX_BLOCKS,
  buttonLimitFor,
  TEXT_MAX,
  btnPort,
  getBlocks,
  isFirstAfterComment,
  isValidUrl,
  newButtonId,
  newQuickReplyId,
} from "./graph"
import { NodeErrors, NodeLinks, stepName, type PanelProps } from "./panel-shared"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { PORT_NEXT } from "./graph"
import { PrivateReplyBadge } from "./private-reply-badge"
import { VariablePicker, type VariableCatalogProps } from "./variable-picker"
import { Choice, FieldValue, CatalogNotice } from './logic-panels'
import { actionLabels, initialAction, initialFieldValue, type EditorAction } from './graph'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

type TextBlock = Extract<MessageBlock, { kind: "text" }>
type ButtonBlock = Extract<MessageBlock, { kind: "button" }>
type TypingBlock = Extract<MessageBlock, { kind: "typing" }>

export function MessagePanel(p: PanelProps) {
  const { workspace = '' } = useParams()
  const connections = useAsync(() => listConnections(workspace), `editor-connections:${workspace}`)
  const own = stepChannelOf(p.node.data.config)
  const boundIds = new Set(p.triggers.flatMap(trigger => trigger.channel_id ? [trigger.channel_id] : []))
  // Com canal escolhido no passo valem as conexões ligadas desse canal; sem ele (fluxo antigo), as do gatilho.
  const selected = own && own !== PENDING_CHANNEL ? stepConnections(p.node.data.config, p.triggers, connections.data ?? [])
    : connections.data?.filter(connection => p.triggers.some(trigger => trigger.channel_id === connection.id)) ?? []
  const profiles = selected.flatMap(connection => connection.profile?.email ? [connection.profile.email] : [])
  const complete = own && own !== PENDING_CHANNEL ? selected.length > 0 : selected.length === boundIds.size && selected.length
  const capability = complete && profiles.length === selected.length
    ? {...profiles[0],subjectMaxLength:Math.min(...profiles.map(profile=>profile.subjectMaxLength)),preheader:profiles.every(profile=>profile.preheader),html:profiles.every(profile=>profile.html)} : undefined
  if (connections.loading) return <SidePanel title="Mensagem" tone="message" onClose={p.onClose}><p role="status">Carregando a ficha da conexão…</p></SidePanel>
  if (connections.error) return <SidePanel title="Mensagem" tone="message" onClose={p.onClose}><Banner variant="danger">Não foi possível carregar a ficha da conexão.<Button size="sm" variant="secondary" onClick={connections.reload}>Tentar novamente</Button></Banner></SidePanel>
  if (capability) return <EmailMessagePanel p={p} capability={capability} />
  if (p.node.data.config.email && !capability) return <SidePanel title="Mensagem de e-mail" tone="message" onClose={p.onClose}><Banner variant="warning">A conexão do gatilho não oferece e-mail. Revise a conexão antes de editar este passo.</Banner></SidePanel>
  return <ChatMessagePanel {...p} />
}

export function ChatMessagePanel(p: PanelProps) {
  const blocks = getBlocks(p.node.data.config)
  const latestBlocks = React.useRef(blocks)
  React.useLayoutEffect(() => { latestBlocks.current = blocks }, [blocks])
  const off = p.readOnly
  const connections = stepConnections(p.node.data.config, p.triggers, p.connections ?? [])
  const offer = stepOffer(connections)
  // A frase da janela só faz sentido onde a ficha do canal declara janela de 24 horas (Meta); Telegram e afins não têm.
  const sendsInWindow = connections.length > 0 && connections.every(c => c.profile?.window?.standardHours === 24)
  const channel = stepChannelOf(p.node.data.config)
  const channelChoices = availableStepChannels(p.connections)
  const profiles = mediaProfiles(connections)
  const cardProfiles = cardsProfiles(connections)
  const variables: VariableCatalogProps = { fields: p.fields, botFields: p.botFields, loading: p.catalogLoading, error: p.catalogErrors?.fields, onRetry: p.reloadCatalogs }
  const restricted = isFirstAfterComment(p.node.id, p.nodes, p.edges, p.triggers)
  const texts = blocks.filter((b) => b.kind === "text").length
  const buttons = blocks.filter((b) => b.kind === "button").length
  const typing = blocks.filter((b) => b.kind === "typing").length
  const replies = blocks.filter(isQuickReply)
  const replyLimits = sharedQuickReplyLimits(connections)
  // One notice per kind, under the last block that needs it: two buttons do not repeat the same warning.
  const notices = blocks.map(b => unstableNotice(b, offer))
  const buttonCap = buttonLimitFor(connections)
  const lists = blocks.filter(isListBlock)
  const listLimit = sharedListLimits(connections)
  const listIssue = listError(blocks, listProfiles(connections))
  const replyIssue = quickRepliesError(blocks, quickReplyProfiles(connections), p.node.data.config)
  const overRestricted = restricted && (texts > FIRST_MSG_MAX_BLOCKS.text || buttons > FIRST_MSG_MAX_BLOCKS.button || typing > 0 || blocks.some(b => b.kind === "button" && b.action.type !== "url" && b.action.type !== "go_to_node"))

  const canText = !off && !(restricted && texts >= FIRST_MSG_MAX_BLOCKS.text)
  // A lista é uma mensagem interativa só: não divide o texto com botões nem respostas rápidas, e cada mensagem leva uma.
  const canList = !off && !restricted && !!listLimit && lists.length === 0 && buttons === 0 && replies.length === 0
  const canButton = !off && replies.length === 0 && lists.length === 0 && buttons < (restricted ? FIRST_MSG_MAX_BLOCKS.button : buttonCap)
  const canReply = !off && !restricted && buttons === 0 && lists.length === 0 && !!replyLimits && replies.length < replyLimits.max
  const canSkip = canReply && replies.length > 0 && !replies.some(r => r.skip)
  // Digitação, limites de texto e de título de botão vêm da ficha das conexões do canal escolhido; sem canal (fluxo antigo) vale o comportamento anterior.
  const hasChannel = !!channel && channel !== PENDING_CHANNEL
  const showTyping = !hasChannel || !!offer.typing
  const typingMax = hasChannel && offer.typing ? Math.min(10, offer.typing.maxSeconds) : 10
  const textLimit = hasChannel && offer.text ? offer.text : { max: TEXT_MAX, unit: "chars" as const }
  const buttonTitleMax = hasChannel && offer.buttons ? offer.buttons.titleMax : 4096
  const postbackOk = !hasChannel || !offer.buttons || offer.buttons.types.includes("postback")
  const canTyping = !off && !restricted

  const name = stepName(p, "Enviar mensagem")
  const [more, setMore] = React.useState(false)
  const [openButtons, setOpenButtons] = React.useState<string[]>(() => blocks.flatMap(b => b.kind === "button" && !b.label ? [b.id] : []))
  const nextLinked = p.edges.some(e => e.source === p.node.id && (e.sourceHandle ?? PORT_NEXT) === PORT_NEXT)
  const set = (next: MessageBlock[]) => p.updateConfig({ blocks: next })
  const replace = (i: number, b: MessageBlock) => set(blocks.map((x, j) => (j === i ? b : x)))
  const remove = (i: number) => {
    const b = blocks[i]
    if (b.kind === "button" || isQuickReply(b)) p.setLink(btnPort(b.id), null)
    if (isListBlock(b)) b.sections.forEach(section => section.rows.forEach(row => p.setLink(btnPort(row.id), null)))
    const rest = blocks.filter((_, j) => j !== i)
    // Sem respostas rápidas, a retomada configurada deixa de valer.
    if (isQuickReply(b) && !rest.some(isQuickReply)) p.updateConfig({ blocks: rest, click_timeout: undefined, reply_attempts: undefined })
    else set(rest)
  }
  const move = (i: number, d: -1 | 1) => {
    const next = [...blocks]
    ;[next[i], next[i + d]] = [next[i + d], next[i]]
    set(next)
  }

  const renderBlock = (b: MessageBlock, i: number) => {
    const isButton = b.kind === "button"
    const expanded = !isButton || openButtons.includes(b.id)
    return (
    <div key={b.kind === "button" || isQuickReply(b) ? b.id : i} className={cn("group/item relative space-y-2", isButton && "border-t border-border")}>
      <h3 className="sr-only">
        {b.kind === "card" ? "Card" : b.kind === "gallery" ? "Galeria" : b.kind === "text" ? "Texto" : b.kind === "button" ? "Botão" : isQuickReply(b) ? (b.skip ? SKIP_LABEL : "Resposta rápida") : isListBlock(b) ? "Lista de opções" : b.kind === "media" ? mediaLabels[b.media] : "Digitação"}
      </h3>
      {!isButton && b.kind !== "text" ? <p aria-hidden="true" className="text-xs font-semibold text-text-muted">{b.kind === "card" ? "Card" : b.kind === "gallery" ? "Galeria" : isQuickReply(b) ? (b.skip ? SKIP_LABEL : "Resposta rápida") : isListBlock(b) ? "Lista de opções" : b.kind === "media" ? mediaLabels[b.media] : "Digitação"}</p> : null}
      <div className="absolute right-1 bottom-full z-10 mb-0.5 flex items-center rounded-md border border-border bg-surface/95 opacity-0 shadow-card transition-opacity focus-within:opacity-100 group-hover/item:opacity-100">
        <Button variant="ghost" size="sm" aria-label={`Subir bloco ${i + 1}`} disabled={off || i === 0} onClick={() => move(i, -1)}>
          <ArrowUp className="size-4" aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="sm" aria-label={`Descer bloco ${i + 1}`} disabled={off || i === blocks.length - 1} onClick={() => move(i, 1)}>
          <ArrowDown className="size-4" aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="sm" aria-label={`Remover bloco ${i + 1}`} disabled={off} onClick={() => remove(i)}>
          <Trash2 className="size-4" aria-hidden="true" />
        </Button>
      </div>
      {isButton ? <button type="button" aria-label={`${expanded ? "Recolher" : "Editar"} botão ${b.label || "sem título"}`} aria-expanded={expanded} onClick={() => setOpenButtons(ids => ids.includes(b.id) ? ids.filter(x => x !== b.id) : [...ids, b.id])}
        className="relative flex h-11 w-full items-center justify-center gap-2 px-10 text-sm font-semibold text-text transition-colors hover:bg-surface-muted">
        <span className={cn("truncate", !b.label && "font-normal text-text-muted")}>{b.label || "Botão sem título"}</span>
        {b.action.type === "url" ? <Link2 className="size-4 shrink-0 text-text-muted" aria-hidden="true" /> : null}
        <span aria-hidden="true" className={cn("absolute right-3 top-1/2 size-2.5 -translate-y-1/2 rounded-full border-2", p.edges.some(e => e.source === p.node.id && e.sourceHandle === btnPort(b.id)) ? "border-accent bg-accent" : "border-text-muted/50 bg-surface")} />
      </button> : null}
      {isCards(b) ? <CardsEditor block={b} siblings={blocks} disabled={off} connections={connections} onChange={nb => replace(i, nb)} /> : b.kind === "text" ? (
        <TextEditor block={b} index={i} disabled={off} limit={textLimit} variables={variables} onChange={(nb) => replace(i, nb)} />
      ) : b.kind === "button" ? (
        expanded ? <div role="group" aria-label={`Botão ${b.label || "sem título"}`} className="border-t border-border bg-surface-muted/40 p-3"><ButtonEditor
          panel={p}
          block={b}
          disabled={off}
          linkOnly={restricted}
          urlOnly={!postbackOk}
          titleMax={buttonTitleMax}
          variables={variables}
          showErrors={p.showErrors}
          onChange={(nb) => replace(i, nb)}
        /></div> : null
      ) : isListBlock(b) ? (
        listLimit ? <ListEditor block={b} limits={listLimit} disabled={off} onChange={nb => replace(i, nb)} onRemoveRow={rowId => p.setLink(btnPort(rowId), null)} />
          : <p className="text-sm text-text-muted">As conexões deste canal não oferecem lista de opções. Tire este bloco para poder publicar.</p>
      ) : isQuickReply(b) ? (
        <QuickReplyEditor block={b} index={replies.indexOf(b) + 1} limits={replyLimits} disabled={off} onChange={nb => replace(i, nb)} />
      ) : b.kind === "media" ? (
        <MediaEditor block={b} disabled={off} connections={connections} variables={variables} onChange={nb => {
          const current = latestBlocks.current
          if (current.includes(b)) set(current.map(block => block === b ? nb : block))
        }} />
      ) : (
        <TypingEditor block={b} index={i} disabled={off} max={typingMax} indicator={connections.length > 0 && connections.every(c => !!c.profile?.typing)} onChange={(nb) => replace(i, nb)} />
      )}
      {hasChannel && notices[i] && !notices.slice(i + 1).includes(notices[i]) ? <Banner variant="warning">{notices[i]}</Banner> : null}
    </div>
    )
  }

  return (
    <SidePanel title={name.title} rename={name.rename} tone="message" onClose={p.onClose} bodyClassName="px-8 py-5">
      <NodeErrors errors={p.errors} show={p.showErrors} />
      <div className="border-b border-border pb-4">
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm leading-6 text-text-muted">
        Enviar
        {sendsInWindow ? <>
        <Popover>
          <PopoverTrigger asChild><button type="button" className="inline-flex items-center gap-1 rounded-sm font-medium text-text decoration-dotted underline underline-offset-4 decoration-text-muted/60 hover:decoration-text">dentro da janela de 24 h<Info className="size-3.5 shrink-0 text-text-muted" aria-hidden="true" /></button></PopoverTrigger>
          <PopoverContent className="w-72 text-sm"><p>Este passo envia enquanto a janela de 24 horas, aberta pela última mensagem do contato, está valendo. Para falar depois disso, use um passo de modelo de mensagem aprovado.</p></PopoverContent>
        </Popover>
        <span aria-hidden="true" className="text-border-input">·</span>
        </> : null}
        <Select value={hasChannel ? channel : undefined} disabled={off || !channelChoices.length} onValueChange={v => p.updateConfig({ channel: v })}>
          <SelectTrigger aria-label="Canal do passo" className="h-7 w-auto gap-1 rounded-pill border border-border bg-surface px-2.5 text-sm font-medium text-text shadow-none hover:border-border-input [&>svg]:size-3.5">
            <SelectValue placeholder="Escolha o canal">{hasChannel ? (channel === "email" ? "por e-mail" : `pelo ${stepChannelLabels[channel as StepChannel]}`) : undefined}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(hasChannel && !channelChoices.includes(channel as StepChannel) ? [channel as StepChannel, ...channelChoices] : channelChoices).map(c => <SelectItem key={c} value={c}>{stepChannelLabels[c]}</SelectItem>)}
          </SelectContent>
        </Select>
      </p>
      </div>
      {channel === PENDING_CHANNEL ? <Banner variant="warning">O canal deste passo ainda não foi escolhido. Escolha um para ver só o que ele aceita; quem chega por qualquer canal recebe o passo enquanto isso.</Banner> : null}
      {hasChannel && !connections.length ? <Banner variant="warning">Não há conexão de {stepChannelLabels[channel as StepChannel]} ligada. Ligue uma em Conexões para este passo poder ser publicado.</Banner> : null}
      {restricted ? (
        <div className="space-y-1">
          <PrivateReplyBadge />
          <p className={overRestricted ? "text-xs text-warning" : "text-xs text-text-muted"}>
            Primeira resposta privada: um texto e, se quiser, um botão de link ou de toque. Abrir o link não libera novas mensagens; a pessoa precisa responder ou tocar no botão.
          </p>
        </div>
      ) : null}

      <ol aria-label="Blocos da mensagem" className="space-y-4">
        {(() => {
          // Um texto e os botões que vêm logo depois formam um bloco só na tela (como no original); os dados continuam sendo uma lista plana.
          const rows: { start: number; end: number }[] = []
          for (let i = 0; i < blocks.length; i++) {
            let end = i
            if (blocks[i].kind === "text" || blocks[i].kind === "button") while (blocks[end + 1]?.kind === "button") end++
            rows.push({ start: i, end }); i = end
          }
          return rows.map(({ start, end }) => {
            const idxs = Array.from({ length: end - start + 1 }, (_, k) => start + k)
            const bad = idxs.some(i => { const b = blocks[i]; return b.kind === "media" && mediaError(b, profiles) || isCards(b) && cardsIssue(b, blocks, cardProfiles) || isQuickReply(b) && replyIssue || isListBlock(b) && listIssue })
            const first = blocks[start]
            return <li key={first.kind === "button" || isQuickReply(first) ? first.id : start} className={cn("group/bloco rounded-xl border bg-surface", bad ? "border-danger" : "border-border", first.kind === "text" || first.kind === "button" ? "space-y-0" : "space-y-2 p-3")}>
              {idxs.map(i => renderBlock(blocks[i], i))}
              {first.kind === "text" || first.kind === "button" ? <button type="button" aria-label="Adicionar botão" disabled={!canButton}
                onClick={() => { const id = newButtonId(blocks); setOpenButtons(ids => [...ids, id]); set([...blocks.slice(0, end + 1), { kind: "button", id, label: "", action: restricted ? { type: "url", url: "" } : { type: "go_to_node" } }, ...blocks.slice(end + 1)]) }}
                className="flex h-10 w-full items-center justify-center gap-1.5 rounded-b-xl border-t border-border text-sm text-text-muted transition-colors hover:bg-surface-muted hover:text-text disabled:cursor-not-allowed disabled:opacity-50"><Plus className="size-4" aria-hidden="true" />Adicionar botão</button> : null}
            </li>
          })
        })()}
      </ol>
      {blocks.length === 0 ? <p className="text-text-muted">Mensagem vazia. Adicione um bloco.</p> : null}
      {replies.length ? <QuickReplySettings config={p.node.data.config} disabled={off} onChange={patch => p.updateConfig(patch)} /> : null}
      {lists.length && listIssue ? <p role="status" className="text-xs text-danger">{listIssue}</p> : null}
      {replies.length && replyIssue ? <p role="status" className="text-xs text-danger">{replyIssue}</p> : null}

      {replyLimits ? <div className="flex flex-wrap justify-end gap-2">
        {replies.length ? <button type="button" disabled={!canSkip} onClick={() => set([...blocks, { kind: "quick_reply", id: newQuickReplyId(blocks), label: SKIP_LABEL, skip: true }])} className={pill}><Plus className="size-4" aria-hidden="true" />Pular</button> : null}
        <button type="button" aria-label="Adicionar resposta rápida" disabled={!canReply} onClick={() => set([...blocks, { kind: "quick_reply", id: newQuickReplyId(blocks), label: "" }])} className={pill}><Plus className="size-4" aria-hidden="true" />Adicionar resposta rápida</button>
      </div> : null}
      <div className="space-y-1 border-t border-border pt-4">
        <p className="pb-1 text-xs font-medium text-text-muted">Adicione um bloco de conteúdo</p>
        <ContentCard icon={Type} title="Texto" hint="Adicione texto simples e botões" disabled={!canText} onClick={() => set([...blocks, { kind: "text", text: "" }])} />
        {mediaKinds.filter(kind => (kind === "image" || kind === "file") && profiles.length > 0 && profiles.every(p => p.media[kind]?.maxBytes && p.media[kind]?.mime.length)).map(kind =>
          <ContentCard key={kind} icon={kind === "image" ? ImageIcon : FileText} title={mediaLabels[kind]} hint={kind === "image" ? "Impulsione o engajamento com visuais" : "Anexe arquivos à sua mensagem"} disabled={off || restricted} onClick={() => set([...blocks, { kind: "media", media: kind, url: "" }])} />)}
        {showTyping ? <ContentCard icon={Clock} title="Digitação" hint="Deixe um intervalo entre as mensagens" disabled={!canTyping} onClick={() => set([...blocks, { kind: "typing", seconds: Math.min(3, typingMax) }])} /> : null}
        {p.createStep ? <ContentCard icon={ClipboardList} title="Coleta de dados" hint="Vira um passo Pergunta depois desta mensagem (e-mail, telefone e mais)" disabled={off || nextLinked} onClick={() => p.createStep!(PORT_NEXT, "question")} /> : null}
        <ContentCard icon={Ellipsis} title="Mais" hint="Ver todas as opções disponíveis" expanded={more} onClick={() => setMore(v => !v)} />
        <div hidden={!more} className="space-y-1">
          {(['card', 'gallery'] as const).filter(kind => cardProfiles.length > 0 && cardProfiles.every(p => p.cards && p.cards.maxCards >= (kind === 'card' ? 1 : 2))).map(kind =>
            <ContentCard key={kind} icon={kind === 'card' ? RectangleHorizontal : GalleryHorizontal} title={kind === 'card' ? 'Card' : 'Galeria'} hint={kind === 'card' ? "Imagem, título e botões" : "Vários cards lado a lado"} disabled={off || restricted} onClick={() => set([...blocks, { kind, aspectRatio: 'horizontal', cards: [{ title: '' }] }])} />)}
          {mediaKinds.filter(kind => (kind === "audio" || kind === "video") && profiles.length > 0 && profiles.every(p => p.media[kind]?.maxBytes && p.media[kind]?.mime.length)).map(kind => {
            const Icon = mediaIcons[kind]
            return <ContentCard key={kind} icon={Icon} title={mediaLabels[kind]} hint={kind === "audio" ? "Envie um áudio" : "Envie um vídeo"} disabled={off || restricted} onClick={() => set([...blocks, { kind: 'media', media: kind, url: '' }])} />
          })}
          {listLimit ? <ContentCard icon={ListChecks} title="Lista de opções" hint="Menu de opções para escolher" disabled={!canList} onClick={() => set([...blocks, emptyList()])} /> : null}
        </div>
      </div>
      {restricted ? <p className="text-xs text-text-muted">Digitação fica de fora da primeira mensagem de um comentário.</p> : null}
      {replyLimits ? <p className="text-xs text-text-muted">{replies.length ? `Até ${replyLimits.max} respostas de ${replyLimits.titleMax} caracteres nesta conexão. Botão e resposta rápida não coexistem no mesmo texto.` : buttons ? "Botão e resposta rápida não coexistem no mesmo texto: tire os botões para usar respostas rápidas." : null}</p>
        : connections.length ? <p role="status" className="text-xs text-text-muted">Esta conexão não aceita respostas rápidas. Use botões, até {buttonCap} por mensagem.</p> : null}
      {buttons >= buttonCap && !restricted ? <p className="text-xs text-text-muted">Limite de {buttonCap} botões por mensagem nesta conexão.</p> : null}

      {p.automationId ? <p className="text-xs text-text-muted">Página deste passo (webview, depois de publicar): <button type="button" className="text-accent underline" onClick={() => { void navigator.clipboard.writeText(`${window.location.origin}/api/flow-public/webview/${p.automationId}/${p.node.id}`).then(() => toast.success("Link da página copiado.")) }}>copiar link</button></p> : null}
      <NodeLinks p={p} />
    </SidePanel>
  )
}

function TextEditor({ block, index, disabled, limit, variables, onChange }: { block: TextBlock; index: number; disabled: boolean; limit: { max: number; unit: "chars" | "bytes" }; variables: VariableCatalogProps; onChange: (b: TextBlock) => void }) {
  const ref = React.useRef<HTMLTextAreaElement>(null)
  const id = `blk-text-${React.useId()}`
  const size = textSize(block.text, limit.unit)
  const over = size > limit.max
  return (
    <div role="group" aria-label={`Bloco de texto ${index + 1}`} className="group/texto space-y-1 px-4 pt-3 pb-2">
      <Label htmlFor={id} className="sr-only">
        Texto do bloco {index + 1}
      </Label>
      <Textarea id={id} ref={ref} value={block.text} disabled={disabled} aria-invalid={over || undefined} placeholder="Escreva a mensagem" className="min-h-24 resize-none border-transparent bg-transparent px-0 text-[15px] leading-6 shadow-none [field-sizing:content] focus-visible:ring-0" onChange={(e) => onChange({ ...block, text: e.target.value })} />
      <div className="flex items-start justify-between gap-2">
        <VariablePicker {...variables} targetRef={ref} value={block.text} disabled={disabled} onChange={text => onChange({ ...block, text })} />
        {/* O contador só aparece com o campo em foco (ou quando passou do limite). */}
        <span className={cn("mt-1.5 shrink-0 text-xs", over ? "text-danger" : "hidden text-text-muted group-focus-within/texto:inline")} aria-live="polite">
          {size.toLocaleString("pt-BR")} / {limit.max.toLocaleString("pt-BR")}{limit.unit === "bytes" ? " bytes" : ""}
        </span>
      </div>
    </div>
  )
}

const clickActionIcons = { add_tag: Tag, remove_tag: Tags, set_custom_field_value: SquarePen, unset_custom_field_value: Eraser } as const

function ButtonEditor({ block, disabled, linkOnly, urlOnly, titleMax, showErrors, variables, onChange, panel }: { block: ButtonBlock; disabled: boolean; linkOnly: boolean; urlOnly: boolean; titleMax: number; showErrors: boolean; variables: VariableCatalogProps; onChange: (b: ButtonBlock) => void; panel: PanelProps }) {
  const uid = React.useId()
  const ref = React.useRef<HTMLInputElement>(null)
  const isUrl = block.action.type === "url"
  const url = block.action.type === "url" ? block.action.url : ""
  const urlBad = isUrl && !isValidUrl(url) && (url !== "" || showErrors)
  const clickActions = <>
          <h4 className="text-xs font-semibold text-text-muted">Ações ao clicar</h4>
          <CatalogNotice p={panel} kind="fields" />
          {(block.actions ?? []).map((action, i) => {
            const change = (value: typeof action) => onChange({ ...block, actions: block.actions!.map((a, j) => i === j ? value : a) })
            const fields = (panel.fields ?? []).filter(f => f.scope === 'contact' && !("archived" in f && f.archived))
            return <div key={i} className="space-y-2 rounded-md border border-border p-2">
              <div className="min-w-0 space-y-1">
                <Label htmlFor={`${uid}-action-${i}`}>Ação do botão {i + 1}</Label>
                <Select value={action.type} disabled={disabled} onValueChange={type => change(initialAction(type as EditorAction['type'], action, fields) as typeof action)}>
                  <SelectTrigger id={`${uid}-action-${i}`} className="w-full min-w-0"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(['add_tag', 'remove_tag', 'set_custom_field_value', 'unset_custom_field_value'] as const).map(type => { const Icon = clickActionIcons[type]; return <SelectItem key={type} value={type}><span className="flex items-center gap-2"><Icon className="size-4 text-text-muted" aria-hidden="true" />{actionLabels[type]}</span></SelectItem> })}
                  </SelectContent>
                </Select>
              </div>
              {'tag_id' in action ? <Choice id={`${uid}-tag-${i}`} label="Tag do botão" value={action.tag_id} options={panel.tags} disabled={disabled} onChange={tag_id => change({ ...action, tag_id })} /> : null}
              {'field_id' in action ? <>
                <Choice id={`${uid}-field-${i}`} label="Campo do botão" value={action.field_id} options={fields} disabled={disabled || panel.catalogLoading || panel.catalogErrors?.fields} onChange={field_id => change(action.type === 'set_custom_field_value' ? { ...action, field_id, value: initialFieldValue(fields.find(f => f.id === field_id)) } : { ...action, field_id })} />
                {action.type === 'set_custom_field_value' ? <FieldValue id={`${uid}-value-${i}`} field={fields.find(f => f.id === action.field_id)} value={action.value} disabled={disabled} onChange={value => change({ ...action, value })} /> : null}
              </> : null}
              <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange({ ...block, actions: block.actions!.filter((_, j) => i !== j) })}><Trash2 className="size-4" aria-hidden="true" />Remover ação do botão {i + 1}</Button>
            </div>
          })}
          <Button size="sm" variant="secondary" disabled={disabled || (block.actions?.length ?? 0) >= 5} onClick={() => onChange({ ...block, actions: [...block.actions ?? [], { type: 'add_tag', tag_id: '' }] })}><Plus className="size-4" aria-hidden="true" />Adicionar ação ao botão</Button>
  </>
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label htmlFor={`${uid}-t`}>Título do botão</Label>
        <Input id={`${uid}-t`} ref={ref} value={block.label} maxLength={titleMax} disabled={disabled} aria-invalid={(showErrors && !block.label.trim()) || undefined} onChange={(e) => onChange({ ...block, label: e.target.value })} />
        <VariablePicker {...variables} targetRef={ref} value={block.label} disabled={disabled} onChange={label => onChange({ ...block, label })} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${uid}-a`}>O que acontece ao tocar</Label>
        <Select
          value={block.action.type}
          disabled={disabled}
          onValueChange={(v) => onChange({ ...block, actions: block.actions, action: v === "url" ? { type: "url", url: "" } : v === "start_automation" ? { type: "start_automation", automation_id: "" } : { type: "go_to_node" } })}
        >
          <SelectTrigger id={`${uid}-a`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="go_to_node" disabled={urlOnly}><span className="flex items-center gap-2"><CornerDownRight className="size-4 text-text-muted" aria-hidden="true" />Ir para um passo</span></SelectItem>
            <SelectItem value="url"><span className="flex items-center gap-2"><Link2 className="size-4 text-text-muted" aria-hidden="true" />Abrir um link</span></SelectItem>
            <SelectItem value="start_automation" disabled={linkOnly || urlOnly}><span className="flex items-center gap-2"><Workflow className="size-4 text-text-muted" aria-hidden="true" />Iniciar outra automação</span></SelectItem>
          </SelectContent>
        </Select>
      </div>
      {block.action.type === "start_automation" ? <div className="space-y-2 border-t border-border pt-3">
        <Choice id={`${uid}-flow`} label="Automação" value={block.action.automation_id} disabled={disabled || panel.catalogLoading || panel.catalogErrors?.automations}
          options={(panel.automations ?? []).filter(a => a.id !== panel.automationId && !a.deleted_at).map(a => ({ id: a.id, name: a.name }))}
          onChange={automation_id => onChange({ ...block, action: { type: "start_automation", automation_id } })} />
        {clickActions}
        <p className="text-xs text-text-muted">Ao tocar, as ações rodam, a automação escolhida começa e esta termina. A automação precisa estar publicada e ligada.</p>
      </div> : null}
      {isUrl ? (
        <div className="space-y-1">
          <Label htmlFor={`${uid}-u`}>Endereço do link</Label>
          <Input
            id={`${uid}-u`}
            type="url"
            inputMode="url"
            placeholder="https://"
            value={url}
            disabled={disabled}
            aria-invalid={urlBad || undefined}
            aria-describedby={urlBad ? `${uid}-e` : undefined}
            onChange={(e) => onChange({ ...block, action: { type: "url", url: e.target.value } })}
          />
          {urlBad ? (
            <p id={`${uid}-e`} className="text-xs text-danger">
              Informe um endereço completo, começando com https://
            </p>
          ) : null}
          {block.action.type === "url" ? <div className="space-y-1"><label htmlFor={`${uid}-webview`} className="text-xs font-semibold">Tamanho da janela (Messenger)</label>
            <select id={`${uid}-webview`} className="h-9 w-full rounded-md border border-border-input bg-surface px-2 text-sm" disabled={disabled} value={block.action.webview_size ?? ""}
              onChange={e => onChange({ ...block, action: { type: "url", url: block.action.type === "url" ? block.action.url : "", ...(e.target.value ? { webview_size: e.target.value as "full" | "medium" | "compact" } : {}) } })}>
              <option value="">Navegador padrão</option><option value="full">Cheia (100%)</option><option value="medium">Média (75%)</option><option value="compact">Compacta (50%)</option>
            </select></div> : null}
          <p className="text-xs text-text-muted" data-testid="nota-botao-de-site">Abrir o link não inscreve o contato nem abre a janela de conversa. Só botão normal, resposta rápida ou mensagem do contato fazem isso.</p>
          <p className="text-xs text-text-muted">Opcional: ligue a saída deste botão a um passo e, ao abrir o link, o fluxo segue por ele.</p>
          {clickActions}
          <p className="text-xs text-text-muted">Com ações, o link passa pelo endereço rastreado: as ações rodam quando o contato abre o link.</p>
          <DropdownMenu><DropdownMenuTrigger asChild><Button size="sm" variant="secondary" disabled={disabled}><Plus className="size-4" aria-hidden="true" />Criar passo depois do link</Button></DropdownMenuTrigger>
            <DropdownMenuContent>{(['message', 'question', 'action', 'smart_delay', 'condition', 'randomizer', 'start_automation'] as const).map(type => <DropdownMenuItem key={type} onSelect={() => panel.createStep?.(btnPort(block.id), type)}>{{ message: 'Mensagem', question: 'Pergunta', action: 'Ações', smart_delay: 'Esperar', condition: 'Verificar condição', randomizer: 'Dividir caminhos', start_automation: 'Iniciar automação' }[type]}</DropdownMenuItem>)}</DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : block.action.type === "start_automation" ? null : (
        <div className="space-y-3 border-t border-border pt-3">
          {clickActions}
          <p className="text-xs text-text-muted">As ações rodam após o clique, antes do próximo passo. Sem próximo passo, o fluxo termina após as ações.</p>
          <DropdownMenu><DropdownMenuTrigger asChild><Button size="sm" variant="secondary" disabled={disabled}><Plus className="size-4" aria-hidden="true" />Criar passo pelo botão</Button></DropdownMenuTrigger>
            <DropdownMenuContent>{(['message', 'question', 'action', 'smart_delay', 'condition', 'randomizer', 'start_automation'] as const).map(type => <DropdownMenuItem key={type} onSelect={() => panel.createStep?.(btnPort(block.id), type)}>{{ message: 'Mensagem', question: 'Pergunta', action: 'Ações', smart_delay: 'Esperar', condition: 'Verificar condição', randomizer: 'Dividir caminhos', start_automation: 'Iniciar automação' }[type]}</DropdownMenuItem>)}</DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  )
}

function TypingEditor({ block, index, disabled, max, indicator, onChange }: { block: TypingBlock; index: number; disabled: boolean; max: number; indicator: boolean; onChange: (b: TypingBlock) => void }) {
  const id = React.useId()
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>Segundos digitando (1 a {max}) · bloco {index + 1}</Label>
      <Input
        id={id}
        type="number"
        min={1}
        max={max}
        value={block.seconds}
        disabled={disabled}
        onChange={(e) => onChange({ ...block, seconds: Math.min(max, Math.max(1, Math.round(Number(e.target.value) || 1))) })}
      />
      <p className="text-xs text-text-muted">{indicator ? "A pessoa vê “digitando…” durante a espera." : "A conexão não mostra o indicador de digitação: a espera acontece, mas sem aviso na conversa."}</p>
    </div>
  )
}

const pill = "inline-flex h-9 items-center gap-1.5 rounded-pill border border-border bg-surface px-4 text-sm font-medium text-text-muted transition-colors hover:border-border-input hover:text-text disabled:cursor-not-allowed disabled:opacity-50"

/** Cartão tracejado da lista "Adicione um dos blocos de conteúdo" (ícone, título e subtítulo). */
function ContentCard({ icon: Icon, title, hint, disabled, expanded, onClick }: { icon: React.ComponentType<{ className?: string }>; title: string; hint: string; disabled?: boolean; expanded?: boolean; onClick: () => void }) {
  const id = React.useId()
  return <button type="button" aria-label={title} aria-describedby={id} aria-expanded={expanded} disabled={disabled} onClick={onClick}
    className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50">
    <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-surface"><Icon className="size-[18px] text-text-muted" /></span>
    <span className="min-w-0"><span className="block text-sm font-medium">{title}</span><span id={id} className="block text-xs text-text-muted">{hint}</span></span>
  </button>
}
