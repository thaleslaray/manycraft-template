import { apiRequest } from "./api"

export type BasicKind = "default_reply" | "welcome_message" | "system_opt_in" | "system_opt_out"
export type BasicEntry = {
  connection_id: string
  kind: BasicKind
  automation_id: string
  automation_name: string
  enabled: boolean
  repeat_mode: "every_time" | "once_per_24_hours"
  dm_only: boolean
}
export type BasicConnection = {
  id: string
  displayName: string
  profile: { inbound: { message: boolean; storyReply: boolean }; conversationStarters?: { maxItems: number; titleMax: number } | null; mainMenu?: { maxItems: number; titleMax: number } | null }
}
export type BasicSettings = { connections: BasicConnection[]; entries: BasicEntry[] }
export type BasicInput = Pick<BasicEntry, "automation_id" | "enabled" | "repeat_mode" | "dm_only">

// Basic sempre lê o estado persistido no motor, inclusive no painel de demonstração.
export function getBasicSettings(): Promise<BasicSettings> {
  return apiRequest("/basic")
}
export function saveBasicEntry(connectionId: string, kind: BasicKind, input: BasicInput): Promise<BasicEntry> {
  const { automation_id, enabled, repeat_mode, dm_only } = input
  return apiRequest(`/basic/${encodeURIComponent(connectionId)}/${kind}`, {
    method: "PUT", body: JSON.stringify({ automation_id, enabled, repeat_mode, dm_only }),
  })
}

export type SurfaceKind = "conversation_starters" | "main_menu"
export type SurfaceItem = { id: string; title: string; automation_id: string; payload?: string }
export type SurfaceConfig = { enabled: boolean; items: SurfaceItem[] }
export type SurfaceSettings = { can_edit: boolean; draft: SurfaceConfig; published: SurfaceConfig | null; published_at: number | null; publishing: boolean; clicks: Record<string, number> }
export function getSurface(connection: string, kind: SurfaceKind): Promise<SurfaceSettings> {
  return apiRequest(`/basic/${encodeURIComponent(connection)}/surfaces/${kind}`)
}
export function saveSurface(connection: string, kind: SurfaceKind, input: SurfaceConfig): Promise<SurfaceSettings> {
  return apiRequest(`/basic/${encodeURIComponent(connection)}/surfaces/${kind}`, { method: "PUT", body: JSON.stringify({ enabled: input.enabled, items: input.items.map(({ id, title, automation_id }) => ({ id, title, automation_id })) }) })
}
export function publishSurface(connection: string, kind: SurfaceKind): Promise<SurfaceSettings> {
  return apiRequest(`/basic/${encodeURIComponent(connection)}/surfaces/${kind}/publish`, { method: "POST" })
}
