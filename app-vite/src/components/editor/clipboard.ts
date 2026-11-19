/** Copiar, colar e desfazer no mapa: lógica pura, sem React, para o editor e para os testes. */
type ClipNode = { id: string; type?: string; position: { x: number; y: number }; data: unknown; selected?: boolean; [key: string]: unknown }
type ClipEdge = { id: string; source: string; target: string; sourceHandle?: string | null; [key: string]: unknown }
export type Clip<N extends ClipNode = ClipNode, E extends ClipEdge = ClipEdge> = { nodes: N[]; edges: E[]; refs?: Record<string, ClipRef> }

/** Etiquetas, campos e sequências citados pelos passos: o nome viaja junto para colar em outra conta. */
export type RefKind = "tag" | "field" | "sequence"
export type ClipRef = { kind: RefKind; name: string }
export type RefCatalogs = Record<RefKind, { id: string; name: string }[]>
const REF_KEYS: Record<string, RefKind> = { tag_id: "tag", tag_ids: "tag", field_id: "field", sequence_id: "sequence" }
const REF_LABEL: Record<RefKind, string> = { tag: "tag", field: "campo", sequence: "sequência" }

/** Percorre os dados dos passos trocando cada id citado (tag_id, tag_ids, field_id, sequence_id) pelo que `swap` devolver. */
function walkRefs(value: unknown, swap: (kind: RefKind, id: string) => string): unknown {
  if (Array.isArray(value)) return value.map(v => walkRefs(v, swap))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, v]) => {
    const kind = REF_KEYS[key]
    if (kind && typeof v === "string") return [key, v ? swap(kind, v) : v]
    if (kind && Array.isArray(v)) return [key, v.map(x => typeof x === "string" && x ? swap(kind, x) : x)]
    return [key, walkRefs(v, swap)]
  }))
}

/** Na cópia: guarda o nome de cada etiqueta, campo e sequência citado (ids fora do catálogo, como campos do sistema, ficam de fora). */
export function collectRefs(nodes: ClipNode[], catalogs: RefCatalogs): Record<string, ClipRef> {
  const refs: Record<string, ClipRef> = {}
  for (const n of nodes) walkRefs(n.data, (kind, id) => {
    const item = catalogs[kind].find(x => x.id === id)
    if (item) refs[id] = { kind, name: item.name }
    return id
  })
  return refs
}

/**
 * Ao colar: id que existe neste espaço fica; id de outro espaço vira o item de mesmo nome (sem diferenciar maiúsculas);
 * sem par, o id fica (a validação do editor aponta o passo) e o nome volta em `missing` para avisar.
 */
export function remapRefs<N extends ClipNode, E extends ClipEdge>(clip: Clip<N, E>, catalogs: RefCatalogs): { clip: Clip<N, E>; missing: string[] } {
  const refs = clip.refs ?? {}
  const missing = new Set<string>()
  const swap = (kind: RefKind, id: string) => {
    if (catalogs[kind].some(x => x.id === id)) return id
    const ref = refs[id]
    if (!ref || ref.kind !== kind) return id
    const twin = catalogs[kind].find(x => x.name.trim().toLowerCase() === ref.name.trim().toLowerCase())
    if (twin) return twin.id
    missing.add(`${REF_LABEL[kind]} "${ref.name}"`)
    return id
  }
  const nodes = clip.nodes.map(n => ({ ...n, data: walkRefs(n.data, swap) }))
  return { clip: { ...clip, nodes }, missing: [...missing] }
}

/** Passos selecionados (menos o gatilho, que é único por automação) e as ligações entre eles. */
export function copySelection<N extends ClipNode, E extends ClipEdge>(nodes: N[], edges: E[]): Clip<N, E> | null {
  const picked = nodes.filter(n => n.selected && n.type !== "trigger")
  if (!picked.length) return null
  const ids = new Set(picked.map(n => n.id))
  return { nodes: structuredClone(picked), edges: structuredClone(edges.filter(e => ids.has(e.source) && ids.has(e.target))) }
}

