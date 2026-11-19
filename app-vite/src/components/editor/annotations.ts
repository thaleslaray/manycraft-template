import { annotationColors, annotationLimits } from "../../../../engine/src/schemas/graph"
import type { Annotation } from "@/data/types"
import type { FlowNode } from "./graph"

/** Notas adesivas e grupos do mapa: só organizam o desenho, nunca viram passo do fluxo. */
export type AnnotationKind = Annotation["kind"]
export type AnnotationColor = (typeof annotationColors)[number]
export const colors = annotationColors
export const colorLabels: Record<AnnotationColor, string> = { yellow: "Amarelo", green: "Verde", pink: "Rosa", blue: "Azul", purple: "Roxo" }
export const annotationLabels: Record<AnnotationKind, string> = { note: "Nota", group: "Grupo", portal: "Portal" }

const nodeType = { note: "sticky", group: "frame", portal: "portal" } as const
export const isAnnotation = (node: { type?: string }): boolean => node.type === "sticky" || node.type === "frame" || node.type === "portal"
/** "2 passos e 1 nota removidos": notas e grupos não entram na conta dos passos. */
export function removedSummary(removed: { type?: string }[]): string {
  const notes = removed.filter(isAnnotation).length, steps = removed.length - notes
  return `${steps} ${steps === 1 ? "passo" : "passos"}${notes ? ` e ${notes} ${notes === 1 ? "nota" : "notas"}` : ""} removidos`
}
const kindOf = (node: { type?: string }): AnnotationKind => (node.type === "frame" ? "group" : node.type === "portal" ? "portal" : "note")

const defaults = {
  note: { size: { w: 220, h: 140 }, color: "yellow" as AnnotationColor },
  group: { size: { w: 480, h: 300 }, color: "blue" as AnnotationColor },
  portal: { size: { w: 200, h: 64 }, color: "purple" as AnnotationColor },
}
export const textLimit = 2000
export const titleLimit = 120
export { annotationLimits }

const clamp = (value: number, min: number, max: number, fallback: number) => (Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback)
/** Tamanho que o motor aceita; valor inválido volta ao tamanho padrão do tipo. */
export function clampSize(kind: AnnotationKind, size: { w: number; h: number }): { w: number; h: number } {
  const base = defaults[kind].size
  return {
    w: clamp(size.w, annotationLimits.minW, annotationLimits.maxW, base.w),
    h: clamp(size.h, annotationLimits.minH, annotationLimits.maxH, base.h),
  }
}

const colorOf = (value: unknown): AnnotationColor => (colors as readonly string[]).includes(String(value)) ? (value as AnnotationColor) : "yellow"

export function annotationToNode(a: Annotation): FlowNode {
  return {
    id: a.id,
    type: nodeType[a.kind],
    position: a.position,
    width: a.size.w,
    height: a.size.h,
    data: { config: { color: a.color, ...(a.kind === "note" ? { text: a.text ?? "", ...(a.font_size ? { font_size: a.font_size } : {}), ...(a.font ? { font: a.font } : {}), ...(a.author ? { author: a.author } : {}) } : a.kind === "portal" ? { title: a.title ?? "", target: a.target ?? "" } : { title: a.title ?? "" }) } },
    deletable: true,
    ...(a.kind === "group" ? { dragHandle: ".frame-drag" } : {}),
    ariaLabel: annotationAriaLabel(a.kind, a.kind === "note" ? a.text : a.title),
  }
}

/** Nome do item para leitor de tela; precisa acompanhar o texto quando ele muda. */
export function annotationAriaLabel(kind: AnnotationKind, content?: string): string {
  const text = content?.trim()
  return `${annotationLabels[kind]}${text ? `: ${text.slice(0, 80)}` : " sem texto"}. Enter abre as opções, Delete remove.`
}

export function nodeToAnnotation(n: FlowNode): Annotation {
  const kind = kindOf(n)
  const base = defaults[kind].size
  const size = clampSize(kind, { w: n.width ?? n.measured?.width ?? base.w, h: n.height ?? n.measured?.height ?? base.h })
  const config = n.data.config
  return {
    id: n.id,
    kind,
    position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
    size,
    color: colorOf(config.color),
    ...(kind === "note" ? { text: String(config.text ?? "").slice(0, textLimit),
      ...(["sm", "md", "lg"].includes(String(config.font_size)) ? { font_size: config.font_size as "sm" | "md" | "lg" } : {}),
      ...(["serif", "mono"].includes(String(config.font)) ? { font: config.font as "serif" | "mono" } : {}),
      ...(typeof config.author === "string" && config.author ? { author: config.author.slice(0, 120) } : {}) } : { title: String(config.title ?? "").slice(0, titleLimit),
      ...(kind === "portal" && typeof config.target === "string" && config.target ? { target: config.target } : {}) }),
  }
}

/** Cria o nó em volta de `at`, deslocando para não ficar exatamente sobre outro do mesmo tipo. */
export function createAnnotation(kind: AnnotationKind, nodes: FlowNode[], at: { x: number; y: number }, author?: string): FlowNode {
  const prefix = kind === "note" ? "nota-" : kind === "portal" ? "portal-" : "grupo-"
  let n = 1
  while (nodes.some(x => x.id === `${prefix}${n}`)) n++
  let position = { x: Math.round(at.x), y: Math.round(at.y) }
  while (nodes.some(x => x.type === nodeType[kind] && Math.abs(x.position.x - position.x) < 24 && Math.abs(x.position.y - position.y) < 24)) position = { x: position.x + 32, y: position.y + 32 }
  return annotationToNode({ id: `${prefix}${n}`, kind, position, size: defaults[kind].size, color: defaults[kind].color, ...(kind === "note" ? { text: "", ...(author ? { author: author.slice(0, 120) } : {}) } : kind === "portal" ? { title: "" } : { title: "Novo grupo" }) })
}

export type GroupDrag = { id: string; origin: { x: number; y: number }; members: Map<string, { x: number; y: number }> }
const sizeOf = (n: FlowNode) => ({ w: n.measured?.width ?? n.width ?? 280, h: n.measured?.height ?? n.height ?? 120 })

/** Quem está dentro do grupo quando ele começa a ser arrastado: passos e notas cujo centro cai no quadro. */
export function startGroupDrag(frame: FlowNode, nodes: FlowNode[]): GroupDrag {
  const box = sizeOf(frame)
  const members = new Map<string, { x: number; y: number }>()
  for (const n of nodes) {
    if (n.id === frame.id || n.type === "frame") continue
    const size = sizeOf(n)
    const cx = n.position.x + size.w / 2
    const cy = n.position.y + size.h / 2
    if (cx >= frame.position.x && cx <= frame.position.x + box.w && cy >= frame.position.y && cy <= frame.position.y + box.h) members.set(n.id, { ...n.position })
  }
  return { id: frame.id, origin: { ...frame.position }, members }
}

export function dragGroup(nodes: FlowNode[], drag: GroupDrag, position: { x: number; y: number }): FlowNode[] {
  const dx = position.x - drag.origin.x
  const dy = position.y - drag.origin.y
  return nodes.map(n => {
    if (n.id === drag.id) return { ...n, position }
    const start = drag.members.get(n.id)
    return start ? { ...n, position: { x: start.x + dx, y: start.y + dy } } : n
  })
}
