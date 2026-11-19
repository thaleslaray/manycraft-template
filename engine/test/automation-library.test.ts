import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { authenticatedRequest as request, seedAuth } from './auth-helpers'
import { dispatchInbound } from '../src/flow/dispatch'
import { assertRunActive } from '../src/flow/state'
import { planGroupRun } from '../src/flow/group-dispatch'

beforeEach(seedAuth)
const mutate = (path: string, body: unknown = {}, method = 'POST') => request(path, 'a', { method, body: JSON.stringify(body) })
const folder = async (name: string, parent_id: string | null = null) => {
  const response = await mutate('folders', { name, parent_id })
  expect(response.status).toBe(201)
  return await response.json() as { id: string; parent_id: string | null; name: string }
}

it('organiza pastas aninhadas persistidas sem ciclos, relações externas ou apagar conteúdo', async () => {
  const root = await folder('Campanhas')
  const child = await folder('Outubro', root.id)
  expect((await mutate(`folders/${root.id}`, { parent_id: child.id }, 'PATCH')).status).toBe(409)
  expect((await mutate(`folders/${root.id}`, { parent_id: root.id }, 'PATCH')).status).toBe(409)
  expect((await mutate(`folders/${child.id}`, { name: 'Novembro', parent_id: null }, 'PATCH')).status).toBe(200)
  await env.DB.prepare("INSERT INTO folders(id,workspace_id,name) VALUES ('folder-b','b','Privada')").run()
  expect((await mutate(`folders/${root.id}`, { parent_id: 'folder-b' }, 'PATCH')).status).toBe(404)
  expect((await mutate('automations/auto-a', { folder_id: root.id }, 'PATCH')).status).toBe(200)
  expect((await mutate('automations/auto-a', { folder_id: 'folder-b' }, 'PATCH')).status).toBe(404)
  expect((await request(`folders/${root.id}`, 'a', { method: 'DELETE' })).status).toBe(409)
  expect((await request(`folders/${child.id}`, 'a', { method: 'DELETE' })).status).toBe(200)
  expect(await (await request('folders')).json()).toMatchObject({ folders: [{ id: root.id, name: 'Campanhas', count: 1 }], total: 1, unfiled: 0, trashed: 0 })
})

it('excluir pasta com itens: sem o pedido explícito recusa; com ele leva automações (até as da lixeira) para Sem pasta e subpastas para o nível acima', async () => {
  const raiz = await folder('Raiz')
  const meio = await folder('Meio', raiz.id)
  const filha = await folder('Filha', meio.id)
  expect((await mutate('automations/auto-a', { folder_id: meio.id }, 'PATCH')).status).toBe(200)
  await env.DB.prepare("UPDATE automations SET deleted_at=1 WHERE id='auto-a'").run()
  const recusa = await request(`folders/${meio.id}`, 'a', { method: 'DELETE' })
  expect(recusa.status).toBe(409)
  expect((await recusa.json() as { error: string }).error).toMatch(/Mover itens para Sem pasta/)
  expect((await request(`folders/${meio.id}?move_items=1`, 'a', { method: 'DELETE' })).status).toBe(200)
  expect(await env.DB.prepare("SELECT folder_id FROM automations WHERE id='auto-a'").first()).toEqual({ folder_id: null })
  expect(await env.DB.prepare('SELECT parent_id FROM folders WHERE id=?').bind(filha.id).first()).toEqual({ parent_id: raiz.id })
  expect(await env.DB.prepare('SELECT id FROM folders WHERE id=?').bind(meio.id).first()).toBeNull()
  expect((await request(`folders/${raiz.id}?move_items=1`, 'b', { method: 'DELETE' })).status).toBe(404)
})

