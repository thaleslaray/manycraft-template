import { clipboardSchema, type FieldKind, type J } from './types'

export type CollectedRefs = {
  tags: Set<string>
  fields: Map<string, FieldKind>
  sequences: Set<string>
  /** Namespaces de fluxos apontados por nós "goto". */
  automations: Set<string>
}

const isDateOnly = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
/** Tipo do campo pelo que o fluxo faz com ele. Texto vence qualquer dúvida: um número cabe num texto, o contrário não. */
function decide(votes: Set<FieldKind>): FieldKind {
  if (votes.has('text') || !votes.size) return 'text'
  for (const kind of ['datetime', 'date', 'number', 'boolean'] as const) if (votes.has(kind)) return kind
  return 'text'
}

/** Varre o fluxo e lista tudo o que ele cita por número (etiquetas, campos, sequências, outros fluxos). */
export function collectRefs(input: unknown): CollectedRefs {
  const clip = clipboardSchema.parse(input)
  const votes = new Map<string, Set<FieldKind>>()
  const out: CollectedRefs = { tags: new Set(), fields: new Map(), sequences: new Set(), automations: new Set() }
  const vote = (id: unknown, kind?: FieldKind) => {
    if (id == null || id === '') return
    const key = String(id), set = votes.get(key) ?? new Set<FieldKind>()
    if (kind) set.add(kind)
    votes.set(key, set)
  }
  const strings = (value: unknown) => {
    if (typeof value === 'string') for (const m of value.matchAll(/cuf_(\d+)/g)) vote(m[1])
    else if (Array.isArray(value)) value.forEach(strings)
    else if (value && typeof value === 'object') Object.values(value).forEach(strings)
  }
  for (const { node, related } of clip.data.nodesData) {
    const n = node as J
    if (n.nodeType === 'goto' && n.flowId) out.automations.add(String(n.flowId))
    for (const action of (n.items ?? []) as J[]) {
      if (action.type === 'add_tag' || action.type === 'remove_tag') out.tags.add(String(action.tag_id))
      else if (action.type === 'add_to_sequence' || action.type === 'remove_from_sequence') out.sequences.add(String(action.sequence_id))
      else if (action.type === 'set_custom_field_value') {
        vote(action.field_id, action.operation === 'now' ? 'datetime' : action.operation && action.operation !== '=' ? 'number' : typeof action.value === 'number' ? 'number' : 'text')
      } else if (action.type === 'unset_custom_field_value') vote(action.field_id)
      else if (action.type === 'external_request') for (const m of (action.mapping ?? []) as J[]) vote(m.field_id, 'text')
    }
    for (const block of related.blocks as J[]) {
      if (block.type === 'question' && block.customFieldId != null) {
        vote(block.customFieldId, block.replyType === 'number' ? 'number' : ['date', 'datetime'].includes(block.replyType) ? 'date' : 'text')
      }
      for (const group of block.filter?.groups ?? []) for (const item of group.items ?? [] as J[]) {
        if (item.type === 'tag' && item.value != null) out.tags.add(String(item.value))
        const cuf = item.type === 'cuf' ? /^cuf_(\d+)$/.exec(String(item.field)) : null
        if (!cuf) continue
        const op = String(item.operator)
        vote(cuf[1], ['GREATER_THAN', 'GREATER_THAN_OR_EQUAL', 'LESS_THAN', 'LESS_THAN_OR_EQUAL'].includes(op) ? 'number'
          : op === 'TRUE' || op === 'FALSE' ? 'boolean'
          : ['ON', 'BEFORE', 'AFTER'].includes(op) ? (isDateOnly(item.value) ? 'date' : 'datetime') : undefined)
      }
    }
    strings(n); strings(related)
  }
  for (const [id, set] of votes) out.fields.set(id, decide(set))
  return out
}
