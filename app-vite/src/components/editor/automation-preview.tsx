import * as React from "react"
import { RotateCcw, Send, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { CardsPreview } from "./cards-block"
import { MediaPreview } from "./media-block"
import {
  SKIP_CHOICE, TIMEOUT_CHOICE, answerPreview, choosePreview, startPreview,
  type PreviewEnv, type PreviewItem, type PreviewState,
} from "./preview"

const bubble = "max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm"

function Item({ item }: { item: PreviewItem }) {
  if (item.kind === "text") return <li className={cn(bubble, "self-start border border-border bg-surface")}>{item.text}</li>
  if (item.kind === "contact") return <li className={cn(bubble, "self-end bg-accent-soft")}><span className="sr-only">Contato: </span>{item.text}</li>
  if (item.kind === "note") return <li className="self-center rounded-md bg-warning-soft px-3 py-1 text-center text-xs text-warning"><span className="sr-only">Nota da prévia: </span>{item.text}</li>
  if (item.kind === "media") return <li className="w-full max-w-[85%] self-start"><MediaPreview block={item.block} /></li>
  return <li className="w-full min-w-0 self-start"><CardsPreview block={item.block} /></li>
}

/** Celular simulado: percorre o fluxo com o que está no editor, sem enviar, gravar ou chamar nada. */
export function AutomationPreview({ env, issue, onClose, className }: { env: PreviewEnv; issue?: string; onClose: () => void; className?: string }) {
  const [state, setState] = React.useState<PreviewState>(() => startPreview(env))
  const [draft, setDraft] = React.useState("")
  const titleId = React.useId()
  const titleRef = React.useRef<HTMLHeadingElement>(null)
  const logRef = React.useRef<HTMLDivElement>(null)
  const controlsRef = React.useRef<HTMLDivElement>(null)
  const interacted = React.useRef(false)

  React.useEffect(() => { titleRef.current?.focus() }, [])
  React.useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
    if (interacted.current) controlsRef.current?.querySelector<HTMLElement>("input, button")?.focus()
  }, [state])

  const update = (next: PreviewState) => { interacted.current = true; setState(next) }
  const restart = () => { setDraft(""); update(startPreview(env)) }
  const wait = state.wait

  return (
    <section
      role="region"
      aria-labelledby={titleId}
      onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); onClose() } }}
      className={cn("flex h-full min-h-0 w-full flex-col overflow-hidden rounded-lg border border-border bg-surface md:w-(--side-panel) md:shrink-0", className)}
    >
      <header className="flex items-center gap-2 bg-surface-muted px-4 py-3">
        <h2 id={titleId} ref={titleRef} tabIndex={-1} className="min-w-0 flex-1 truncate text-lg font-semibold outline-none">Prévia da automação</h2>
        <button type="button" onClick={restart} aria-label="Recomeçar prévia" title="Recomeçar" className="grid size-8 shrink-0 place-items-center rounded-md text-text-muted hover:bg-border/40 hover:text-text">
          <RotateCcw className="size-4" aria-hidden="true" />
        </button>
        <button type="button" onClick={onClose} aria-label="Fechar prévia" className="grid size-8 shrink-0 place-items-center rounded-md text-text-muted hover:bg-border/40 hover:text-text">
          <X className="size-4" aria-hidden="true" />
        </button>
      </header>
      <p className="border-y border-border bg-warning-soft px-4 py-2 text-xs text-warning">
        Só uma simulação: nada é enviado, gravado nem chamado. Se você mudar o fluxo, recomece para ver a mudança.
      </p>
      {issue ? <p role="status" className="px-4 pt-2 text-xs text-text-muted">{issue}</p> : null}
      {/* Moldura de celular: a conversa aparece como no aparelho do contato. */}
      <div className="mx-auto my-4 flex min-h-0 w-full max-w-sm flex-1 flex-col overflow-hidden rounded-3xl border-8 border-text bg-bg shadow-node" aria-label="Celular de exemplo">
        <div className="flex justify-center bg-surface pt-2" aria-hidden="true"><span className="h-1.5 w-16 rounded-full bg-border" /></div>
        <p className="border-b border-border bg-surface px-3 py-2 text-xs font-semibold">Maria Silva · contato de exemplo</p>
        <div ref={logRef} role="log" aria-live="polite" aria-label="Conversa da prévia" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto p-3 focus-visible:outline-2 focus-visible:outline-accent">
          {state.items.length === 0 ? <p className="text-center text-sm text-text-muted">Nada para mostrar ainda.</p> : (
            <ol className="flex flex-col gap-2">{state.items.map(item => <Item key={item.id} item={item} />)}</ol>
          )}
        </div>
        <div ref={controlsRef} className="space-y-2 border-t border-border bg-surface p-3">
          {wait?.kind === "choices" ? (
            <div role="group" aria-label="Opções do contato" className="flex flex-wrap gap-2">
              {wait.choices.map(c => (
                <Button key={c.id} size="sm" variant={c.tone === "timeout" || c.tone === "path" ? "secondary" : "primary"} className="h-auto min-h-8 max-w-full whitespace-normal py-1 text-left break-words"
                  onClick={() => update(choosePreview(env, state, c.id))}>{c.label || "Sem título"}</Button>
              ))}
            </div>
          ) : null}
          {wait?.kind === "answer" ? (
            <>
              {wait.options.length ? (
                <div role="group" aria-label="Opções de resposta" className="flex flex-wrap gap-2">
                  {wait.options.map(o => <Button key={o} size="sm" className="h-auto min-h-8 max-w-full whitespace-normal py-1 text-left break-words" onClick={() => update(answerPreview(env, state, o))}>{o}</Button>)}
                </div>
              ) : (
                <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (!draft.trim()) return; update(answerPreview(env, state, draft)); setDraft("") }}>
                  <Input aria-label="Resposta do contato" value={draft} maxLength={500} placeholder="Escreva a resposta" onChange={e => setDraft(e.target.value)} />
                  <Button type="submit" size="icon" aria-label="Enviar resposta" disabled={!draft.trim()}><Send className="size-4" aria-hidden="true" /></Button>
                </form>
              )}
              <div className="flex flex-wrap gap-2">
                {wait.skip ? <Button size="sm" variant="secondary" onClick={() => update(choosePreview(env, state, SKIP_CHOICE))}>Pular</Button> : null}
                <Button size="sm" variant="ghost" onClick={() => update(choosePreview(env, state, TIMEOUT_CHOICE))}>Não responder</Button>
              </div>
            </>
          ) : null}
          {!wait ? (
            <div className="space-y-2">
              <p role="status" className="text-sm text-text-muted">{state.ended ?? "Prévia concluída."}</p>
              <Button size="sm" variant="secondary" onClick={restart}><RotateCcw className="size-4" aria-hidden="true" />Recomeçar</Button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