it('duplica somente rascunho com gatilhos e palavras independentes e desligados, incluindo grupos', async () => {
  await env.DB.prepare("UPDATE automations SET draft_graph=json_set(draft_graph,'$.nodes[0].config.trigger_id','trg-a') WHERE id='auto-a'").run()
  await mutate('automations/auto-a/publish')
  await env.DB.prepare("UPDATE automations SET draft_graph=json_set(draft_graph,'$.nodes[1].config.blocks[0].text','Rascunho posterior'),has_unpublished_changes=1 WHERE id='auto-a'").run()
  await env.DB.batch([
    env.DB.prepare("INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,priority,status) VALUES ('group-a','a','trg-a','group','[]',0,'live')"),
    env.DB.prepare("UPDATE keywords SET parent_id='group-a',status='live' WHERE id='key-a'"),
  ])
  const response = await mutate('automations/auto-a/duplicate')
  expect(response.status).toBe(201)
  const copy = await response.json() as { id: string; name: string }
  expect(copy.name).toBe('Automação a (cópia)')
  const original = await (await request('automations/auto-a')).json() as any
  const detail = await (await request(`automations/${copy.id}`)).json() as any
  expect(detail.automation).toMatchObject({ status: 'draft', published_version_id: null })
  expect(detail.triggers).toHaveLength(1)
  expect(detail.triggers[0]).toMatchObject({ active: false, config: original.triggers[0].config })
  expect(detail.triggers[0].id).not.toBe('trg-a')
  expect(detail.automation.draft_graph.nodes[0].config.trigger_id).toBe(detail.triggers[0].id)
  expect(original.automation.draft_graph.nodes[0].config.trigger_id).toBe('trg-a')
  const expectedGraph = structuredClone(original.automation.draft_graph)
  expectedGraph.nodes[0].config.trigger_id = detail.triggers[0].id
  expect(detail.automation.draft_graph).toEqual(expectedGraph)
  expect(detail.automation.draft_graph.nodes[1].config.blocks[0].text).toBe('Rascunho posterior')
  const keys = await env.DB.prepare('SELECT * FROM keywords WHERE trigger_id=? ORDER BY priority').bind(detail.triggers[0].id).all<any>()
  expect(keys.results.map(k => k.status)).toEqual(['draft', 'draft'])
  expect(keys.results[1].parent_id).toBe(keys.results[0].id)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM automation_versions WHERE automation_id=?').bind(copy.id).first('n')).toBe(0)
})

