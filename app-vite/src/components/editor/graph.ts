import { staticUrlIssue } from "../../../../engine/src/flow/external-url"
import { isCards, cardsIssue, cardsProfiles, cardTexts } from "./cards-block"
import { smartDelaySchema, flowConditionSchema } from "../../../../engine/src/schemas/temporal"
import { originOptions, type TemporalRule } from "./temporal"
import { questionSchema, questionFieldType, questionCapabilityError, questionSystemField, questionSystemFieldFits } from "../../../../engine/src/schemas/question"
import { disconnectedSteps } from "../../../../engine/src/schemas/graph"
import { buttonActionSchema } from "../../../../engine/src/schemas/graph"
import type { Connection } from "@/data/connections"
import { mediaError, mediaProfiles } from "./media"
import { stepChannelOf, stepConnections, PENDING_CHANNEL, stepChannelLabels, stepOffer, textSize } from "./step-channel"
import { variableErrors } from "../../../../engine/src/schemas/message-variables"
import { isQuickReply, quickRepliesError } from "../../../../engine/src/schemas/message-quick-replies"
import { isListBlock, listError, listRows } from "./list-block"
import { BUTTON_DEFAULT_MAX, buttonLimit, buttonsError } from "../../../../engine/src/schemas/message-buttons"
import type { Edge, Node } from "@xyflow/react"
import { annotationToNode, isAnnotation, nodeToAnnotation } from "./annotations"
import { FIRST_STEP_GAP } from "./connect-drop"
import { emailFilters, emailSystemFields, emailOperatorsFor, systemFieldChoices, type EmailFilter } from "./email-condition"
import type { Graph, GraphEdge, GraphNode, MessageBlock, NodeType, Trigger, ChannelType, CustomField, Automation } from "@/data"

export const PORT_THEN = "next"
export const PORT_NEXT = "next"
export const btnPort = (buttonId: string) => `btn:${buttonId}`

export type NodeData = { config: Record<string, unknown> }
export type FlowNode = Node<NodeData>
export type FlowEdge = Edge

export const nodeTitle: Record<string, string> = {
  trigger: "Gatilho",
  message: "Mensagem",
  question: "Pergunta",
  action: "Ações",
  smart_delay: "Esperar",
  dynamic: "Bloco dinâmico",
  template_message: "Modelo (fora da janela)",
  condition: "Verificar condição",
  randomizer: "Dividir caminhos",
  start_automation: "Iniciar automação",
  sticky: "Nota",
  frame: "Grupo",
  portal: "Portal",
}

/** Nome acessível do passo no mapa: tipo e, quando há, o começo do primeiro texto (passos do mesmo tipo ficam distinguíveis). */
export function stepAriaLabel(type: string, config: Record<string, unknown> | undefined): string {
  const blocks = Array.isArray(config?.blocks) ? config.blocks as Record<string, unknown>[] : []
  const own = blocks.find(block => (block.kind === "text" || block.type === "text") && typeof block.text === "string" && block.text.trim())?.text ?? config?.text ?? config?.question
  const text = typeof own === "string" ? own.replace(/\s+/g, " ").trim() : ""
  const short = text.length > 60 ? `${text.slice(0, 60)}…` : text
  return `Passo ${nodeTitle[type] ?? type}${short ? `: ${short}` : ""}. Enter abre as opções, Delete remove.`
}

/** Nome do passo gravado no idioma em que foi criado (como no original: trocar o idioma do painel não renomeia passos já feitos). */
const titleByLang: Record<string, Record<string, string>> = {
  en: { trigger: "Trigger", message: "Message", question: "Question", action: "Actions", smart_delay: "Smart Delay", dynamic: "Dynamic Block", template_message: "Template", condition: "Condition", randomizer: "Randomizer", start_automation: "Start Automation" },
  es: { trigger: "Disparador", message: "Mensaje", question: "Pregunta", action: "Acciones", smart_delay: "Espera", dynamic: "Bloque dinámico", template_message: "Plantilla", condition: "Condición", randomizer: "Aleatorio", start_automation: "Iniciar automatización" },
}
export function creationTitle(type: string, lang: string): string {
  return titleByLang[lang.slice(0, 2).toLowerCase()]?.[type] ?? nodeTitle[type] ?? type
}
const questionDefaultRetry = "Não consegui validar. Tente novamente."
const questionDatetimeRetry = "Não entendi a data e hora. Responda assim: 24/10/2026 14:30."
/** Mensagem de nova tentativa ao trocar o tipo de resposta: a padrão vira a de data e hora (e volta), texto escrito pela pessoa nunca muda. */
export function questionRetryMessage(answerType: string, current: unknown): string {
  if (answerType === "datetime" && current === questionDefaultRetry) return questionDatetimeRetry
  if (answerType !== "datetime" && current === questionDatetimeRetry) return questionDefaultRetry
  return String(current)
}
export const edgeId = (from: string, port: string) => `${from}:${port}`

/** Largura do cartão (--node-w em tokens.css), folga mínima entre cartões e altura a partir da qual dois cartões na mesma coluna não se tocam. */
export const NODE_WIDTH = 280
const NODE_GAP = 40
const NODE_ROW = 200

/**
 * Posições salvas com o espaçamento de uma largura antiga (ex.: x=250 com cartão de 280) fazem cartões se
 * cobrirem ao abrir. Só na tela: empurra para a direita quem cobre um cartão anterior; o grafo salvo não muda
 * (só vira dado se a pessoa salvar). Quem não se cobre fica onde está.
 */
export function separateOverlaps<T extends { position: { x: number; y: number } }>(steps: T[]): T[] {
  const placed: { x: number; y: number }[] = []
  const out = new Map<T, T>()
  const order = [...steps].sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y)
  for (const n of order) {
    let x = n.position.x
    for (const p of placed) if (Math.abs(p.y - n.position.y) < NODE_ROW && x < p.x + NODE_WIDTH && x + NODE_WIDTH > p.x) x = p.x + NODE_WIDTH + NODE_GAP
    placed.push({ x, y: n.position.y })
    out.set(n, x === n.position.x ? n : { ...n, position: { ...n.position, x } })
  }
  return steps.map((n) => out.get(n)!)
}

/**
 * Com os cartões já medidos (altura real, não a suposta): se dois se cobrem, o de baixo desce até deixar uma folga de 40 px.
 * Só na tela, derivado do estado; o rascunho e o grafo salvo não mudam. Passos sem medida e notas/grupos ficam onde estão.
 */
export function separateByHeight<T extends { id: string; type?: string; position: { x: number; y: number }; measured?: { width?: number; height?: number } }>(nodes: T[]): T[] {
  const placed: { x: number; y: number; w: number; h: number }[] = []
  const out = new Map<string, T>()
  const steps = nodes.filter(n => n.type !== "frame" && n.type !== "sticky" && n.measured?.height).sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
  for (const n of steps) {
    const w = n.measured!.width ?? NODE_WIDTH, h = n.measured!.height!
    let y = n.position.y
    for (const p of placed) if (n.position.x < p.x + p.w && n.position.x + w > p.x && y < p.y + p.h + NODE_GAP && y + h + NODE_GAP > p.y) y = p.y + p.h + NODE_GAP
    placed.push({ x: n.position.x, y, w, h })
    if (y !== n.position.y) out.set(n.id, { ...n, position: { ...n.position, y } })
  }
  return out.size ? nodes.map(n => out.get(n.id) ?? n) : nodes
}

