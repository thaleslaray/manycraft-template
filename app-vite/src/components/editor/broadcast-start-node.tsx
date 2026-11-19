import { Handle, Position } from "@xyflow/react"
import { Send, Zap } from "lucide-react"

/** Início fixo do mapa da transmissão: o envio. Não é um gatilho escolhível, então não abre painel nem tem menu. */
export function BroadcastStartNode() {
  return (
    <div className="w-56 rounded-lg border border-border bg-surface p-3 shadow-node">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-text"><Zap className="size-3.5 text-accent" aria-hidden="true" />Quando…</p>
      <p className="mt-2 flex items-center gap-1.5 rounded-md bg-success-soft px-2 py-1.5 text-xs text-success"><Send className="size-3.5 shrink-0" aria-hidden="true" />Você envia uma transmissão</p>
      <p className="mt-2 text-right text-xs text-text-muted">Entra em</p>
      <Handle type="source" position={Position.Right} id="next" isConnectable={false} aria-label="Saída do início do envio" className="size-3! rounded-pill! border-2! border-border-input! bg-surface!" style={{ top: "auto", bottom: "0.75rem" }} />
    </div>
  )
}

export const BROADCAST_START_ID = "broadcast-start"