it('lixeira desliga gatilhos e palavras, bloqueia o disparo no canal falso e restaura sem reativar', async () => {
  await mutate('automations/auto-a/publish')
  await env.DB.batch([
    env.DB.prepare("UPDATE channels SET type='telegram',provider='telegram_bot' WHERE id='ch-a'"),
    env.DB.prepare("UPDATE keywords SET status='live' WHERE id='key-a'"),
  ])
  await env.DB.prepare("UPDATE triggers SET repeat_mode='every_time' WHERE id='trg-a'").run()
  const makeEvent = (eventId: string) => ({ version: 1 as const, provider: 'telegram' as const, workspaceId: 'a', channelId: 'ch-a', eventId, receivedAt: Date.now(),
    payload: { update_id: Number(eventId), message: { message_id: Number(eventId), from: { id: 99 }, chat: { id: 99, type: 'private' }, text: 'quero' } } })
  const createWorkflow = vi.fn(async () => ({}))
  const bindings = { ...env, FLOW_RUN: { create: createWorkflow } }
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Nenhum HTTP externo permitido'))
  try {
    const before = makeEvent('98')
    await env.DB.prepare("INSERT INTO inbound_events(id,workspace_id,channel_id,payload) VALUES ('before-trash','a','ch-a',?)").bind(JSON.stringify(before.payload)).run()
    await dispatchInbound(before, 'before-trash', bindings as any)
    expect(createWorkflow).toHaveBeenCalledTimes(1)
    expect(await env.DB.prepare("SELECT count(*) AS n FROM flow_runs WHERE workspace_id='a'").first('n')).toBe(1)
    const running = await env.DB.prepare("SELECT id FROM flow_runs WHERE workspace_id='a' LIMIT 1").first<string>('id')
    expect((await mutate('automations/auto-a/trash')).status).toBe(200)
    expect(await env.DB.prepare('SELECT status FROM flow_runs WHERE id=?').bind(running).first('status')).toBe('cancelled')
    await expect(assertRunActive(env, running!)).rejects.toThrow('Flow run cancelled')
    // A planner that read eligibility before trash must still be stopped before its first side effect.
    await env.DB.prepare(`INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,trigger_id,channel_id)
      SELECT 'racing-run',workspace_id,contact_id,automation_version_id,trigger_id,channel_id FROM flow_runs WHERE id=?`).bind(running).run()
    await expect(assertRunActive(env, 'racing-run')).rejects.toThrow('Flow run cancelled')
    expect(await env.DB.prepare("SELECT status FROM triggers WHERE id='trg-a'").first('status')).toBe('inactive')
    expect(await env.DB.prepare("SELECT status FROM keywords WHERE id='key-a'").first('status')).toBe('draft')
    expect((await request('automations/auto-a')).status).toBe(404)
    const after = makeEvent('99')
    await env.DB.prepare("INSERT INTO inbound_events(id,workspace_id,channel_id,payload) VALUES ('trash-input','a','ch-a',?)").bind(JSON.stringify(after.payload)).run()
    await dispatchInbound(after, 'trash-input', bindings as any)
    expect(await env.DB.prepare("SELECT count(*) AS n FROM flow_runs WHERE workspace_id='a' AND inbound_event_id='trash-input'").first('n')).toBe(0)
    expect(createWorkflow).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  } finally { fetchMock.mockRestore() }
  expect((await (await request('automation-library?trash=true')).json() as any).items).toHaveLength(1)
  expect((await mutate('automations/auto-a/restore')).status).toBe(200)
  expect(await env.DB.prepare("SELECT status,deleted_at FROM automations WHERE id='auto-a'").first()).toEqual({ status: 'stopped', deleted_at: null })
  expect(await env.DB.prepare("SELECT status FROM triggers WHERE id='trg-a'").first('status')).toBe('inactive')
  expect(await env.DB.prepare("SELECT status FROM keywords WHERE id='key-a'").first('status')).toBe('draft')
  expect((await mutate('automations/auto-a/triggers/trg-a', { enabled: true }, 'PATCH')).status).toBe(200)
  expect(await env.DB.prepare("SELECT status FROM keywords WHERE id='key-a'").first('status')).toBe('live')
  expect((await mutate('automations/auto-a/triggers/trg-a', { enabled: false }, 'PATCH')).status).toBe(200)
  expect(await env.DB.prepare("SELECT status FROM keywords WHERE id='key-a'").first('status')).toBe('live')
})

it('pagina 30 registros por updated_at e id sem repetição, com filtros de tipo e estado do mesmo gatilho', async () => {
  await env.DB.batch(Array.from({ length: 34 }, (_, i) => env.DB.prepare("INSERT INTO automations(id,workspace_id,name,updated_at) VALUES (?,'a',?,1000)").bind(`page-${i.toString().padStart(2, '0')}`, `Página ${i}`)))
  await env.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,name,kind,status) VALUES ('welcome-inactive','a','auto-a','Boas-vindas desligada','welcome_message','inactive')").run()
  const first = await (await request('automation-library')).json() as any
  expect(first.items).toHaveLength(30)
  expect(first.next_cursor).toEqual(expect.any(String))
  const next = await (await request(`automation-library?cursor=${encodeURIComponent(first.next_cursor)}`)).json() as any
  expect(next.items).toHaveLength(5)
  expect(next.next_cursor).toBeNull()
  expect(new Set([...first.items, ...next.items].map((a: any) => a.id)).size).toBe(35)
  expect((await (await request('automation-library?trigger_type=dm_keyword&trigger_status=active')).json() as any).items.map((a: any) => a.id)).toEqual(['auto-a'])
  expect((await (await request('automation-library?trigger_type=dm_keyword&trigger_status=inactive')).json() as any).items).toEqual([])
  expect((await (await request('automation-library?trigger_type=welcome&trigger_status=inactive')).json() as any).items.map((a: any) => a.id)).toEqual(['auto-a'])
  expect((await request('automation-library?cursor=invalid')).status).toBe(400)
  expect((await request('automation-library?trigger_type=invalid')).status).toBe(400)
  expect((await (await request('automations')).json() as any[]).length).toBe(35)
})