/**
 * Rascunho incompleto (ex.: `{}` gravado direto no banco) vira o fluxo de uma automação nova: só o gatilho, como o motor cria.
 * Um grafo com `nodes` (mesmo vazio) passa como está.
 */
export function completeGraph(graph: Partial<Graph> | null | undefined): Graph {
  const edges = Array.isArray(graph?.edges) ? graph.edges : [], annotations = Array.isArray(graph?.annotations) ? graph.annotations : undefined
  if (graph && Array.isArray(graph.nodes) && graph.edges === edges && graph.annotations === annotations) return graph as Graph
  return { nodes: Array.isArray(graph?.nodes) ? graph.nodes : [{ id: "trigger", type: "trigger", position: { x: 0, y: 80 }, config: {} }], edges, ...(annotations ? { annotations } : {}) }
}

export function toFlow(input: Graph): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const graph = completeGraph(input)
  const marks = (graph.annotations ?? []).map(annotationToNode)
  const steps = separateOverlaps(graph.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: { config: n.config },
      deletable: n.type !== "trigger",
      ariaLabel: stepAriaLabel(n.type, n.config),
    })))
  return {
    // Grupos primeiro (ficam atrás), notas por último (ficam na frente dos passos).
    nodes: [...marks.filter(n => n.type === "frame"), ...steps, ...marks.filter(n => n.type === "sticky")],
    edges: graph.edges.map((e) => {
      // Grafos antigos do fake usavam “then” na saída do gatilho.
      const port = e.port === "then" && graph.nodes.some(n => n.id === e.from && n.type === "trigger") ? PORT_THEN : e.port
      return { id: edgeId(e.from, port), source: e.from, sourceHandle: port, target: e.to }
    }),
  }
}

const textOperand = new Set(["add", "subtract", "add_days"])
/** Na ação Definir campo, a quantidade de somar/subtrair/dias digitada como texto numérico vai ao motor como número. */
function savedConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(config.actions)) return config
  return { ...config, actions: config.actions.map((a: FieldAction) => a?.type === "set_custom_field_value" && a.operation && textOperand.has(a.operation)
    ? { ...a, value: numericText(a.value) } : a) }
}

export function toGraph(nodes: FlowNode[], edges: FlowEdge[]): Graph {
  const marks = nodes.filter(isAnnotation).map(nodeToAnnotation)
  return {
    nodes: nodes.filter(n => !isAnnotation(n)).map<GraphNode>((n) => ({
      id: n.id,
      type: n.type as NodeType,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      config: savedConfig(n.data.config),
    })),
    edges: edges.map<GraphEdge>((e) => ({ from: e.source, port: e.sourceHandle ?? PORT_NEXT, to: e.target })),
    ...(marks.length ? { annotations: marks } : {}),
  }
}

export const getBlocks = (config: Record<string, unknown>): MessageBlock[] =>
  (config.blocks as MessageBlock[] | undefined) ?? []

export type TagAction = { type: "add_tag" | "remove_tag"; tag_id: string }
export type FieldOperation = "set" | "clear" | "add" | "subtract" | "add_days" | "set_now"
export type FieldAction = { type: "set_custom_field_value" | "unset_custom_field_value"; field_id: string; value?: unknown; operation?: FieldOperation }
/** Mesma tabela do motor (engine/src/flow/field-operations.ts): o que cada tipo de campo aceita. */
export const fieldOperationLabels: Record<FieldOperation, string> = {
  set: "Definir valor", clear: "Limpar valor", add: "Somar", subtract: "Subtrair", add_days: "Somar dias", set_now: "Definir como agora",
}
const operationsByType: Record<string, FieldOperation[]> = {
  number: ["set", "add", "subtract"], text: ["set", "clear"], date: ["set", "add_days", "set_now"], datetime: ["set", "add_days", "set_now"],
}
export const fieldOperationsFor = (field?: { type: string }): FieldOperation[] => operationsByType[field?.type ?? ""] ?? ["set"]
/** O campo guarda o que foi digitado ("1." e "1,5" enquanto se escreve); número de verdade só ao salvar. Vírgula decimal vale como ponto. */
export const numericText = (value: unknown): unknown => {
  if (typeof value !== "string" || !value.trim() || hasVariable(value)) return value
  const number = Number(value.trim().replace(",", "."))
  return Number.isFinite(number) ? number : value
}
const hasVariable = (value: string) => /\{\{[^{}]*\}\}/.test(value)
/** Quantidade de somar/subtrair/dias: número, ou texto com variável (o motor aplica o valor padrão se ela estiver vazia). */
export function validOperand(operation: FieldOperation, value: unknown): boolean {
  value = numericText(value)
  if (typeof value === "number") return operation === "add_days" ? Number.isInteger(value) : Number.isFinite(value)
  return typeof value === "string" && hasVariable(value)
}
export function describeFieldAction(a: FieldAction, fieldName: string): string {
  if (a.type === "unset_custom_field_value") return `Limpa ${fieldName}`
  const operation = a.operation ?? "set", value = typeof a.value === "string" ? a.value : JSON.stringify(a.value) ?? "sem valor"
  if (operation === "add") return `Soma ${value} em ${fieldName}`
  if (operation === "subtract") return `Subtrai ${value} de ${fieldName}`
  if (operation === "add_days") return `Soma ${value} dia(s) em ${fieldName}`
  if (operation === "set_now") return `Define ${fieldName} como agora`
  if (operation === "clear") return `Limpa ${fieldName}`
  return `Define ${fieldName}: ${JSON.stringify(a.value) ?? "sem valor"}`
}
/** Campo do bot: valor único do espaço; sem valor limpa. */
export type GlobalFieldAction = { type: "change_global_field_value"; field_id: string; value?: unknown; operation?: "set" | "add" | "subtract" }
export type SequenceAction = { type: "add_to_sequence" | "remove_from_sequence"; sequence_id: string }
export type ConversationAction = { type: "open_conversation" | "close_conversation" | "delete_subscriber" }
  | { type: "assign_conversation"; assignee_id: string | null }
  | { type: "notify_admin"; message: string; recipient_id?: string; via?: ("email" | "chat")[] }
  | { type: "pause_automations"; duration: Duration; automation_id?: string; scope?: "rules" | "sequences" }
  | { type: "subscribe_to_account" | "unsubscribe_to_account"; connection_id: string }
  | { type: "fire_custom_event"; event_name: string; value?: number; currency?: "BRL" | "USD" | "EUR" }
  | { type: "subscribe_topic" | "unsubscribe_topic"; topic_id: string }
  | { type: "apps_request"; app_id: string; action: string; inputs: Record<string, string> }
  | { type: "set_user_level_menu"; items: { title: string; automation_id: string }[] }
