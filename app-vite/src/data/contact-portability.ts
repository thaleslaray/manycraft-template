import { apiRequest } from './api'
import type { ContactDetail } from './types'

export type MergePreview = {
  primary: ContactDetail
  secondary: ContactDetail
  can_merge: boolean
  conflicts: { channel_type: string; primary_connection_name: string | null; secondary_connection_name: string | null }[]
}
const post = <T>(path: string, body: unknown) => apiRequest<T>(path, { method: 'POST', body: JSON.stringify(body) })
export const bulkContactAction = (action: 'pause' | 'unsubscribe', ids: string[], confirmation: string) =>
  post<{ count: number }>(`/contacts/bulk-${action}`, { ids, confirmation })
export const exportContact = (id: string) => apiRequest<Record<string, unknown>>(`/contacts/${encodeURIComponent(id)}/export`)
export const previewContactMerge = (primary_id: string, secondary_id: string) => post<MergePreview>('/contacts/merge-preview', { primary_id, secondary_id })
export const mergeContacts = (primary_id: string, secondary_id: string, confirmation: string) => post('/contacts/merge', { primary_id, secondary_id, confirmation })

export type ContactExportInput = { ids?: string[]; filter?: unknown; search?: string; query?: Record<string, string> }
/** CSV dos contatos escolhidos ou do filtro atual (o motor monta o arquivo; excluídos ficam de fora). */
export const exportContactsCsv = (input: ContactExportInput) => post<{ csv: string; count: number; file_name: string }>('/contacts/export', input)