it('exclusão definitiva exige lixeira e recusa vínculos de regras sem afetar outro workspace', async () => {
  expect((await request('automations/auto-a', 'a', { method: 'DELETE' })).status).toBe(409)
  expect((await mutate('automations/auto-b/trash')).status).toBe(404)
  await mutate('automations/auto-a/publish')
  expect((await mutate('automations/auto-a/trash')).status).toBe(200)
  await env.DB.prepare("INSERT INTO rules(id,workspace_id,kind,event_type,action_type,automation_id) VALUES ('uses-a','a','internal_event','add_tag','start_flow','auto-a')").run()
  expect((await request('automations/auto-a', 'a', { method: 'DELETE' })).status).toBe(409)
  expect(await env.DB.prepare("SELECT id FROM automations WHERE id='auto-a'").first()).not.toBeNull()
  await env.DB.prepare("DELETE FROM rules WHERE id='uses-a'").run()
  await env.DB.prepare(`INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('references-a','a','Depende da original',
    '{"nodes":[{"id":"action","type":"action","position":{"x":0,"y":0},"config":{"automation_id":"auto-a"}}],"edges":[]}')`).run()
  expect((await request('automations/auto-a', 'a', { method: 'DELETE' })).status).toBe(409)
  await env.DB.prepare("DELETE FROM automations WHERE id='references-a'").run()
  expect((await request('automations/auto-a', 'a', { method: 'DELETE' })).status).toBe(200)
  expect(await env.DB.prepare("SELECT id FROM automations WHERE id='auto-a'").first()).toBeNull()
  expect(await env.DB.prepare("SELECT id FROM triggers WHERE id='trg-a'").first()).toBeNull()
  expect(await env.DB.prepare("SELECT id FROM automations WHERE id='auto-b'").first()).not.toBeNull()
})

it('mantém autorização por papel nas rotas de biblioteca e organização', async () => {
  expect(await (await request('folders')).json()).toMatchObject({ can_edit: true })
  await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE user_id='user-a'").run()
  expect((await request('folders')).status).toBe(200)
  expect(await (await request('folders')).json()).toMatchObject({ can_edit: false })
  expect((await request('automation-library')).status).toBe(200)
  expect((await mutate('folders', { name: 'Não pode' })).status).toBe(403)
  expect((await mutate('automations/auto-a/trash')).status).toBe(403)
  await env.DB.prepare("UPDATE workspace_members SET role='livechat_agent' WHERE user_id='user-a'").run()
  expect((await request('automation-library')).status).toBe(403)
})


it.each(['direct', 'group'] as const)('não dispara %s quando a automação vai à lixeira e volta enquanto o evento é planejado', async audience => {
  await mutate('automations/auto-a/publish')
  await env.DB.batch([
    env.DB.prepare("UPDATE channels SET type='telegram',provider='telegram_bot' WHERE id='ch-a'"),
    env.DB.prepare("UPDATE keywords SET status='live' WHERE id='key-a'"),
    env.DB.prepare("UPDATE triggers SET audience=?,group_match=?,repeat_mode='every_time' WHERE id='trg-a'").bind(audience, audience === 'group' ? 'keyword' : null),
    env.DB.prepare("INSERT INTO group_threads(id,workspace_id,channel_id,external_group_id) VALUES ('thread-a','a','ch-a','test-group')"),
    env.DB.prepare("INSERT INTO inbound_events(id,workspace_id,channel_id,payload) VALUES ('racing-input','a','ch-a','{}')"),
  ])
  let planning = false, intercepted = false
  const database = {
    prepare(sql: string) { if (sql.includes('INSERT INTO trigger_firings')) planning = true; return env.DB.prepare(sql) },
    async batch(statements: D1PreparedStatement[]) {
      if (planning && !intercepted) {
        intercepted = true
        expect((await mutate('automations/auto-a/trash')).status).toBe(200)
        expect((await mutate('automations/auto-a/restore')).status).toBe(200)
      }
      return env.DB.batch(statements)
    },
  }
  const createWorkflow = vi.fn(async () => ({}))
  const bindings = { ...env, DB: database, FLOW_RUN: { create: createWorkflow } }
  const event = { version: 1 as const, provider: 'telegram' as const, workspaceId: 'a', channelId: 'ch-a', eventId: '100', receivedAt: Date.now(),
    payload: { update_id: 100, message: { message_id: 100, from: { id: 100 }, chat: { id: 100, type: 'private' }, text: 'quero' } } }
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('HTTP externo proibido'))
  try {
    if (audience === 'direct') await dispatchInbound(event, 'racing-input', bindings as any)
    else {
      const group = { externalGroupId: 'test-group', mentionsMe: false }
      await planGroupRun(bindings as any, { connection: { profile: { groups: { reply: true } } } } as any,
        event, 'racing-input', { kind: 'message', externalUserId: 'user-a', externalMessageId: '100', text: 'quero', group } as any, group)
    }
    expect(intercepted).toBe(true)
    expect(await env.DB.prepare("SELECT count(*) FROM flow_runs WHERE workspace_id='a'").first('count(*)')).toBe(0)
    expect(await env.DB.prepare("SELECT count(*) FROM trigger_firings WHERE workspace_id='a'").first('count(*)')).toBe(0)
    expect(createWorkflow).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  } finally { fetchMock.mockRestore() }
})

