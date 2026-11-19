import { apiRequest, isFakeMode } from "./api"

/** Configurações > Geral do espaço, guardadas no motor. */
export type ProfileAnswers = { segment?: string; size?: string; channel?: string; goal: "leads" | "sales" | "support" | "engagement" | "skip" }
export type WorkspaceSettings = { name: string; timezone: string; show_only_subscribed: boolean; hide_keywords_tab: boolean; hide_rules_tab: boolean; import_enabled?: boolean; profile_answers?: ProfileAnswers | null; photo_url?: string | null; description?: string | null }
export type WorkspaceSettingsInput = Partial<Omit<WorkspaceSettings, "photo_url">> & { photo_media_id?: string | null }

let fake: WorkspaceSettings = { name: "Estúdio Aurora", timezone: "America/Sao_Paulo", show_only_subscribed: true, hide_keywords_tab: false, hide_rules_tab: false }
function applyFake(current: WorkspaceSettings, input: WorkspaceSettingsInput): WorkspaceSettings {
  const { photo_media_id, ...rest } = input
  return { ...current, ...rest, ...(photo_media_id === undefined ? {} : { photo_url: photo_media_id ? fakePhotos.get(photo_media_id) ?? null : null }) }
}
const fakePhotos = new Map<string, string>()
let cached: Promise<WorkspaceSettings> | undefined
let loaded: WorkspaceSettings | undefined
const listeners = new Set<() => void>()

export function getWorkspaceSettings(): Promise<WorkspaceSettings> {
  if (isFakeMode()) return Promise.resolve({ ...fake })
  cached ??= apiRequest<WorkspaceSettings>("/workspace-settings").then(value => { loaded = value; return value }).catch(error => { cached = undefined; throw error })
  return cached
}

/** O que já foi carregado, sem esperar: quem monta depois começa com isso e a tela não pisca nem recria o formulário. */
export function peekWorkspaceSettings(): WorkspaceSettings | null {
  return isFakeMode() ? { ...fake } : loaded ?? null
}

export async function saveWorkspaceSettings(input: WorkspaceSettingsInput): Promise<WorkspaceSettings> {
  const next = isFakeMode() ? (fake = applyFake(fake, input)) : await apiRequest<WorkspaceSettings>("/workspace-settings", { method: "PATCH", body: JSON.stringify(input) })
  cached = Promise.resolve(next)
  loaded = next
  for (const listener of listeners) listener()
  return next
}

/** Avisa quem mostra uma preferência (abas, lista de contatos) quando ela muda. */
export function onWorkspaceSettingsChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Envia a foto da conta pelo envio de arquivos do motor; o id vai no PATCH de Configurações. */
export async function uploadAccountPhoto(file: File): Promise<{ id: string }> {
  if (isFakeMode()) { const id = crypto.randomUUID(); fakePhotos.set(id, URL.createObjectURL(file)); return { id } }
  return apiRequest<{ id: string }>(`/media?purpose=account_photo&name=${encodeURIComponent(file.name.slice(0, 255))}`, { method: "POST", headers: { "Content-Type": file.type }, body: file })
}
