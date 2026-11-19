import * as React from "react"
import { createPortal } from "react-dom"
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from "@xyflow/react"
import { X } from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { StepIcon } from "./channel-badge"
import type { DropGroup, DropItem } from "./connect-drop"

/** Nó invisível no ponto da soltura: só serve de ponta para o conector provisório (a seta aponta para a caixinha). */
export const DROP_ANCHOR_ID = "connect-drop-anchor"
export function DropAnchorNode() {
  return (
    <div aria-hidden="true" className="pointer-events-none size-px">
      <Handle type="target" position={Position.Left} isConnectable={false} className="opacity-0!" style={{ top: 0, left: 0 }} />
    </div>
  )
}

// Rótulo de grupo discreto, igual na caixinha, no cartão do primeiro passo e na lista do celular.
const groupLabelCls = "px-2 pt-2 pb-1 text-xs font-medium text-text-muted"

/**
 * Caixinha de próximos passos ao soltar o conector no vazio do mapa, ancorada no ponto da soltura (coordenadas da tela).
 * Mostra o catálogo agrupado (Conteúdo, Lógica) com o ícone de cada item, como o cartão do primeiro passo.
 * Abre com o foco no primeiro item; setas navegam, Esc, Cancelar ou clicar fora fecham sem criar nada.
 */
export function ConnectDropMenu({ point, groups, onPick, onCancel }: { point: { x: number; y: number }; groups: DropGroup[]; onPick: (item: DropItem) => void; onCancel: () => void }) {
  const content = React.useRef<HTMLDivElement>(null)
  const id = React.useId()
  React.useEffect(() => {
    // Aberto pelo mouse, o Radix foca a caixa; aqui o foco vai direto para o primeiro passo.
    const frame = requestAnimationFrame(() => content.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])
  // No body: dentro do editor algum ancestral cria outro referencial e o "fixed" deixaria de ser a tela.
  return createPortal(
    <DropdownMenu open onOpenChange={open => { if (!open) onCancel() }}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden="true" tabIndex={-1} className="pointer-events-none fixed size-0" style={{ left: point.x, top: point.y }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent ref={content} aria-label="Próximo passo" side="right" align="start" sideOffset={0} alignOffset={-18} collisionPadding={16}
        onCloseAutoFocus={e => e.preventDefault()} className="w-60 p-1.5">
        {groups.map(group => (
          <div key={group.key} role="group" aria-labelledby={`${id}-${group.key}`}>
            <DropdownMenuLabel id={`${id}-${group.key}`} className={groupLabelCls}>{group.label}</DropdownMenuLabel>
            {group.items.map(item => (
              <DropdownMenuItem key={item.key} onSelect={() => onPick(item)} className="h-10 gap-2.5 px-2 font-medium">
                <StepIcon icon={item.icon} />{item.label}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
        <div role="separator" className="my-1 h-px bg-border" />
        <DropdownMenuItem onSelect={onCancel} className="gap-2.5 px-2 text-text-muted">
          <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center"><X className="size-4" /></span>Cancelar
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
    document.body
  )
}

/**
 * Opções agrupadas do primeiro passo como botões de verdade (cartão do mapa e lista do celular): mesmo catálogo,
 * mesmos rótulos e ícones da caixinha do conector.
 */
export function StepChoices({ groups, onPick, disabled, className }: { groups: DropGroup[]; onPick: (item: DropItem) => void; disabled?: boolean; className?: string }) {
  const id = React.useId()
  return (
    <div className={cn("space-y-1", className)}>
      {groups.map(group => (
        <div key={group.key} role="group" aria-labelledby={`${id}-${group.key}`}>
          <p id={`${id}-${group.key}`} className={groupLabelCls}>{group.label}</p>
          <ul className="space-y-0.5">
            {group.items.map(item => (
              <li key={item.key}>
                <button type="button" disabled={disabled} onClick={() => onPick(item)}
                  className="nodrag nopan flex h-10 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm font-medium text-text transition-colors duration-(--duration-fast) hover:bg-surface-muted focus-visible:bg-surface-muted disabled:opacity-50">
                  <StepIcon icon={item.icon} />{item.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

/** Título do cartão do primeiro passo; o dedo apontando é enfeite (fica fora do nome acessível). */
export function FirstStepTitle({ id }: { id: string }) {
  return <p id={id} className="px-2 text-base font-semibold text-text">Escolha o primeiro passo <span aria-hidden="true">👇</span></p>
}

/** Cartão do mapa do fluxo vazio: não é um passo (fica fora do grafo salvo, da validação e do histórico). */
export const FIRST_STEP_ID = "first-step-card"
export type FirstStepData = { config: Record<string, never>; groups: DropGroup[]; onPick: (item: DropItem) => void
  /** Mapa estreito: o cartão fica abaixo do início e a entrada do conector é o topo dele. */
  vertical?: boolean }
export function FirstStepNode({ id: nodeId, data }: NodeProps) {
  const { groups, onPick, vertical } = data as unknown as FirstStepData
  const id = React.useId()
  const updateInternals = useUpdateNodeInternals()
  React.useEffect(() => { updateInternals(nodeId) }, [nodeId, vertical, updateInternals])
  return (
    <section aria-labelledby={`${id}-title`} className="w-(--node-w) cursor-default rounded-lg border-2 border-dashed border-border-input bg-surface/90 px-2 pt-3.5 pb-2">
      {vertical ? <Handle type="target" position={Position.Top} isConnectable={false} className="opacity-0!" />
        : <Handle type="target" position={Position.Left} isConnectable={false} className="opacity-0!" style={{ top: "1.5rem" }} />}
      <FirstStepTitle id={`${id}-title`} />
      <StepChoices groups={groups} onPick={onPick} className="mt-1.5" />
    </section>
  )
}
