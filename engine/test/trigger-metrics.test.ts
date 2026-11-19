import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'

beforeEach(seedAuth)

it('atribui execuções sem envio e recibos ao gatilho, com contatos únicos e isolamento', async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO contacts(id,workspace_id,first_name) VALUES ('c-other','a','Outro contato')"),
    env.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) SELECT 'v-a','a','auto-a',1,draft_graph FROM automations WHERE id='auto-a'"),
    env.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind) VALUES ('other','a','auto-a','ch-a','Outro','keyword')"),
  ])
  for (const [id, trigger] of [['r1', 'trg-a'], ['r2', 'trg-a'], ['r3', 'other']]) {
    await env.DB.prepare('INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,trigger_id,channel_id) VALUES (?,?,?,?,?,?)')
      .bind(id, 'a', id === 'r3' ? 'c-other' : 'c-a', 'v-a', trigger, 'ch-a').run()
  }
  for (const [run, node, type, button] of [['r1','m','sent',null], ['r1','m2','sent',null], ['r1','m','delivered',null], ['r1','m','read',null], ['r1','m','clicked','b'], ['r3','m','sent',null], ['r3','m','delivered',null], ['r3','m','read',null], ['r3','m','clicked','b']]) {
    await env.DB.prepare('INSERT INTO node_events(workspace_id,automation_id,contact_id,flow_run_id,node_id,type,button_id) VALUES (?,?,?,?,?,?,?)')
      .bind('a', 'auto-a', run === 'r3' ? 'c-other' : 'c-a', run, node, type, button).run()
  }
  const response = await authenticatedRequest('automations/auto-a/trigger-metrics?trigger_id=trg-a')
  expect(response.status).toBe(200)
  const stats = await response.json() as Record<string, number>
  // O Instagram do espaço avisa leitura, mas não entrega: delivered é null, não zero.
  expect(stats).toMatchObject({ runs: 2, optins: 0, sent: 1, delivered: null, read: 1, clicked: 1, ctr: 1 })
  const contacts = await (await authenticatedRequest('automations/auto-a/metric-contacts?trigger_id=trg-a&metric=read')).json()
  expect(contacts).toMatchObject({ contacts: [{ id: 'c-a', first_name: 'Mariana' }], next_cursor: null })
  expect((await (await authenticatedRequest('automations/auto-a/metric-contacts?metric=optins')).json())).toMatchObject({ contacts: [] })
  expect((await authenticatedRequest('automations/auto-b/trigger-metrics')).status).toBe(404)
  expect((await authenticatedRequest('automations/auto-a/trigger-metrics?trigger_id=trg-b')).status).toBe(404)
  expect((await authenticatedRequest('automations/auto-a/metric-contacts?metric=unknown')).status).toBe(400)
  const list = await (await authenticatedRequest('automations')).json() as { id: string; delivered: number; read: number }[]
  expect(list.find(a => a.id === 'auto-a')).toMatchObject({ delivered: 2, read: 2 })
})

