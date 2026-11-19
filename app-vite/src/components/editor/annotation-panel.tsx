import * as React from "react"
import { useReactFlow } from "@xyflow/react"
import { Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input, Textarea } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SidePanel } from "@/components/ui/side-panel"
import { cn } from "@/lib/utils"
import { toneClass } from "./annotation-nodes"
import { annotationLabels, annotationLimits, clampSize, colorLabels, colors, textLimit, titleLimit, type AnnotationColor } from "./annotations"
import type { FlowNode } from "./graph"

type Size = { w: number; h: number }

/** Campo numérico que guarda o que foi digitado e só aplica ao sair ou apertar Enter. */
function SizeField({ id, label, value, min, max, disabled, onCommit }: { id: string; label: string; value: number; min: number; max: number; disabled: boolean; onCommit: (value: number) => void }) {
  const [text, setText] = React.useState<string | null>(null)
  const commit = () => {
    if (text === null) return
    const parsed = Number(text.replace(",", "."))
    setText(null)
    if (text.trim() && Number.isFinite(parsed)) onCommit(parsed)
  }
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="numeric"
        disabled={disabled}
        value={text ?? String(value)}
        aria-describedby={`${id}-dica`}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit() }}
      />
      <p id={`${id}-dica`} className="text-xs text-text-muted">De {min} a {max}</p>
    </div>
  )
}

/** Painel da nota ou do grupo: texto ou título, cor, tamanho e remoção. Alternativa por teclado ao arrastar as alças. */
export function AnnotationPanel({ node, readOnly, update, resize, onClose, onDelete }: {
  node: FlowNode
  readOnly: boolean
  update: (patch: Record<string, unknown>) => void
  resize: (size: Size) => void
  onClose: () => void
  onDelete: () => void
}) {
  const note = node.type === "sticky"
  const portal = node.type === "portal"
  const kind = note ? "note" : portal ? "portal" : "group"
  const { getNodes } = useReactFlow()
  const steps = getNodes().filter(n => !["sticky", "frame", "portal"].includes(n.type ?? ""))
  const label = annotationLabels[kind]
  const config = node.data.config
  const color = (colors as readonly string[]).includes(String(config.color)) ? (config.color as AnnotationColor) : "yellow"
  const size = clampSize(kind, { w: node.width ?? node.measured?.width ?? Number.NaN, h: node.height ?? node.measured?.height ?? Number.NaN })
  const radios = React.useId()
  const text = String(config.text ?? "")
  return (
    <SidePanel
      title={label}
      tone="message"
      onClose={onClose}
      footer={readOnly ? null : (
        <Button variant="ghost" onClick={onDelete}>
          <Trash2 className="size-4" aria-hidden="true" />
          {`Apagar ${label.toLowerCase()}`}
        </Button>
      )}
    >
      <p className="text-sm text-text-muted">
        {portal ? "Atalho visual: o botão Ir leva o mapa até o passo escolhido. Não muda o que a automação faz." : note ? "Anotação solta no mapa. Ela não é enviada e não muda o que a automação faz." : "Quadro para organizar passos. Mover o grupo leva junto o que está dentro dele; a automação não é afetada."}
      </p>
      {portal ? (
        <div className="space-y-1">
          <Label htmlFor="annotation-target">Passo de destino</Label>
          <select id="annotation-target" disabled={readOnly} className="h-10 w-full rounded-md border border-border-input bg-surface px-3 text-sm" value={String(config.target ?? "")} onChange={(e) => update({ target: e.target.value })}>
            <option value="">Escolha o passo</option>{steps.map(n => <option key={n.id} value={n.id}>{n.id}</option>)}
          </select>
          <Label htmlFor="annotation-portal-title">Rótulo (opcional)</Label>
          <Input id="annotation-portal-title" maxLength={titleLimit} disabled={readOnly} value={String(config.title ?? "")} onChange={(e) => update({ title: e.target.value })} />
        </div>
      ) : note ? (
        <div className="space-y-1">
          <Label htmlFor="annotation-text">Texto da nota</Label>
          <Textarea id="annotation-text" rows={6} maxLength={textLimit} disabled={readOnly} value={text} onChange={(e) => update({ text: e.target.value })} aria-describedby="annotation-text-count" />
          <p id="annotation-text-count" className="text-right text-xs text-text-muted">{text.length} de {textLimit}</p>
        </div>
      ) : (
        <div className="space-y-1">
          <Label htmlFor="annotation-title">Título do grupo</Label>
          <Input id="annotation-title" maxLength={titleLimit} disabled={readOnly} value={String(config.title ?? "")} onChange={(e) => update({ title: e.target.value })} />
        </div>
      )}
      {kind === "note" ? <div className="space-y-1">
        <Label htmlFor="annotation-font">Tamanho do texto</Label>
        <select id="annotation-font" disabled={readOnly} className="h-10 w-full rounded-md border border-border-input bg-surface px-3 text-sm" value={String(config.font_size ?? "md")} onChange={(e) => update({ font_size: e.target.value === "md" ? undefined : e.target.value })}>
          <option value="sm">Pequeno</option><option value="md">Médio</option><option value="lg">Grande</option>
        </select>
        <Label htmlFor="annotation-family">Fonte</Label>
        <select id="annotation-family" disabled={readOnly} className="h-10 w-full rounded-md border border-border-input bg-surface px-3 text-sm" value={String(config.font ?? "sans")} onChange={(e) => update({ font: e.target.value === "sans" ? undefined : e.target.value })}>
          <option value="sans">Padrão</option><option value="serif">Serifada</option><option value="mono">Monoespaçada</option>
        </select>
        {config.author ? <p className="text-xs text-text-muted">Criada por {String(config.author)}</p> : null}
      </div> : null}
      <fieldset className="space-y-2" disabled={readOnly}>
        <legend className="mb-1 text-sm font-medium">Cor</legend>
        <div className="flex flex-wrap gap-2">
          {colors.map((c) => (
            <label key={c} className="relative cursor-pointer">
              <input type="radio" name={radios} value={c} checked={color === c} onChange={() => update({ color: c })} className="peer sr-only" />
              <span className={cn("flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm peer-checked:border-accent peer-checked:ring-2 peer-checked:ring-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent peer-disabled:opacity-50", toneClass[c])}>
                {colorLabels[c]}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-3">
        <SizeField id="annotation-w" label="Largura" value={size.w} min={annotationLimits.minW} max={annotationLimits.maxW} disabled={readOnly} onCommit={(w) => resize(clampSize(kind, { w, h: size.h }))} />
        <SizeField id="annotation-h" label="Altura" value={size.h} min={annotationLimits.minH} max={annotationLimits.maxH} disabled={readOnly} onCommit={(h) => resize(clampSize(kind, { w: size.w, h }))} />
      </div>
      <p className="sr-only">{label} selecionado. Use as setas para mover no mapa.</p>
    </SidePanel>
  )
}
