import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { PENDING_CHANNEL, stepChannelLabels, type StepChannel } from "./step-channel"

/** Primeira pergunta ao criar um passo de mensagem: por qual canal ele vai. Só entram canais ativos com conexão ligada. */
export function StepChannelDialog({ channels, loading, onPick, onCancel }: { channels: StepChannel[]; loading: boolean; onPick: (channel: StepChannel | typeof PENDING_CHANNEL) => void; onCancel: () => void }) {
  return (
    <Dialog open onOpenChange={open => { if (!open) onCancel() }}>
      <DialogContent aria-describedby="step-channel-help">
        <DialogHeader>
          <DialogTitle>Por qual canal vai esta mensagem?</DialogTitle>
          <DialogDescription id="step-channel-help">O passo mostra só o que o canal escolhido aceita. Quem chega por outro canal não recebe este passo.</DialogDescription>
        </DialogHeader>
        {loading ? <p role="status" className="text-sm text-text-muted">Carregando as conexões…</p>
          : channels.length ? <ul className="grid gap-2" aria-label="Canais disponíveis">
            {channels.map(channel => <li key={channel}><Button className="w-full justify-start" variant="secondary" onClick={() => onPick(channel)}>{stepChannelLabels[channel]}</Button></li>)}
          </ul> : <p role="status" className="text-sm text-text-muted">Nenhuma conexão ligada. Ligue um canal em Conexões, ou crie o passo agora e escolha o canal depois.</p>}
        <div className="flex justify-end gap-2">
          {!loading && !channels.length ? <Button variant="secondary" onClick={() => onPick(PENDING_CHANNEL)}>Escolher depois</Button> : null}
          <Button variant="ghost" onClick={onCancel}>Cancelar</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