it('preserva opt-in atribuído, filtra coorte e pagina contatos sem repetir', async () => {
  const now = Date.now()
  await env.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) SELECT 'v-a','a','auto-a',1,draft_graph FROM automations WHERE id='auto-a'").run()
  const statements: D1PreparedStatement[] = []
  for (let i = 0; i < 32; i++) {
    const id = `p-${String(i).padStart(2, '0')}`
    statements.push(env.DB.prepare('INSERT INTO contacts(id,workspace_id,first_name) VALUES (?,?,?)').bind(id, 'a', id))
    statements.push(env.DB.prepare('INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,trigger_id,trigger_opt_in,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(`r-${id}`, 'a', id, 'v-a', 'trg-a', 1, i === 31 ? now - 40 * 86400000 : now))
  }
  await env.DB.batch(statements)
  // Current contact consent may change without changing the historical trigger attribution.
  await env.DB.prepare("UPDATE contacts SET status='unsubscribed' WHERE workspace_id='a'").run()
  const stats = await (await authenticatedRequest('automations/auto-a/trigger-metrics?period_days=7')).json()
  expect(stats).toMatchObject({ runs: 31, optins: 31, sent: 0, ctr: null })
  const first = await (await authenticatedRequest('automations/auto-a/metric-contacts?metric=optins&period_days=7')).json() as { contacts: { id: string }[]; next_cursor: string }
  expect(first.contacts).toHaveLength(30)
  expect(first.next_cursor).toBe('p-29')
  const second = await (await authenticatedRequest(`automations/auto-a/metric-contacts?metric=optins&period_days=7&cursor=${first.next_cursor}`)).json()
  expect(second).toMatchObject({ contacts: [{ id: 'p-30' }], next_cursor: null })
  await env.DB.prepare("UPDATE workspace_members SET role='livechat_agent' WHERE workspace_id='a'").run()
  expect((await authenticatedRequest('automations/auto-a/trigger-metrics')).status).toBe(403)
  expect((await authenticatedRequest('automations/auto-a/metric-contacts?metric=runs')).status).toBe(403)
})

it('conta impressões do link de referência por gatilho, sem duplicar reenvio, e devolve null onde o canal não informa', async () => {
  const { recordTriggerImpressions } = await import('../src/db/trigger-metrics')
  await env.DB.batch([
    env.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status,config) VALUES ('ref-1','a','auto-a','ch-a','Link da bio','widget','messenger_ref_url','active',?)").bind(JSON.stringify({ ref: 'bio' })),
    env.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status,config) VALUES ('ref-2','a','auto-a','ch-a','Link do site','widget','messenger_ref_url','active',?)").bind(JSON.stringify({ ref: 'site' })),
  ])
  await recordTriggerImpressions(env.DB, 'a', 'ch-a', 'bio', 'ev-1')
  await recordTriggerImpressions(env.DB, 'a', 'ch-a', 'bio', 'ev-1')
  await recordTriggerImpressions(env.DB, 'a', 'ch-a', 'bio', 'ev-2')
  await recordTriggerImpressions(env.DB, 'a', 'ch-a', 'site', 'ev-3')
  await recordTriggerImpressions(env.DB, 'a', 'ch-a', 'desconhecido', 'ev-4')
  await env.DB.prepare("INSERT INTO trigger_impressions(workspace_id,trigger_id,event_key,occurred_at) VALUES ('a','ref-1','velho',?)").bind(Date.now() - 40 * 86400000).run()
  const all = await (await authenticatedRequest('automations/auto-a/trigger-metrics')).json() as { impressions: number | null }
  expect(all.impressions).toBe(3)
  expect((await (await authenticatedRequest('automations/auto-a/trigger-metrics?trigger_id=ref-1')).json() as { impressions: number }).impressions).toBe(2)
  expect((await (await authenticatedRequest('automations/auto-a/trigger-metrics?trigger_id=ref-1&period_days=90')).json() as { impressions: number }).impressions).toBe(3)
  // gatilho de palavra-chave: o canal não informa exibição
  expect((await (await authenticatedRequest('automations/auto-a/trigger-metrics?trigger_id=trg-a')).json() as { impressions: number | null }).impressions).toBeNull()
})

it('não promete impressões para o gatilho de anúncio do WhatsApp enquanto nenhum canal as informa', async () => {
  await env.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status,config) VALUES ('ctwa-1','a','auto-a','ch-a','Anúncio','widget','ctwa_trigger','active','{}')").run()
  expect((await (await authenticatedRequest('automations/auto-a/trigger-metrics?trigger_id=ctwa-1')).json() as { impressions: number | null }).impressions).toBeNull()
})

it('canal sem aviso de entrega nem leitura (Telegram) devolve null nas duas, e quem avisa segue com o número', async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('tg-a','a','telegram','bot-a')"),
    env.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind) VALUES ('tg-trg','a','auto-a','tg-a','Telegram','keyword')"),
    env.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) SELECT 'v-a','a','auto-a',1,draft_graph FROM automations WHERE id='auto-a'"),
    env.DB.prepare("INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,trigger_id,channel_id) VALUES ('tg-r','a','c-a','v-a','tg-trg','tg-a')"),
    env.DB.prepare("INSERT INTO node_events(workspace_id,automation_id,contact_id,flow_run_id,node_id,type) VALUES ('a','auto-a','c-a','tg-r','m','sent')"),
  ])
  const telegram = await (await authenticatedRequest('automations/auto-a/trigger-metrics?trigger_id=tg-trg')).json()
  expect(telegram).toMatchObject({ runs: 1, sent: 1, delivered: null, read: null })
  // Com um gatilho de canal que avisa leitura junto (Instagram), a leitura volta a ser contada.
  expect(await (await authenticatedRequest('automations/auto-a/trigger-metrics')).json()).toMatchObject({ sent: 1, delivered: null, read: 0 })
})
