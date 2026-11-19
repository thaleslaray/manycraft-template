import { nodeTitle, type FlowNode } from "./graph"

export type Pending = { id: string; title: string; issue: string; more: number }

/** Passos com erro, na ordem do mapa, para a lista de pendências ao publicar. */
export function pendingSteps(nodes: Pick<FlowNode, "id" | "type">[], errors: Record<string, string[]>): Pending[] {
  return nodes.flatMap(n => {
    const list = errors[n.id]
    if (!list?.length) return []
    return [{ id: n.id, title: nodeTitle[n.type ?? ""] ?? "Passo", issue: list[0], more: list.length - 1 }]
  })
}

export type ButtonIndicator = { kind: "url" | "go_to_node" | "start_automation" | "tag" | "field"; label: string }
type ButtonLike = { action: { type: string }; actions?: { type: string }[] }

/** O que o botão faz, para os ícones no nó. O endereço nunca entra: fica na configuração do toque. */
export function buttonIndicators(block: ButtonLike, linked: boolean): ButtonIndicator[] {
  const out: ButtonIndicator[] = []
  if (block.action.type === "url") {
    out.push({ kind: "url", label: "Abre um link" })
    if (linked) out.push({ kind: "go_to_node", label: "Segue para um passo" })
  } else if (block.action.type === "start_automation") out.push({ kind: "start_automation", label: "Inicia outra automação" })
  else out.push({ kind: "go_to_node", label: "Segue para um passo" })
  for (const a of block.actions ?? []) {
    out.push(a.type.includes("tag") ? { kind: "tag", label: a.type === "add_tag" ? "Adiciona tag" : "Remove tag" } : { kind: "field", label: a.type === "set_custom_field_value" ? "Define campo" : "Limpa campo" })
  }
  return out
}
