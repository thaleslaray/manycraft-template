import * as React from "react"
import { Clock3 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { closeOnEscape, useOpenState } from "./inbox-shared"

/** Lembrete da conversa: no horário ela reabre, fica não lida e o histórico mostra a nota. */
export function InboxReminder({ at, note, busy, onSave, open: controlled, onOpenChange, trigger = true }: { at: string | null; note: string | null; busy: boolean; onSave: (at: string | null, note?: string) => void; open?: boolean; onOpenChange?: (open: boolean) => void; trigger?: boolean }) {
  const [open, setOpen] = useOpenState(controlled, onOpenChange)
  const [when, setWhen] = React.useState("")
  const [text, setText] = React.useState("")
  // Só ao abrir: a nota que chega enquanto a pessoa digita não apaga o que ela escreveu.
  React.useEffect(() => { if (open) setText(note ?? "") }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const min = new Date(Date.now() + 60_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
  return <>
    {trigger ? <Button size="sm" variant="secondary" disabled={busy} aria-expanded={open} onClick={() => { if (open) { setOpen(false); return } setOpen(true); setText(note ?? "") }}><Clock3 className="size-4" aria-hidden="true" />{at ? "Lembrete marcado" : "Lembrete"}</Button> : null}
    {trigger && at ? <p className="w-full text-xs text-warning">Lembrete em {new Date(at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}{note ? ` · ${note}` : ""}</p> : null}
    {open ? <form className="absolute inset-x-3 top-full z-30 mt-1 space-y-2 rounded-md border border-border bg-surface p-3 shadow-lg" onKeyDown={closeOnEscape(() => setOpen(false))} onSubmit={e => { e.preventDefault(); if (!when) return; onSave(new Date(when).toISOString(), text.trim() || undefined); setOpen(false) }}>
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="space-y-1 text-xs font-semibold">Quando<input type="datetime-local" required min={min} value={when} onChange={e => setWhen(e.target.value)} className="h-9 w-full rounded-md border border-border-input bg-surface px-2 text-sm font-normal" /></label>
      <label className="space-y-1 text-xs font-semibold">Nota<input maxLength={500} value={text} onChange={e => setText(e.target.value)} placeholder="Retornar com o orçamento" className="h-9 w-full rounded-md border border-border-input bg-surface px-2 text-sm font-normal" /></label>
    </div>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" type="submit" disabled={busy || !when}>Salvar lembrete</Button>
      {at ? <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => { onSave(null); setOpen(false) }}>Tirar lembrete</Button> : null}
      <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>Cancelar</Button>
    </div>
  </form> : null}
  </>
}
