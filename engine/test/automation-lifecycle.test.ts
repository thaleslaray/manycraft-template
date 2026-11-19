import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest as request, fixtureCookie, seedAuth } from './auth-helpers'
import type { Automation, AutomationDetail } from '../src/contracts'
import { graph } from './fixtures'
import { env } from 'cloudflare:workers'

beforeEach(seedAuth)

it('rascunho aceita passo solto mas a publicação recusa inclusive uma ilha cíclica', async () => {
  const draft = structuredClone(graph)
  draft.nodes.push({ id: 'ilha', type: 'message', position: { x: 800, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Solto' }] } })
  draft.edges.push({ from: 'ilha', port: 'next', to: 'ilha' })
  expect((await request('automations/auto-a/draft', 'a', { method: 'PUT', body: JSON.stringify({ graph: draft }) })).status).toBe(200)
  const response = await request('automations/auto-a/publish', 'a', { method: 'POST' })
  expect(response.status).toBe(400)
  expect(await response.text()).toContain('solto')
})

it('rascunho preserva ação incompleta no botão; publicação valida a referência e o valor do campo', async () => {
  const draft = structuredClone(graph)
  draft.nodes[1].config.blocks = [{ kind: 'text', text: 'Escolha' }, { kind: 'button', id: 'tag', label: 'Confirmar', action: { type: 'go_to_node' }, actions: [{ type: 'add_tag', tag_id: '' }] }]
  const save = () => request('automations/auto-a/draft', 'a', { method: 'PUT', body: JSON.stringify({ graph: draft }) })
  expect((await save()).status).toBe(200)
  expect((await request('automations/auto-a/publish', 'a', { method: 'POST' })).status).toBe(400)
  const button = (draft.nodes[1].config.blocks as { actions?: unknown[] }[])[1]
  for (const action of [{ type: 'add_tag', tag_id: 'tag-b' }, { type: 'set_custom_field_value', field_id: 'field-a', value: 23 }]) {
    button.actions = [action]
    expect((await save()).status).toBe(200)
    expect((await request('automations/auto-a/publish', 'a', { method: 'POST' })).status).toBe(400)
  }
  button.actions = [{ type: 'add_tag', tag_id: 'tag-a' }]
  expect((await save()).status).toBe(200)
  expect((await request('automations/auto-a/publish', 'a', { method: 'POST' })).status).toBe(201)
})

it('criar um rascunho o torna recuperável pelo editor e pela lista', async () => {
  const response = await request('automations', 'a', { method: 'POST', body: JSON.stringify({ name: 'Nova automação', folder_id: null }) })
  expect(response.status).toBe(201)
  const created = await response.json() as Automation
  const detail = await (await request(`automations/${created.id}`)).json() as AutomationDetail
  expect(detail.automation).toMatchObject({ name: 'Nova automação', status: 'draft', published_version_id: null })
  expect(detail.automation.draft_graph.nodes).toMatchObject([{ type: 'trigger' }])
  expect(await (await request('automations')).json()).toContainEqual(expect.objectContaining({ id: created.id, name: 'Nova automação' }))
})

it('renomear, publicar, pausar e retomar preserva a versão publicada e o rascunho', async () => {
  const patch = (body: unknown) => request('automations/auto-a', 'a', { method: 'PATCH', body: JSON.stringify(body) })
  expect((await patch({ name: '  Atendimento da oficina  ' })).status).toBe(200)
  const version = await (await request('automations/auto-a/publish', 'a', { method: 'POST' })).json() as { id: string }
  const draft = structuredClone(graph)
  draft.nodes[1]!.config = { blocks: [{ kind: 'text', text: 'Texto ainda não publicado' }] }
  await request('automations/auto-a/draft', 'a', { method: 'PUT', body: JSON.stringify({ graph: draft }) })
  for (const status of ['stopped', 'live']) {
    expect((await patch({ status })).status).toBe(200)
    const detail = await (await request('automations/auto-a')).json() as AutomationDetail
    expect(detail.automation).toMatchObject({ name: 'Atendimento da oficina', status, published_version_id: version.id, draft_graph: draft, has_unpublished_changes: true })
    expect(detail.published_version?.graph).toEqual(graph)
    expect(await (await request(`automations?status=${status}`)).json()).toContainEqual(expect.objectContaining({ id: 'auto-a', name: 'Atendimento da oficina' }))
  }
})

it('o resumo usa as palavras configuradas e editadas, mesmo quando config.include está desatualizado', async () => {
  await env.DB.prepare(`UPDATE keywords SET words='["preço","oficina"]' WHERE id='key-a'`).run()
  const list = await (await request('automations')).json() as { trigger_summary: string }[]
  expect(list[0]?.trigger_summary).toBe('Quando chega uma mensagem com “preço”, “oficina”')
})

it('o resumo mantém o sentido de uma regra que não contém a palavra', async () => {
  await env.DB.prepare(`UPDATE keywords SET rule='does_not_contain', words='["preço"]' WHERE id='key-a'`).run()
  const list = await (await request('automations')).json() as { trigger_summary: string }[]
  expect(list[0]?.trigger_summary).toBe('Quando chega uma mensagem sem “preço”')
})

it('recusa estado sem publicação, nome vazio, pasta estrangeira e escrita sem permissão', async () => {
  for (const status of ['live', 'stopped']) expect((await request('automations/auto-a', 'a', { method: 'PATCH', body: JSON.stringify({ status }) })).status).toBe(409)
  for (const body of [{ name: '' }, {}, { status: 'draft' }]) expect((await request('automations/auto-a', 'a', { method: 'PATCH', body: JSON.stringify(body) })).status).toBe(400)
  expect((await request('automations/auto-b', 'a', { method: 'PATCH', body: JSON.stringify({ name: 'Outro espaço' }) })).status).toBe(404)
  await env.DB.prepare(`INSERT INTO folders(id,workspace_id,name) VALUES ('folder-b','b','Pasta estrangeira')`).run()
  expect((await request('automations', 'a', { method: 'POST', body: JSON.stringify({ name: 'Teste', folder_id: 'folder-b' }) })).status).toBe(404)
  await env.DB.prepare(`UPDATE workspace_members SET role='viewer' WHERE workspace_id='a'`).run()
  expect((await request('automations', 'a', { method: 'POST', body: JSON.stringify({ name: 'Teste' }) })).status).toBe(403)
  expect((await request('automations/auto-a', 'a', { method: 'PATCH', body: JSON.stringify({ name: 'Teste' }) })).status).toBe(403)
})

it('papel sem edição recebe 403 ao publicar, antes da checagem de conexões (que daria 409 com detalhes)', async () => {
  const card = { title: 'Curso', buttons: [{ type: 'url', title: 'Conhecer', url: 'https://example.test/curso' }] }
  const draft = { nodes: [{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} }, { id: 'm', type: 'message', position: { x: 300, y: 0 }, config: { blocks: [{ kind: 'gallery', aspectRatio: 'horizontal', cards: [card] }] } }], edges: [{ from: 't', port: 'next', to: 'm' }] }
  await env.DB.prepare("UPDATE channels SET capabilities_override='{}',type='telegram',provider='telegram_bot',status='connected',display_name='Atendimento sem vitrine' WHERE id='ch-a'").run()
  expect((await request('automations/auto-a/draft', 'a', { method: 'PUT', body: JSON.stringify({ graph: draft }) })).status).toBe(200)
  expect((await request('automations/auto-a/publish', 'a', { method: 'POST' })).status).toBe(409)
  await env.DB.prepare(`UPDATE workspace_members SET role='viewer' WHERE workspace_id='a'`).run()
  const refused = await request('automations/auto-a/publish', 'a', { method: 'POST' })
  expect(refused.status).toBe(403)
  expect(await refused.text()).not.toContain('Atendimento sem vitrine')
})

it.each(['viewer', 'livechat_agent'])('papel %s sem edição recebe 403 ao publicar e a automação não muda', async role => {
  await env.DB.prepare("INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES ('m-pub','a','user-b',?)").bind(role).run()
  const before = await env.DB.prepare("SELECT status,published_version_id FROM automations WHERE id='auto-a'").first()
  const response = await request('automations/auto-a/publish', 'a', { method: 'POST' }, await fixtureCookie('b'))
  expect(response.status).toBe(403)
  expect(await env.DB.prepare("SELECT status,published_version_id FROM automations WHERE id='auto-a'").first()).toEqual(before)
  expect(await env.DB.prepare("SELECT count(*) AS n FROM automation_versions WHERE automation_id='auto-a'").first('n')).toBe(0)
})
