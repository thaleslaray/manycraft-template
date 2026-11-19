import * as React from "react"
import { ChevronRight } from "lucide-react"
import type { Connection } from "@/data/connections"
import type { Tag, Trigger, Automation } from "@/data"
import { PortLinks } from "./port-links"
import { nodeTitle, outputPorts, triggersOf, type Catalogs, type EditorField, type FlowEdge, type FlowNode } from "./graph"

export type PanelProps = {
  node: FlowNode
  nodes: FlowNode[]
  edges: FlowEdge[]
  triggers: Trigger[]
  tags: Tag[]
  connections?: Connection[]
  fields?: EditorField[]
  /** Campos do bot (valor único do espaço): ação "Definir campo do bot" e variável {{bot:ID}}. */
  botFields?: EditorField[]
  sequences?: Catalogs["sequences"]
  segments?: { id: string; name: string }[]
  automations?: Automation[]
  members?: { id: string; name: string }[]
  automationId?: string
  /** A automação já tem versão publicada (gatilho só liga depois de publicar). */
  published?: boolean
  catalogLoading?: boolean
  catalogErrors?: { fields?: boolean; automations?: boolean; segments?: boolean; sequences?: boolean; members?: boolean; connections?: boolean }
  reloadCatalogs?: () => void
  readOnly: boolean
  errors: string[]
  showErrors: boolean
  updateConfig: (patch: Record<string, unknown>) => void
  setLink: (port: string, to: string | null) => void
  createStep?: (port: string, type: "message" | "question" | "action" | "smart_delay" | "condition" | "randomizer" | "start_automation") => void
  onClose: () => void
  onDeleteNode: () => void
  /** O mapa tem alterações ainda não salvas (para a barra inferior do passo). */
  dirty?: boolean
  onTriggerChange: (t: Trigger) => void
  /** Gatilho escolhido no nó do mapa (linha clicada). */
  triggerId?: string
  /** Novo gatilho escolhido no pop-up: o painel abre o formulário já nesse tipo. */
  creating?: { kind: string; channel: string; connectionKind?: string } | null
  onCreated?: () => void
  onTriggerRemove?: (id: string) => void
}

/** Lista de erros do passo (só depois de tentar publicar). */
export function NodeErrors({ errors, show }: { errors: string[]; show: boolean }) {
  if (!show || errors.length === 0) return null
  return (
    <ul role="alert" className="space-y-1 rounded-md bg-warning-soft p-3 text-sm text-warning">
      {errors.map((e) => (
        <li key={e}>{e}</li>
      ))}
    </ul>
  )
}

/** Ligações das portas do passo (alternativa ao arrastar). */
export function NodeLinks({ p }: { p: PanelProps }) {
  const { node } = p
  const ports = outputPorts(node)
  // Como no ManyChat, os gatilhos da mesma entrada são um passo só, com uma saída só: trocar o destino vale para todos.
  const sharing = triggersOf(node, p.triggers ?? []).length
  const links = <PortLinks fromId={node.id} ports={ports} nodes={p.nodes} edges={p.edges} readOnly={p.readOnly} onChange={p.setLink} />
  if (sharing <= 1) return links
  return <>
    <p className="rounded-md bg-surface-muted p-3 text-xs text-text-muted">Esta entrada tem {sharing} gatilhos e eles dividem a mesma saída: o destino de "Então vai para" vale para todos os gatilhos desta entrada.</p>
    {links}
  </>
}

/** Título e renomeio do passo (config.label; sem nome próprio vale o do tipo). */
export function stepName(p: PanelProps, fallback?: string) {
  const label = typeof p.node.data.config.label === "string" ? p.node.data.config.label.trim() : ""
  const title = label || fallback || nodeTitle[p.node.type ?? ""] || "Passo"
  return { title, rename: { value: title, disabled: p.readOnly, onChange: (name: string) => p.updateConfig({ label: name }) } }
}

/** "Mais opções" recolhido no fim do painel: o essencial fica à vista e o resto abre sob demanda. */
export function MoreOptions({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const id = React.useId()
  return (
    <div className="border-t border-border pt-3">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(v => !v)} className="flex items-center gap-1 text-sm font-medium text-text-muted hover:text-text">
        <ChevronRight className={`size-4 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true" />Mais opções
      </button>
      <div id={id} hidden={!open} className="mt-4 space-y-6">{children}</div>
    </div>
  )
}
