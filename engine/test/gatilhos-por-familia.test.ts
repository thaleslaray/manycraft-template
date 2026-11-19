import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest, seedAuth, fixtureCookie } from './auth-helpers'

beforeEach(seedAuth)

type Family = { id: string; label: string; active: number; total: number; runs_30d: number; items: { id: string; name: string; type_channel: string; active: boolean; runs_30d: number; target: { kind: string; automation_id?: string; screen?: string } }[] }
const overview = async (workspace = 'a') => (await (await authenticatedRequest('triggers/overview', workspace)).json() as { families: Family[] }).families

const widget = (id: string, type: string, status = 'active') =>
  env.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status,config) VALUES (?,?,?,?,?,'widget',?,?,'{}')").bind(id, 'a', 'auto-a', 'ch-a', id, type, status)
const run = (id: string, trigger: string, at: number) => env.DB.prepare('INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,trigger_id,channel_id,created_at) VALUES (?,?,?,?,?,?,?)').bind(id, 'a', 'c-a', 'v-a', trigger, 'ch-a', at)

it('agrupa os gatilhos da conta por família, com ativos/total e execuções em 30 dias', async () => {
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) SELECT 'v-a','a','auto-a',1,draft_graph FROM automations WHERE id='auto-a'"),
    env.DB.prepare("UPDATE automations SET status='live' WHERE id='auto-a'"),
    widget('com-1', 'feed_comment'), widget('com-2', 'feed_comment', 'draft'), widget('ref-1', 'messenger_ref_url'),
    env.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,config) VALUES ('boas','a','auto-a','ch-a','Boas-vindas','welcome_message','active','{}')"),
    run('r1', 'trg-a', now - 86400000), run('r2', 'trg-a', now - 40 * 86400000), run('r3', 'com-1', now), run('r4', 'com-1', now),
  ])
  const families = await overview()
  const by = Object.fromEntries(families.map(f => [f.id, f]))
  expect(families.filter(f => f.total > 0).map(f => f.id)).toEqual(['keywords', 'comments', 'references', 'basic'])
  expect(families.map(f => f.id)).toEqual(['keywords', 'comments', 'live', 'stories', 'references', 'ads', 'cart', 'basic', 'confirmations', 'surfaces', 'rules', 'externals'])
  expect(by.comments.items.find(i => i.id === 'com-1')).toMatchObject({ type_code: 15, type_key: 'ig_comment:instagram' })
  expect(by.references.items[0]).toMatchObject({ type_code: 8, type_key: 'ref_url:instagram' })
  expect(by.keywords).toMatchObject({ label: 'Palavras-chave', active: 1, total: 1, runs_30d: 1 })
  expect(by.comments).toMatchObject({ active: 1, total: 2, runs_30d: 2 })
  expect(by.comments.items.find(i => i.id === 'com-1')).toMatchObject({ type_channel: 'Comentário · Instagram', active: true, runs_30d: 2, target: { kind: 'automation', automation_id: 'auto-a' } })
  expect(by.references.items[0]).toMatchObject({ type_channel: 'Link de referência · Instagram' })
  expect(by.basic.items[0]).toMatchObject({ name: 'Boas-vindas', target: { kind: 'screen', screen: 'basic' } })
})

it('gatilho ligado de automação que não está ao vivo não conta como ativo', async () => {
  await env.DB.batch([widget('com-1', 'feed_comment'), env.DB.prepare("UPDATE triggers SET status='active' WHERE id='trg-a'")])
  const draft = Object.fromEntries((await overview()).map(f => [f.id, f]))
  expect(draft.comments).toMatchObject({ active: 0, total: 1 })
  expect(draft.keywords).toMatchObject({ active: 0, total: 1 })
  await env.DB.prepare("UPDATE automations SET status='live' WHERE id='auto-a'").run()
  expect(Object.fromEntries((await overview()).map(f => [f.id, f])).comments).toMatchObject({ active: 1, total: 1 })
})

it('família sem gatilho aparece zerada, com status e contadores próprios', async () => {
  await env.DB.prepare("DELETE FROM triggers").run()
  const families = await overview()
  expect(families).toHaveLength(12)
  expect(families.every(f => f.total === 0 && f.active === 0 && f.runs_30d === 0 && f.items.length === 0)).toBe(true)
})

it('inclui iniciadores/menu publicados e regras, e não mistura outro workspace', async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO conversation_surfaces(workspace_id,connection_id,kind,draft,published) VALUES ('a','ch-a','main_menu','{}',?)")
      .bind(JSON.stringify({ enabled: true, items: [{ id: 'i1', title: 'Preços', automation_id: 'auto-a', payload: 's:x' }] })),
    env.DB.prepare("INSERT INTO rules(id,workspace_id,name,kind,event_type,action_type,automation_id,active,status) VALUES ('rule-1','a','Cuidar de quem comprou','internal_event','add_tag','start_flow','auto-a',1,'active')"),
    env.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,config) VALUES ('kw-b','b','auto-b','ch-b','Outra conta','keyword','active','{}')"),
  ])
  const by = Object.fromEntries((await overview()).map(f => [f.id, f]))
  expect(by.surfaces.items[0]).toMatchObject({ name: 'Preços', type_channel: 'Menu principal · Instagram', active: true, target: { kind: 'screen', screen: 'basic' } })
  expect(by.rules.items[0]).toMatchObject({ name: 'Cuidar de quem comprou', active: true, target: { kind: 'screen', screen: 'rules' } })
  expect(by.keywords.items.map(i => i.id)).not.toContain('kw-b')
})

it('quem não pode ler automações recebe 403', async () => {
  await env.DB.prepare("UPDATE workspace_members SET role='livechat_agent' WHERE workspace_id='a'").run()
  expect((await authenticatedRequest('triggers/overview')).status).toBe(403)
  expect(await fixtureCookie()).toBeTruthy()
})
