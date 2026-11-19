import { getWorkspaceSettings, saveWorkspaceSettings } from "./workspace-settings"
import { apiRequest, isFakeMode } from "./api"
import { roles, type Role } from "../../../shared/permissions"
/** Campos e tags usam o motor; demais preferências mantêm o modo de estudo. */
export type SettingsSection = "integrations" | "logs" | "inbox" | "general" | "channels" | "message-templates" | "fields" | "tags" | "team" | "api"
/** Os papéis do motor (shared/permissions.ts); o modo de estudo não inventa outros. */
export type SettingsRole = Role
export type SettingsKind = "fields" | "tags"
export type SettingsFieldType = "text" | "number" | "date" | "datetime" | "boolean" | "array"
export type SettingsFolder = { id: string; name: string; kind: SettingsKind }
export type SettingsItem = { id: string; name: string; folder_id: string | null; kind: SettingsKind; field_type: SettingsFieldType; scope: "contact" | "bot"; contact_count: number; archived?: boolean; description?: string | null }
export type SettingsMember = { id: string; name: string; email: string; role: SettingsRole; status: "active" | "invited" }
export type SettingsSnapshot = {
  general: { name: string; timezone: string }
  folders: SettingsFolder[]
  items: SettingsItem[]
  members: SettingsMember[]
  api: { last4: string; created_at: string } | null
}
const stores = new Map<string, SettingsSnapshot>()
const clone = <T>(value: T): T => structuredClone(value)
const newId = () => crypto.randomUUID()
const named = (value: string) => {
  const name = value.trim()
  if (!name || name.length > 120) throw new Error("Use um nome de 1 a 120 caracteres.")
  return name
}
function state(workspaceId: string) {
  if (!workspaceId.trim()) throw new Error("Espaço de trabalho inválido.")
  let value = stores.get(workspaceId)
  if (!value) {
    const demo = workspaceId === "demo"
    value = {
      general: { name: demo ? "Estúdio Aurora" : "Meu espaço de trabalho", timezone: "America/Sao_Paulo" },
      folders: demo ? [{ id: "folder-sales", name: "Relacionamento com clientes e acompanhamento de novos negócios", kind: "tags" }, { id: "folder-profile", name: "Perfil do contato", kind: "fields" }] : [],
      items: demo ? [
        { id: "tag-client", name: "Cliente recorrente", kind: "tags", folder_id: "folder-sales", field_type: "text", scope: "contact", contact_count: 128 },
        { id: "tag-interest", name: "Interesse em consultoria", kind: "tags", folder_id: null, field_type: "text", scope: "contact", contact_count: 46 },
        { id: "field-city", name: "Cidade de residência", kind: "fields", folder_id: "folder-profile", field_type: "text", scope: "contact", contact_count: 80 },
        { id: "field-hours", name: "Horário da equipe", kind: "fields", folder_id: null, field_type: "text", scope: "bot", contact_count: 0 },
      ] : [],
      members: [{ id: "owner", name: "Responsável pelo espaço", email: "responsavel@exemplo.com", role: "owner", status: "active" }, ...(demo ? [{ id: "member-ana", name: "Ana Ribeiro", email: "ana@exemplo.com", role: "editor" as const, status: "active" as const }] : [])],
      api: null,
    }
    stores.set(workspaceId, value)
  }
  return value
}
async function tick() { await Promise.resolve() }
/** Cada tela pede só o que mostra; sem `parts`, busca tudo. */
export type SettingsPart = "general" | "fields" | "tags" | "fieldFolders" | "tagFolders" | "api"
export async function getSettings(workspaceId: string, parts?: readonly SettingsPart[]): Promise<SettingsSnapshot> {
  await tick()
  const snapshot = clone(state(workspaceId))
  if (!isFakeMode()) {
    type EngineItem = { id: string; name: string; folder_id: string | null; archived: boolean; type?: SettingsFieldType; scope?: SettingsItem["scope"]; contact_count?: number; description?: string | null }
    const want = (part: SettingsPart) => !parts || parts.includes(part)
    const none = Promise.resolve([] as never[])
    const [fields, tags, fieldFolders, tagFolders, key, general] = await Promise.all([
      want("fields") ? apiRequest<EngineItem[]>("/fields") : none,
      want("tags") ? apiRequest<EngineItem[]>("/tags") : none,
      want("fieldFolders") ? apiRequest<SettingsFolder[]>("/settings-folders?kind=fields") : none,
      want("tagFolders") ? apiRequest<SettingsFolder[]>("/settings-folders?kind=tags") : none,
      want("api") ? apiRequest<{ last4: string; created_at: number } | null>("/api-keys").catch(() => null) : Promise.resolve(null),
      want("general") ? getWorkspaceSettings() : Promise.resolve(null),
    ])
    if (want("api")) snapshot.api = key && typeof key.last4 === "string" && Number.isFinite(key.created_at) ? { last4: key.last4, created_at: new Date(key.created_at).toISOString() } : null
    if (general) snapshot.general = { name: general.name, timezone: general.timezone }
    snapshot.folders = [...fieldFolders, ...tagFolders]
    snapshot.items = [
      ...fields.map(row => ({ ...row, kind: "fields" as const, field_type: row.type ?? "text", scope: row.scope ?? "contact", contact_count: row.contact_count ?? 0 })),
      ...tags.map(row => ({ ...row, kind: "tags" as const, field_type: "text" as const, scope: "contact" as const, contact_count: row.contact_count ?? 0 })),
    ]
  }
  return snapshot
}
export async function updateGeneralSettings(workspaceId: string, input: SettingsSnapshot["general"]) {
  if (!isFakeMode()) { await saveWorkspaceSettings(input); return }
  await tick()
  try { new Intl.DateTimeFormat("pt-BR", { timeZone: input.timezone }).format() } catch { throw new Error("Escolha um fuso horário válido.") }
  state(workspaceId).general = { name: named(input.name), timezone: input.timezone }
}
export async function saveSettingsFolder(workspaceId: string, kind: SettingsKind, name: string, id?: string) {
  if (!isFakeMode()) return apiRequest(`/settings-folders${id ? `/${encodeURIComponent(id)}` : ""}`, { method: id ? "PATCH" : "POST", body: JSON.stringify(id ? { name } : { kind, name }) })
  await tick()
  const db = state(workspaceId)
  const nextName = named(name)
  if (db.folders.some((row) => row.kind === kind && row.id !== id && row.name.toLocaleLowerCase() === nextName.toLocaleLowerCase())) throw new Error("Já existe uma pasta com esse nome.")
  if (id) {
    const row = db.folders.find((folder) => folder.id === id && folder.kind === kind)
    if (!row) throw new Error("Pasta não encontrada.")
    row.name = nextName
  } else db.folders.push({ id: newId(), name: nextName, kind })
}
export async function deleteSettingsFolder(workspaceId: string, kind: SettingsKind, id: string) {
  if (!isFakeMode()) return apiRequest(`/settings-folders/${encodeURIComponent(id)}`, { method: "DELETE" })
  await tick()
  const db = state(workspaceId)
  if (!db.folders.some((row) => row.id === id && row.kind === kind)) throw new Error("Pasta não encontrada.")
  db.folders = db.folders.filter((row) => row.id !== id)
  db.items.filter((row) => row.kind === kind && row.folder_id === id).forEach((row) => { row.folder_id = null })
}
export async function saveSettingsItem(workspaceId: string, input: Omit<SettingsItem, "id" | "contact_count">, id?: string) {
  if (!isFakeMode()) {
    const body = { name: input.name, folder_id: input.folder_id, ...(input.kind === "fields" && input.description !== undefined ? { description: input.description?.trim() || null } : {}), ...(!id && input.kind === "fields" ? { type: input.field_type, scope: input.scope } : {}) }
    return apiRequest(`/${input.kind}${id ? `/${encodeURIComponent(id)}` : ""}`, { method: id ? "PATCH" : "POST", body: JSON.stringify(body) })
  }
  await tick()
  const db = state(workspaceId)
  const name = named(input.name)
  if (input.folder_id && !db.folders.some((folder) => folder.id === input.folder_id && folder.kind === input.kind)) throw new Error("Escolha uma pasta desta seção.")
  if (!["text", "number", "date", "datetime", "boolean", "array"].includes(input.field_type) || !["contact", "bot"].includes(input.scope)) throw new Error("Tipo de campo inválido.")
  if (db.items.some((row) => row.kind === input.kind && row.id !== id && row.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error("Já existe um item com esse nome.")
  if (id) {
    const row = db.items.find((item) => item.id === id && item.kind === input.kind)
    if (!row) throw new Error("Item não encontrado.")
    Object.assign(row, clone(input), { name })
  } else db.items.push({ ...clone(input), name, id: newId(), contact_count: 0 })
}
export async function archiveSettingsItem(workspaceId: string, kind: SettingsKind, id: string, archived: boolean) {
  if (!isFakeMode()) return apiRequest(`/${kind}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ archived }) })
  const item = state(workspaceId).items.find(row => row.id === id && row.kind === kind)
  if (!item) throw new Error("Item não encontrado.")
  item.archived = archived
}
export async function getSettingsFieldUsage(_workspaceId: string, id: string): Promise<{ automations: { id: string; name: string }[] }> {
  return isFakeMode() ? { automations: [] } : apiRequest(`/fields/${encodeURIComponent(id)}/usage`)
}
export async function deleteSettingsItem(workspaceId: string, kind: SettingsKind, id: string, confirmed = false) {
  if (!isFakeMode()) return apiRequest(`/${kind}/${encodeURIComponent(id)}${kind === "fields" && confirmed ? "?confirm=true" : ""}`, { method: "DELETE" })
  await tick()
  const db = state(workspaceId)
  if (!db.items.some((row) => row.id === id && row.kind === kind)) throw new Error("Item não encontrado.")
  db.items = db.items.filter((row) => row.id !== id)
}
export async function inviteSettingsMember(workspaceId: string, email: string, role: Exclude<SettingsRole, "owner">) {
  await tick()
  const db = state(workspaceId)
  const address = email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error("Informe um e-mail válido.")
  if ((role as Role) === "owner" || !roles.includes(role)) throw new Error("Escolha um papel válido para o convite.")
  if (db.members.some((member) => member.email === address)) throw new Error("Este e-mail já está na equipe ou possui convite.")
  db.members.push({ id: newId(), name: address.split("@")[0], email: address, role, status: "invited" })
}
export async function changeSettingsRole(workspaceId: string, memberId: string, role: SettingsRole) {
  await tick()
  const db = state(workspaceId)
  const member = db.members.find((row) => row.id === memberId)
  if (!member || !roles.includes(role)) throw new Error("Membro ou papel inválido.")
  if (member.role === "owner" && role !== "owner") throw new Error("Transfira a propriedade a um membro ativo antes de alterar o responsável.")
  if (role === "owner") {
    if (member.status !== "active") throw new Error("A propriedade só pode ser transferida para um membro ativo.")
    db.members.filter((row) => row.role === "owner").forEach((row) => { row.role = "administrator" })
  }
  member.role = role
}
export async function generateSettingsToken(workspaceId: string): Promise<string> {
  if (!isFakeMode()) return (await apiRequest<{ token: string }>("/api-keys", { method: "POST" })).token
  await tick()
  const db = state(workspaceId)
  const token = `estudo_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`
  db.api = { last4: token.slice(-4), created_at: new Date().toISOString() }
  return token
}
export async function revokeSettingsToken(workspaceId: string) {
  if (!isFakeMode()) { await apiRequest("/api-keys", { method: "DELETE" }); return }
  await tick(); state(workspaceId).api = null
}
