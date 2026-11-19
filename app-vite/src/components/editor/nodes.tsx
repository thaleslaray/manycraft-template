import { questionSystemFields } from "../../../../engine/src/schemas/question"
import { variableLabels } from "./variable-picker"
import { CardsPreview, isCards } from "./cards-block"
import { NoteNode } from "./note-node"
import { annotationNodeTypes } from "./annotation-nodes"
import { describeWaitPhrase, describeWindow, describeDate, describeOffset, describeOrigin, type TimeWindow } from "./temporal"
import { MediaPreview } from "./media-block"
import { isQuickReply } from "./quick-reply-block"
import { isListBlock, listRows } from "./list-block"
import * as React from "react"
import { emailFilters, emailSystemFields, systemFieldChoices } from "./email-condition"
import { BroadcastStartNode } from "./broadcast-start-node"
import { Handle, NodeToolbar, Position, useNodesData, useNodes, useEdges, useUpdateNodeInternals, type NodeProps, type NodeTypes } from "@xyflow/react"
import { CircleHelp, AlertCircle, Clock, Copy, Trash2, Tags, Zap, GitBranch, Shuffle, Workflow, Link2, CornerDownRight, Tag, SquarePen } from "lucide-react"
import { buttonIndicators, type ButtonIndicator } from "./pending"
import { summarizeTrigger } from "@/data"
import { formatPercent } from "@/lib/time"
import { cn } from "@/lib/utils"
import { useEditor } from "./editor-context"
import { ChannelBadge } from "./channel-badge"
import {
  PORT_NEXT,
  PORT_THEN,
  btnPort,
  describeDelay,
  describeAction,
  fieldOperators,
  describeFieldAction,
  getActions,
  getBlocks,
  getDuration,
  getRules,
  getVariations,
  outputPorts,
  hasReceipts,
  reportsDelivery,
  receiptShares,
  messageChannel,
  nodeTitle,
  triggersOf,
  channelLabels,
  type FlowNode,
  type FlowEdge,
  isFirstAfterComment,
} from "./graph"
import { triggerNodeTitle } from "./post-choice"
import { PrivateReplyBadge } from "./private-reply-badge"

const indicatorIcons: Record<ButtonIndicator["kind"], typeof Link2> = { url: Link2, go_to_node: CornerDownRight, start_automation: Workflow, tag: Tag, field: SquarePen }

type Tone = "trigger" | "message" | "action" | "delay"
const toneCls: Record<Tone, string> = {
  trigger: "bg-node-trigger",
  message: "bg-surface",
  action: "bg-node-action",
  delay: "bg-node-delay",
}

/** Valor da regra para o resumo no cartão: sim/não, número ou texto curto. */
function valueText(value: unknown, field?: string): string {
  if (typeof value === "boolean") return ` ${value ? "sim" : "não"}`
  if (typeof value === "number") return ` ${value.toLocaleString("pt-BR")}`
  if (typeof value !== "string" || !value) return ""
  const label = field ? systemFieldChoices[field]?.find(choice => choice.id === value)?.name ?? value : value
  return ` ${label.length > 24 ? `${label.slice(0, 24)}…` : label}`
}

function useConnected(id: string) {
  const edges = useEdges()
  return new Set(edges.filter((e) => e.source === id).map((e) => e.sourceHandle))
}

const handleCls = "size-3! rounded-pill! border-2! border-border-input! bg-surface!"
const handleOn = "border-accent! bg-accent!"

function PortRow({ id, label, connected, className }: { id: string; label: string; connected: boolean; className?: string }) {
  return (
    <div className={cn("relative flex items-center justify-end gap-2 px-4 py-2 text-xs text-text-muted", className)}>
      {label}
      <Handle type="source" position={Position.Right} id={id} className={cn(handleCls, connected && handleOn)} aria-label={label} />
    </div>
  )
}

