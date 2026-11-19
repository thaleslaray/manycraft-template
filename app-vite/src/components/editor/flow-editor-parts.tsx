/** Peças do editor de fluxo: item do menu do "+", trava com permissões por ação e lista dos passos. */
import * as React from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { setAutomationLock, lockableActions, lockedActionsOf, type Automation, type LockableAction } from "@/data"
import { isAnnotation } from "./annotations"
import { nodeTitle, type FlowEdge, type FlowNode } from "./graph"

/** Item do menu do "+": bloco tracejado com ícone, dois por linha. */
export function StepItem({ icon: Icon, onSelect, children }: { icon: React.ComponentType<{ className?: string }>; onSelect: () => void; children: React.ReactNode }) {
  return (
    <DropdownMenuItem onSelect={onSelect} className="h-auto min-h-[3.6rem] gap-3 rounded-md border border-dashed border-border-input px-4 py-2 text-sm">
      <Icon className="size-4 shrink-0 text-text-muted" aria-hidden="true" />{children}
    </DropdownMenuItem>
  )
}

/** Trava com permissões por ação: o dono escolhe o que fica só para dono e administradores (todas = somente leitura). */
export function LockMenu({ automation, onChange, open, setOpen }: { automation: Automation; onChange: (locked: boolean, actions: LockableAction[]) => void; open: boolean; setOpen: (open: boolean) => void }) {
  const current = lockedActionsOf(automation)
  const [picked, setPicked] = React.useState<LockableAction[]>(current.length ? current : Object.keys(lockableActions) as LockableAction[])
  const apply = async (locked: boolean) => {
    try { await setAutomationLock(automation.id, locked, picked); onChange(locked, picked); setOpen(false); toast.success(locked ? "Permissões da automação salvas." : "Automação destravada.") }
    catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível alterar a trava.") }
  }
  return <>
    {open ? <Dialog open onOpenChange={setOpen}><DialogContent>
      <DialogHeader><DialogTitle>Permissões desta automação</DialogTitle><DialogDescription>Marque o que só o dono e os administradores podem fazer. Com tudo marcado, os demais papéis só leem.</DialogDescription></DialogHeader>
      <div className="space-y-2">{(Object.keys(lockableActions) as LockableAction[]).map(k => <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-accent" checked={picked.includes(k)} onChange={e => setPicked(e.target.checked ? [...picked, k] : picked.filter(x => x !== k))} />{lockableActions[k]}</label>)}</div>
      <DialogFooter>{automation.locked ? <Button variant="ghost" onClick={() => void apply(false)}>Destravar</Button> : null}<Button disabled={!picked.length} onClick={() => void apply(true)}>Salvar trava</Button></DialogFooter>
    </DialogContent></Dialog> : null}
  </>
}

/** Lista dos passos a partir do gatilho, seguindo as ligações (depois os soltos); clicar abre o painel do passo. */
export function StepList({ nodes, edges, selected, onPick }: { nodes: FlowNode[]; edges: FlowEdge[]; selected: string | null; onPick: (id: string) => void }) {
  const steps = nodes.filter(n => !isAnnotation(n))
  const order: FlowNode[] = [], seen = new Set<string>()
  const visit = (n: FlowNode | undefined, depth: number) => {
    if (!n || seen.has(n.id)) return
    seen.add(n.id); order.push({ ...n, data: { ...n.data, depth } } as FlowNode)
    for (const e of edges.filter(e => e.source === n.id)) visit(steps.find(x => x.id === e.target), depth + 1)
  }
  for (const t of steps.filter(n => n.type === "trigger")) visit(t, 0)
  for (const n of steps) visit(n, 0)
  return <ol aria-label="Passos em lista" className="h-full space-y-1 overflow-y-auto bg-surface p-3">
    {order.map(n => <li key={n.id}><button type="button" onClick={() => onPick(n.id)} style={{ marginInlineStart: `${Math.min(Number((n.data as { depth?: number }).depth ?? 0), 8) * 1.25}rem` }}
      className={`w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-surface-muted ${selected === n.id ? "border-accent" : "border-border"}`}>
      <span className="font-semibold">{nodeTitle[n.type ?? ""] ?? n.type}</span> <span className="text-text-muted">· {n.id}</span></button></li>)}
  </ol>
}
