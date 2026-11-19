import { manychatOptAction } from '../../channels/manychat-nodes'
import { optActionTypes } from '../../schemas/actions'
import { translateVariables, type VarHooks } from './vars'
import type { J, RefResolver } from './types'

export type ActionOutcome = { actions: J[]; unsupported: string[]; notes: { code: string; message: string; level: 'loss' | 'attention' }[] }
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

/** Itens de um actionGroup -> ações nossas na ordem original. O que não tem equivalente volta em `unsupported` com o rótulo do tipo. */
export function translateActions(items: J[], orderedIds: unknown, refs: RefResolver, hooks: VarHooks): ActionOutcome {
  const order = Array.isArray(orderedIds) ? orderedIds.map(String) : []
  const sorted = order.length ? [...items].sort((a, b) => (order.indexOf(a._oid) + 1 || 1e9) - (order.indexOf(b._oid) + 1 || 1e9)) : items
  const out: ActionOutcome = { actions: [], unsupported: [], notes: [] }
  const text = (value: unknown) => translateVariables(String(value ?? ''), hooks)
  for (const a of sorted) {
    const type = String(a.type)
    const opt = manychatOptAction(type)
    if (opt && (optActionTypes as readonly string[]).includes(opt)) out.actions.push({ type: opt })
    else if (type === 'add_tag' || type === 'remove_tag') out.actions.push({ type, tag_id: refs.tag(String(a.tag_id)) })
    else if (type === 'add_to_sequence' || type === 'remove_from_sequence') out.actions.push({ type, sequence_id: refs.sequence(String(a.sequence_id)) })
    else if (type === 'unset_custom_field_value') out.actions.push({ type, field_id: refs.field(String(a.field_id)).id })
    else if (type === 'set_custom_field_value') {
      const op = a.operation ?? '='
      if (op !== '=') { out.unsupported.push(`set_custom_field_value[${op}]`); continue }
      const field = refs.field(String(a.field_id))
      let value: unknown = typeof a.value === 'string' ? text(a.value) : a.value
      if (field.type === 'number') {
        const n = Number(value)
        if (value === '' || !Number.isFinite(n)) { out.unsupported.push('set_custom_field_value[valor não numérico]'); continue }
        value = n
      } else if (field.type === 'boolean') value = ['true', 'on', '1', 'yes'].includes(String(value).toLowerCase())
      else if (field.type === 'text') value = String(value ?? '')
      out.actions.push({ type, field_id: field.id, value })
    } else if (type === 'open_conversation' || type === 'close_conversation') out.actions.push({ type })
    else if (type === 'assign_conversation') {
      out.actions.push({ type, assignee_id: '' })
      out.notes.push({ level: 'attention', code: 'assign_member', message: 'Atribuir conversa: escolha a pessoa responsável (os usuários da ManyChat não existem aqui).' })
    } else if (type === 'notify_admin') out.actions.push({ type, message: text(a.text) || 'Aviso do fluxo importado' })
    else if (type === 'fire_custom_event') {
      out.actions.push({ type, event_name: `Evento importado ${a.event_id}`, ...(typeof a.cost === 'number' && a.cost >= 0 ? { value: a.cost } : {}) })
      out.notes.push({ level: 'attention', code: 'event_name', message: `Evento ${a.event_id}: o nome não veio na exportação; renomeie.` })
    } else if (type === 'external_request') {
      const method = String(a.method ?? 'GET').toUpperCase()
      if (!methods.has(method)) { out.unsupported.push(`external_request[${method}]`); continue }
      const raw = a.headers && !Array.isArray(a.headers) ? Object.entries(a.headers as Record<string, unknown>) : ((a.headers ?? []) as J[]).map(h => [h.name, h.value] as const)
      const headers = raw.filter(([name]) => /^[A-Za-z0-9-]{1,100}$/.test(String(name))).map(([name, value]) => ({ name: String(name), value: text(value) }))
      if (a.payload && a.content_type && !headers.some(h => h.name.toLowerCase() === 'content-type')) headers.push({ name: 'Content-Type', value: String(a.content_type) })
      if (headers.some(h => /^authorization$/i.test(h.name))) out.notes.push({ level: 'attention', code: 'request_credential', message: 'Requisição externa com cabeçalho Authorization copiado da ManyChat: confira se a credencial deve ir junto.' })
      out.actions.push({ type, method, url: text(a.url), headers, ...(a.payload ? { body: text(a.payload) } : {}),
        mappings: ((a.mapping ?? []) as J[]).filter(m => m.field_id != null && m.path).map(m => ({ path: String(m.path), field_id: refs.field(String(m.field_id)).id })) })
      if (a.async === true) out.notes.push({ level: 'attention', code: 'request_async', message: 'Requisição externa assíncrona na origem: aqui ela espera a resposta.' })
    } else out.unsupported.push(type === 'integration_request' ? `integration_request[${a.integration}]` : type)
  }
  return out
}