export type ExternalRequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
export type ExternalRequestAction = { type: "external_request"; method: ExternalRequestMethod; url: string; headers: { name: string; value: string }[]; body?: string; mappings: { path: string; field_id: string }[] }
export const externalMethods: ExternalRequestMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"]
export const optChannelLabels = { instagram: "Instagram", whatsapp: "WhatsApp", email: "e-mail", tiktok: "TikTok", telegram: "Telegram" } as const
export type OptChannel = keyof typeof optChannelLabels
/** Inscrição ou cancelamento no marketing de um tipo de canal: vale para todas as identidades do contato naquele canal. */
export type OptAction = { type: `set_${OptChannel}_opt_in` | `set_${OptChannel}_opt_out` }
const optLabels = Object.fromEntries(Object.entries(optChannelLabels).flatMap(([channel, name]) => [
  [`set_${channel}_opt_in`, `Inscrever no ${name}`], [`set_${channel}_opt_out`, `Cancelar inscrição no ${name}`],
])) as Record<OptAction["type"], string>
/** Google Sheets: inserir linha, buscar linha para campos ou atualizar células da linha encontrada. */
export type SheetsAction = { type: "google_sheets"; sheets: { operation: "insert_row" | "get_row" | "update_row"; spreadsheet_id: string; sheet: string; values?: unknown[]; lookup_column?: string; lookup_value?: string; mappings?: { column: string; field_id: string }[] } }
export type EditorAction = SheetsAction | TagAction | FieldAction | GlobalFieldAction | SequenceAction | ConversationAction | ExternalRequestAction | OptAction
export const actionLabels: Record<EditorAction["type"], string> = {
  add_tag: "Adicionar tag", remove_tag: "Remover tag", set_custom_field_value: "Definir valor de campo", unset_custom_field_value: "Limpar valor de campo", change_global_field_value: "Definir campo do bot",
  add_to_sequence: "Inscrever na sequência", remove_from_sequence: "Cancelar sequência",
  assign_conversation: "Atribuir conversa", open_conversation: "Abrir conversa", close_conversation: "Fechar conversa", notify_admin: "Notificar equipe",
  pause_automations: "Pausar automações", subscribe_to_account: "Ativar inscrição por conexão", unsubscribe_to_account: "Desativar inscrição por conexão",
  apps_request: "Ação de app", set_user_level_menu: "Trocar menu do contato", subscribe_topic: "Inscrever no tópico de notificação", unsubscribe_topic: "Cancelar tópico de notificação",
  delete_subscriber: "Excluir contato", fire_custom_event: "Registrar conversão", external_request: "Requisição externa", google_sheets: "Google Sheets",
  ...optLabels,
}
export function initialAction(type: EditorAction["type"], previous?: EditorAction, fields: EditorField[] = []): EditorAction {
  if (type === "add_tag" || type === "remove_tag") return { type, tag_id: previous && "tag_id" in previous ? previous.tag_id : "" }
  if (type === "add_to_sequence" || type === "remove_from_sequence") return { type, sequence_id: previous && "sequence_id" in previous ? previous.sequence_id : "" }
  if (type === "set_custom_field_value" || type === "unset_custom_field_value") {
    const field_id = previous && "field_id" in previous ? previous.field_id : ""
    return { type, field_id, ...(type === "set_custom_field_value" ? { value: previous && "value" in previous ? previous.value : initialFieldValue(fields.find(f => f.id === field_id)) } : {}) }
  }
  if (type === "change_global_field_value") return { type, field_id: "", value: "" }
  if (type === "assign_conversation") return { type, assignee_id: "" }
  if (type === "notify_admin") return { type, message: "" }
  if (type === "pause_automations") return { type, duration: { value: 30, unit: "minutes" } }
  if (type === "subscribe_to_account" || type === "unsubscribe_to_account") return { type, connection_id: previous && "connection_id" in previous ? previous.connection_id : "" }
  if (type === "fire_custom_event") return { type, event_name: "" }
  if (type === "set_user_level_menu") return { type, items: [] }
  if (type === "apps_request") return { type, app_id: "", action: "", inputs: {} }
  if (type === "subscribe_topic" || type === "unsubscribe_topic") return { type, topic_id: previous && "topic_id" in previous ? previous.topic_id : "" }
  if (type === "external_request") return { type, method: "GET", url: "", headers: [], mappings: [] }
  if (type === "google_sheets") return { type, sheets: { operation: "insert_row", spreadsheet_id: "", sheet: "Página1", values: [""] } }
  return { type }
}
export function describeAction(action: ConversationAction | ExternalRequestAction | OptAction | GlobalFieldAction | SheetsAction, botFields: { id: string; name: string }[] = []): string {
  if (action.type === "google_sheets") return `Google Sheets: ${{ insert_row: "insere linha", get_row: "busca linha", update_row: "atualiza linha" }[action.sheets.operation]} em ${action.sheets.sheet || "aba a definir"}`
  if (action.type === "change_global_field_value") { const name = botFields.find(f => f.id === action.field_id)?.name ?? "campo do bot a definir"; if (action.operation === "add" || action.operation === "subtract") return `${action.operation === "add" ? "Soma" : "Subtrai"} ${action.value} em ${name}`; return action.value == null || action.value === "" ? `Limpa ${name}` : `Define ${name}: ${typeof action.value === "string" ? action.value : JSON.stringify(action.value)}` }
  if (action.type === "external_request") return `${action.method} ${action.url.replace(/^https?:\/\//, "").replace(/[?#].*$/, "") || "endereço a definir"}${action.mappings?.length ? ` (grava ${action.mappings.length} campo${action.mappings.length > 1 ? "s" : ""})` : ""}`
  if (action.type === "assign_conversation") return action.assignee_id === null ? "Remove a atribuição da conversa" : "Atribui a conversa à equipe"
  if (action.type === "notify_admin") return `Notifica a equipe: ${action.message || "mensagem a definir"}`
  if (action.type === "pause_automations") return action.duration && validDuration(action.duration) ? `Pausa ${action.automation_id ? "uma automação" : action.scope === "rules" ? "automações de regras" : action.scope === "sequences" ? "automações de sequências" : "automações"} por ${describeDelay(action.duration)}` : "Duração da pausa a definir"
  if (action.type === "fire_custom_event") return `Registra conversão: ${action.event_name || "evento a definir"}${typeof action.value === "number" ? ` (${action.value.toLocaleString("pt-BR")})` : ""}`
  return actionLabels[action.type]
}
export const getActions = (config: Record<string, unknown>): EditorAction[] =>
  (config.actions as EditorAction[] | undefined) ?? []

export type FieldOperator = "equals" | "not_equals" | "contains" | "not_contains" | "starts_with" | "is_set" | "is_not_set" | "gt" | "gte" | "lt" | "lte" | "within_days"
export type ConditionRule = TemporalRule | { type: "tag"; tag_id: string; operator: "has" | "not_has" }
  | { type: "any_tag"; tag_ids: string[]; operator: "has" | "not_has" }
  | { type: "topic"; topic_id?: string; operator: "has" | "not_has" }
  | { type: "segment"; segment_id: string; operator: "in" | "not_in" | "has" | "not_has" }
  | { type: "field"; field_id: string; operator: FieldOperator; value?: unknown }
  | { type: "bot_field"; field_id: string; operator: FieldOperator; value?: unknown }
  | { type: "email"; filter: EmailFilter }
  | { type: "system_field"; field: string; operator: FieldOperator; value?: unknown }
export const getRules = (config: Record<string, unknown>): ConditionRule[] => (config.rules as ConditionRule[] | undefined) ?? []
export type Variation = { id: string; weight: number }
export const getVariations = (config: Record<string, unknown>): Variation[] => (config.variations as Variation[] | undefined) ?? []
export type EditableNodeType = "question" | "message" | "action" | "smart_delay" | "dynamic" | "template_message" | "condition" | "randomizer" | "start_automation"
export type EditorField = Omit<CustomField, "type"> & { type: CustomField["type"] | "array" }
export type Catalogs = { botFields?: { id: string; type?: string }[]; sequences?: { id: string; name: string }[]; fields?: EditorField[]; segments?: { id: string; name: string }[]; automations?: Automation[]; automationId?: string; members?: { id: string }[]; connections?: Connection[] }

