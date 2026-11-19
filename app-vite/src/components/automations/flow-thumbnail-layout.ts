import type { FlowPreview } from "@/data/types"

export type ThumbTone = "trigger" | "message" | "action" | "delay" | "condition"
export type ThumbCard = { id: string; x: number; y: number; w: number; h: number; band: number; tone: ThumbTone; lines: { x: number; y: number; w: number; h: number }[] }

// Tamanho aproximado de cada tipo de passo no editor (unidades do mapa) e quantas linhas de texto cinza ele desenha.
const shapes: Record<string, { w: number; h: number; tone: ThumbTone; lines: number[] }> = {
  trigger: { w: 260, h: 120, tone: "trigger", lines: [0.8, 0.55] },
  message: { w: 280, h: 190, tone: "message", lines: [0.9, 0.75, 0.85, 0.5] },
  question: { w: 280, h: 150, tone: "message", lines: [0.85, 0.6, 0.7] },
  action: { w: 280, h: 120, tone: "action", lines: [0.7, 0.5] },
  condition: { w: 280, h: 130, tone: "condition", lines: [0.75, 0.6] },
  randomizer: { w: 220, h: 100, tone: "condition", lines: [0.6, 0.4] },
  smart_delay: { w: 220, h: 70, tone: "delay", lines: [0.6] },
  dynamic: { w: 280, h: 130, tone: "action", lines: [0.75, 0.55] },
  template_message: { w: 280, h: 170, tone: "message", lines: [0.9, 0.7, 0.6] },
  start_automation: { w: 240, h: 90, tone: "action", lines: [0.7] },
}
const fallback = shapes.action
const BAND = 34, LINE_H = 10, LINE_GAP = 12, PAD_X = 16

/**
 * Desenha o fluxo real em pequeno: cada passo vira um cartão com faixa de cabeçalho e linhas de texto cinza,
 * nas posições do editor, e cada ligação vira uma curva da direita de um cartão à esquerda do outro.
 * Tudo cabe em `width` x `height` e fica centralizado.
 */
export function layoutThumbnail(preview: FlowPreview, width: number, height: number, margin = 8): { cards: ThumbCard[]; edges: string[] } {
  const boxes = preview.nodes.map(node => ({ node, shape: shapes[node.type] ?? fallback }))
  if (!boxes.length) return { cards: [], edges: [] }
  const minX = Math.min(...boxes.map(b => b.node.x)), minY = Math.min(...boxes.map(b => b.node.y))
  const spanX = Math.max(...boxes.map(b => b.node.x + b.shape.w)) - minX, spanY = Math.max(...boxes.map(b => b.node.y + b.shape.h)) - minY
  const scale = Math.min((width - margin * 2) / spanX, (height - margin * 2) / spanY, 0.3)
  const offX = (width - spanX * scale) / 2, offY = (height - spanY * scale) / 2
  const cards = boxes.map<ThumbCard>(({ node, shape }) => {
    const x = offX + (node.x - minX) * scale, y = offY + (node.y - minY) * scale, w = shape.w * scale, h = shape.h * scale, band = BAND * scale
    const lines = shape.lines.map((fraction, i) => ({ x: x + PAD_X * scale, y: y + band + (14 + i * (LINE_H + LINE_GAP)) * scale, w: (w - PAD_X * 2 * scale) * fraction, h: LINE_H * scale }))
      .filter(line => line.y + line.h < y + h - 4 * scale)
    return { id: node.id, x, y, w, h, band, tone: shape.tone, lines: lines.length ? lines : [{ x: x + PAD_X * scale, y: y + band + 6 * scale, w: (w - PAD_X * 2 * scale) * 0.6, h: LINE_H * scale }] }
  })
  const byId = new Map(cards.map(card => [card.id, card]))
  const edges = preview.edges.flatMap(edge => {
    const from = byId.get(edge.from), to = byId.get(edge.to)
    if (!from || !to) return []
    // Como no original: sai da linha de baixo do cartão de origem e entra pelo cabeçalho do destino.
    const x1 = from.x + from.w, y1 = from.y + from.band + (from.h - from.band) * 0.7, x2 = to.x, y2 = to.y + to.band / 2
    const dx = Math.max(Math.abs(x2 - x1) / 2, 4)
    return [`M${x1.toFixed(1)} ${y1.toFixed(1)} C${(x1 + dx).toFixed(1)} ${y1.toFixed(1)} ${(x2 - dx).toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`]
  })
  return { cards, edges }
}
