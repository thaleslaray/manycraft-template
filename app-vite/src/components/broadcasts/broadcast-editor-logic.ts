import type { BroadcastMetrics } from "@/data/broadcasts"
import type { AutomationStats, Graph, GraphNode } from "@/data/types"

const number = (value: number) => value.toLocaleString("pt-BR")

/** Contador em destaque do público: número grande e a frase ao lado. */
export function recipientsLabel(count: number | undefined, loading: boolean): { value: string; text: string } {
  if (loading || count === undefined) return { value: "…", text: "Calculando público" }
  return { value: number(count), text: count === 1 ? "contato receberá esta transmissão" : "contatos receberão esta transmissão" }
}

/** Passo único de um envio de texto: o mesmo id que o motor usa ao guardar a transmissão como fluxo. */
export const BROADCAST_STEP = "broadcast-message"

/** Fluxo de uma transmissão nova: um passo de mensagem no canal escolhido. O início é o envio, então não há gatilho. */
export function newBroadcastFlow(channel: string, text = ""): Graph {
  return { nodes: [{ id: BROADCAST_STEP, type: "message", position: { x: 0, y: 0 }, config: { blocks: [{ kind: "text", text }], channel } }], edges: [] }
}

/** Cópia de automação: o gatilho da origem não faz parte do envio, então sai do mapa junto com as ligações dele. */
export function withoutTrigger(flow: Graph): Graph {
  const entries = new Set(flow.nodes.filter(node => node.type === "trigger").map(node => node.id))
  return entries.size ? { ...flow, nodes: flow.nodes.filter(node => !entries.has(node.id)), edges: flow.edges.filter(edge => !entries.has(edge.from) && !entries.has(edge.to)) } : flow
}

/** O envio começa no único passo sem ligação de entrada; com zero ou vários, o fluxo ainda não está ligado. */
export function flowStart(flow: Graph): GraphNode | undefined {
  const starts = flow.nodes.filter(node => !flow.edges.some(edge => edge.to === node.id))
  return starts.length === 1 ? starts[0] : undefined
}

/** Texto do passo inicial: é o que o motor guarda como conteúdo da transmissão e o que a lista e o relatório mostram. */
export function flowContent(flow: Graph): string {
  const blocks = (flowStart(flow)?.config.blocks ?? []) as { kind: string; text?: string }[]
  return blocks.find(block => block.kind === "text")?.text ?? ""
}

/** Troca o canal dos passos de mensagem quando a transmissão muda de conexão; o resto do fluxo fica como está. */
export function retargetFlow(flow: Graph, channel: string): Graph {
  return { ...flow, nodes: flow.nodes.map(node => node.type === "message" && !node.config.email ? { ...node, config: { ...node.config, channel } } : node) }
}

/** Fluxo do relatório: passo de mensagem sem canal próprio (transmissão antiga ou do seed) herda o canal da transmissão; o fluxo sem gatilho não tem de onde tirar outro. */
export function reportFlow(flow: Graph, channel: string): Graph {
  return { ...flow, nodes: flow.nodes.map(node => node.type === "message" && !node.config.email && !node.config.channel ? { ...node, config: { ...node.config, channel } } : node) }
}

/**
 * Números por nó para o mapa do relatório. Com várias mensagens o motor entrega cada uma; com uma só, o total é o do passo inicial.
 */
export function reportStats(flow: Graph, metrics: BroadcastMetrics | null | undefined): AutomationStats {
  const nodes: AutomationStats["nodes"] = {}
  if (metrics?.messages?.length) for (const m of metrics.messages) nodes[m.node_id] = { sent: m.sent, delivered: m.delivered, read: m.read, clicked: m.clicked }
  else if (metrics) { const start = flowStart(flow); if (start) nodes[start.id] = { sent: metrics.sent, delivered: metrics.delivered, read: metrics.read, clicked: metrics.clicked } }
  return { automation_id: "broadcast-report", period_days: 0, nodes, runs: metrics?.sent ?? 0, unique_contacts: metrics?.sent ?? 0 }
}
