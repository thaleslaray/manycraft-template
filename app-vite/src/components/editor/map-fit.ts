/** Enquadramento do mapa ao abrir: dada a caixa do mapa e os nós medidos, o zoom e a posição (lógica pura, sem React). */
import type { Node, Rect } from "@xyflow/react"

// Enquadramento do mapa: nós menores que o zoom máximo do original, folga à direita para os controles de zoom (coluna de ~52px)
// e em cima para o "+" flutuante e a dica.
export const FIT_RIGHT_GUTTER = 96
// Mapa da automação: os nós abrem do tamanho do original (fluxo curto chega a 1,5, como o print do original) e o fluxo fica
// centrado, com ~11% de folga dos lados; fluxo maior que a tela encolhe até caber (piso 0,3, o zoom mínimo do mapa).
// Fluxo longo não encolhe abaixo de `read` ao abrir (texto do passo legível): abre no começo do fluxo e o resto se alcança arrastando.
export const MAP_ZOOM = { min: 0.3, read: 0.65, max: 1.5, side: 0.115, vertical: 0.12 } as const
// Mapa da transmissão em tela estreita: zoom mínimo de leitura (o passo fica com pelo menos 3/4 do tamanho natural).
export const NARROW_MAP = { width: 640, minZoom: 0.75 } as const
export const FIT_OPTIONS = { padding: { top: "12%", right: "12%", bottom: "12%", left: "12%" }, maxZoom: MAP_ZOOM.max, duration: 200 } as const

export type Viewport = { zoom: number; x: number; y: number }

/** Automação (sem hospedeiro): centrado, entre `read` e `max`. Hospedeiro (transmissão): alinhado ao topo e à esquerda, sem passar de 1. */
export function mapViewport(box: { width: number; height: number }, all: Node[], bounds: Rect, host?: { readOnly?: boolean }): Viewport {
  if (!host) {
    const side = box.width * MAP_ZOOM.side, room = { w: box.width - 2 * side, h: box.height * (1 - 2 * MAP_ZOOM.vertical) }
    const wanted = Math.min(room.w / bounds.width, room.h / bounds.height)
    const zoom = Math.max(MAP_ZOOM.read, Math.min(MAP_ZOOM.max, wanted))
    const x = wanted < MAP_ZOOM.read ? side - bounds.x * zoom : (box.width - bounds.width * zoom) / 2 - bounds.x * zoom
    const tall = bounds.height * zoom > room.h
    const y = tall ? box.height * MAP_ZOOM.vertical - bounds.y * zoom : (box.height - bounds.height * zoom) / 2 - bounds.y * zoom
    return { zoom, x, y }
  }
  const margin = { x: 48, top: 112, bottom: 32 }
  const fitted = Math.min(1, (box.width - margin.x - FIT_RIGHT_GUTTER) / bounds.width, (box.height - margin.top - margin.bottom) / bounds.height)
  // Tela estreita (celular), no relatório e no editor da transmissão: em vez de encolher até o texto ficar ilegível, abre num
  // zoom de leitura alinhado ao começo do fluxo (o início do envio); o resto se alcança arrastando.
  if (box.width < NARROW_MAP.width) {
    const narrow = Math.max(fitted, NARROW_MAP.minZoom)
    let x = 16 - bounds.x * narrow
    // O início do envio fica 300 px à esquerda do primeiro passo: se o passo não couber inteiro, o mapa desliza o mínimo para mostrá-lo
    // (o início fica cortado à esquerda, mas a ligação até o passo continua visível).
    const first = all.filter(n => n.type !== "broadcast_start" && n.type !== "first_step").sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y)[0]
    const firstRight = first ? (first.position.x + (first.measured?.width ?? 0)) * narrow + x : 0
    if (first && firstRight > box.width - 16) x -= Math.min(firstRight - (box.width - 16), first.position.x * narrow + x - 16)
    return { zoom: narrow, x, y: 96 - bounds.y * narrow }
  }
  const zoom = fitted
  // Relatório (só leitura): o mapa fica centrado na horizontal, com o topo a 14% da altura (terço de cima), como no original; o editor da transmissão segue alinhado ao topo e à esquerda.
  if (host.readOnly) {
    const top = Math.max(margin.top, box.height * 0.14)
    return { zoom, x: (box.width - bounds.width * zoom) / 2 - bounds.x * zoom, y: top - bounds.y * zoom }
  }
  return { zoom, x: margin.x - bounds.x * zoom, y: margin.top - bounds.y * zoom }
}
