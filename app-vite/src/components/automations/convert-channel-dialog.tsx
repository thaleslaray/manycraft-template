import * as React from "react"
import { toast } from "sonner"
import { apiRequest } from "@/data/api"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { FieldSelect } from "@/components/ui/field-select"

export const convertibleChannels: { value: string; label: string }[] = [
  { value: "instagram", label: "Instagram" }, { value: "messenger", label: "Messenger" }, { value: "whatsapp", label: "WhatsApp" },
  { value: "telegram", label: "Telegram" }, { value: "email", label: "E-mail" }, { value: "tiktok", label: "TikTok" },
]

/** Duplicar e converter: cópia em rascunho sem gatilhos e sem os blocos que o canal escolhido não oferece. */
export function ConvertChannelDialog({ automationId, onClose }: { automationId: string; onClose: () => void }) {
  const [channel, setChannel] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!channel) { setError("Escolha o canal de destino."); return }
    setBusy(true); setError("")
    try {
      const r = await apiRequest<{ id: string; removed: number }>(`/automations/${encodeURIComponent(automationId)}/convert`, { method: "POST", body: JSON.stringify({ channel }) })
      toast.success(`Cópia convertida criada em rascunho${r.removed ? ` (${r.removed} item(ns) incompatível(is) removido(s), incluindo gatilhos)` : ""}.`)
      window.location.assign(`/${window.location.pathname.split("/")[1]}/automations/${r.id}`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível converter."); setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent><form onSubmit={submit} className="space-y-5">
      <DialogHeader><DialogTitle>Duplicar e converter para outro canal</DialogTitle><DialogDescription>Cria uma cópia em rascunho. Os gatilhos e os blocos que o canal escolhido não oferece ficam de fora.</DialogDescription></DialogHeader>
      <FieldSelect id="convert-channel" label="Canal de destino" value={channel} onChange={value => { setChannel(value); setError("") }} options={convertibleChannels} placeholder="Escolha o canal" />
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      <DialogFooter><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancelar</Button><Button type="submit" loading={busy}>Criar cópia convertida</Button></DialogFooter>
    </form></DialogContent>
  </Dialog>
}