function Shell({
  id,
  tone,
  icon,
  kicker,
  title,
  selected,
  children,
  noTarget,
  ignoreLabel,
  plain,
}: {
  id: string
  tone: Tone
  icon: React.ReactNode
  kicker?: string
  title: string
  selected?: boolean
  children: React.ReactNode
  noTarget?: boolean
  /** Rótulo de criação que equivale ao título padrão do passo e não deve sobrepô-lo. */
  ignoreLabel?: string
  /** Cabeçalho sem faixa de cor (gatilho): ícone e título maiores. */
  plain?: boolean
}) {
  const { errors, showErrors, readOnly, duplicateStep, deleteStep } = useEditor()
  const created = (useNodesData(id)?.data as { config?: { label?: unknown } } | undefined)?.config?.label
  const shown = typeof created === "string" && created && created !== ignoreLabel ? created : title
  const errs = errors[id] ?? []
  const bad = showErrors && errs.length > 0
  return (
    <div
      className={cn(
        plain ? "w-[calc(var(--node-w)*1.13)]" : "w-(--node-w)",
        "rounded-lg border bg-surface shadow-node",
        selected ? "ring-2 ring-accent" : "",
        bad ? "border-danger ring-2 ring-danger" : "border-border"
      )}
    >
      {selected && !readOnly && !noTarget && duplicateStep && deleteStep ? (
        <NodeToolbar isVisible position={Position.Top} offset={10} className="flex gap-1 rounded-md border border-border bg-surface p-1 shadow-card">
          <button type="button" aria-label="Duplicar passo" title="Duplicar passo" onClick={() => duplicateStep(id)} className="grid size-8 place-items-center rounded-md text-text-muted hover:bg-surface-muted hover:text-text"><Copy className="size-4" aria-hidden="true" /></button>
          <button type="button" aria-label="Apagar passo" title="Apagar passo" onClick={() => deleteStep(id)} className="grid size-8 place-items-center rounded-md text-danger hover:bg-danger-soft"><Trash2 className="size-4" aria-hidden="true" /></button>
        </NodeToolbar>
      ) : null}
      {noTarget ? null : (
        <Handle type="target" position={Position.Left} className={handleCls} aria-label="Entrada do passo" style={{ top: "1.5rem" }} />
      )}
      <div className={cn("flex items-center rounded-t-lg px-4 py-3", plain ? "gap-3 pt-4" : "gap-2", toneCls[tone])}>
        <span aria-hidden="true" className="text-text-muted">{icon}</span>
        <div className="min-w-0 flex-1">
          {kicker ? <p className="text-xs text-text-muted">{kicker}</p> : null}
          <p className={cn("truncate", plain ? "text-lg" : "font-semibold")}>{shown}</p>
        </div>
        {bad ? (
          <span role="img" aria-label={`Erro: ${errs[0]}`} title={errs.join(" ")}>
            <AlertCircle className="size-5 text-danger" aria-hidden="true" />
          </span>
        ) : null}
      </div>
      {children}
    </div>
  )
}


export function TriggerNode({ id, data, selected }: NodeProps<FlowNode>) {
  const { triggers, readOnly, newTrigger, pickTrigger } = useEditor()
  const connected = useConnected(id)
  const list = triggersOf({ id, type: "trigger", data, position: { x: 0, y: 0 } }, triggers)
  return (
    <Shell id={id} tone="message" plain icon={<Zap className="size-6" />} title="Quando…" selected={selected} noTarget>
      <div className="space-y-2 px-4 pb-3">
        {list.length ? list.map((t) => (
          <button key={t.id} type="button" aria-label={`Configurar ${t.name}`} onClick={() => pickTrigger?.(t.id)} className="flex w-full items-center gap-3 rounded-md bg-node-trigger px-3 py-2 text-left">
            {t.config.post_snapshot?.thumbnailUrl ? <img src={t.config.post_snapshot.thumbnailUrl} alt="" className="size-8 shrink-0 rounded object-cover" /> : <ChannelBadge channel={t.channel_type} />}
            <div className="min-w-0">
              <p className="text-sm">{triggerNodeTitle([t.type])}</p>
              <p className="text-xs text-text-muted">{summarizeTrigger(t)}</p>
              {list.length > 1 && t.channel_type ? <p className="text-xs text-text-muted">{channelLabels[t.channel_type]}</p> : null}
              {!t.active ? <p className="text-xs text-warning">Gatilho desligado</p> : null}
            </div>
          </button>
        )) : <p className="text-sm">Configure o gatilho</p>}
        {readOnly ? null : <button type="button" aria-label="Novo gatilho" onClick={() => newTrigger?.(id)} className="w-full rounded-md border border-dashed border-border-input px-3 py-3 text-center text-sm text-accent hover:bg-surface-muted">+ Novo gatilho</button>}
      </div>
      <PortRow id={PORT_THEN} label="Então" connected={connected.has(PORT_THEN)} />
    </Shell>
  )
}

