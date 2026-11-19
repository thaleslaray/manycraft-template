import { Handle, Position, type NodeProps } from "@xyflow/react"
import { StickyNote } from "lucide-react"
import { cn } from "@/lib/utils"
import type { FlowNode } from "./graph"

const handleCls = "size-3! rounded-pill! border-2! border-border-input! bg-surface!"

/** Anotação do fluxo. Nos fluxos importados também marca o que não veio ("Não importado: …") e segue adiante pela saída “next”. */
export function NoteNode({ data, selected }: NodeProps<FlowNode>) {
  const text = String(data.config.text ?? "")
  const skipped = typeof data.config.imported_unsupported === "string"
  return (
    <div className={cn("w-(--node-w) rounded-lg border border-dashed bg-surface-muted p-4 shadow-node", skipped ? "border-warning" : "border-border", selected && "ring-2 ring-accent")}>
      <Handle type="target" position={Position.Left} className={handleCls} aria-label="Entrada da nota" style={{ top: "1.5rem" }} />
      <p className="mb-1 flex items-center gap-2 text-xs font-semibold text-text-muted"><StickyNote className="size-4" aria-hidden="true" />{skipped ? "Passo não importado" : "Nota"}</p>
      <p className="whitespace-pre-wrap break-words text-sm">{text || "Nota sem texto"}</p>
      <Handle type="source" position={Position.Right} id="next" className={handleCls} aria-label="Segue para" style={{ top: "1.5rem" }} />
    </div>
  )
}
