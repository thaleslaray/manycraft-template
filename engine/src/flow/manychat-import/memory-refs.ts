import type { CollectedRefs } from './refs'
import type { FieldKind, RefResolver } from './types'

/** Resolvedor sem banco: ids sintéticos. Serve para testes e para medir cobertura. */
export function memoryResolver(collected: CollectedRefs, imported: Record<string, string> = {}, types: Record<string, FieldKind> = {}): RefResolver {
  return {
    tag: id => `tag:${id}`,
    field: id => ({ id: `field:${id}`, type: types[id] ?? collected.fields.get(id) ?? 'text' }),
    sequence: id => `sequence:${id}`,
    automation: ns => imported[ns] ?? null,
  }
}
