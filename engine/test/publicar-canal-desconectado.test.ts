import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import type { Graph, GraphNode } from '../src/contracts'
import { app } from '../src/index'
import { fixtureCookie, seedAuth } from './auth-helpers'

const node = (id: string, type: GraphNode['type'], config: GraphNode['config'] = {}): GraphNode => ({ id, type, position: { x: 0, y: 0 }, config })
const buttons = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'button', id: `b${i}`, label: `Botão ${i}`, action: { type: 'go_to_node' } }))
const replies = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'quick_reply', id: `q${i}`, label: `Opção ${i}` }))
const graph = (...steps: unknown[][]): Graph => ({
  nodes: [node('start', 'trigger'), ...steps.map((blocks, i) => node(`m${i}`, 'message', { blocks: [{ kind: 'text', text: `Passo ${i}` }, ...blocks] }))],
  edges: steps.map((_, i) => ({ from: i ? `m${i - 1}` : 'start', port: 'next', to: `m${i}` })),
})
let cookie = ''
const request = (path: string, init: RequestInit) => app.request(`/api/${path}`, { ...init, headers: { cookie, 'x-workspace': 'a', 'content-type': 'application/json', origin: 'https://engine.test' } }, env)
const draft = (value: Graph) => request('automations/auto-a/draft', { method: 'PUT', body: JSON.stringify({ graph: value }) })
const publish = () => request('automations/auto-a/publish', { method: 'POST' })

beforeEach(async () => {
  await seedAuth(); cookie = await fixtureCookie()
  await env.DB.batch([
    env.DB.prepare("UPDATE channels SET display_name='Bot fixo',type='telegram',provider='telegram_bot',status='disconnected' WHERE id='ch-a'"),
    env.DB.prepare("UPDATE triggers SET channel_id='ch-a' WHERE id='trg-a'"),
  ])
})

it('canal fixo do gatilho desconectado vale pelo próprio perfil, não pelo limite padrão de 3 botões', async () => {
  expect((await draft(graph(buttons(5)))).status).toBe(200)
  expect((await publish()).status).toBe(201)
  expect((await draft(graph(buttons(11)))).status).toBe(200)
  const refused = await publish()
  expect(refused.status).toBe(409)
  expect(await refused.text()).toContain('até 10 botões')
})

it('publicar junta todos os problemas dos passos numa só resposta', async () => {
  expect((await draft(graph(buttons(11), replies(11)))).status).toBe(200)
  const refused = await publish()
  expect(refused.status).toBe(409)
  const text = await refused.text()
  expect(text).toContain('até 10 botões')
  expect(text).toContain('até 10 respostas rápidas')
})
