import * as React from "react"
import { Play } from "lucide-react"
import { toast } from "sonner"
import { apiRequest, isFakeMode } from "@/data/api"
import { Button } from "@/components/ui/button"
import { closeOnEscape, useOpenState } from "./inbox-shared"

type AutomationOption = { id: string; name: string }

/** Roda uma automação publicada para o contato desta conversa (o atendente escolhe na lista). */
export function InboxRunAutomation({ conversationId, onDone, disabled, open: controlled, onOpenChange, trigger = true }: { conversationId: string; onDone: () => void; disabled: boolean; open?: boolean; onOpenChange?: (open: boolean) => void; trigger?: boolean }) {
  const [open, setOpen] = useOpenState(controlled, onOpenChange)
  const [options, setOptions] = React.useState<AutomationOption[] | null>(null)
  const [choice, setChoice] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  React.useEffect(() => {
    if (!open || options) return
    apiRequest<AutomationOption[]>(`/inbox/runnable-automations?conversation_id=${encodeURIComponent(conversationId)}`).then(setOptions).catch(() => setOptions([]))
  }, [open, options, conversationId])
  if (isFakeMode()) return null
  return <>{trigger ? <Button size="sm" variant="secondary" disabled={disabled} aria-expanded={open} onClick={() => setOpen(!open)}><Play className="size-4" aria-hidden="true" />Rodar automação</Button> : null}
  {open ? <form className="absolute inset-x-3 top-full z-30 mt-1 flex flex-wrap items-end gap-2 rounded-md border border-border bg-surface p-3 shadow-lg" onKeyDown={closeOnEscape(() => setOpen(false))} onSubmit={async e => {
    e.preventDefault()
    if (!choice) return
    setBusy(true)
    try {
      await apiRequest(`/inbox/conversations/${encodeURIComponent(conversationId)}/run-automation`, { method: "POST", body: JSON.stringify({ automation_id: choice }) })
      toast.success("Automação iniciada para este contato.")
      setOpen(false); onDone()
    } catch (error) { toast.error(error instanceof Error ? error.message : "Não foi possível iniciar a automação.") } finally { setBusy(false) }
  }}>
    <label className="min-w-0 flex-1 space-y-1 text-xs font-semibold">Automação publicada
      <select className="h-9 w-full rounded-md border border-border-input bg-surface px-2 text-sm font-normal" value={choice} onChange={e => setChoice(e.target.value)} disabled={!options}>
        <option value="">{options ? (options.length ? "Escolha" : "Nenhuma automação ligada para este canal") : "Carregando…"}</option>
        {options?.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </label>
    <Button size="sm" type="submit" loading={busy} disabled={!choice}>Rodar</Button>
    <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>Cancelar</Button>
  </form> : null}</>
}
