import type { Connection } from "@/data/connections"
import type { ChannelType, Trigger } from "@/data"
import { mediaConnections } from "./media"

/** Canais que aceitam passo de mensagem. Messenger e TikTok estão congelados e ficam de fora. */
export const stepChannels = ["whatsapp", "instagram", "telegram", "email"] as const
export type StepChannel = typeof stepChannels[number]
export const PENDING_CHANNEL = "pending"
export const stepChannelLabels: Record<StepChannel, string> = { whatsapp: "WhatsApp", instagram: "Instagram", telegram: "Telegram", email: "E-mail" }

const isStepChannel = (value: unknown): value is StepChannel => typeof value === "string" && (stepChannels as readonly string[]).includes(value)

/** Canal escolhido no passo: um canal ativo, "pending" (fluxo antigo com vários canais) ou nada (fluxo antigo). */
export function stepChannelOf(config: Record<string, unknown>): StepChannel | typeof PENDING_CHANNEL | undefined {
  const value = config.channel
  return isStepChannel(value) ? value : value === PENDING_CHANNEL ? PENDING_CHANNEL : undefined
}

/** Canal de um passo novo quando não há o que perguntar: o do passo de onde ele sai; senão o único canal dos gatilhos; senão o único canal ligado. */
export function inferredStepChannel(origin: Record<string, unknown> | undefined, triggers: { channel_id: string | null; channel_type?: string | null }[], connections: Connection[] | undefined): StepChannel | undefined {
  const from = origin && stepChannelOf(origin)
  if (from && from !== PENDING_CHANNEL) return from
  const kinds = new Set(triggers.map(t => t.channel_type ?? (connections ?? []).find(c => c.id === t.channel_id)?.kind).filter(isStepChannel))
  if (kinds.size === 1) return [...kinds][0]
  const available = availableStepChannels(connections)
  return kinds.size === 0 && available.length === 1 ? available[0] : undefined
}

/** Canais que o workspace pode escolher num passo novo: os que têm ao menos uma conexão ligada. */
export function availableStepChannels(connections: Connection[] | undefined): StepChannel[] {
  return stepChannels.filter(channel => (connections ?? []).some(c => c.kind === channel && c.status === "connected"))
}

/**
 * As conexões cuja ficha vale para o passo. Com canal escolhido, são todas as conexões ligadas desse canal
 * (quem monta o fluxo só pode usar o que todas aceitam). Sem canal, vale o gatilho, como nos fluxos antigos.
 */
export function stepConnections(config: Record<string, unknown>, triggers: Trigger[], connections: Connection[]): Connection[] {
  const channel = stepChannelOf(config)
  if (isStepChannel(channel)) return connections.filter(c => c.kind === channel && c.status === "connected")
  return mediaConnections(triggers, connections)
}

type Step = { id: string; type?: string; data: { config: Record<string, unknown> } }

/**
 * Fluxos antigos: o passo de mensagem sem canal recebe o do gatilho quando há um só canal;
 * com vários canais fica "a escolher" e o editor avisa. Nada do conteúdo muda.
 */
export function assignStepChannels<T extends Step>(nodes: T[], triggers: Trigger[]): T[] {
  const channels = [...new Set(triggers.map(t => t.channel_type).filter((c): c is ChannelType => !!c))]
  const mark = channels.length === 1 && isStepChannel(channels[0]) ? channels[0] : channels.length > 1 ? PENDING_CHANNEL : undefined
  if (!mark) return nodes
  return nodes.map(n => n.type === "message" && n.data.config.channel === undefined ? { ...n, data: { ...n.data, config: { ...n.data.config, channel: mark } } } : n)
}

export type StepOffer = {
  /** Quantas conexões compõem a oferta; 0 = nenhuma conexão ligada para este canal. */
  connections: number
  text: { max: number; unit: "chars" | "bytes" } | null
  buttons: { types: string[]; max: number; titleMax: number } | null
  quickReplies: { max: number; titleMax: number } | null
  list: boolean
  cards: boolean
  media: ("image" | "video" | "audio" | "file")[]
  typing: { maxSeconds: number } | null
  /** Recursos que a ficha de ao menos uma conexão declara instáveis (a entrega pode falhar em alguns apps). */
  unstable: UnstableFeature[]
}

export type UnstableFeature = "buttons" | "list" | "cards"

/**
 * O que o painel do passo oferece: só o que a ficha de TODAS as conexões do canal declara (a interseção).
 * Sem conexão, nada é oferecido; o painel avisa.
 */
export function stepOffer(connections: Connection[]): StepOffer {
  type Profile = NonNullable<Connection["profile"]>
  const all = <T,>(pick: (p: Profile) => T | null | undefined): T[] | null => {
    const found = connections.map(c => (c.profile ? pick(c.profile) : null))
    return found.length && found.every(v => v != null) ? (found as T[]) : null
  }
  const text = all(p => p.text)
  const buttons = all(p => p.buttons && p.buttons.maxPerMessage > 0 ? p.buttons : null)
  const quick = all(p => p.quickReplies)
  const typing = all(p => p.typing)
  return {
    connections: connections.length,
    text: text ? { max: Math.min(...text.map(t => t.maxLength)), unit: text.some(t => t.unit === "bytes") ? "bytes" : "chars" } : null,
    buttons: buttons ? { types: buttons[0].types.filter(t => buttons.every(b => b.types.includes(t))), max: Math.min(...buttons.map(b => b.maxPerMessage)), titleMax: Math.min(...buttons.map(b => b.titleMax)) } : null,
    quickReplies: quick ? { max: Math.min(...quick.map(q => q.max)), titleMax: Math.min(...quick.map(q => q.titleMax)) } : null,
    list: !!all(p => p.list),
    cards: !!all(p => p.cards),
    // Limite zero (sem tipos aceitos) é como o provedor diz "não envia mídia" (unavailableMedia, Uazapi e Z-API): o bloco não é oferecido.
    media: (["image", "video", "audio", "file"] as const).filter(kind => !!all(p => { const m = p.media?.[kind]; return m && m.maxBytes > 0 && m.mime.length ? m : null })),
    typing: typing ? { maxSeconds: Math.min(...typing.map(t => t.maxSeconds)) } : null,
    unstable: (["buttons", "list", "cards"] as const).filter(feature => connections.some(c => c.profile?.unstable?.includes(feature))),
  }
}

/** Recurso da ficha que um bloco usa (só os que a ficha pode marcar como instáveis). */
export function blockFeature(block: { kind: string }): UnstableFeature | null {
  return block.kind === "button" ? "buttons" : block.kind === "list" ? "list" : block.kind === "card" || block.kind === "gallery" ? "cards" : null
}

/** Aviso do bloco quando o recurso que ele usa é instável em alguma conexão do canal; null se não houver. */
export function unstableNotice(block: { kind: string }, offer: Pick<StepOffer, "unstable">): string | null {
  const feature = blockFeature(block)
  if (!feature || !offer.unstable.includes(feature)) return null
  const what = feature === "buttons" ? "Os botões" : feature === "list" ? "A lista de opções" : "Os cards"
  return `${what} podem não aparecer em alguns aplicativos (por exemplo, no WhatsApp Web) com esta conexão. Escreva o texto de modo que a mensagem faça sentido mesmo sem eles.`
}

/** Tamanho do texto na unidade da ficha (bytes em UTF-8 ou caracteres). */
export const textSize = (text: string, unit: "chars" | "bytes") => unit === "bytes" ? new TextEncoder().encode(text).length : [...text].length
