import { X } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { getBlocks, nodeTitle, type FlowEdge, type FlowNode } from "./graph"

const NONE = "__nenhum"

/** Nome curto de um passo: "Mensagem 2 · “Oi! Toca no…”". */
export function stepLabel(node: FlowNode, nodes: FlowNode[]): string {
  const same = nodes.filter((n) => n.type === node.type)
  const base = `${nodeTitle[node.type ?? ""] ?? node.type} ${same.indexOf(node) + 1}`
  if (node.type === "message") {
    const t = getBlocks(node.data.config).find((b) => b.kind === "text")
    if (t && t.kind === "text" && t.text.trim()) return `${base} · “${t.text.trim().slice(0, 22)}${t.text.trim().length > 22 ? "…" : ""}”`
  }
  return base
}

/**
 * Alternativa por teclado e leitor de tela para arrastar a ligação:
 * escolhe para onde cada porta vai.
 */
export function PortLinks({
  fromId,
  ports,
  nodes,
  edges,
  readOnly,
  onChange,
}: {
  fromId: string
  ports: { port: string; label: string }[]
  nodes: FlowNode[]
  edges: FlowEdge[]
  readOnly: boolean
  onChange: (port: string, to: string | null) => void
}) {
  const targets = nodes.filter((n) => n.type !== "trigger" && n.id !== fromId)
  return (
    <section aria-label="Ligações" className="space-y-3 border-t border-border pt-4">
      <h3 className={ports.length === 1 ? "sr-only" : "text-xs font-semibold text-text-muted"}>{ports.length === 1 ? "Próximo passo" : "Ligações"}</h3>
      {ports.map((p) => {
        const current = edges.find((e) => e.source === fromId && e.sourceHandle === p.port)?.target ?? NONE
        const id = `link-${fromId}-${p.port}`
        const target = current === NONE ? undefined : nodes.find(n => n.id === current)
        if (target) return (
          <div key={p.port} className="space-y-1">
            <p id={`${id}-rotulo`} className={ports.length === 1 ? "sr-only" : "text-sm font-medium"}>{p.label}</p>
            <div role="group" aria-labelledby={`${id}-rotulo`} className="flex items-stretch overflow-hidden rounded-lg border border-border bg-surface">
              <div className="min-w-0 flex-1 px-3 py-2">
                <p className="text-xs text-text-muted">{nodeTitle[target.type ?? ""] ?? target.type}</p>
                <p className="truncate text-sm font-semibold">{stepLabel(target, nodes)}</p>
              </div>
              <button type="button" aria-label={`Desfazer ligação: ${p.label}`} disabled={readOnly} onClick={() => onChange(p.port, null)}
                className="grid w-10 shrink-0 place-items-center border-l border-border text-text-muted hover:bg-surface-muted hover:text-text disabled:opacity-50"><X className="size-4" aria-hidden="true" /></button>
            </div>
          </div>
        )
        return (
          <div key={p.port} className="space-y-1">
            <Label htmlFor={id}>{p.label}</Label>
            <Select value={current} disabled={readOnly} onValueChange={(v) => onChange(p.port, v === NONE ? null : v)}>
              <SelectTrigger id={id}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Nenhum (termina aqui)</SelectItem>
                {targets.map((n) => (
                  <SelectItem key={n.id} value={n.id}>
                    {stepLabel(n, nodes)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )
      })}
    </section>
  )
}