export const fieldOperators: Record<FieldOperator, string> = {
  within_days: "Nos últimos dias", equals: "É igual a", not_equals: "É diferente de", contains: "Contém o texto", not_contains: "Não contém o texto", starts_with: "Começa com",
  is_set: "Tem valor salvo", is_not_set: "Não tem valor salvo",
  gt: "É maior que", gte: "É maior ou igual a", lt: "É menor que", lte: "É menor ou igual a",
}
/** Comparações que o motor aceita em campo do bot, por tipo. */
export function botOperatorsFor(type?: EditorField["type"]): FieldOperator[] {
  return ["equals", "not_equals", "is_set", "is_not_set", ...(type === "text" ? ["contains", "not_contains", "starts_with"] : []),
    ...(type === "number" || type === "date" || type === "datetime" ? ["gt", "gte", "lt", "lte"] : [])] as FieldOperator[]
}
export const needsValue = (operator: string) => operator !== "is_set" && operator !== "is_not_set"
export function operatorsFor(field?: EditorField): FieldOperator[] {
  return ["equals", "not_equals", "is_set", "is_not_set", ...(field?.type === "text" ? ["contains"] : []),
    ...(field?.type === "number" ? ["gt", "gte", "lt", "lte"] : [])] as FieldOperator[]
}
export function initialFieldValue(field?: EditorField): unknown {
  return field?.type === "boolean" ? false : field?.type === "array" ? [] : ""
}
export function validFieldValue(field: EditorField, value: unknown): boolean {
  if (field.type === "text") return typeof value === "string"
  if (field.type === "number") return typeof value === "number" && Number.isFinite(value)
  if (field.type === "boolean") return typeof value === "boolean"
  if (field.type === "array") return Array.isArray(value)
  if (typeof value !== "string") return false
  if (field.type === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
  return /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && validFieldValue({ ...field, type: "date" }, value.slice(0, 10)) && !Number.isNaN(Date.parse(value))
}

/** Todas as formas de ligar passos usam as mesmas portas do executor. */
export function outputPorts(node: FlowNode): { port: string; label: string }[] {
  if (node.type === "question") return [{ port: "success", label: "Resposta válida" }, { port: "no_response", label: "Sem resposta" }]
  if (node.type === "condition") return [{ port: "true", label: "Se atender às regras" }, { port: "false", label: "Se não atender às regras" }]
  if (node.type === "randomizer" || node.type === "split") return getVariations(node.data.config).map((v, i) => ({ port: v.id, label: `Caminho ${i + 1}` }))
  if (node.type === "trigger") return [{ port: PORT_THEN, label: "Então vai para" }]
  const replies = node.type === "message" ? getBlocks(node.data.config).some(isQuickReply) : false
  return [...(node.type === "message" ? getBlocks(node.data.config).flatMap(b => b.kind === "button" && b.action.type === "go_to_node"
    ? [{ port: btnPort(b.id), label: `Ao tocar em “${b.label || "botão sem título"}” vai para` }]
    : b.kind === "button" && b.action.type === "url" ? [{ port: btnPort(b.id), label: `Ao abrir o link “${b.label || "botão sem título"}” segue para` }]
    : isQuickReply(b) ? [{ port: btnPort(b.id), label: `Ao tocar em “${b.label || "resposta sem título"}” vai para` }]
    : isListBlock(b) ? listRows(b).map(r => ({ port: btnPort(r.id), label: `Ao escolher “${r.title || "opção sem título"}” vai para` })) : []) : []),
    { port: PORT_NEXT, label: replies ? "Se não tocar, vai para" : "Próximo passo vai para" }]
}

export type DelayUnit = "seconds" | "minutes" | "hours" | "days"
export type Duration = { value: number; unit: DelayUnit }
export const unitLabel: Record<DelayUnit, string> = { seconds: "segundos", minutes: "minutos", hours: "horas", days: "dias" }
const unitSeconds: Record<DelayUnit, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 }
export function getDuration(config: Record<string, unknown>): Duration {
  const d = config.duration as Duration | undefined
  return d && Object.hasOwn(unitSeconds, d.unit) ? d : { value: 0, unit: "minutes" }
}
export function validDuration(d: Duration): boolean {
  return Number.isInteger(d.value) && d.value > 0 && d.value * unitSeconds[d.unit] <= 365 * 86400
}
export function describeDelay(d: Duration): string {
  const singular: Record<DelayUnit, string> = { seconds: "segundo", minutes: "minuto", hours: "hora", days: "dia" }
  return `${d.value} ${d.value === 1 ? singular[d.unit] : unitLabel[d.unit]}`
}

/** O React Flow mede e seleciona nós na carga; só o grafo persistido conta como edição. */
export const graphSnapshot = (nodes: FlowNode[], edges: FlowEdge[]) => JSON.stringify(toGraph(nodes, edges))

export const channelLabels: Record<ChannelType, string> = {
  instagram: "Instagram", telegram: "Telegram", messenger: "Messenger", whatsapp: "WhatsApp",
  tiktok: "TikTok", email: "E-mail",
}
export function automationChannel(triggers: Trigger[]): ChannelType | undefined {
  const channels = [...new Set(triggers.map(t => t.channel_type).filter((c): c is ChannelType => !!c))]
  return channels.length === 1 ? channels[0] : undefined
}
/** A Bot API do Telegram não avisa entrega nem leitura ao bot (conferido na doc em 23/10/2026). */
export function hasReceipts(config: Record<string, unknown>, triggers: Trigger[]): boolean {
  return effectiveChannel(config, triggers) !== "telegram"
}
/** O Instagram só avisa a leitura (webhook messaging_seen), nunca a entrega: o cartão não mostra "entregues" nesses canais. */
export function reportsDelivery(config: Record<string, unknown>, triggers: Trigger[]): boolean {
  const channel = effectiveChannel(config, triggers)
  return channel !== "telegram" && channel !== "instagram"
}
/** Porcentagens do cartão do passo, sempre sobre as enviadas e nunca acima de 100%
 * (uma leitura pode chegar de mensagem que o cartão não contou como enviada). */
export function receiptShares(s: { sent?: number; delivered?: number; read?: number }, delivery: boolean): { delivered: number | null; read: number | null } {
  const sent = s.sent ?? 0
  if (sent <= 0) return { delivered: null, read: null }
  const share = (n?: number) => Math.min(1, (n ?? 0) / sent)
  return { delivered: delivery ? share(s.delivered) : null, read: share(s.read) }
}
/** O canal do passo: o que foi escolhido nele; sem escolha (fluxo antigo), o do gatilho. */
function effectiveChannel(config: Record<string, unknown>, triggers: Trigger[]): ChannelType | undefined {
  const own = stepChannelOf(config)
  return own && own !== PENDING_CHANNEL ? own : automationChannel(triggers)
}
export function messageChannel(config: Record<string, unknown>, triggers: Trigger[]): string {
  if (stepChannelOf(config) === PENDING_CHANNEL) return "Canal a escolher"
  if (config.email) return channelLabels.email
  const channel = effectiveChannel(config, triggers)
  return channel && channel in channelLabels ? channelLabels[channel] : "Canal não definido"
}

export function newId(prefix: string, existing: string[]) {
  let n = 1
  while (existing.includes(`${prefix}${n}`)) n++
  return `${prefix}${n}`
}

export function newButtonId(blocks: MessageBlock[]) {
  const used = blocks.flatMap((b) => (b.kind === "button" ? [b.id] : []))
  return newId("b", used)
}
export function newQuickReplyId(blocks: MessageBlock[]) {
  return newId("q", blocks.flatMap((b) => (isQuickReply(b) ? [b.id] : [])))
}

