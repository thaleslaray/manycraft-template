import { apiRequest } from './api'
import type { ContactPage } from './types'
import type { ContactQueryFilter } from '../../../shared/contact-filter'
export type { ContactQueryFilter, ContactFilterRule, FilterOperator } from '../../../shared/contact-filter'
export type Segment = { id: string; name: string; filter: ContactQueryFilter; total: number | null; error?: string; filterKind?: 'general' | 'email' }
export type SegmentOptions = {
  tags: { id: string; name: string }[]
  fields: { id: string; name: string; type: string }[]
  connections: { id: string; label: string }[]
  triggers?: { id: string; name: string }[]
  /** Todas as contas conectadas, com o canal de cada uma. */
  accounts?: { id: string; label: string; channel: string }[]
}
export const emptyContactFilter = (): ContactQueryFilter => ({ match: 'all', rules: [] })
export const listSegments = () => apiRequest<Segment[]>('/segments')
export const getSegment = (id: string) => apiRequest<Segment>(`/segments/${encodeURIComponent(id)}`)
export const getSegmentOptions = () => apiRequest<SegmentOptions>('/segments/options')
export const saveSegment = (name: string, filter: ContactQueryFilter, id?: string) => apiRequest<Segment>(id ? `/segments/${encodeURIComponent(id)}` : '/segments', { method: id ? 'PUT' : 'POST', body: JSON.stringify({ name, filter }) })
export const queryContacts = (filter: ContactQueryFilter, cursor: string | null, search: string) => apiRequest<ContactPage>('/contacts/query', { method: 'POST', body: JSON.stringify({ filter, cursor, search }) })
