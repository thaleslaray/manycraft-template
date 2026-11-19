import * as React from "react"
import { Tag } from "lucide-react"
import { toast } from "sonner"
import { apiRequest, isFakeMode } from "@/data/api"
import { useAsync } from "@/hooks/use-async"
import { cn } from "@/lib/utils"
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"

import { listInboxLabels, type InboxLabel } from "@/data/inbox-team"
export { listInboxLabels, type InboxLabel }
export const labelTone: Record<string, string> = {
  neutral: "bg-border/50 text-text", accent: "bg-accent-soft text-accent", success: "bg-success-soft text-success", warning: "bg-warning-soft text-warning", danger: "bg-danger-soft text-danger",
}

export function LabelChips({ labels }: { labels: { id: string; name: string; color: string }[] }) {
  if (!labels.length) return null
  return <span className="flex flex-wrap gap-1">{labels.map(l => <span key={l.id} className={cn("rounded-pill px-2 py-0.5 text-2xs font-semibold", labelTone[l.color] ?? labelTone.neutral)}>{l.name}</span>)}</span>
}

/** Põe e tira etiquetas manuais da conversa. */
export function ConversationLabels({ conversationId, current, disabled, onChanged, compact = false }: { compact?: boolean; conversationId: string; current: { id: string; name: string; color: string }[]; disabled: boolean; onChanged: () => void }) {
  const labels = useAsync(listInboxLabels, "inbox-labels")
  const [busy, setBusy] = React.useState(false)
  if (isFakeMode()) return null
  async function toggle(id: string, on: boolean) {
    setBusy(true)
    try { await apiRequest(`/inbox/conversations/${encodeURIComponent(conversationId)}/labels`, { method: "POST", body: JSON.stringify({ label_id: id, on }) }); onChanged() }
    catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível mudar a etiqueta.") } finally { setBusy(false) }
  }
  return <div className="flex flex-wrap items-center gap-2">
    {compact ? null : <LabelChips labels={current} />}
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{compact ? <Button size="icon" variant="ghost" className="relative size-8" aria-label="Etiquetas" title="Etiquetas" disabled={disabled || busy}><Tag className="size-4" aria-hidden="true" />{current.length ? <span className="absolute top-1 right-1 size-1.5 rounded-full bg-accent" aria-hidden="true" /> : null}</Button> : <Button size="sm" variant="ghost" disabled={disabled || busy}><Tag className="size-4" aria-hidden="true" />Etiquetas</Button>}</DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-72 overflow-y-auto">
        <DropdownMenuLabel>{(labels.data ?? []).length ? "Etiquetas da conversa" : "Crie etiquetas em Configurações > Caixa de entrada"}</DropdownMenuLabel>
        {(labels.data ?? []).map(l => <DropdownMenuCheckboxItem key={l.id} checked={current.some(c => c.id === l.id)} onSelect={e => e.preventDefault()} onCheckedChange={on => void toggle(l.id, on === true)}>{l.name}</DropdownMenuCheckboxItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
}
