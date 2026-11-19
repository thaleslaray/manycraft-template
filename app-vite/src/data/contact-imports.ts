import { apiRequest } from './api'
import type { Contact } from './types'
export { parseContactCsv } from '../../../shared/contact-csv'

export function createContact(input: { first_name: string; last_name: string; phone: string; email: string }): Promise<Contact> {
  return apiRequest('/contacts', { method: 'POST', body: JSON.stringify(input) })
}

export type ContactImport = {
  id: string; file_name: string; status: 'uploading' | 'queued' | 'processing' | 'completed' | 'failed'; total: number
  processed: number; created: number; updated: number; ignored: number; error: string | null
  ignored_rows: { line: number; reason: string }[]
}
export type ImportField = { id: string; name: string; scope: string; type: string; archived: boolean }
export function listImportFields(): Promise<ImportField[]> { return apiRequest('/fields') }
export function startContactImport(input: { csv: string; file_name: string; mapping: Record<string, number>; consent: true; tag_ids: string[] }): Promise<ContactImport> {
  return apiRequest('/contact-imports', { method: 'POST', body: JSON.stringify(input) })
}
export function getContactImport(id: string): Promise<ContactImport> { return apiRequest(`/contact-imports/${encodeURIComponent(id)}`) }
export function retryContactImport(id: string): Promise<ContactImport> {
  return apiRequest(`/contact-imports/${encodeURIComponent(id)}/retry`, { method: 'POST' })
}
