/**
 * Teclado, copiar e colar do mapa: Delete com o campo invisível em foco, desfazer/refazer, Cmd+C/D, e o evento de colar que
 * decide entre blocos da ManyChat e a cópia do próprio editor (talvez de outra conta: etiquetas, campos e sequências pelo nome).
 * Devolve o ref do campo invisível que segura o foco no mapa (o Chrome do Mac só dispara a colagem com um campo editável em foco).
 */
import * as React from "react"
import { toast } from "sonner"
import { collectRefs, copySelection, pasteClip, remapRefs, type Clip, type RefCatalogs } from "./clipboard"
import { manychatClipboardFrom, fragmentCreatedSummary, translateManychatFragment } from "@/data/manychat-import"
import type { Trigger } from "@/data"
import { toFlow, type FlowEdge, type FlowNode } from "./graph"
import { assignStepChannels } from "./step-channel"

export type EditorKeyActions = { undo: () => void; redo: () => void; removeElements: (nodes: FlowNode[], edges: FlowEdge[]) => void }
type SetList<T> = React.Dispatch<React.SetStateAction<T[]>>

export function useEditorClipboard({ readOnly, nodes, edges, setNodes, setEdges, triggers, catalogs, keyActions }: {
  readOnly: boolean; nodes: FlowNode[]; edges: FlowEdge[]; setNodes: SetList<FlowNode>; setEdges: SetList<FlowEdge>
  triggers: Trigger[]; catalogs: RefCatalogs; keyActions: React.RefObject<EditorKeyActions>
}) {
  const clip = React.useRef<Clip<FlowNode, FlowEdge> | null>(null)
  const MANYCRAFT_STEPS = "application/x-manycraft-steps"
  // Catálogos deste espaço para copiar (guardar nomes) e colar (achar pelo nome) sem refazer os ouvintes.
  const refCatalogs = React.useRef(catalogs)
  refCatalogs.current = catalogs
  React.useEffect(() => {
    if (readOnly) return
    const onKey = (e: KeyboardEvent) => {
      // Com o campo invisível de colar em foco, o mapa não recebe Delete/Backspace: apaga a seleção aqui.
      if (e.target === pasteCatcher.current && (e.key === "Delete" || e.key === "Backspace") && !e.metaKey && !e.ctrlKey) {
        const doomed = nodes.filter(n => n.selected && n.deletable !== false)
        const ids = new Set(doomed.map(n => n.id))
        const links = edges.filter(x => x.selected || ids.has(x.source) || ids.has(x.target))
        if (doomed.length || links.length) {
          e.preventDefault()
          const gone = new Set(links.map(x => x.id))
          setNodes(ns => ns.filter(n => !ids.has(n.id))); setEdges(es => es.filter(x => !gone.has(x.id)))
          keyActions.current.removeElements(doomed, links)
        }
        return
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el && el !== pasteCatcher.current && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return
      const key = e.key.toLowerCase()
      if (key === "z" && !e.shiftKey) { e.preventDefault(); keyActions.current.undo() }
      else if ((key === "z" && e.shiftKey) || key === "y") { e.preventDefault(); keyActions.current.redo() }
      else if (key === "c" || key === "d") {
        const selection = copySelection(nodes, edges)
        if (!selection) return
        const copied = { ...selection, refs: collectRefs(selection.nodes, refCatalogs.current) }
        // Cmd+C segue para o evento de copiar (abaixo), que grava os passos na área de transferência; Cmd+D duplica aqui.
        if (key === "d") e.preventDefault()
        clip.current = copied
        // Fica também no navegador: colar em outra automação (ou em outra conta) funciona.
        try { localStorage.setItem("editor-clip", JSON.stringify(copied)) } catch { /* sem armazenamento: só nesta aba */ }
        if (key === "d") { const next = pasteClip(copied, nodes, edges); setNodes(next.nodes); setEdges(next.edges) }
        else toast.success(`${copied.nodes.length} passo${copied.nodes.length > 1 ? "s" : ""} copiado${copied.nodes.length > 1 ? "s" : ""}.`)
      }
      // Cmd+V não é tratado aqui: o evento de colar decide entre blocos da ManyChat e a cópia interna (abaixo).
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [readOnly, nodes, edges, setNodes, setEdges, keyActions])

  // Colar: blocos copiados na ManyChat viram passos traduzidos ao lado do fluxo; fora isso, a cópia interna do editor.
  // No Chrome do Mac o Cmd+V só dispara a colagem com um campo editável em foco: um campo invisível fica em foco no mapa.
  const pasteCatcher = React.useRef<HTMLTextAreaElement>(null)
  const latest = React.useRef({ nodes, edges })
  latest.current = { nodes, edges }
  React.useEffect(() => {
    if (readOnly) return
    const focusCatcher = () => { if (!document.querySelector("[role=dialog]")) pasteCatcher.current?.focus({ preventScroll: true }) }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (!target?.closest(".flow-canvas") || target.closest("input, textarea, select, button, a, [contenteditable]")) return
      setTimeout(focusCatcher, 0)
    }
    // Copiar passos do ManyCraft também vai para a área de transferência: assim a última cópia (ManyCraft ou ManyChat) é a que cola.
    const onCopy = (event: ClipboardEvent) => {
      const el = event.target as HTMLElement | null
      if (el && el !== pasteCatcher.current && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return
      const selection = copySelection(latest.current.nodes, latest.current.edges)
      if (!selection || !event.clipboardData) return
      const copied = { ...selection, refs: collectRefs(selection.nodes, refCatalogs.current) }
      event.preventDefault()
      event.clipboardData.setData(MANYCRAFT_STEPS, JSON.stringify(copied))
      event.clipboardData.setData("text/plain", `${copied.nodes.length} passo(s) do ManyCraft`)
    }
    const onPaste = (event: ClipboardEvent) => {
      const el = event.target as HTMLElement | null
      if (el && el !== pasteCatcher.current && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return
      const own = event.clipboardData?.getData(MANYCRAFT_STEPS)
      if (own) {
        try {
          const parsed = JSON.parse(own) as Clip<FlowNode, FlowEdge>
          event.preventDefault()
          pasteOwn(parsed)
          return
        } catch { /* conteúdo estranho: segue para as outras fontes */ }
      }
      const manychat = manychatClipboardFrom(event.clipboardData)
      if (manychat) {
        event.preventDefault()
        const loading = toast.loading("Trazendo os blocos da ManyChat…")
        translateManychatFragment(manychat).then(fragment => {
          if (closed) { toast.dismiss(loading); return }
          const flow = toFlow(fragment.graph)
          const dropped = new Set(flow.nodes.filter(n => n.type === "trigger").map(n => n.id))
          const steps = assignStepChannels(flow.nodes.filter(n => !dropped.has(n.id)), triggers)
          const links = flow.edges.filter(e => !dropped.has(e.source) && !dropped.has(e.target))
          if (!steps.length) { toast.error("Nada para colar: a cópia só tinha o gatilho.", { id: loading }); return }
          // Encaixa à direita do que já existe, alinhado ao topo.
          const { nodes: current, edges: currentEdges } = latest.current
          const right = current.length ? Math.max(...current.map(n => n.position.x)) + 400 : 0
          const top = current.length ? Math.min(...current.map(n => n.position.y)) : 0
          const minX = Math.min(...steps.map(n => n.position.x)), minY = Math.min(...steps.map(n => n.position.y))
          const placed = steps.map(n => ({ ...n, position: { x: n.position.x - minX + right, y: n.position.y - minY + top } }))
          const next = pasteClip({ nodes: placed, edges: links }, current, currentEdges, 0)
          setNodes(next.nodes); setEdges(next.edges)
          const out = fragment.report.summary.loss
          const created = fragmentCreatedSummary(fragment)
          toast.success(`${steps.length} passo${steps.length > 1 ? "s" : ""} da ManyChat colado${steps.length > 1 ? "s" : ""}.${out ? ` ${out} ${out > 1 ? "itens ficaram" : "item ficou"} de fora: ${fragment.report.items.filter(i => i.level === "loss").map(i => i.message).join(" ")}` : ""}${created ? ` ${created}` : ""}`, { id: loading, duration: out || created ? 12000 : 5000 })
        }).catch(e => toast.error(e instanceof Error ? e.message : "Não consegui trazer os blocos da ManyChat.", { id: loading }))
        return
      }
      if (!clip.current) { try { const saved = localStorage.getItem("editor-clip"); if (saved) clip.current = JSON.parse(saved) } catch { /* nada salvo */ } }
      if (!clip.current) return
      event.preventDefault()
      pasteOwn(clip.current)
    }
    // Cópia do próprio editor, talvez de outra conta: etiquetas, campos e sequências seguem pelo nome; o que não existe aqui é avisado.
    const pasteOwn = (source: Clip<FlowNode, FlowEdge>) => {
      const { clip: remapped, missing } = remapRefs(source, refCatalogs.current)
      const { nodes: current, edges: currentEdges } = latest.current
      const next = pasteClip(remapped, current, currentEdges); setNodes(next.nodes); setEdges(next.edges)
      if (missing.length) toast.warning(`Não existe nesta conta: ${missing.join(", ")}. Escolha outro item nos passos marcados.`, { duration: 12000 })
    }
    // O editor pode fechar enquanto a ManyChat é traduzida: a resposta atrasada não mexe mais no mapa.
    let closed = false
    focusCatcher()
    document.addEventListener("paste", onPaste)
    document.addEventListener("copy", onCopy)
    document.addEventListener("pointerdown", onPointerDown)
    return () => { closed = true; document.removeEventListener("paste", onPaste); document.removeEventListener("copy", onCopy); document.removeEventListener("pointerdown", onPointerDown) }
  }, [readOnly, triggers, setNodes, setEdges])
  return pasteCatcher
}
