import * as React from "react"
import { ArrowLeft, ChevronDown, Pencil } from "lucide-react"
import { cn } from "@/lib/utils"

export type PanelTone = "trigger" | "message" | "action" | "delay" | "neutral"
const toneCls: Record<PanelTone, string> = {
  trigger: "bg-node-trigger",
  message: "bg-node-ai",
  action: "bg-node-action",
  delay: "bg-node-delay",
  neutral: "bg-surface-muted border-b border-border",
}

/** Painel lateral do editor: foco vai para o título ao abrir; Esc fecha. */
function SidePanel({
  title,
  tone,
  onClose,
  children,
  footer,
  className,
  bodyClassName,
  icon,
  rename,
}: {
  title: string
  tone: PanelTone
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  className?: string
  /** Preenchimento do corpo (padrão p-4). */
  bodyClassName?: string
  /** Ícone do canal ao lado do título (gatilhos). */
  icon?: React.ReactNode
  /** Passos com nome próprio: título centrado e lápis para renomear (mensagem, ações, espera). */
  rename?: { value: string; disabled?: boolean; onChange: (name: string) => void }
}) {
  const [renaming, setRenaming] = React.useState(false)
  const titleRef = React.useRef<HTMLHeadingElement>(null)
  const id = React.useId()
  const bodyRef = React.useRef<HTMLDivElement>(null)
  const [more, setMore] = React.useState(false)
  React.useEffect(() => {
    titleRef.current?.focus()
  }, [])
  const measure = React.useCallback(() => {
    const el = bodyRef.current
    if (el) setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 8)
  }, [])
  React.useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [measure, children])
  return (
    <section
      role="region"
      aria-labelledby={id}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation()
          onClose()
        }
      }}
      className={cn("flex h-full w-full flex-col overflow-hidden rounded-lg border border-border bg-surface md:w-(--side-panel) md:shrink-0", className)}
    >
      <header className={cn("flex items-center gap-2 px-4 py-4", toneCls[tone], rename && "relative justify-center")}>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar painel"
          className={cn("grid size-8 shrink-0 place-items-center rounded-md text-text-muted hover:bg-border/40 hover:text-text", rename && "absolute left-3")}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
        </button>
        {icon ? <span aria-hidden="true" className="shrink-0">{icon}</span> : null}
        {rename && renaming ? (
          <input
            autoFocus
            aria-label="Nome do passo"
            defaultValue={rename.value}
            maxLength={80}
            onBlur={(e) => { const name = e.target.value.trim(); if (name && name !== rename.value) rename.onChange(name); setRenaming(false) }}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { e.stopPropagation(); setRenaming(false) } }}
            className="h-8 min-w-0 max-w-48 rounded-md border border-border-input bg-surface px-2 text-center text-lg font-semibold"
          />
        ) : null}
        <h2 id={id} ref={titleRef} tabIndex={-1} className={cn("min-w-0 truncate text-lg font-semibold outline-none", rename && "text-center", rename && renaming && "sr-only")} title={title}>
          {title}
        </h2>
        {rename && !renaming ? (
          <button type="button" aria-label="Renomear passo" disabled={rename.disabled} onClick={() => setRenaming(true)} className="grid size-6 shrink-0 place-items-center rounded-md text-text-muted hover:text-text disabled:opacity-50">
            <Pencil className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </header>
      <div className="relative min-h-0 flex-1">
        <div ref={bodyRef} onScroll={measure} className={cn("h-full space-y-6 overflow-y-auto", bodyClassName ?? "p-4")}>{children}</div>
        {more ? <div data-testid="rolagem-indicador" aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 flex h-10 items-end justify-center bg-linear-to-t from-surface to-transparent pb-1 text-text-muted"><ChevronDown className="size-4" /></div> : null}
      </div>
      {footer ? <footer className="border-t border-border bg-surface px-4 py-3">{footer}</footer> : null}
    </section>
  )
}

export { SidePanel }