/** Prefixo do id de cada tipo de passo novo (m1, a2...). */
export const stepIdPrefix: Record<EditableNodeType, string> = { question: "q", message: "m", action: "a", smart_delay: "d", dynamic: "y", template_message: "w", condition: "c", randomizer: "r", start_automation: "s" }

/**
 * Primeiro passo de um fluxo só com o gatilho (lista do celular): nasce à direita do gatilho, ligado ao "Então",
 * com a configuração padrão e o canal escolhido (mensagem).
 */
export function withFirstStep(graph: Graph, type: EditableNodeType, channel: string | undefined, lang: string): { graph: Graph; id: string } {
  const trigger = graph.nodes.find(n => n.type === "trigger")
  const id = newId(stepIdPrefix[type], graph.nodes.map(n => n.id))
  const node: GraphNode = { id, type: type as NodeType, position: trigger ? { x: trigger.position.x + FIRST_STEP_GAP.automation, y: trigger.position.y } : { x: 0, y: 80 }, config: { ...defaultConfig(type), ...(channel ? { channel } : {}), label: creationTitle(type, lang) } }
  return { id, graph: { ...graph, nodes: [...graph.nodes, node], edges: trigger ? [...graph.edges.filter(e => !(e.from === trigger.id && e.port === PORT_THEN)), { from: trigger.id, port: PORT_THEN, to: id }] : graph.edges } }
}

export function defaultConfig(type: EditableNodeType): Record<string, unknown> {
  if (type === "question") return { text: "", answer_type: "text", field_id: "", retry_message: questionDefaultRetry, max_attempts: 3, skip: false, timeout: { value: 5, unit: "minutes" }, choices: [] }
  if (type === "message") return { blocks: [{ kind: "text", text: "" }] }
  if (type === "action") return { actions: [] }
  if (type === "condition") return { match: "all", rules: [] }
  if (type === "randomizer") return { variations: [{ id: "v1", weight: 50 }, { id: "v2", weight: 50 }], random_every_time: true }
  if (type === "start_automation") return { automation_id: "", wait_for_finish: true }
  if (type === "dynamic") return { url: "", fallback_text: "" }
  if (type === "template_message") return { template_id: "", params: {} }
  return { duration: { value: 5, unit: "minutes" } }
}

// ───────── Regras ─────────

export const FIRST_MSG_MAX_BLOCKS = { text: 1, button: 1 }
/** Fichas de botão das conexões do gatilho; conexão sem ficha carregada vale o padrão (3). */
const buttonProfiles = (connections: Connection[]) => connections.map(c => ({ buttons: { maxPerMessage: c.profile?.buttons?.maxPerMessage ?? BUTTON_DEFAULT_MAX } }))
/** Quantos botões cabem na mensagem: o menor limite entre as conexões (3; Telegram 10). */
export const buttonLimitFor = (connections: Connection[]) => buttonLimit(buttonProfiles(connections))
export const TEXT_MAX = 1000

export function triggerOf(node: FlowNode | undefined, triggers: Trigger[]): Trigger | undefined {
  return triggersOf(node, triggers)[0]
}

/** Todos os gatilhos que entram por este passo — uma automação pode ser disparada em vários canais. */
export function triggersOf(node: FlowNode | undefined, triggers: Trigger[]): Trigger[] {
  if (!node || node.type !== "trigger") return []
  const linked = triggers.filter((t) => t.id === node.data.config.trigger_id || t.node_id === node.id)
  if (linked.length) return linked
  return triggers.length === 1 && !node.data.config.trigger_id && !triggers[0].node_id ? [triggers[0]] : []
}

/** A primeira mensagem continua sendo resposta privada mesmo quando há ações antes dela. */
export function isFirstAfterComment(nodeId: string, nodes: FlowNode[], edges: FlowEdge[], triggers: Trigger[]): boolean {
  const visited = new Set<string>([nodeId])
  const preceding = (id: string): boolean => edges.some(edge => {
    if (edge.target !== id || visited.has(edge.source)) return false
    visited.add(edge.source)
    const source = nodes.find(node => node.id === edge.source)
    if (!source || source.type === "message") return false
    if (source.type === "trigger") return triggersOf(source, triggers).some(trigger => trigger.type === "ig_comment")
    return preceding(source.id)
  })
  return preceding(nodeId)
}

const urlOk = (u: string) => /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(u.trim())
export const isValidUrl = urlOk

