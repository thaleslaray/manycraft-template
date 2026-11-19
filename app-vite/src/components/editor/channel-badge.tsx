import { Camera, Clock, GitBranch, Mail, MessageCircle, MessageSquare, MessagesSquare, Music2, Send, Shuffle, Tags, Workflow, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { StepIconKey } from "./connect-drop"

/** Único mapa canal → ícone da tela; o nome do canal vem de `channelLabels` (editor/graph). */
export const channelGlyphs: Record<string, LucideIcon> = { instagram: Camera, whatsapp: MessageCircle, telegram: Send, messenger: MessagesSquare, email: Mail, tiktok: Music2 }
/** Cor do círculo de cada canal, pelos tokens da marca (a mesma das Configurações). */
export const channelTones: Record<string, string> = {
  instagram: "bg-accent-soft text-accent",
  whatsapp: "bg-success-soft text-success",
  email: "bg-warning-soft text-warning",
  telegram: "bg-border/40 text-text",
}
export function ChannelBadge({ channel, className }: { channel?: string | null; className?: string }) {
  const Icon = channelGlyphs[channel ?? ""] ?? MessageSquare
  return <span aria-hidden="true" className={cn("grid size-8 shrink-0 place-items-center rounded-pill bg-accent-soft text-accent", className)}><Icon className="size-4" /></span>
}

/** Ícone e cor de cada item do catálogo de próximo passo: canal com a cor dele; lógica com a cor do cartão do passo no mapa. */
const stepIcons: Record<StepIconKey, { Icon: LucideIcon; tone: string }> = {
  instagram: { Icon: channelGlyphs.instagram, tone: channelTones.instagram },
  whatsapp: { Icon: channelGlyphs.whatsapp, tone: channelTones.whatsapp },
  telegram: { Icon: channelGlyphs.telegram, tone: channelTones.telegram },
  email: { Icon: channelGlyphs.email, tone: channelTones.email },
  message: { Icon: MessageSquare, tone: "bg-accent-soft text-accent" },
  action: { Icon: Tags, tone: "bg-node-action text-warning" },
  condition: { Icon: GitBranch, tone: "bg-node-condition text-text" },
  randomizer: { Icon: Shuffle, tone: "bg-node-ai text-text" },
  smart_delay: { Icon: Clock, tone: "bg-node-delay text-danger" },
  start_automation: { Icon: Workflow, tone: "bg-node-trigger text-success" },
}
export function StepIcon({ icon, className }: { icon: StepIconKey; className?: string }) {
  const { Icon, tone } = stepIcons[icon]
  return <span aria-hidden="true" className={cn("grid size-7 shrink-0 place-items-center rounded-pill", tone, className)}><Icon className="size-3.5" /></span>
}