it('salvar um gatilho já ativo não publica uma palavra irmã que continua em rascunho', async () => {
  await env.DB.prepare("INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES ('sibling-a','a','trg-a','is','[\"reservada\"]','draft',2)").run()
  await env.DB.prepare("UPDATE keywords SET status='live' WHERE id='key-a'").run()
  expect((await mutate('automations/auto-a/publish')).status).toBe(201)   // ativar gatilho exige automação publicada
  expect((await mutate('automations/auto-a/triggers/trg-a', { enabled: true, keyword_id: 'key-a', words: ['curso'] }, 'PATCH')).status).toBe(200)
  expect(await env.DB.prepare("SELECT status FROM keywords WHERE id='sibling-a'").first('status')).toBe('draft')
})


it('snapshots internos de transmissões ficam fora da biblioteca e lixeira e não podem ser restaurados', async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO automations(id,workspace_id,name,deleted_at) VALUES ('broadcast-internal','a','Snapshot interno',1)"),
    env.DB.prepare("INSERT INTO broadcasts(id,workspace_id,name,channel_id,automation_id) VALUES ('internal','a','Transmissão','ch-a','broadcast-internal')"),
  ])
  expect((await (await request('automation-library?trash=1')).json() as any).items).toEqual([])
  expect((await (await request('automation-library')).json() as any).items.map((item: any) => item.id)).toEqual(['auto-a'])
  expect(await (await request('folders')).json()).toMatchObject({ total: 1, unfiled: 1, trashed: 0 })
  expect((await mutate('automations/broadcast-internal/restore')).status).toBe(404)
  expect((await mutate('automations/broadcast-internal/trash')).status).toBe(404)
  expect((await request('automations/broadcast-internal', 'a', { method: 'DELETE' })).status).toBe(404)
  expect(await env.DB.prepare("SELECT deleted_at FROM automations WHERE id='broadcast-internal'").first('deleted_at')).toBe(1)
})

it('lista devolve a miniatura do fluxo: com passos vem desenhada, sem fluxo vem vazia', async () => {
  const solo = { nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} }], edges: [] }
  await env.DB.prepare("INSERT INTO automations(id,workspace_id,name,draft_graph) VALUES ('auto-vazia','a','Vazia',?)").bind(JSON.stringify(solo)).run()
  const page = await (await request('automation-library')).json() as { items: any[] }
  const comFluxo = page.items.find(i => i.id === 'auto-a')
  const semFluxo = page.items.find(i => i.id === 'auto-vazia')
  expect(comFluxo.flow_preview.nodes.length).toBeGreaterThan(1)
  expect(comFluxo.flow_preview.nodes[0]).toEqual({ id: expect.any(String), type: expect.any(String), x: expect.any(Number), y: expect.any(Number) })
  expect(comFluxo.flow_preview.edges.length).toBeGreaterThan(0)
  expect(JSON.stringify(comFluxo.flow_preview)).not.toContain('config')
  expect(semFluxo.flow_preview).toBeNull()
})
