import * as React from "react"
import { apiRequest, isFakeMode } from "@/data/api"
import { useAsync } from "@/hooks/use-async"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"

type ChannelType = "telegram" | "instagram" | "messenger" | "whatsapp" | "tiktok" | "email"
type Profile = { text: { maxLength: number; unit: string }; buttons?: { maxPerMessage: number; titleMax: number } | null; quickReplies?: { max: number } | null; cards?: { maxCards: number } | null; list?: unknown; media?: { image?: unknown; video?: unknown; audio?: unknown; file?: unknown } | null; typing?: { maxSeconds: number } | null; window?: { standardHours: number } | null }
const names: Record<ChannelType, string> = { telegram: "Telegram", instagram: "Instagram", messenger: "Messenger", whatsapp: "WhatsApp", tiktok: "TikTok", email: "E-mail" }
const yes = (v: unknown, detail?: string) => v ? (detail ?? "Sim") : "Não"

/** Tabela de compatibilidade: o que cada canal aceita em uma mensagem (o motor adapta ou recusa na publicação). */
/** Sem `onOpenChange`, mostra o próprio botão; com ele, quem abre é o menu de ações do editor. */
export function ChannelCompatibility({ open: controlled, onOpenChange }: { open?: boolean; onOpenChange?: (open: boolean) => void } = {}) {
  const [inner, setInner] = React.useState(false)
  const open = controlled ?? inner, setOpen = onOpenChange ?? setInner
  const data = useAsync(() => !open || isFakeMode() ? Promise.resolve([]) : apiRequest<{ channels: { kind: ChannelType; profile: Profile }[] }>("/connections/capabilities").then(r => r.channels), `caps|${open}`)
  const rows = (data.data ?? []).map(c => ({ k: c.kind, p: c.profile }))
  const lines: [string, (p: Profile) => string][] = [
    ["Texto (máximo)", p => `${p.text.maxLength.toLocaleString("pt-BR")} ${p.text.unit === "bytes" ? "bytes" : "caracteres"}`],
    ["Botões por mensagem", p => p.buttons ? `${p.buttons.maxPerMessage} (título até ${p.buttons.titleMax})` : "Não"],
    ["Respostas rápidas", p => p.quickReplies ? `Até ${p.quickReplies.max}` : "Não"],
    ["Cartões e galeria", p => p.cards ? `Até ${p.cards.maxCards} cartões` : "Não"],
    ["Lista", p => yes(p.list)],
    ["Imagem", p => yes(p.media?.image)],
    ["Vídeo", p => yes(p.media?.video)],
    ["Áudio", p => yes(p.media?.audio)],
    ["Arquivo", p => yes(p.media?.file)],
    ["Digitando…", p => p.typing ? `Até ${p.typing.maxSeconds} s` : "Não"],
    ["Janela de resposta", p => p.window ? `${p.window.standardHours} h` : "Sem janela"],
  ]
  return <>
    {onOpenChange ? null : <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Compatibilidade por canal</Button>}
    {open ? <Dialog open onOpenChange={setOpen}><DialogContent className="max-w-4xl">
      <DialogHeader><DialogTitle>Compatibilidade de blocos por canal</DialogTitle><DialogDescription>O que cada canal aceita. Na publicação, bloco sem suporte na conexão do gatilho vira aviso.</DialogDescription></DialogHeader>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm">
        <thead><tr className="border-b border-border"><th className="py-2 pr-3">Bloco</th>{rows.map(r => <th key={r.k} className="py-2 pr-3">{names[r.k]}</th>)}</tr></thead>
        <tbody>{lines.map(([label, cell]) => <tr key={label} className="border-b border-border last:border-0"><th className="py-2 pr-3 font-medium">{label}</th>{rows.map(r => <td key={r.k} className="py-2 pr-3 text-text-muted">{cell(r.p)}</td>)}</tr>)}</tbody>
      </table></div>
    </DialogContent></Dialog> : null}
  </>
}