export function validateGraph(allNodes: FlowNode[], edges: FlowEdge[], triggers: Trigger[], catalogs: Catalogs = {}): Record<string, string[]> {
  const botIds = new Set((catalogs.botFields ?? []).map(f => f.id))
  const nodes = allNodes.filter(n => !isAnnotation(n))
  const out: Record<string, string[]> = {}
  const add = (id: string, msg: string) => (out[id] ??= []).push(msg)
  const hasEdge = (from: string, port: string) => edges.some((e) => e.source === from && e.sourceHandle === port)
  for (const id of disconnectedSteps(toGraph(nodes, edges))) add(id, "Passo solto. Ligue este passo ao gatilho antes de publicar.")

  for (const n of nodes) {
    if (n.type === "trigger") {
      if (!triggersOf(n, triggers).length) add(n.id, "Adicione um gatilho: sem ele nada dispara esta automação.")
      if (!hasEdge(n.id, PORT_THEN)) add(n.id, "Ligue a porta “Então” a um passo.")
    } else if (n.type === "question") {
      if (isFirstAfterComment(n.id, nodes, edges, triggers)) add(n.id, "Coloque a pergunta depois de uma nova interação; o comentário exige primeiro uma resposta privada.")
      const parsed = questionSchema.safeParse(n.data.config)
      if (!parsed.success) add(n.id, "Preencha pergunta, tipo, tentativas e tempo limite válidos. As opções precisam ser distintas.")
      if (parsed.success) {
        const config = parsed.data
        const field = catalogs.fields?.find(f => f.id === config.field_id && f.scope === "contact" && !("archived" in f && f.archived))
        if (questionSystemField(config.field_id)) {
          if (!questionSystemFieldFits(config.field_id, config.answer_type)) add(n.id, "O campo do sistema não combina com o tipo da resposta.")
        } else if (catalogs.fields && (!field || field.type !== questionFieldType(config.answer_type))) add(n.id, "Escolha um campo disponível e compatível com o tipo da resposta.")
        for (const text of [config.text, config.retry_message]) for (const error of variableErrors(text, new Set((catalogs.fields ?? []).map(f => f.id)), botIds)) add(n.id, error)
        if (catalogs.connections) {
          for (const connection of questionConnections(triggers, catalogs.connections)) {
            const error = questionCapabilityError(config, connection.profile ?? {})
            if (error) add(n.id, `${error} Confira a ficha da conexão ${connection.displayName || connection.label}.`)
          }
        }
      }
    } else if (n.type === "message") {
      const email = n.data.config.email as { subject?: string; preheader?: string; senderId?: string; html?: string; text?: string; onOpen?: { automationId?: string; actions?: unknown[] }; linkActions?: { url: string; automationId?: string; actions?: unknown[] }[] } | undefined
      if (email) {
        if (!email.subject?.trim()) add(n.id, "Preencha o assunto do e-mail.")
        if (!email.preheader?.trim()) add(n.id, "Preencha a prévia do e-mail.")
        if (!email.senderId) add(n.id, "Escolha o remetente do e-mail.")
        if (!email.html || !email.text?.trim()) add(n.id, "Adicione o design e o corpo do e-mail.")
        if (email.onOpen && !email.onOpen.automationId && !email.onOpen.actions?.length) add(n.id, "Escolha uma ação para a abertura do e-mail.")
        if (email.linkActions?.some(link => !urlOk(link.url) || !link.automationId && !link.actions?.length)) add(n.id, "Confira o endereço e a ação de cada clique.")
      }
      const blocks = getBlocks(n.data.config)
      if (!blocks.some((b) => (b.kind === "text" && b.text.trim()) || b.kind === "media" || isCards(b))) add(n.id, "Escreva o texto da mensagem.")
      const ownChannel = stepChannelOf(n.data.config)
      const channelConnections = stepConnections(n.data.config, triggers, catalogs.connections ?? [])
      if (ownChannel && ownChannel !== PENDING_CHANNEL && catalogs.connections && !channelConnections.length) add(n.id, `Não há conexão de ${stepChannelLabels[ownChannel]} ligada para este passo.`)
      // Passo com canal escolhido: o limite é o da ficha (na unidade dela); sem canal, o antigo.
      const textLimit = ownChannel && ownChannel !== PENDING_CHANNEL ? stepOffer(channelConnections).text : null
      if (textLimit) { if (blocks.some((b) => b.kind === "text" && textSize(b.text, textLimit.unit) > textLimit.max)) add(n.id, `Texto acima de ${textLimit.max.toLocaleString("pt-BR")} ${textLimit.unit === "bytes" ? "bytes" : "caracteres"}.`) }
      else if (blocks.some((b) => b.kind === "text" && b.text.length > TEXT_MAX)) add(n.id, `Texto acima de ${TEXT_MAX} caracteres.`)
      if (blocks.some(isQuickReply)) {
        const targets = stepConnections(n.data.config, triggers, catalogs.connections ?? [])
        if (!targets.length) add(n.id, "Escolha uma conexão compatível no gatilho.")
        for (const connection of targets) {
          const error = quickRepliesError(blocks, [{ quickReplies: connection.profile?.quickReplies, buttons: connection.profile?.buttons ?? { types: [], maxPerMessage: 0, titleMax: 0, payloadMaxBytes: 0 } }], n.data.config)
          if (error) add(n.id, `${connection.displayName || connection.label}: ${error}`)
        }
      }
      if (blocks.some(isListBlock)) {
        const targets = stepConnections(n.data.config, triggers, catalogs.connections ?? [])
        if (!targets.length) add(n.id, "Escolha uma conexão compatível no gatilho.")
        for (const connection of targets) {
          const error = listError(blocks, [{ list: connection.profile?.list }])
          if (error) add(n.id, `${connection.displayName || connection.label}: ${error}`)
        }
      }
      {
        const error = buttonsError(blocks, buttonProfiles(stepConnections(n.data.config, triggers, catalogs.connections ?? [])))
        if (error) add(n.id, error)
      }
      if (blocks.some(b => b.kind === "typing" && !(b.seconds >= 1 && b.seconds <= 10))) add(n.id, "A digitação aceita de 1 a 10 segundos.")
      for (const b of blocks) {
        if (isCards(b)) {
          const targets = stepConnections(n.data.config, triggers, catalogs.connections ?? [])
          if (!targets.length) add(n.id, 'Escolha uma conexão compatível no gatilho.')
          for (const connection of targets) {
            const error = cardsIssue(b, blocks, cardsProfiles([connection]))
            if (error) add(n.id, `${connection.displayName || connection.label}: ${error}`)
          }
          for (const text of cardTexts(b)) for (const error of variableErrors(text, new Set((catalogs.fields ?? []).filter(f => f.scope === 'contact').map(f => f.id)), botIds)) add(n.id, error)
        }
        if (b.kind === 'media') {
          const profiles = mediaProfiles(stepConnections(n.data.config, triggers, catalogs.connections ?? []))
          const error = mediaError(b, profiles)
          if (error) add(n.id, error)
          for (const error of variableErrors(b.url, new Set((catalogs.fields ?? []).filter(f => f.scope === 'contact').map(f => f.id)), botIds)) add(n.id, error)
        }
        if (b.kind === "text" || b.kind === "button" || isQuickReply(b)) {
          const ids = new Set((catalogs.fields ?? []).filter(f => f.scope === "contact").map(f => f.id))
          for (const error of variableErrors(b.kind === "text" ? b.text : b.label, ids, botIds)) add(n.id, error)
        }
        if (isListBlock(b)) {
          const ids = new Set((catalogs.fields ?? []).filter(f => f.scope === "contact").map(f => f.id))
          for (const row of listRows(b)) {
            for (const error of variableErrors(`${row.title} ${row.description ?? ""}`, ids, botIds)) add(n.id, error)
            if (!hasEdge(n.id, btnPort(row.id))) add(n.id, `Opção “${row.title || "sem título"}” da lista não leva a nenhum passo.`)
          }
        }
        if (isQuickReply(b) && !b.skip && !hasEdge(n.id, btnPort(b.id))) add(n.id, `Resposta rápida “${b.label || "sem título"}” não leva a nenhum passo.`)
        if (b.kind !== "button") continue
        if (!b.label.trim()) add(n.id, "Dê um título ao botão.")
        if (b.action.type === "url" && !urlOk(b.action.url)) add(n.id, `Botão “${b.label || "sem título"}”: informe um endereço válido.`)
        if (b.action.type === "go_to_node" && !b.actions?.length && !hasEdge(n.id, btnPort(b.id))) add(n.id, `Botão “${b.label || "sem título"}” não leva a nenhum passo.`)
        if (b.action.type === "start_automation" && (!b.action.automation_id || (catalogs.automations && !catalogs.automations.some(a => a.id === (b.action as { automation_id: string }).automation_id && a.status === "live" && a.published_version_id && !a.deleted_at)))) add(n.id, `Botão “${b.label || "sem título"}”: escolha uma automação publicada e ligada.`)
        if ((b.actions?.length ?? 0) > 5) add(n.id, "Use até cinco ações por botão.")
        for (const action of b.actions ?? []) {
          if (!buttonActionSchema.safeParse(action).success) add(n.id, "Complete a ação do botão.")
          if ('tag_id' in action && !action.tag_id) add(n.id, "Escolha a tag do botão.")
          if ('field_id' in action) {
            const field = catalogs.fields?.find(f => f.id === action.field_id && f.scope === 'contact' && !("archived" in f && f.archived))
            if (!action.field_id || catalogs.fields && !field) add(n.id, "Escolha um campo de contato disponível para o botão.")
            if (action.type === 'set_custom_field_value' && (!Object.hasOwn(action, 'value') || field && !validFieldValue(field, action.value))) add(n.id, "Informe um valor compatível com o campo do botão.")
          }
        }
      }
      if (isFirstAfterComment(n.id, nodes, edges, triggers)) {
        const texts = blocks.filter((b) => b.kind === "text").length
        const buttons = blocks.filter((b) => b.kind === "button").length
        const typing = blocks.some((b) => b.kind === "typing")
        if (texts > FIRST_MSG_MAX_BLOCKS.text || buttons > FIRST_MSG_MAX_BLOCKS.button || typing || blocks.some(b => b.kind === "media" || isCards(b) || isQuickReply(b) || isListBlock(b)))
          add(n.id, "A primeira mensagem após um comentário aceita só 1 texto e 1 botão (de link ou de toque).")
        if (blocks.some(block => block.kind === "button" && block.action.type !== "url" && block.action.type !== "go_to_node"))
          add(n.id, "A primeira resposta privada aceita botão de link ou de toque (ir para um passo).")
        // Só o toque é uma resposta da pessoa: a saída direta ou a de tempo esgotado enviariam mensagem a quem ainda não respondeu.
        const tap = blocks.find(block => block.kind === "button" && block.action.type === "go_to_node")
        if (edges.some(edge => edge.source === n.id && edge.sourceHandle !== (tap && tap.kind === "button" ? `btn:${tap.id}` : undefined)))
          add(n.id, "Na primeira resposta privada só o botão de toque pode levar a outro passo: tire a ligação direta ou a de tempo esgotado.")
      }
    } else if (n.type === "action") {
      const acts = getActions(n.data.config)
      if (acts.length === 0) add(n.id, "Adicione ao menos uma ação.")
      for (const a of acts) {
        if (a.type === "add_tag" || a.type === "remove_tag") {
          if (!a.tag_id) add(n.id, "Escolha a tag da ação.")
        } else if (a.type === "set_custom_field_value" || a.type === "unset_custom_field_value") {
          const field = catalogs.fields?.find(f => f.id === a.field_id && f.scope === "contact")
          if (!a.field_id || (catalogs.fields && !field)) add(n.id, "Escolha um campo de contato disponível.")
          const operation = a.operation ?? "set"
          if (a.type === "set_custom_field_value" && field && !fieldOperationsFor(field).includes(operation)) add(n.id, "Essa operação não existe para o tipo do campo.")
          else if (a.type === "set_custom_field_value" && operation === "set" && (!Object.hasOwn(a, "value") || (field && !validFieldValue(field, a.value) && !(field.type === "text" && typeof a.value === "string")))) add(n.id, "Informe um valor compatível com o tipo do campo.")
          else if (a.type === "set_custom_field_value" && (operation === "add" || operation === "subtract" || operation === "add_days") && !validOperand(operation, a.value)) add(n.id, operation === "add_days" ? "Informe a quantidade de dias (número inteiro) ou uma variável." : "Informe um número ou uma variável para a operação.")
        } else if (a.type === "change_global_field_value") {
          if (!a.field_id) add(n.id, "Escolha o campo do bot.")
          if ((a.operation === "add" || a.operation === "subtract") && (typeof a.value !== "number" || !Number.isFinite(a.value))) add(n.id, "Informe o número a somar ou subtrair.")
        } else if (a.type === "add_to_sequence" || a.type === "remove_from_sequence") {
          if (!a.sequence_id || (catalogs.sequences && !catalogs.sequences.some(s => s.id === a.sequence_id))) add(n.id, "Escolha uma sequência disponível neste espaço.")
        } else if (a.type === "assign_conversation") {
          if (a.assignee_id !== null && (!a.assignee_id || (catalogs.members && !catalogs.members.some(m => m.id === a.assignee_id)))) add(n.id, "Escolha uma pessoa disponível para o atendimento.")
        } else if (a.type === "notify_admin") {
          if (typeof a.message !== "string" || !a.message.trim() || a.message.length > 2000) add(n.id, "Escreva uma notificação de até 2.000 caracteres.")
          if (a.recipient_id && catalogs.members && !catalogs.members.some(m => m.id === a.recipient_id)) add(n.id, "Escolha uma pessoa disponível para a notificação.")
        } else if (a.type === "pause_automations") {
          if (!a.duration || !validDuration(a.duration)) add(n.id, "Informe uma pausa inteira positiva de até um ano.")
        } else if (a.type === "subscribe_to_account" || a.type === "unsubscribe_to_account") {
          if (!a.connection_id || (catalogs.connections && !catalogs.connections.some(c => c.id === a.connection_id))) add(n.id, "Escolha uma conexão disponível neste espaço.")
        } else if (a.type === "apps_request") {
          if (!a.app_id || !a.action) add(n.id, "Escolha o app e a ação.")
        } else if (a.type === "subscribe_topic" || a.type === "unsubscribe_topic") {
          if (!a.topic_id) add(n.id, "Escolha um tópico de notificação.")
        } else if (a.type === "fire_custom_event") {
          if (typeof a.event_name !== "string" || !a.event_name.trim() || a.event_name.length > 100) add(n.id, "Dê um nome de até 100 caracteres à conversão.")
          if (a.value !== undefined && (!Number.isFinite(a.value) || a.value < 0)) add(n.id, "Informe um valor de conversão positivo ou zero.")
        } else if (a.type === "google_sheets") {
          const g = a.sheets
          if (!g?.spreadsheet_id || g.spreadsheet_id.length < 10 || !g.sheet?.trim()) add(n.id, "Informe o ID da planilha e a aba.")
          if (g?.operation !== "insert_row" && !/^[A-Z]{1,3}$/.test(g?.lookup_column ?? "")) add(n.id, "Informe a coluna de busca (letra).")
          if (g?.operation === "insert_row" && !(g.values ?? []).length) add(n.id, "Informe ao menos um valor da linha.")
        } else if (a.type === "external_request") {
          if (!externalMethods.includes(a.method)) add(n.id, "Escolha o método da requisição.")
          const issue = typeof a.url === "string" && a.url.trim() ? staticUrlIssue(a.url) : "Informe o endereço da requisição."
          if (issue) add(n.id, issue)
          const known = new Set((catalogs.fields ?? []).filter(f => f.scope === "contact").map(f => f.id))
          const texts = [a.url ?? "", (a.body ?? "").replaceAll("{{full_contact_data}}", ""), ...(a.headers ?? []).map(h => h.value)]
          if (catalogs.fields) for (const error of texts.flatMap(text => variableErrors(text, known, botIds))) add(n.id, error)
          if ((a.headers ?? []).some(h => !/^[A-Za-z0-9-]{1,100}$/.test(h.name) || ["host", "content-length", "connection", "transfer-encoding"].includes(h.name.toLowerCase()))) add(n.id, "Confira o nome dos cabeçalhos (letras, números e hífen).")
          if ((a.headers ?? []).length > 10) add(n.id, "Use no máximo 10 cabeçalhos.")
          const mappings = a.mappings ?? []
          if (mappings.length > 10 || mappings.some(m => !m.path?.trim() || !m.field_id)) add(n.id, "Complete o caminho e o campo de cada mapeamento.")
          if (new Set(mappings.map(m => m.field_id)).size !== mappings.length) add(n.id, "Cada campo pode receber só um caminho.")
          if (catalogs.fields && mappings.some(m => m.field_id && !catalogs.fields!.some(f => f.id === m.field_id && f.scope === "contact"))) add(n.id, "Escolha campos de contato disponíveis no mapeamento.")
        } else if (!["open_conversation", "close_conversation", "delete_subscriber"].includes(a.type) && !(a.type in optLabels)) add(n.id, "Esta ação não é executada pelo motor.")
      }
    } else if (n.type === "condition") {
      const rules = getRules(n.data.config)
      if (!["all", "any"].includes(String(n.data.config.match))) add(n.id, "Escolha como combinar as regras.")
      if (!rules.length) add(n.id, "Adicione ao menos uma regra.")
      for (const rule of rules) {
        if (rule.type === "any_tag") {
          if (!rule.tag_ids?.length || !["has", "not_has"].includes(rule.operator)) add(n.id, "Escolha ao menos uma tag e a comparação da regra.")
        } else if (rule.type === "tag") {
          if (!rule.tag_id || !["has", "not_has"].includes(rule.operator)) add(n.id, "Escolha a tag e a comparação da regra.")
        } else if (rule.type === "segment") {
          if (!rule.segment_id || !["in", "not_in", "has", "not_has"].includes(rule.operator) || (catalogs.segments && !catalogs.segments.some(s => s.id === rule.segment_id))) add(n.id, "Escolha um segmento disponível e a comparação da regra.")
        } else if (rule.type === "field") {
          const field = catalogs.fields?.find(f => f.id === rule.field_id && f.scope === "contact")
          if (!rule.field_id || (catalogs.fields && !field)) add(n.id, "Escolha um campo de contato disponível.")
          if (!Object.hasOwn(fieldOperators, rule.operator) || (field && !operatorsFor(field).includes(rule.operator))) add(n.id, "A comparação não é compatível com o campo.")
          if (needsValue(rule.operator) && (!Object.hasOwn(rule, "value") || (field && !validFieldValue(field, rule.value)))) add(n.id, "Informe um valor compatível com o tipo do campo.")
        } else if (rule.type === "bot_field") {
          const field = catalogs.botFields?.find(f => f.id === rule.field_id)
          if (!rule.field_id || (catalogs.botFields && !field)) add(n.id, "Escolha um campo do bot disponível.")
          else if (field?.type) {
            const type = field.type as EditorField["type"]
            if (!Object.hasOwn(fieldOperators, rule.operator) || !botOperatorsFor(type).includes(rule.operator)) add(n.id, "A comparação não é compatível com o campo do bot.")
            else if (needsValue(rule.operator) && (!Object.hasOwn(rule, "value") || !validFieldValue({ type } as EditorField, rule.value))) add(n.id, "Informe um valor compatível com o tipo do campo do bot.")
          }
        } else if (rule.type === "sequence") {
          if (!rule.sequence_id || !["has", "not_has"].includes(rule.operator) || (catalogs.sequences && !catalogs.sequences.some(s => s.id === rule.sequence_id))) add(n.id, "Escolha uma sequência disponível e a comparação.")
        } else if (rule.type === "origin") {
          if (!originOptions.some(o => o.id === rule.origin) || !["is", "is_not"].includes(rule.operator)) add(n.id, "Escolha a origem do contato e a comparação.")
        } else if (rule.type === "current_time" || rule.type === "date") {
          if (!flowConditionSchema.safeParse({ match: "all", rules: [rule] }).success) add(n.id, "Confira a data, o horário, os dias e o fuso da condição.")
          if (rule.type === "date" && catalogs.fields) {
            const field = catalogs.fields.find(f => f.id === rule.field_id && f.scope === "contact" && ["date", "datetime"].includes(f.type))
            const compare = rule.compare
            const compared = compare?.kind === "field" ? catalogs.fields.find(f => f.id === compare.field_id && f.scope === "contact" && f.type === field?.type) : true
            if (!field || !compared) add(n.id, "Escolha campos de data disponíveis e do mesmo tipo.")
          }
        } else if (rule.type === "email") {
          if (!emailFilters.some(filter => filter.id === rule.filter)) add(n.id, "Escolha uma condição de e-mail válida.")
        } else if (rule.type === "system_field") {
          const field = emailSystemFields.find(field => field.id === rule.field)
          if (!field || !emailOperatorsFor(rule.field).includes(rule.operator as never)) add(n.id, "Escolha o dado e a comparação de e-mail.")
          if (rule.operator === "within_days" && (typeof rule.value !== "number" || !Number.isInteger(rule.value) || rule.value < 1 || rule.value > 36500)) add(n.id, "Informe um período válido em dias.")
          if (needsValue(rule.operator) && (!field || !Object.hasOwn(rule, "value") || !validFieldValue(field, rule.value))) add(n.id, "Informe um valor compatível com o dado de e-mail.")
          else if (field && systemFieldChoices[field.id] && needsValue(rule.operator) && !systemFieldChoices[field.id].some(choice => choice.id === rule.value)) add(n.id, "Escolha um dos valores disponíveis para este dado.")
        } else add(n.id, "Tipo de regra não reconhecido.")
      }
    } else if (n.type === "randomizer" || n.type === "split") {
      const variations = getVariations(n.data.config)
      if (variations.length < 2 || variations.length > 6) add(n.id, "Use entre dois e seis caminhos.")
      if (variations.some(v => !v.id.trim() || !Number.isFinite(v.weight) || v.weight <= 0) || !Number.isFinite(variations.reduce((sum, v) => sum + v.weight, 0)) || new Set(variations.map(v => v.id)).size !== variations.length)
        add(n.id, "Cada caminho precisa de um identificador único e peso positivo.")
      if (n.data.config.random_every_time !== undefined && typeof n.data.config.random_every_time !== "boolean") add(n.id, "Escolha quando sortear o caminho.")
    } else if (n.type === "start_automation" || n.type === "goto") {
      const target = n.data.config.automation_id
      if (typeof target !== "string" || !target.trim()) add(n.id, "Escolha a automação que será iniciada.")
      else if (target === catalogs.automationId) add(n.id, "Escolha outra automação para evitar uma chamada a si mesma.")
      else if (catalogs.automations && !catalogs.automations.some(a => a.id === target && a.status === "live" && a.published_version_id && !a.deleted_at)) add(n.id, "A automação de destino precisa estar publicada e ativa.")
      if (n.data.config.wait_for_finish !== undefined && typeof n.data.config.wait_for_finish !== "boolean") add(n.id, "Escolha se o fluxo espera a outra automação terminar.")
    } else if (n.type === "template_message") {
      if (typeof n.data.config.template_id !== "string" || !n.data.config.template_id) add(n.id, "Escolha um modelo aprovado.")
    } else if (n.type === "dynamic") {
      const url = n.data.config.url
      if (typeof url !== "string" || !/^https:\/\/[^\s/]+\.[^\s]+$/i.test(url.trim())) add(n.id, "Informe o endereço https do seu servidor.")
      const fallback = n.data.config.fallback_text
      if (fallback !== undefined && (typeof fallback !== "string" || fallback.length > TEXT_MAX)) add(n.id, `O texto reserva aceita até ${TEXT_MAX} caracteres.`)
    } else if (n.type === "smart_delay") {
      if (!smartDelaySchema.safeParse(n.data.config).success) add(n.id, "Confira a duração ou data, o deslocamento, o fuso e os dias da espera.")
      const source = n.data.config.date as { kind?: string; field_id?: string } | undefined
      if (n.data.config.mode === "date" && source?.kind === "field" && catalogs.fields && !catalogs.fields.some(f => f.id === source.field_id && f.scope === "contact" && ["date", "datetime"].includes(f.type))) add(n.id, "Escolha um campo de data disponível.")
    }
  }
  for (const e of edges) {
    const source = nodes.find(n => n.id === e.source)
    if (!source || !nodes.some(n => n.id === e.target)) { if (source) add(source.id, "A ligação aponta para um passo que não existe."); continue }
    if (!outputPorts(source).some(p => p.port === (e.sourceHandle ?? PORT_NEXT))) add(source.id, "Remova a ligação de uma saída que não existe mais.")
    if (edges.filter(x => x.source === e.source && x.sourceHandle === e.sourceHandle).length > 1) add(source.id, "Cada saída deve levar a apenas um passo.")
  }
  return out
}

/** A ficha já inclui ajustes do provedor e da conexão. */
export function questionConnections(triggers: Trigger[], connections: Connection[]): Connection[] {
  const all = triggers.some(t => !t.channel_id)
  return connections.filter(c => c.status === "connected" && (all || triggers.some(t => t.channel_id === c.id)))
}
