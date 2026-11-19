import * as React from "react"
import { Search, Webhook, ShoppingBag } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { ChannelBadge } from "./channel-badge"
import { triggerCards, triggerChannels, type TriggerCard } from "./trigger-catalog"

export type NewTriggerChoice = { kind: string; channel: string; connectionKind?: string }

function Glyph({ channel }: { channel: string }) {
  if (channel === "hotmart") return <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-pill bg-accent-soft text-accent"><ShoppingBag className="size-4" /></span>
  if (channel === "contact") return <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-pill bg-accent-soft text-accent"><Webhook className="size-4" /></span>
  return <ChannelBadge channel={channel} />
}

/** Pop-up "Iniciar automação quando…": canais à esquerda, gatilhos em cartões à direita, busca no topo. */
export function NewTriggerDialog({ open, onOpenChange, onChoose }: { open: boolean; onOpenChange: (open: boolean) => void; onChoose: (choice: NewTriggerChoice) => void }) {
  const [channel, setChannel] = React.useState(triggerChannels[0].id)
  const [query, setQuery] = React.useState("")
  React.useEffect(() => { if (open) { setChannel(triggerChannels[0].id); setQuery("") } }, [open])
  const current = triggerChannels.find(c => c.id === channel) ?? triggerChannels[0]
  const text = query.trim().toLowerCase()
  const cards = triggerCards.filter(card => card.channel === current.id && (!text || `${card.kicker} ${card.title}`.toLowerCase().includes(text)))
  const pick = (card: TriggerCard) => { onChoose({ kind: card.kind, channel: card.channel, connectionKind: current.connectionKind }); onOpenChange(false) }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[2.8%] w-[760px] max-w-[calc(100vw-2rem)] translate-y-0 gap-0 p-0" aria-describedby="novo-gatilho-ajuda">
        <div className="flex items-center justify-between gap-4 px-5 pt-5 pr-14">
          <DialogTitle className="text-xl font-bold">Iniciar automação quando…</DialogTitle>
          <label className="relative block w-56 shrink-0">
            <span className="sr-only">Buscar gatilho</span>
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted" aria-hidden="true" />
            <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={`Pesquisar por ${current.label}`} className="h-9 w-full rounded-md border border-border-input bg-surface pr-3 pl-9 text-sm" />
          </label>
        </div>
        <DialogDescription id="novo-gatilho-ajuda" className="sr-only">Escolha o canal e o evento que inicia a automação.</DialogDescription>
        <div className="flex min-h-0 gap-4 p-5">
          <nav aria-label="Canais" className="w-44 shrink-0 space-y-1">
            {triggerChannels.map(c => <button key={c.id} type="button" aria-current={c.id === channel || undefined} onClick={() => setChannel(c.id)}
              className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-muted", c.id === channel && "bg-surface-muted font-medium")}>
              <span className="shrink-0 [&>span]:size-5 [&>span]:bg-transparent" aria-hidden="true"><Glyph channel={c.id} /></span><span className="min-w-0 truncate">{c.label}</span>
            </button>)}
          </nav>
          <section aria-label="Gatilhos" className="h-[calc(74vh-8.5rem)] min-w-0 flex-1 space-y-3 overflow-y-auto pr-1">
            <h3 className="text-sm font-semibold">Gatilhos</h3>
            <p className="text-xs text-text-muted">{current.blurb}</p>
            {cards.map(card => <button key={`${card.channel}-${card.kind}`} type="button" onClick={() => pick(card)}
              className="flex w-full items-center gap-3 rounded-md border border-border bg-surface px-4 py-4 text-left hover:border-border-input hover:bg-surface-muted">
              <Glyph channel={card.channel} />
              <span className="min-w-0"><span className="block text-xs text-text-muted">{card.kicker}</span><span className="block text-sm font-medium">{card.title}</span></span>
            </button>)}
            {!cards.length ? <p role="status" className="text-sm text-text-muted">Nenhum gatilho encontrado.</p> : null}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