function Metric({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return big ? (
    <div className="text-center">
      <p className="text-lg text-accent tabular-nums">{value}</p>
      <p className="text-xs text-text-muted">{label}</p>
    </div>
  ) : (
    <div className="text-center">
      <p className="text-2xs text-text-muted">{label}</p>
      <p className="font-bold text-accent tabular-nums">{value}</p>
    </div>
  )
}

export function MessageNode({ id, data, selected }: NodeProps<FlowNode>) {
  const { stats, triggers, readOnly, fullMetrics, fields = [], botFields = [] } = useEditor()
  const connected = useConnected(id)
  const allNodes = useNodes<FlowNode>()
  const allEdges = useEdges<FlowEdge>()
  const privateReply = isFirstAfterComment(id, allNodes, allEdges, triggers)
  const update = useUpdateNodeInternals()
  const blocks = getBlocks(data.config)
  const buttonKey = blocks.flatMap((b) => (b.kind === "button" ? [`${b.id}:${b.action.type}`] : isQuickReply(b) ? [`${b.id}:q`] : isListBlock(b) ? listRows(b).map(r => `${r.id}:l`) : [])).join(",")
  React.useEffect(() => {
    update(id)
  }, [id, buttonKey, update])

  const s = stats?.nodes[id]
  const sent = s?.sent ?? 0
  const pct = (n?: number) => (sent > 0 ? formatPercent((n ?? 0) / sent) : "—")
  const channel = messageChannel(data.config, triggers)
  const isEmail = !!data.config.email || data.config.channel === "email"
  const receipts = hasReceipts(data.config, triggers)
  const delivery = receipts && reportsDelivery(data.config, triggers)
  const shares = receiptShares({ sent, delivered: s?.delivered, read: s?.read }, delivery)
  const hasReplies = blocks.some(isQuickReply)
  // E-mail tem cliques nos links do corpo, mesmo sem botões: a coluna "Clicado" aparece também nele.
  const hasButtons = blocks.some((b) => b.kind === "button" || isListBlock(b)) || hasReplies || isEmail
  const cols = fullMetrics ? 4 : 1 + (delivery ? 1 : 0) + (receipts ? 1 : 0) + (hasButtons ? 1 : 0)

  return (
    <Shell id={id} tone="message" icon={<ChannelBadge channel={isEmail ? "email" : data.config.channel as string | undefined} />} kicker={channel} title={isEmail ? "Mensagem de e-mail" : "Enviar mensagem"} ignoreLabel={nodeTitle.message} selected={selected}>
      {privateReply ? <p className="border-b border-border px-4 py-1"><PrivateReplyBadge /></p> : null}
      {data.config.email ? <p className="border-b border-border px-4 py-2 text-sm font-semibold">{String((data.config.email as {subject?:string}).subject || "Assunto pendente")}</p> : null}
      {readOnly && stats ? (
        <div className={`grid ${["grid-cols-1", "grid-cols-2", "grid-cols-3", "grid-cols-4"][cols - 1]} gap-1 px-4 pt-1`} role="group" aria-label="Métricas da mensagem">
          <Metric big label="Enviado" value={sent.toLocaleString("pt-BR")} />
          {delivery || fullMetrics ? <Metric big label="Entregue" value={delivery ? formatPercent(shares.delivered) : "—"} /> : null}
          {receipts || fullMetrics ? <Metric big label="Aberto" value={receipts ? formatPercent(shares.read) : "—"} /> : null}
          {hasButtons || fullMetrics ? <Metric big label="Clicado" value={hasButtons ? pct(s?.clicked) : "—"} /> : null}
        </div>
      ) : null}
      <div className="m-4 space-y-2 rounded-md bg-surface-muted p-3">
        {blocks.length === 0 ? <p className="text-text-muted">Mensagem vazia</p> : null}
        {blocks.map((b, i) => {
          if (b.kind === "text")
            return (
              <p key={i} className="line-clamp-3 whitespace-pre-wrap break-words">
                {b.text ? variableLabels(b.text, fields, botFields) : <span className="text-text-muted">Texto vazio</span>}
              </p>
            )
          if (b.kind === "typing")
            return (
              <p key={i} className="text-xs text-text-muted">
                Digitando por {b.seconds} s…
              </p>
            )
          if (isCards(b)) return <CardsPreview key={i} block={b} />
          if (b.kind === "media") return <MediaPreview key={i} block={b} compact />
          if (isQuickReply(b)) {
            const taps = s?.buttons?.[b.id]
            return (
              <div key={i} className="relative flex items-center justify-between gap-2 rounded-full border border-border bg-surface px-3 py-2">
                <span className="min-w-0 truncate font-semibold">{b.label || "Resposta sem título"}</span>
                <span className="shrink-0 text-xs text-text-muted">
                  {sent > 0 && taps !== undefined ? `${formatPercent(taps / sent)} · ` : ""}
                  {b.skip ? "pula" : "resposta rápida"}
                </span>
                <Handle type="source" position={Position.Right} id={btnPort(b.id)} aria-label={`Saída da resposta ${b.label}`} className={cn(handleCls, connected.has(btnPort(b.id)) && handleOn)} />
              </div>
            )
          }
          if (isListBlock(b)) return (
            <div key={i} className="space-y-1 rounded-md border border-border bg-surface p-2">
              <p className="truncate text-xs font-semibold text-text-muted">{b.buttonText || "Lista sem botão"}</p>
              {listRows(b).map(r => {
                const taps = s?.buttons?.[r.id]
                return (
                  <div key={r.id} className="relative flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2">
                    <span className="min-w-0 truncate font-semibold">{r.title || "Opção sem título"}</span>
                    <span className="shrink-0 text-xs text-text-muted">
                      {sent > 0 && taps !== undefined ? `${formatPercent(taps / sent)} · ` : ""}opção da lista
                    </span>
                    <Handle type="source" position={Position.Right} id={btnPort(r.id)} aria-label={`Saída da opção ${r.title}`} className={cn(handleCls, connected.has(btnPort(r.id)) && handleOn)} />
                  </div>
                )
              })}
            </div>
          )
          const clicks = s?.buttons?.[b.id]
          const marks = buttonIndicators(b, connected.has(btnPort(b.id)))
          return (
            <div key={i} className="relative flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2">
              <span className="min-w-0 truncate font-semibold">{b.label || "Botão sem título"}</span>
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-text-muted">
                {sent > 0 && clicks !== undefined ? <span data-testid="ctr-botao" className="font-semibold text-accent tabular-nums">CTR {formatPercent(clicks / sent)}</span> : null}
                <span role="list" aria-label="O que o botão faz" className="flex items-center gap-1">
                  {marks.map((m, k) => { const Icon = indicatorIcons[m.kind]; return <span key={k} role="listitem" title={m.label} aria-label={m.label}><Icon className="size-3.5" aria-hidden="true" /></span> })}
                </span>
              </span>
              <Handle
                type="source"
                position={Position.Right}
                id={btnPort(b.id)}
                aria-label={`Saída do botão ${b.label}`}
                className={cn(handleCls, connected.has(btnPort(b.id)) && handleOn)}
              />
            </div>
          )
        })}
      </div>
      <PortRow id={PORT_NEXT} label={hasReplies ? "Se não tocar" : "Próximo passo"} connected={connected.has(PORT_NEXT)} />
    </Shell>
  )
}

export function ActionNode({ id, data, selected }: NodeProps<FlowNode>) {
  const { tags, fields = [], sequences = [] } = useEditor()
  const connected = useConnected(id)
  const acts = getActions(data.config)
  return (
    <Shell id={id} tone="action" icon={<Tags className="size-4" />} title={nodeTitle.action} selected={selected}>
      <div className="space-y-1 px-4 py-3">
        {acts.length === 0 ? <p className="text-text-muted">Nenhuma ação ainda</p> : null}
        {acts.map((a, i) => (
          <p key={i} className="break-words">
            {"tag_id" in a ? <>{a.type === "add_tag" ? "Adiciona a tag " : "Remove a tag "}<strong>{a.tag_id ? tags.find(t => t.id === a.tag_id)?.name ?? "Tag indisponível" : "Escolha a tag"}</strong></>
              : "sequence_id" in a ? <>{a.type === "add_to_sequence" ? "Inscreve em " : "Cancela "}<strong>{sequences.find(s => s.id === a.sequence_id)?.name ?? "Sequência indisponível"}</strong></>
              : (a.type === "set_custom_field_value" || a.type === "unset_custom_field_value") ? <strong>{describeFieldAction(a, fields.find(f => f.id === a.field_id)?.name ?? "campo indisponível")}</strong> : describeAction(a as Parameters<typeof describeAction>[0])}
          </p>
        ))}
      </div>
      <PortRow id={PORT_NEXT} label="Próximo passo" connected={connected.has(PORT_NEXT)} />
    </Shell>
  )
}

export function DelayNode({ id, data, selected }: NodeProps<FlowNode>) {
  const { stats, fields = [], readOnly } = useEditor()
  const connected = useConnected(id)
  const s = stats?.nodes[id]
  const m = getDuration(data.config)
  const resto = [data.config.window ? describeWindow(data.config.window as TimeWindow) : "", data.config.timezone ? String(data.config.timezone).replace(/_/g, " ") : ""].filter(Boolean).join(" · ")
  return (
    <Shell id={id} tone="delay" icon={<Clock className="size-4" />} title={nodeTitle.smart_delay} selected={selected}>
      <div className="space-y-2 px-4 py-3">
        {readOnly && stats ? (
          <div className="grid grid-cols-3 gap-2">
            <Metric label="Total" value={(s?.entered ?? 0).toLocaleString("pt-BR")} />
            <Metric label="Esperando" value={(s?.waiting ?? 0).toLocaleString("pt-BR")} />
            <Metric label="Aprovado" value={(s?.passed ?? 0).toLocaleString("pt-BR")} />
          </div>
        ) : null}
        <p className="break-words">{describeWaitPhrase(data.config, describeDelay(m), fields)}</p>
        {resto ? <p className="break-words text-xs text-text-muted">{resto}</p> : null}
      </div>
      <PortRow id={PORT_NEXT} label="Próximo passo" connected={connected.has(PORT_NEXT)} />
    </Shell>
  )
}

/** Condições e sorteios têm portas próprias; nunca recebem uma saída next inventada. */
export function LogicNode({ id, type, data, selected }: NodeProps<FlowNode>) {
  const { automations = [], tags, fields = [], botFields = [], segments = [], sequences = [] } = useEditor()
  const connected = useConnected(id)
  const update = useUpdateNodeInternals()
  const ports = outputPorts({ id, type, data, position: { x: 0, y: 0 } })
  const portKey = ports.map(p => p.port).join(",")
  React.useEffect(() => { update(id) }, [id, portKey, update])
  const condition = type === "condition"
  const random = type === "randomizer" || type === "split"
  const variations = getVariations(data.config)
  const total = variations.reduce((sum, v) => sum + v.weight, 0)
  const rules = getRules(data.config)
  const dynamic = type === "dynamic"
  const template = type === "template_message"
  const title = condition ? nodeTitle.condition : random ? nodeTitle.randomizer : dynamic ? nodeTitle.dynamic : template ? nodeTitle.template_message : nodeTitle.start_automation
  return <Shell id={id} tone="action" icon={condition ? <GitBranch className="size-4" /> : random ? <Shuffle className="size-4" /> : <Workflow className="size-4" />} title={title} selected={selected}>
    <div className="space-y-1 px-4 py-3 text-sm">
      {condition ? <>
        <p>{rules.length ? `${data.config.match === "any" ? "Alguma" : "Todas"} das ${rules.length} regras` : "Nenhuma regra ainda"}</p>
        {rules.map((r, i) => <p key={i} className="break-words text-xs text-text-muted">{r.type === "any_tag" ? `${r.operator === "has" ? "Possui alguma" : "Não possui nenhuma"} de ${r.tag_ids.length} tags` : r.type === "tag"
          ? `${r.operator === "has" ? "Possui" : "Não possui"} a tag ${tags.find(t => t.id === r.tag_id)?.name ?? "—"}`
          : r.type === "segment" ? `${r.operator === "in" || r.operator === "has" ? "Pertence ao" : "Não pertence ao"} segmento ${segments.find(s => s.id === r.segment_id)?.name ?? "indisponível"}`
          : r.type === "sequence" ? `${r.operator === "has" ? "Pertence" : "Não pertence"} à sequência ${sequences.find(s => s.id === r.sequence_id)?.name ?? "indisponível"}`
          : r.type === "origin" ? describeOrigin(r)
          : r.type === "current_time" ? `Horário atual: ${describeWindow(r.window)}${r.timezone ? ` · ${r.timezone}` : ""}`
          : r.type === "date" ? `${fields.find(f => f.id === r.field_id)?.name ?? "Data"} ${r.operator === "before" ? "antes de" : r.operator === "after" ? "depois de" : "na mesma data que"} ${describeDate(r.compare, fields)}${describeOffset(r.offset)}`
          : r.type === "email" ? emailFilters.find(filter => filter.id === r.filter)?.name ?? "Condição de e-mail"
          : r.type === "topic" ? `${r.operator === "has" ? "Tem" : "Não tem"} inscrição em tópico de notificação`
          : r.type === "bot_field" ? `Campo do bot ${botFields.find(f => f.id === r.field_id)?.name ?? "—"} ${(fieldOperators[r.operator as keyof typeof fieldOperators] ?? "").toLowerCase()}${valueText(r.value)}`.trim()
          : r.type === "system_field" ? `${emailSystemFields.find(field => field.id === r.field)?.name ?? "Dado do contato"} ${(fieldOperators[r.operator as keyof typeof fieldOperators] ?? "").toLowerCase()}${valueText(r.value, r.field)}`.trim()
          : `Compara o campo ${fields.find(f => f.id === r.field_id)?.name ?? "—"}`}</p>)}
      </> : template ? <>
          <p>{data.config.template_id ? "Modelo escolhido" : "Escolha o modelo aprovado"}</p>
          <p className="text-xs text-text-muted">Vale mesmo fora da janela de 24 h</p>
      </> : dynamic ? <>
          <p className="break-all">{String(data.config.url || "Endereço do servidor a definir")}</p>
          <p className="text-xs text-text-muted">O conteúdo vem do seu servidor na hora do envio</p>
        </> : random ? <p>{variations.length} caminhos · {data.config.random_every_time === false ? "Mantém a escolha por contato" : "Sorteia a cada passagem"}</p>
        : <>
          <p className="break-words">{automations.find(a => a.id === data.config.automation_id)?.name ?? "Escolha uma automação de destino"}</p>
          {type === "start_automation" ? <p className="text-xs text-text-muted">{data.config.wait_for_finish === true ? "Espera terminar e volta" : "Segue sem esperar"}</p> : null}
        </>}
    </div>
    {ports.map((p, i) => <PortRow key={p.port} id={p.port} label={random && total > 0 ? `${p.label} · ${(variations[i].weight / total * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%` : p.label} connected={connected.has(p.port)} />)}
  </Shell>
}

export function QuestionNode({ id, data, selected }: NodeProps<FlowNode>) {
  const { fields = [] } = useEditor()
  const connected = useConnected(id)
  return <Shell id={id} tone="message" icon={<CircleHelp className="size-4" />} title="Pergunta" selected={selected}>
    <div className="m-4 space-y-2 rounded-md bg-surface-muted p-3">
      <p className="line-clamp-3 whitespace-pre-wrap break-words">{String(data.config.text || "Escreva sua pergunta")}</p>
      <p className="text-xs text-text-muted">Salvar em {fields.find(f => f.id === data.config.field_id)?.name || (questionSystemFields as Record<string, { label: string }>)[String(data.config.field_id)]?.label || "campo a definir"}</p>
      {data.config.skip ? <p className="rounded-md border border-border p-2 text-center text-xs">Pular</p> : null}
    </div>
    <PortRow id="success" label="Resposta válida" connected={connected.has("success")} />
    <PortRow id="no_response" label="Sem resposta" connected={connected.has("no_response")} />
  </Shell>
}

export const nodeTypes: NodeTypes = {
  question: QuestionNode,
  trigger: TriggerNode,
  message: MessageNode,
  action: ActionNode,
  smart_delay: DelayNode,
  dynamic: LogicNode,
  template_message: LogicNode,
  condition: LogicNode,
  randomizer: LogicNode,
  split: LogicNode,
  start_automation: LogicNode,
  goto: LogicNode,
  note: NoteNode,
  broadcast_start: BroadcastStartNode,
  ...annotationNodeTypes,
}
