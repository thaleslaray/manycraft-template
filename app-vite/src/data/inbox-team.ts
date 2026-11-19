import { apiRequest, isFakeMode } from './api'
import type { InboxMember } from './inbox'
export type InboxSettings = { pause_minutes: number; new_message_behavior: 'any_message' | 'explicit' }
export type SavedReply = { id: string; shortcut: string; body: string }
export type InboxMention = { id: string; conversation_id: string; message_id: string; text: string }
export type InboxContext = { current_member_id: string; can_configure: boolean; members: InboxMember[]; counts: { open: number; mine: number; mentions: number } }
export const getInboxContext = () => apiRequest<InboxContext>('/inbox/context')
let demoSettings: InboxSettings = { pause_minutes: 30, new_message_behavior: 'any_message' }
let demoReplies: SavedReply[] = []
export const getInboxSettings = async () => isFakeMode() ? structuredClone(demoSettings) : apiRequest<InboxSettings>('/inbox/settings')
export const saveInboxSettings = async (input: InboxSettings) => {
  if (isFakeMode()) return structuredClone(demoSettings = input)
  return apiRequest<InboxSettings>('/inbox/settings', { method: 'PUT', body: JSON.stringify(input) })
}
export const listSavedReplies = async () => isFakeMode() ? structuredClone(demoReplies) : apiRequest<SavedReply[]>('/inbox/saved-replies')
export const saveSavedReply = async (input: Omit<SavedReply, 'id'>, id?: string) => {
  if (isFakeMode()) { const row = { ...input, id: id ?? crypto.randomUUID() }; demoReplies = [...demoReplies.filter(r => r.id !== row.id), row]; return row }
  return apiRequest<SavedReply>(`/inbox/saved-replies${id ? `/${encodeURIComponent(id)}` : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(input) })
}
export const deleteSavedReply = async (id: string) => {
  if (isFakeMode()) { demoReplies = demoReplies.filter(r => r.id !== id); return }
  await apiRequest(`/inbox/saved-replies/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
export type InboxLabel = { id: string; name: string; color: string; condition?: unknown; conversations?: number }
/** Etiquetas da caixa de entrada; aqui (e não no componente) para o aquecimento do menu não puxar a tela. */
export function listInboxLabels() { return isFakeMode() ? Promise.resolve([] as InboxLabel[]) : apiRequest<InboxLabel[]>("/inbox/labels") }
export const listInboxMentions = async () => isFakeMode() ? [] : apiRequest<InboxMention[]>('/inbox/mentions')
export const readInboxMention = (id: string) => apiRequest(`/inbox/mentions/${encodeURIComponent(id)}/read`, { method: 'POST', body: '{}' })
