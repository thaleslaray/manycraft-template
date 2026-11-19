import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { authenticatedRequest as request, seedAuth } from './auth-helpers'
import { graphSchema } from '../src/schemas/graph'
import type { Automation, Graph } from '../src/contracts'

type Model = { id: string; version: number; name: string; graph: Graph; warnings: string[] }
const catalog = async (connection = 'ch-a') => {
  const response = await request(`automation-templates?connection_id=${connection}`)
  expect(response.status).toBe(200)
  return response.json() as Promise<{ templates: Model[] }>
}
beforeEach(seedAuth)

it('oferece seis modelos versionados com grafos válidos e cópias independentes em rascunho', async () => {
  const { templates } = await catalog()
  expect(templates).toHaveLength(6)
  for (const model of templates) {
    expect(model.version).toBeGreaterThan(0)
    expect(graphSchema.safeParse(model.graph).success).toBe(true)
    const response = await request('automation-templates', 'a', { method: 'POST', body: JSON.stringify({ template_id: model.id, version: model.version, connection_id: 'ch-a' }) })
    expect(response.status).toBe(201)
    const created = await response.json() as Automation
    expect(created).toMatchObject({ name: model.name, status: 'draft', published_version_id: null })
    expect(graphSchema.safeParse(created.draft_graph).success).toBe(true)
    const detail = await (await request(`automations/${created.id}`)).json() as { triggers: { channel_id: string }[] }
    expect(detail.triggers).toHaveLength(1)
    expect(detail.triggers[0]?.channel_id).toBe('ch-a')
    expect((await request(`automations/${created.id}/publish`, 'a', { method: 'POST' })).status).toBe(201)
  }
})

it('usa a ficha efetiva e recusa o modelo incompatível mesmo sem passar pela tela', async () => {
  await env.DB.prepare(`UPDATE channels SET capabilities_override=? WHERE id='ch-a'`).bind(JSON.stringify({ buttons: { types: [] } })).run()
  const { templates } = await catalog()
  const link = templates.find(t => t.id === 'link-palavra')!
  expect(link.warnings.join(' ')).toContain('botão de link')
  const before = await env.DB.prepare('SELECT count(*) n FROM automations').first<{ n: number }>()
  expect((await request('automation-templates', 'a', { method: 'POST', body: JSON.stringify({ template_id: link.id, version: link.version, connection_id: 'ch-a' }) })).status).toBe(409)
  expect(await env.DB.prepare('SELECT count(*) n FROM automations').first()).toEqual(before)
})

it('preserva a pasta e a versão de origem e não compartilha edições entre cópias', async () => {
  await env.DB.prepare(`INSERT INTO folders(id,workspace_id,name) VALUES ('model-folder','a','Campanhas')`).run()
  const create = () => request('automation-templates', 'a', { method: 'POST', body: JSON.stringify({ template_id: 'link-palavra', version: 1, connection_id: 'ch-a', folder_id: 'model-folder' }) })
  const one = await (await create()).json() as Automation
  const two = await (await create()).json() as Automation
  expect(one.id).not.toBe(two.id)
  expect(one.folder_id).toBe('model-folder')
  expect(one.draft_graph).toMatchObject({ template: { id: 'link-palavra', version: 1 } })
  const edited = structuredClone(one.draft_graph)
  edited.nodes[1]!.config.blocks = [{ kind: 'text', text: 'Só desta cópia' }]
  expect((await request(`automations/${one.id}/draft`, 'a', { method: 'PUT', body: JSON.stringify({ graph: edited }) })).status).toBe(200)
  const detail = await (await request(`automations/${two.id}`)).json() as { automation: Automation }
  expect(detail.automation.draft_graph).toEqual(two.draft_graph)
  const installed = await (await request('automation-templates/installed')).json() as { items: { automation_id: string; template_id: string; installed_by: string; automation_exists: number }[] }
  expect(installed.items.map(i => i.automation_id).sort()).toEqual([one.id, two.id].sort())
  expect(installed.items[0]).toMatchObject({ template_id: 'link-palavra', installed_by: expect.any(String), automation_exists: 1 })
})

it('recusa versão antiga, conexão ou pasta estrangeira, conexão arquivada e papel sem edição', async () => {
  const payload = { template_id: 'link-palavra', version: 1, connection_id: 'ch-a' }
  const create = (patch = {}) => request('automation-templates', 'a', { method: 'POST', body: JSON.stringify({ ...payload, ...patch }) })
  expect((await create({ version: 99 })).status).toBe(409)
  expect((await create({ template_id: 'ausente' })).status).toBe(404)
  expect((await create({ connection_id: 'ch-b' })).status).toBe(404)
  expect((await create({ folder_id: 'estrangeira' })).status).toBe(404)
  await env.DB.prepare(`UPDATE channels SET archived_at=1 WHERE id='ch-a'`).run()
  expect((await create()).status).toBe(404)
  await env.DB.prepare(`UPDATE workspace_members SET role='viewer' WHERE workspace_id='a'`).run()
  expect((await create()).status).toBe(403)
})
