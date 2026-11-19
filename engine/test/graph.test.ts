import { expect, it } from 'vitest'
import { graph } from './fixtures'
import { graphSchema } from '../src/schemas/graph'

function withBlock(block: Record<string, unknown>) {
  const input = structuredClone(graph)
  input.nodes[1]!.config = { blocks: [block] }
  return input
}

it.each([
  { type: 'question', answer_timeout: { value: 0, unit: 'minutes' } },
  { type: 'question', answer_timeout: { value: 1.5, unit: 'hours' } },
  { type: 'question', answer_type: 'unknown' },
  { type: 'question', retries: -1 },
  { type: 'quick_reply', settings: { timeout: { value: 5, unit: 'months' } } },
])('preserva guards Postgres do bloco %j', (block) => {
  expect(graphSchema.safeParse(withBlock(block)).success).toBe(false)
})

it('aceita os vocabulários do painel e do schema com prazos válidos', () => {
  expect(graphSchema.safeParse(graph).success).toBe(true)
  expect(graphSchema.safeParse(withBlock({ type: 'question', answer_type: 'email', answer_timeout: { value: 30, unit: 'minutes' }, retries: 4 })).success).toBe(true)
  const native = withBlock({ type: 'quick_reply', settings: { timeout: { value: 23, unit: 'hours' } } })
  native.nodes[0]!.type = 'trigger'
  // Entradas nativas são validadas em runtime, pois o front ainda expõe o vocabulário legado.
  const input: unknown = { ...native, nodes: native.nodes.map((node, i) => ({ ...node, type: i ? 'instagram' : 'starting_step' })) }
  expect(graphSchema.safeParse(input).success).toBe(true)
})

it('rejeita conexões quebradas, IDs repetidos e ações sem vocabulário conhecido', () => {
  expect(graphSchema.safeParse({ ...graph, edges: [{ from: 'missing', port: 'next', to: 'm' }] }).success).toBe(false)
  expect(graphSchema.safeParse({ ...graph, nodes: [...graph.nodes, graph.nodes[0]] }).success).toBe(false)
  const input = structuredClone(graph)
  input.nodes[1]!.config = { actions: [{ type: 'unknown' }] }
  expect(graphSchema.safeParse(input).success).toBe(false)
})

const nota = { id: 'nota-1', kind: 'note', position: { x: 10, y: 20 }, size: { w: 220, h: 140 }, color: 'yellow', text: 'Lembrar de revisar' }
const quadro = { id: 'grupo-1', kind: 'group', position: { x: -20, y: -20 }, size: { w: 640, h: 360 }, color: 'blue', title: 'Boas-vindas' }

it('guarda notas e grupos do canvas no rascunho sem tratá-los como passos', () => {
  const parsed = graphSchema.parse({ ...graph, annotations: [quadro, nota] })
  expect(parsed.annotations).toEqual([quadro, nota])
  expect(parsed.nodes).toEqual(graph.nodes)
})

it('rejeita nota ou grupo com tamanho, cor, texto ou id inválidos', () => {
  const bad = (patch: Record<string, unknown>) => graphSchema.safeParse({ ...graph, annotations: [{ ...nota, ...patch }] }).success
  expect(bad({})).toBe(true)
  expect(bad({ color: 'neon' })).toBe(false)
  expect(bad({ kind: 'sticker' })).toBe(false)
  expect(bad({ size: { w: 10, h: 140 } })).toBe(false)
  expect(bad({ size: { w: 220, h: 99999 } })).toBe(false)
  expect(bad({ text: 'x'.repeat(2001) })).toBe(false)
  expect(bad({ position: { x: Number.NaN, y: 0 } })).toBe(false)
  expect(bad({ id: graph.nodes[0]!.id })).toBe(false)
  expect(graphSchema.safeParse({ ...graph, annotations: [nota, nota] }).success).toBe(false)
  expect(graphSchema.safeParse({ ...graph, annotations: Array.from({ length: 201 }, (_, i) => ({ ...nota, id: `n${i}` })) }).success).toBe(false)
})
