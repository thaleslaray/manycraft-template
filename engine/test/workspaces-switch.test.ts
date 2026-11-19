import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest, fixtureCookie, seedAuth } from './auth-helpers'

let cookie = ''
beforeEach(async () => {
  await seedAuth(); cookie = await fixtureCookie()
  await env.DB.prepare("INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES ('m-ab','b','user-a','editor')").run()
})
const call = (path: string, body?: unknown, ws = 'a') => authenticatedRequest(path, ws, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }, cookie)

it('lista as contas do usuário, troca só para as suas e sai de uma onde não é dono', async () => {
  expect(await (await call('workspaces/mine')).json()).toMatchObject({ current: 'a', items: [{ id: 'a', role: 'owner' }, { id: 'b', role: 'editor' }] })
  const switched = await call('workspaces/switch', { workspace_id: 'b' })
  expect(switched.headers.get('set-cookie')).toContain('workspace_context=b')
  await env.DB.prepare("INSERT INTO workspaces(id,name) VALUES ('c','Alheio')").run()
  expect((await call('workspaces/switch', { workspace_id: 'c' })).status).toBe(404)
  expect((await call('team/leave', {}, 'a')).status).toBe(409)
  expect((await call('team/leave', {}, 'b')).status).toBe(200)
  expect(await env.DB.prepare("SELECT count(*) FROM workspace_members WHERE workspace_id='b' AND user_id='user-a'").first('count(*)')).toBe(0)
})

it('clonar a conta cria espaço novo com tags, campos e automações em rascunho, sem contatos', async () => {
  await env.DB.prepare("UPDATE automations SET draft_graph=? WHERE id='auto-a'").bind(JSON.stringify({ nodes: [{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} }, { id: 'act', type: 'action', position: { x: 0, y: 0 }, config: { actions: [{ type: 'add_tag', tag_id: 'tag-a' }] } }], edges: [] })).run()
  const response = await call('workspaces/clone', { name: 'Cópia' })
  expect(response.status).toBe(201)
  const { id } = await response.json() as { id: string }
  expect(await env.DB.prepare('SELECT count(*) FROM contacts WHERE workspace_id=?').bind(id).first('count(*)')).toBe(0)
  const tag = await env.DB.prepare('SELECT id FROM tags WHERE workspace_id=?').bind(id).first<string>('id')
  const draft = await env.DB.prepare('SELECT draft_graph,published_version_id FROM automations WHERE workspace_id=?').bind(id).first<{ draft_graph: string; published_version_id: string | null }>()
  expect(draft!.published_version_id).toBeNull()
  expect(JSON.parse(draft!.draft_graph).nodes[1].config.actions[0].tag_id).toBe(tag)
  expect(await env.DB.prepare("SELECT role FROM workspace_members WHERE workspace_id=? AND user_id='user-a'").bind(id).first('role')).toBe('owner')
})

it('duplica a automação para outra conta onde pode editar, religando tag de mesmo nome', async () => {
  await env.DB.prepare("UPDATE automations SET draft_graph=? WHERE id='auto-a'").bind(JSON.stringify({ nodes: [{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} }, { id: 'act', type: 'action', position: { x: 0, y: 0 }, config: { actions: [{ type: 'add_tag', tag_id: 'tag-a' }] } }], edges: [] })).run()
  await env.DB.prepare("UPDATE tags SET name='Etiqueta a' WHERE id='tag-b'").run()
  const r = await call('automations/auto-a/copy-to', { workspace_id: 'b' })
  expect(r.status).toBe(201)
  const { id } = await r.json() as { id: string }
  const graph = JSON.parse((await env.DB.prepare("SELECT draft_graph FROM automations WHERE id=? AND workspace_id='b'").bind(id).first<string>('draft_graph'))!)
  expect(graph.nodes[1].config.actions[0].tag_id).toBe('tag-b')
  await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE id='m-ab'").run()
  expect((await call('automations/auto-a/copy-to', { workspace_id: 'b' })).status).toBe(404)
})

it('link de compartilhamento mostra a automação a quem não está logado e outra conta salva a cópia em rascunho', async () => {
  const { app } = await import('../src/index')
  const { token } = await (await call('automations/auto-a/share', {})).json() as { token: string }
  const view = await app.request(`https://engine.test/api/automation-share/${token}`, {}, env)
  expect(view.status).toBe(200)
  expect(await view.json()).toMatchObject({ name: expect.any(String), allow_copy: true })
  const copy = await call('automations/import-shared', { token }, 'b')
  expect(copy.status).toBe(201)
  const { id } = await copy.json() as { id: string }
  expect(await env.DB.prepare("SELECT workspace_id,published_version_id FROM automations WHERE id=?").bind(id).first()).toEqual({ workspace_id: 'b', published_version_id: null })
  await call('automations/auto-a/share', {})
  expect((await app.request(`https://engine.test/api/automation-share/${token}`, {}, env)).status).toBe(404)
})

it('duplica e converte para outro canal: sem gatilhos e sem blocos que o destino não oferece', async () => {
  await env.DB.prepare("UPDATE automations SET draft_graph=? WHERE id='auto-a'").bind(JSON.stringify({ nodes: [
    { id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'm', type: 'message', position: { x: 0, y: 0 }, config: { blocks: [{ kind: 'text', text: 'oi' }, { kind: 'quick_reply', id: 'q1', label: 'Sim' }] } },
    { id: 'n', type: 'message', position: { x: 0, y: 0 }, config: { blocks: [{ kind: 'text', text: 'ok' }] } },
  ], edges: [{ from: 't', port: 'next', to: 'm' }, { from: 'm', port: 'btn:q1', to: 'n' }] })).run()
  const r = await call('automations/auto-a/convert', { channel: 'email' })
  expect(r.status).toBe(201)
  const { id, removed } = await r.json() as { id: string; removed: number }
  expect(removed).toBe(2)
  const graph = JSON.parse((await env.DB.prepare('SELECT draft_graph FROM automations WHERE id=?').bind(id).first<string>('draft_graph'))!)
  expect(graph.nodes.map((n: { id: string }) => n.id)).toEqual(['m', 'n'])
  expect(graph.nodes[0].config.blocks).toEqual([{ kind: 'text', text: 'oi' }])
  expect(graph.edges).toEqual([])
})
