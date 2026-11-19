import * as React from "react"
import type { InboxChannel } from "@/data"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"

export const inboxChannelLabels: Record<InboxChannel, string> = {
  instagram: "Instagram", whatsapp: "WhatsApp", messenger: "Messenger", telegram: "Telegram", email: "E-mail",
}

export function InboxLoadError({ onRetry }: { onRetry: () => void }) {
  return <Banner variant="danger"><p>Não foi possível abrir o atendimento.</p><Button variant="secondary" size="sm" onClick={onRetry} className="mt-2">Tentar de novo</Button></Banner>
}

/** Um defeito dentro da conversa derruba só o painel dela; pastas e lista continuam na tela. */
export class InboxPanelBoundary extends React.Component<{ children: React.ReactNode; onBack: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (!this.state.failed) return this.props.children
    return <div className="space-y-3 rounded-lg border border-border bg-surface p-4" role="alert">
      <Banner variant="danger"><p>Não foi possível mostrar esta conversa. Os dados estão salvos; tente abrir de novo ou escolha outra conversa.</p></Banner>
      <Button variant="secondary" size="sm" onClick={this.props.onBack}>Voltar para a lista</Button>
    </div>
  }
}

/** Abre/fecha sozinho, ou controlado pelo pai (para a conversa abrir um formulário por vez). */
export function useOpenState(open?: boolean, onOpenChange?: (open: boolean) => void): [boolean, (open: boolean) => void] {
  const [inner, setInner] = React.useState(false)
  return [open ?? inner, onOpenChange ?? setInner]
}
/** Esc fecha o formulário em que o foco está. */
export const closeOnEscape = (close: () => void) => (event: React.KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); close() } }
