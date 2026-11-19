import { cn } from "@/lib/utils"
import type { Broadcast, BroadcastAudience } from "@/data/broadcasts"
import type { Graph } from "@/data/types"

export const channelLabel = (channel: BroadcastAudience["channel"]) => ({ telegram: "Telegram", instagram: "Instagram", whatsapp: "WhatsApp", messenger: "Messenger", email: "E-mail", tiktok: "TikTok" })[channel]

export function MessagePreview({ content, channel }: { content: string; channel: BroadcastAudience["channel"] }) {
  return <section aria-label="Prévia da mensagem" className="min-w-0 space-y-2 rounded-lg bg-bg p-4"><h3 className="text-xs font-medium text-text-muted">Prévia · {channelLabel(channel)}</h3><p className="whitespace-pre-wrap wrap-anywhere rounded-md border border-border bg-surface p-3 text-sm">{content || "Sua mensagem aparece aqui enquanto você escreve."}</p></section>
}

export function GraphPreview({ graph, label }: { graph: Graph; label: string }) {
  return <section aria-label={label} className="min-w-0 space-y-3 rounded-lg bg-surface-muted p-4"><h3 className="text-sm font-semibold">{label}</h3>{graph.nodes.filter(node => !["trigger", "start"].includes(node.type)).map(node => <div key={node.id} className="space-y-2 rounded-lg border border-border bg-surface p-3 text-sm"><p className="text-xs text-text-muted">{node.type === "message" ? "Mensagem" : "Etapa da automação"}</p>{Array.isArray(node.config.blocks) ? (node.config.blocks as { kind: string; text?: string; label?: string }[]).map((block, i) => <p key={i} className={cn("whitespace-pre-wrap wrap-anywhere", block.kind === "button" && "rounded border border-border p-2 text-center text-accent")}>{block.text ?? block.label ?? "Conteúdo da etapa"}</p>) : <p>{"Etapa configurada"}</p>}</div>)}</section>
}

export function BroadcastProgress({ metrics }: { metrics: Broadcast["metrics"] }) {
  const total = metrics?.total ?? ((metrics?.sent ?? 0) + (metrics?.queued ?? 0) + (metrics?.skipped ?? 0) + (metrics?.failed ?? 0) + (metrics?.uncertain ?? 0))
  const processed = Math.max(0, total - (metrics?.queued ?? 0))
  const percent = total ? Math.round(processed / total * 100) : 0
  return <div className="space-y-1"><div className="flex justify-between text-xs text-text-muted"><span>{processed} de {total} destinatários processados</span><span>{percent}%</span></div><progress aria-label="Progresso da transmissão" max={Math.max(1, total)} value={processed} className="h-2 w-full appearance-none overflow-hidden rounded-pill bg-border [&::-webkit-progress-bar]:bg-border [&::-webkit-progress-value]:bg-accent [&::-moz-progress-bar]:bg-accent" /></div>
}


