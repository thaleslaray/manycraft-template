import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { getDashboard, getInboxInsights, getInsights } from '../src/db/insights'
import type { Principal, Role } from '../src/permissions'
const from = Date.UTC(2026, 9, 20) / 1000, to = from + 2 * 86400
const filter = { from, to }
const principal = (workspaceId = 'a', role: Role = 'viewer'): Principal => ({ userId: 'reader', workspaceId, role })
const graph = '{"nodes":[],"edges":[]}'
async function message(ws: string, id: string, contact: string, channel: string, at: number,
  sender = 'human', status = 'sent', external = true, direction = 'out') {
  await env.DB.prepare(`INSERT INTO messages (id,workspace_id,conversation_id,direction,source,external_message_id,content,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).bind(`${ws}-${id}`, ws, `v-${ws}-${contact}-${channel}`, direction, direction === 'in' ? 'contact' : 'human',
    external ? `external-${ws}-${id}` : null, JSON.stringify({ sender, status, text: id }), at * 1000).run()
}
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM workspaces').run()
  for (const ws of ['a', 'b']) {
    await env.DB.prepare('INSERT INTO workspaces (id,name) VALUES (?,?)').bind(ws, ws).run()
    for (const type of ['instagram', 'telegram']) await env.DB.prepare('INSERT INTO channels (id,workspace_id,type,external_id) VALUES (?,?,?,?)')
      .bind(`${ws}-${type}`, ws, type, `${ws}-${type}`).run()
    for (const [id, at] of [['old', from - 86400], ['new', from], ['end', to]] as const) {
      await env.DB.prepare('INSERT INTO contacts (id,workspace_id,subscribed_at,created_at) VALUES (?,?,?,?)')
        .bind(`${ws}-${id}`, ws, at * 1000, at * 1000).run()
      for (const channel of id === 'old' ? ['instagram', 'telegram'] : ['instagram']) {
        const cc = `cc-${ws}-${id}-${channel}`
        await env.DB.prepare('INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id) VALUES (?,?,?,?,?)')
          .bind(cc, ws, `${ws}-${id}`, `${ws}-${channel}`, `${ws}-${id}`).run()
        await env.DB.prepare('INSERT INTO conversations (id,workspace_id,contact_channel_id,created_at,last_message_at) VALUES (?,?,?,?,?)')
          .bind(`v-${ws}-${id}-${channel}`, ws, cc, (from - 86400) * 1000, (from - 86400) * 1000).run()
      }
    }
    await env.DB.prepare("INSERT INTO automations (id,workspace_id,name,status,draft_graph) VALUES (?,?,?,'live',?)")
      .bind(`auto-${ws}`, ws, `Automação ${ws}`, graph).run()
    await env.DB.prepare('INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES (?,?,?,1,?)')
      .bind(`version-${ws}`, ws, `auto-${ws}`, graph).run()
    await env.DB.prepare("INSERT INTO triggers (id,workspace_id,automation_id,channel_id,name,kind,status,config) VALUES (?,?,?,?,'Entrada','keyword','active','{}')")
      .bind(`trigger-${ws}`, ws, `auto-${ws}`, `${ws}-instagram`).run()
    for (const [suffix, channel, at] of [['old', 'instagram', from - 1], ['new', 'instagram', from], ['tg', 'telegram', from]] as const) {
      await env.DB.prepare('INSERT INTO flow_runs (id,workspace_id,contact_id,automation_version_id,channel_id,created_at) VALUES (?,?,?,?,?,?)')
        .bind(`run-${ws}-${suffix}`, ws, `${ws}-old`, `version-${ws}`, `${ws}-${channel}`, at * 1000).run()
    }
    for (const [node, run, type, at] of [['sent', 'old', 'sent', from], ['click', 'old', 'clicked', from + 86400],
      ['tg-click', 'tg', 'clicked', from], ['early', 'old', 'clicked', from - 1], ['late', 'old', 'clicked', to]] as const) {
      await env.DB.prepare('INSERT INTO node_events (workspace_id,automation_id,node_id,contact_id,flow_run_id,type,created_at) VALUES (?,?,?,?,?,?,?)')
        .bind(ws, `auto-${ws}`, node, `${ws}-old`, `run-${ws}-${run}`, type, at * 1000).run()
    }
    await message(ws, 'first', 'old', 'instagram', from)
    await message(ws, 'second', 'old', 'instagram', from + 86400)
    await message(ws, 'tg', 'old', 'telegram', from)
    await message(ws, 'new', 'new', 'instagram', from, 'contact', 'sent', true, 'in')
    await message(ws, 'late', 'end', 'instagram', to)
    await message(ws, 'early', 'old', 'instagram', from - 1)
    await message(ws, 'failed', 'old', 'instagram', from, 'human', 'failed')
    await message(ws, 'pending', 'old', 'instagram', from, 'human', 'sent', false)
    await message(ws, 'note', 'old', 'instagram', from, 'note')
    await message(ws, 'system', 'old', 'instagram', from, 'system')
  }
})
it('filtra [from,to), canal e workspace sem duplicar contatos entre canais ou dias', async () => {
  const report = await getInsights(env, principal(), { ...filter, channel: 'instagram' })
  expect(report.points).toMatchObject([{ date: '2026-10-20', contacts: 2, messages: 1, clicks: 0 },
    { date: '2026-10-21', contacts: 1, messages: 1, clicks: 1 }])
  expect(report.totals).toMatchObject({ contacts: 2, messages: 2, clicks: 1, clickRate: 0.5 })
  expect(report.automations).toEqual([{ id: 'auto-a', name: 'Automação a', contacts: 1, messages: 1, clicks: 1, conversions: 0, revenue: 0 }])
  expect(report.metadata.automation_messages).toBe('sent_nodes')
  expect((await getInsights(env, principal(), { ...filter, channel: 'telegram' })).totals)
    .toMatchObject({ contacts: 1, messages: 1, clicks: 1, clickRate: 1 })
  expect((await getInsights(env, principal(), filter)).totals).toMatchObject({ contacts: 2, messages: 3, clicks: 2, clickRate: 2 / 3 })
  expect((await getInsights(env, principal('b'), filter)).automations[0].id).toBe('auto-b')
})
it('usa inscrições e execuções reais sem inventar deltas de estados atuais', async () => {
  const dashboard = await getDashboard(env, principal(), { ...filter, channel: 'instagram' })
  expect(dashboard.metrics.map(m => [m.key, m.value, m.delta])).toEqual([
    ['contacts', 3, 1], ['new_contacts', 1, 0], ['open_conversations', 2, null], ['live_automations', 1, null]])
  expect(dashboard.most_used).toEqual([{ id: 'auto-a', name: 'Automação a', status: 'live', runs: 1, unique_contacts: 1 }])
  expect(dashboard.empty).toBe(false)
  const telegram = await getDashboard(env, principal(), { ...filter, channel: 'telegram' })
  expect(telegram.metrics.map(m => m.value)).toEqual([1, 0, 1, 0])
  expect(telegram.most_used[0].runs).toBe(1)
  expect((await getDashboard(env, principal(), filter)).most_used[0].runs).toBe(2)
})
it('retorna zeros, série contínua e taxa nula sem dados; respeita dias parciais', async () => {
  const empty = await getInsights(env, principal(), { from: to, to: to + 86400, channel: 'email' })
  expect(empty.points).toEqual([{ date: "2026-10-22", contacts: 0, messages: 0, clicks: 0, new_contacts: 0, unsubscribed: 0, net: 0 }])
  expect(empty.totals).toMatchObject({ contacts: 0, messages: 0, clicks: 0, clickRate: null })
  expect(empty.automations).toEqual([])
  expect((await getDashboard(env, principal(), { ...filter, channel: 'email' })).empty).toBe(true)
  const partial = await getInsights(env, principal(), { from: from + 1, to: from + 86400 + 1, channel: 'instagram' })
  expect(partial.points.map(p => p.date)).toEqual(['2026-10-20', '2026-10-21'])
  expect(partial.totals).toMatchObject({ contacts: 1, messages: 1, clicks: 1, clickRate: 1 })
})
it('nega agente de inbox e valida filtros dentro do repositório, permitindo viewer', async () => {
  for (const get of [getDashboard, getInsights]) {
    await expect(get(env, principal('a', 'livechat_agent'), filter)).rejects.toMatchObject({ status: 403 })
    await expect(get(env, principal(), { from: to, to: from })).rejects.toMatchObject({ status: 400 })
    await expect(get(env, principal(), { from: NaN, to })).rejects.toMatchObject({ status: 400 })
    await expect(get(env, principal(), { from, to: from + 367 * 86400 })).rejects.toMatchObject({ status: 400 })
    await expect(get(env, principal(), { ...filter, channel: 'fax' as never })).rejects.toMatchObject({ status: 400 })
  }
})

it('crescimento, saldo, conversões por moeda e receita por automação', async () => {
  await env.DB.batch([
    env.DB.prepare("UPDATE contacts SET status='unsubscribed' WHERE id='a-old'"),
    env.DB.prepare("UPDATE contacts SET unsubscribed_at=? WHERE id='a-old'").bind((from + 3600) * 1000),
    env.DB.prepare("INSERT INTO conversion_events (id,workspace_id,contact_id,automation_id,run_id,event_name,value,currency,created_at) VALUES ('cv1','a','a-old','auto-a','run-a-new','Compra',100,'BRL',?)").bind((from + 60) * 1000),
    env.DB.prepare("INSERT INTO conversion_events (id,workspace_id,contact_id,automation_id,run_id,event_name,value,currency,created_at) VALUES ('cv2','a','a-old','auto-a','run-a-new','Compra',20,'USD',?)").bind((from + 60) * 1000),
  ])
  const report = await getInsights(env, principal(), filter)
  expect(report.totals).toMatchObject({ new_contacts: 1, unsubscribed: 1, net: 0 })
  expect(report.points[0]).toMatchObject({ new_contacts: 1, unsubscribed: 1, net: 0 })
  expect(report.conversions).toEqual({ events: [{ name: 'Compra', count: 2 }], revenue: [{ currency: 'BRL', value: 100 }, { currency: 'USD', value: 20 }] })
  expect(report.automations.find(a => a.id === 'auto-a')).toMatchObject({ conversions: 2, revenue: 120 })
  expect(report.by_channel?.map(c => c.channel).sort()).toEqual(['instagram', 'telegram'])
})

it('contatos excluídos não entram no total do Início nem na contagem da tag (mesma regra da lista de Contatos)', async () => {
  const antes = await getDashboard(env, principal(), filter)
  await env.DB.prepare("INSERT INTO tags (id,workspace_id,name) VALUES ('t-x','a','vip')").run()
  await env.DB.prepare("INSERT INTO contact_tags (workspace_id,contact_id,tag_id) VALUES ('a','a-old','t-x'),('a','a-new','t-x')").run()
  await env.DB.prepare("UPDATE contacts SET status='deleted' WHERE id='a-new'").run()
  const depois = await getDashboard(env, principal(), filter)
  expect(depois.metrics[0].value).toBe(antes.metrics[0].value - 1)
  const { listTags } = await import('../src/db/tags')
  expect((await listTags(env.DB, 'a')).find(t => t.id === 't-x')?.contact_count).toBe(1)
})

it('análise da caixa de entrada: taxa de resposta e tempo da primeira resposta humana', async () => {
  await message('a', 'pergunta', 'old', 'instagram', from + 10, 'contact', 'sent', true, 'in')
  const inbox = await getInboxInsights(env, principal(), filter)
  expect(inbox.conversations).toBe(2)
  expect(inbox.answered).toBe(1)
  expect(inbox.response_rate).toBe(0.5)
  expect(inbox.first_response_seconds).toBe(86390)
  await expect(getInboxInsights(env, principal(), { from, to: from + 100 * 86400 })).rejects.toThrow(/3 meses/)
})

it('painel inicial traz primeiros passos, canais, tempo economizado, mais engajados', async () => {
  const summary = await getDashboard(env, principal(), filter)
  expect(summary.checklist.map(s => [s.key, s.done])).toEqual([['connect', true], ['automation', true], ['publish', false], ['first_contact', true], ['team', false]])
  expect(summary.channels.map(c => c.type).sort()).toEqual(['instagram', 'telegram'])
  expect(summary.time_saved.minutes).toBe(1)
  expect(summary.most_engaged).toEqual([expect.objectContaining({ contact_id: 'a-new', messages: 1 })])
})
