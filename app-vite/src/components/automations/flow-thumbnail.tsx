import type { FlowPreview } from "@/data/types"
import { layoutThumbnail, type ThumbTone } from "./flow-thumbnail-layout"

const W = 240
const H = 136
const bandClass: Record<ThumbTone, string> = {
  trigger: "fill-node-trigger", message: "fill-node-ai", action: "fill-node-action", delay: "fill-node-delay", condition: "fill-node-condition",
}

/** Mapa reduzido do fluxo, só leitura: os passos reais como cartões pequenos, com as ligações curvas entre eles. */
export function FlowThumbnail({ preview }: { preview: FlowPreview }) {
  const { cards, edges } = layoutThumbnail(preview, W, H)
  return <svg role="img" aria-label={`Miniatura do fluxo: ${preview.nodes.length} passos`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" className="h-full w-full">
    {edges.map((d, i) => <path key={i} d={d} fill="none" className="stroke-text-muted" strokeWidth={0.9} />)}
    {cards.map(card => <g key={card.id}>
      <rect x={card.x} y={card.y} width={card.w} height={card.h} rx={1.8} className="fill-surface stroke-border-input" strokeWidth={0.6} />
      <path d={`M${card.x} ${card.y + card.band} V${card.y + 1.8} Q${card.x} ${card.y} ${card.x + 1.8} ${card.y} H${card.x + card.w - 1.8} Q${card.x + card.w} ${card.y} ${card.x + card.w} ${card.y + 1.8} V${card.y + card.band} Z`} className={bandClass[card.tone]} />
      {card.lines.map((line, i) => <rect key={i} x={line.x} y={line.y} width={line.w} height={line.h} rx={0.8} className="fill-border-input" />)}
    </g>)}
  </svg>
}
