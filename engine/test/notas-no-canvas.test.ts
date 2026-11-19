import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { seed, graph } from './fixtures'
import { getAutomation, publishAutomation, saveDraft } from '../src/db/automations'

const annotations = [
  { id: 'grupo-1', kind: 'group', position: { x: -40, y: -40 }, size: { w: 700, h: 400 }, color: 'blue', title: 'Boas-vindas' },
  { id: 'nota-1', kind: 'note', position: { x: 300, y: 300 }, size: { w: 220, h: 140 }, color: 'yellow', text: 'Revisar o texto' },
]

beforeEach(seed)

it('notas e grupos vão com o rascunho, entram na versão publicada e não contam como passos soltos', async () => {
  await saveDraft(env.DB, 'a', 'auto-a', { ...graph, annotations })
  const draft = await getAutomation(env.DB, 'a', 'auto-a')
  expect(draft!.automation.draft_graph.annotations).toEqual(annotations)
  const version = await publishAutomation(env.DB, 'a', 'auto-a')
  expect((version.graph as any).annotations).toEqual(annotations)
  expect((version.graph as any).nodes).toEqual(graph.nodes)
})

it('o rascunho recusa nota com o id de um passo', async () => {
  await expect(saveDraft(env.DB, 'a', 'auto-a', { ...graph, annotations: [{ ...annotations[1], id: graph.nodes[0]!.id }] })).rejects.toThrow()
})
