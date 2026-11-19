import { appsMenuHidden, installedTemplatesMenuHidden, integrationsHidden } from "../../lib/hidden-features"
import { roleCan, type Action, type Role } from "../../../../shared/permissions"

/** Seções das Configurações: grupos do menu, rotas e qual seção cada endereço abre. Sem React, para testar sozinho. */
export type SettingsId =
  | "general" | "notices" | "team" | "logs" | "compliance"
  | "inbox" | "assignment"
  | "instagram" | "whatsapp" | "email" | "telegram"
  | "fields" | "tags"
  | "api" | "apps" | "integrations" | "installed"

type Item = { id: SettingsId; title: string; path: string; channel?: ChannelId; needs?: Action }
type Group = { title: string; items: Item[] }
export type ChannelId = "instagram" | "whatsapp" | "email" | "telegram"

/** Menu das Configurações, na ordem do original. Seções que a réplica não tem ficam de fora (cobrança, pagamentos, pixel, eventos). */
export const settingsGroups: Group[] = [
  { title: "Principal", items: [
    { id: "general", title: "Geral", path: "" },
    { id: "notices", title: "Notificações", path: "/notices" },
    { id: "team", title: "Membros da equipe", path: "/team", needs: "team" },
    { id: "logs", title: "Registros", path: "/logs", needs: "automation:read" },
    { id: "compliance", title: "Conformidade", path: "/compliance", needs: "team" },
  ] },
  { title: "Caixa de entrada", items: [
    { id: "inbox", title: "Comportamento da caixa de entrada", path: "/inbox" },
    { id: "assignment", title: "Atribuição automática", path: "/assignment" },
  ] },
  { title: "Canais", items: [
    { id: "instagram", title: "Instagram", path: "/channels/instagram", channel: "instagram" },
    { id: "whatsapp", title: "WhatsApp", path: "/channels/whatsapp", channel: "whatsapp" },
    { id: "email", title: "E-mail", path: "/email", channel: "email" },
    { id: "telegram", title: "Telegram", path: "/channels/telegram", channel: "telegram" },
  ] },
  { title: "Automação", items: [
    { id: "fields", title: "Campos", path: "/fields" },
    { id: "tags", title: "Tags", path: "/tags" },
  ] },
  { title: "Extensões", items: [
    { id: "api", title: "API", path: "/api", needs: "team" },
    ...(appsMenuHidden ? [] : [{ id: "apps" as const, title: "Aplicativos", path: "/apps", needs: "automation:read" as const }]),
    ...(integrationsHidden ? [] : [{ id: "integrations" as const, title: "Integrações", path: "/integrations", needs: "automation:read" as const }]),
    ...(installedTemplatesMenuHidden ? [] : [{ id: "installed" as const, title: "Modelos instalados", path: "/installed", needs: "automation:read" as const }]),
  ] },
]
const allItems = settingsGroups.flatMap(group => group.items)

/** Seção que o papel pode abrir: o motor recusa (403) o que cada papel não pode ler, então o menu esconde essas seções em vez de abrir uma tela com erro. */
export function settingsVisibleTo(role: Role, id: SettingsId): boolean {
  return settingsAllowed(action => roleCan(role, action), id)
}
export function settingsAllowed(can: (action: Action) => boolean, id: SettingsId): boolean {
  const needs = allItems.find(item => item.id === id)?.needs
  return !needs || can(needs)
}

/** Rotas antigas continuam abrindo: modelos de mensagem e tópicos moraram em Canais, a lista única de canais mostra todos. */
const aliases: [RegExp, SettingsId | "channels"][] = [
  [/\/settings\/message-templates$/, "whatsapp"],
  [/\/settings\/topics$/, "email"],
  [/\/settings\/channels$/, "channels"],
  [/\/settings\/fields\/bot$/, "fields"],
  [/\/settings\/team\/groups$/, "team"],
  [/\/settings\/logs\/activity$/, "logs"],
]
export function activeSettings(pathname: string): SettingsId | "channels" {
  for (const [pattern, id] of aliases) if (pattern.test(pathname)) return id
  const hit = [...allItems].sort((a, b) => b.path.length - a.path.length).find(item => item.path && pathname.endsWith(`/settings${item.path}`))
  return hit?.id ?? "general"
}

/** `/settings/channels/<tipo>` com um tipo que a réplica não tem (Messenger, por exemplo) manda para a lista de canais; tipo conhecido ou outro endereço: nada. */
export function unknownChannelRedirect(pathname: string): string | null {
  const hit = /^(.*\/settings\/channels)\/([^/]+)\/?$/.exec(pathname)
  if (!hit) return null
  return allItems.some(item => item.channel && item.path === `/channels/${hit[2]}`) ? null : hit[1]
}
