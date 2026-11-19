import { NavLink, useLocation, useNavigate, useParams } from "react-router"
import { Camera, Mail, MessageCircle, Send } from "lucide-react"
import { cn } from "@/lib/utils"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { settingsGroups, activeSettings, type ChannelId, type SettingsId } from "./settings-sections"
import { useRole } from "@/hooks/use-role"
import { roleCan } from "../../../../shared/permissions"
import { primeSettingsTab } from "./settings-prime"
import { channelTones } from "@/components/editor/channel-badge"
export { activeSettings, unknownChannelRedirect, type SettingsId, type ChannelId } from "./settings-sections"

const channelGlyph = { instagram: Camera, whatsapp: MessageCircle, email: Mail, telegram: Send } as const
export const channelNames: Record<ChannelId, string> = { instagram: "Instagram", whatsapp: "WhatsApp", email: "E-mail", telegram: "Telegram" }

/** Contas na ordem do menu de canais (Instagram, WhatsApp, E-mail, Telegram); o que não é canal do menu vai para o fim. */
export function byChannelOrder<T extends { channel: string }>(accounts: T[]): T[] {
  const order = Object.keys(channelNames), rank = (channel: string) => { const at = order.indexOf(channel); return at < 0 ? order.length : at }
  return [...accounts].sort((a, b) => rank(a.channel) - rank(b.channel))
}

/** Ícone do canal em círculo colorido pelos tokens da marca. */
export function ChannelIcon({ channel, className }: { channel: ChannelId; className?: string }) {
  const Glyph = channelGlyph[channel]
  return <span aria-hidden="true" className={cn("grid shrink-0 place-items-center rounded-full", channelTones[channel], className ?? "size-5")}><Glyph className="size-[60%]" /></span>
}

export function SettingsNav({ visible }: { visible: (id: SettingsId) => boolean }) {
  const { workspace = "demo" } = useParams()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const active = activeSettings(pathname)
  const groups = settingsGroups.map(group => ({ ...group, items: group.items.filter(item => visible(item.id)) })).filter(group => group.items.length)
  const flat = groups.flatMap(group => group.items)
  const role = useRole()
  // Mouse em cima, foco do teclado ou toque: o dado da aba começa a vir antes do clique.
  const prime = (id: SettingsId) => { if (id !== active) primeSettingsTab(id, workspace, action => roleCan(role, action)) }
  return <>
    <div className="flex items-center gap-3 md:hidden">
      <Label htmlFor="settings-section">Seção</Label>
      <Select value={active} onValueChange={id => navigate(`/${workspace}/settings${id === "channels" ? "/channels" : flat.find(item => item.id === id)?.path ?? ""}`)}>
        <SelectTrigger id="settings-section" className="w-auto min-w-44"><SelectValue /></SelectTrigger>
        <SelectContent>{active === "channels" ? <SelectItem value="channels">Canais</SelectItem> : null}{flat.map(({ id, title }) => <SelectItem key={id} value={id}>{title}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    <nav aria-label="Seções de configurações" className="hidden w-44 shrink-0 space-y-7 md:block md:self-start">
      {groups.map(group => <div key={group.title}>
        <p className="pb-1.5 text-base font-semibold">{group.title}</p>
        <ul>{group.items.map(({ id, title, path, channel }) => <li key={id}>
          <NavLink to={`/${workspace}/settings${path}`} end aria-current={id === active ? "page" : undefined} onMouseEnter={() => prime(id)} onFocus={() => prime(id)} onPointerDown={() => prime(id)}
            className={cn("flex items-center gap-2 py-1.5 text-sm leading-5 transition-colors hover:text-text", id === active ? "font-medium text-accent" : "text-text-muted")}>
            {channel ? <ChannelIcon channel={channel} className="size-5" /> : null}{title}
          </NavLink>
        </li>)}</ul>
      </div>)}
    </nav>
  </>
}
