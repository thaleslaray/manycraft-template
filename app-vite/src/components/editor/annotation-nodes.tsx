import { NodeResizer, useReactFlow, type NodeProps, type NodeTypes } from "@xyflow/react"
import { CornerDownRight, Square, StickyNote } from "lucide-react"
import { cn } from "@/lib/utils"
import { useEditor } from "./editor-context"
import { annotationLimits, type AnnotationColor } from "./annotations"
import type { FlowNode } from "./graph"

/** Cada cor usa um tom que já existe nos tokens dos passos. */
export const toneClass: Record<AnnotationColor, string> = {
  yellow: "bg-node-action",
  green: "bg-node-trigger",
  pink: "bg-node-delay",
  blue: "bg-node-condition",
  purple: "bg-node-ai",
}
const toneOf = (value: unknown): string => toneClass[value as AnnotationColor] ?? toneClass.yellow

function Resizer({ selected, minWidth, minHeight }: { selected?: boolean; minWidth: number; minHeight: number }) {
  const { readOnly } = useEditor()
  return (
    <NodeResizer
      isVisible={Boolean(selected) && !readOnly}
      minWidth={minWidth}
      minHeight={minHeight}
      maxWidth={annotationLimits.maxW}
      maxHeight={annotationLimits.maxH}
      lineClassName="border-accent!"
      handleClassName="size-3! rounded-sm! border-2! border-accent! bg-surface!"
    />
  )
}

/** Nota adesiva: texto livre, sem portas de ligação. */
export function StickyNode({ data, selected }: NodeProps<FlowNode>) {
  const text = String(data.config.text ?? "")
  return (
    <>
      <Resizer selected={selected} minWidth={annotationLimits.minW} minHeight={annotationLimits.minH} />
      <div className={cn("flex h-full w-full flex-col gap-1 overflow-hidden rounded-md border border-border p-3 shadow-node", toneOf(data.config.color), selected && "ring-2 ring-accent")}>
        <p className="flex items-center gap-1 text-xs font-semibold text-text-muted">
          <StickyNote className="size-4 shrink-0" aria-hidden="true" />
          Nota{data.config.author ? <span className="truncate font-normal"> · {String(data.config.author)}</span> : null}
        </p>
        {text ? <p className={cn("min-h-0 flex-1 overflow-hidden whitespace-pre-wrap break-words", data.config.font === "serif" ? "font-serif" : data.config.font === "mono" ? "font-mono" : "", data.config.font_size === "lg" ? "text-lg" : data.config.font_size === "sm" ? "text-xs" : "text-sm")} title={text.length > 200 ? text : undefined}>{text}</p> : <p className="text-sm text-text-muted">Nota sem texto</p>}
      </div>
    </>
  )
}

/** Quadro que agrupa passos: o título é a alça de arrastar; o corpo deixa ver as ligações. */
export function FrameNode({ data, selected }: NodeProps<FlowNode>) {
  const title = String(data.config.title ?? "")
  return (
    <>
      <Resizer selected={selected} minWidth={annotationLimits.minW} minHeight={annotationLimits.minH} />
      <div className={cn("flex h-full w-full flex-col overflow-hidden rounded-lg border-2 border-dashed border-border-input bg-surface-muted/40", selected && "border-accent")}>
        <p className={cn("frame-drag flex cursor-grab items-center gap-2 px-3 py-2 text-sm font-semibold active:cursor-grabbing", toneOf(data.config.color))}>
          <Square className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate" title={title}>{title || "Grupo sem título"}</span>
        </p>
      </div>
    </>
  )
}

/** Portal: atalho para um passo distante; clicar no botão leva o mapa até ele. */
export function PortalNode({ data, selected }: NodeProps<FlowNode>) {
  const { getNode, setCenter } = useReactFlow()
  const target = String(data.config.target ?? "")
  const label = String(data.config.title ?? "") || (target ? `Ir para ${target}` : "Portal sem destino")
  return (
    <div className={cn("flex h-full w-full items-center gap-2 rounded-full border border-border px-3 shadow-node", toneOf(data.config.color), selected && "ring-2 ring-accent")}>
      <CornerDownRight className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{label}</span>
      {target ? <button type="button" className="nodrag rounded px-2 py-1 text-xs underline" onClick={(e) => { e.stopPropagation(); const n = getNode(target); if (n) void setCenter(n.position.x + 140, n.position.y + 60, { zoom: 1, duration: 300 }) }}>Ir</button> : null}
    </div>
  )
}

export const annotationNodeTypes: NodeTypes = { sticky: StickyNode, frame: FrameNode, portal: PortalNode }
