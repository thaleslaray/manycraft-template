import type { Connection } from "@/data/connections"
import { availableStepChannels, inferredStepChannel, stepChannelLabels, type StepChannel } from "./step-channel"
import type { EditableNodeType } from "./graph"

/** Ícone do item: o do canal (mensagem) ou o do tipo de passo; a tela pinta o círculo com a cor de cada um. */
export type StepIconKey = StepChannel | "message" | "action" | "condition" | "randomizer" | "smart_delay" | "start_automation"
/** Item do catálogo de próximo passo (caixinha do conector solto e cartão do primeiro passo). */
export type DropItem = { key: string; label: string; type: EditableNodeType; channel?: StepChannel; icon: StepIconKey }
/** Grupo do catálogo, como no original: Conteúdo, IA e Lógica. IA não existe na réplica (sem Etapa de IA), então nunca aparece. */
export type DropGroup = { key: "content" | "logic"; label: string; items: DropItem[] }

type CatalogInput = { origin?: Record<string, unknown>; triggers: { channel_id: string | null; channel_type?: string | null }[]; connections: Connection[] | undefined; hostChannel?: StepChannel }

/**
 * Catálogo único de próximo passo, agrupado como no original ("Conteúdo": um item por canal; "Lógica": Ações, Condição,
 * Randomizador, Atraso Inteligente e, no conector, Iniciar a automação). Os nomes são os do menu do "+" do editor
 * ("Dividir caminhos" = Randomizador, "Esperar" = Atraso Inteligente). SMS e Etapa de IA não existem aqui.
 * Conteúdo: com canal conhecido (o do passo de origem, o único dos gatilhos ou o único ligado), só ele e o E-mail, como no
 * original; sem canal conhecido, todos os canais ligados; sem nenhum canal ligado, "Mensagem" (o editor pergunta o canal).
 * No hospedeiro (transmissão) o canal é o dele.
 * `place`: "connector" é a caixinha do conector solto; "first-step" é o cartão do fluxo vazio, que segue o original e não
 * oferece "Iniciar automação" (redirecionar logo depois do gatilho equivale a usar o gatilho da outra automação).
 */
export function stepCatalog(o: CatalogInput, place: "connector" | "first-step" = "connector"): DropGroup[] {
  const available = availableStepChannels(o.connections)
  const known = o.hostChannel ?? inferredStepChannel(o.origin, o.triggers, o.connections)
  const channels: StepChannel[] = o.hostChannel ? [o.hostChannel]
    : known ? [known, ...(known !== "email" && available.includes("email") ? ["email" as const] : [])]
    : available
  const content: DropItem[] = channels.length
    ? channels.map(channel => ({ key: `message:${channel}`, label: stepChannelLabels[channel], type: "message", channel, icon: channel }))
    : [{ key: "message", label: "Mensagem", type: "message", icon: "message" }]
  const logic: DropItem[] = [
    { key: "action", label: "Ações", type: "action", icon: "action" },
    { key: "condition", label: "Condição", type: "condition", icon: "condition" },
    { key: "randomizer", label: "Dividir caminhos", type: "randomizer", icon: "randomizer" },
    { key: "smart_delay", label: "Esperar", type: "smart_delay", icon: "smart_delay" },
    ...(place === "connector" ? [{ key: "start_automation", label: "Iniciar automação", type: "start_automation", icon: "start_automation" } as const] : []),
  ]
  return [{ key: "content", label: "Conteúdo", items: content }, { key: "logic", label: "Lógica", items: logic }]
}

/** Os itens do catálogo, na ordem em que aparecem. */
export const catalogItems = (groups: DropGroup[]): DropItem[] => groups.flatMap(g => g.items)

/**
 * O fluxo mostra o cartão "Escolha o primeiro passo"? Só quando não há nenhum passo além do gatilho (notas, grupos e
 * portais não contam). O cartão não é um passo: não entra no grafo salvo, na validação nem no histórico.
 */
export function needsFirstStep(nodes: { type?: string }[]): boolean {
  return !nodes.some(n => n.type !== "trigger" && n.type !== "sticky" && n.type !== "frame" && n.type !== "portal")
}

/** Distância entre o início do mapa (gatilho ou início do envio) e o cartão do primeiro passo: à direita no mapa largo, abaixo (`below`) no estreito. */
export const FIRST_STEP_GAP = { automation: 380, broadcast: 300, below: 56 } as const

/**
 * A soltura abre a caixinha? Só quando o conector saiu de uma saída (source), não terminou numa entrada válida
 * e foi solto no vazio do mapa (não em cima de um passo).
 */
export function opensDropMenu(state: { isValid: boolean | null; fromHandle: { type: string } | null; toHandle?: unknown }, overNode: boolean): boolean {
  return !!state.fromHandle && state.fromHandle.type === "source" && state.isValid !== true && !state.toHandle && !overNode
}

/** Posição do passo novo: a entrada dele (à esquerda, a 1,5rem do topo) cai onde o conector foi solto. */
export function dropStepPosition(at: { x: number; y: number }): { x: number; y: number } {
  return { x: at.x, y: at.y - 24 }
}