/** Cola com ids novos, deslocado, já selecionado; ligações internas seguem os novos ids. */
export function pasteClip<N extends ClipNode, E extends ClipEdge>(clip: Clip<N, E>, nodes: N[], edges: E[], offset = 40): { nodes: N[]; edges: E[] } {
  const taken = new Set(nodes.map(n => n.id))
  const ids = new Map<string, string>()
  for (const n of clip.nodes) {
    const base = n.id.replace(/-c\d+$/, "")
    let k = 1
    while (taken.has(`${base}-c${k}`)) k++
    taken.add(`${base}-c${k}`)
    ids.set(n.id, `${base}-c${k}`)
  }
  const pasted = clip.nodes.map(n => ({ ...structuredClone(n), id: ids.get(n.id)!, position: { x: n.position.x + offset, y: n.position.y + offset }, selected: true }))
  const links = clip.edges.map(e => {
    const source = ids.get(e.source)!, target = ids.get(e.target)!
    return { ...structuredClone(e), id: `${source}:${e.sourceHandle ?? "next"}`, source, target }
  })
  return { nodes: [...nodes.map(n => (n.selected ? { ...n, selected: false } : n)), ...pasted], edges: [...edges, ...links] }
}

/** Pilha de desfazer/refazer por fotografia do grafo; seleção e medidas não contam como mudança. */
export class History<T> {
  private past: T[] = []
  private future: T[] = []
  private readonly key: (state: T) => string
  private readonly limit: number
  constructor(key: (state: T) => string, limit = 50) { this.key = key; this.limit = limit }
  get canUndo() { return this.past.length > 0 }
  get canRedo() { return this.future.length > 0 }
  record(previous: T, next: T) {
    if (this.key(previous) === this.key(next)) return
    this.past.push(previous)
    if (this.past.length > this.limit) this.past.shift()
    this.future = []
  }
  undo(current: T): T | undefined {
    const state = this.past.pop()
    if (state !== undefined) this.future.push(current)
    return state
  }
  redo(current: T): T | undefined {
    const state = this.future.pop()
    if (state !== undefined) this.past.push(current)
    return state
  }
}

/** Auto-organizar: colunas pela distância a partir do gatilho (busca em largura), linhas pela ordem de chegada.
 * Notas e grupos ficam onde estão; passos soltos vão para uma coluna final. */
export function autoLayout<N extends ClipNode, E extends ClipEdge>(nodes: N[], edges: E[], gap = { x: 360, y: 240 }, skip: (n: N) => boolean = () => false): N[] {
  const steps = nodes.filter(n => !skip(n))
  const depth = new Map<string, number>()
  const roots = steps.filter(n => n.type === "trigger" || n.type === "starting_step")
  const queue = (roots.length ? roots : steps.slice(0, 1)).map(n => n.id)
  for (const id of queue) depth.set(id, 0)
  for (let i = 0; i < queue.length; i++) {
    for (const e of edges.filter(edge => edge.source === queue[i])) {
      if (!depth.has(e.target) && steps.some(n => n.id === e.target)) { depth.set(e.target, depth.get(queue[i])! + 1); queue.push(e.target) }
    }
  }
  const last = Math.max(0, ...depth.values()) + 1
  const rows = new Map<number, number>()
  const order = [...queue, ...steps.filter(n => !depth.has(n.id)).map(n => n.id)]
  const placed = new Map<string, { x: number; y: number }>()
  for (const id of order) {
    const column = depth.get(id) ?? last, row = rows.get(column) ?? 0
    rows.set(column, row + 1)
    placed.set(id, { x: column * gap.x, y: row * gap.y })
  }
  return nodes.map(n => placed.has(n.id) ? { ...n, position: placed.get(n.id)! } : n)
}
