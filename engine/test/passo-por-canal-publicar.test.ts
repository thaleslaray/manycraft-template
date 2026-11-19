import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import type { Graph, GraphNode } from '../src/contracts'
import { app } from '../src/index'
import { fixtureCookie, seedAuth } from './auth-helpers'

const node = (id: string, type: GraphNode['type'], config: GraphNode['config'] = {}): GraphNode => ({ id, type, position: { x: 0, y: 0 }, config })
const buttons = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'button', id: `b${i}`, label: `Botão ${i}`, action: { type: 'go_to_node' } }))
const step = (id: string, channel: string | undefined, blocks: unknown[]) => node(id, 'message', { ...(channel ? { channel } : {}), blocks: [{ kind: 'text', text: `Passo ${id}` }, ...blocks] })
const graph = (...steps: GraphNode[]): Graph => ({ nodes: [node('start', 'trigger'), ...steps], edges: steps.map((s, i) => ({ from: i ? steps[i - 1].id : 'start', port: 'next', to: s.id })) })
let cookie = ''
const request = (path: string, init: RequestInit) => app.request(`/api/${path}`, { ...init, headers: { cookie, 'x-workspace': 'a', 'content-type': 'application/json', origin: 'https://engine.test' } }, env)
const draft = (value: Graph) => request('automations/auto-a/draft', { method: 'PUT', body: JSON.stringify({ graph: value }) })
const publish = () => request('automations/auto-a/publish', { method: 'POST' })

beforeEach(async () => {
  await seedAuth(); cookie = await fixtureCookie()
  await env.DB.batch([
    env.DB.prepare("UPDATE channels SET display_name='Bot',type='telegram',provider='telegram_bot',status='connected' WHERE id='ch-a'"),
    env.DB.prepare("UPDATE triggers SET channel_id='ch-a' WHERE id='trg-a'"),
    env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,connection_state,status) VALUES ('ch-ig','a','instagram','instagram_unified','123','connected','connected')"),
    env.DB.prepare("INSERT INTO triggers (id,workspace_id,automation_id,channel_id,name,kind,status,config) VALUES ('trg-ig','a','auto-a','ch-ig','Instagram','keyword','active','{}')"),
  ])
})

it('cada passo é conferido só contra as conexões do seu canal', async () => {
  // 5 botões cabem no Telegram (10), mas o Instagram só aceita 3: sem canal no passo, o gatilho do Instagram barra.
  expect((await draft(graph(step('m1', undefined, buttons(5))))).status).toBe(200)
  const old = await publish()
  expect(old.status).toBe(409)
  // Com o canal escolhido, o passo do Telegram passa e o do Instagram (3 botões) também.
  expect((await draft(graph(step('m1', 'telegram', buttons(5)), step('m2', 'instagram', buttons(3))))).status).toBe(200)
  expect((await publish()).status).toBe(201)
})

it('passo do Instagram com mais botões do que o Instagram aceita continua barrado', async () => {
  expect((await draft(graph(step('m1', 'instagram', buttons(5))))).status).toBe(200)
  const refused = await publish()
  expect(refused.status).toBe(409)
  expect(await refused.text()).toContain('3 botões')
})
