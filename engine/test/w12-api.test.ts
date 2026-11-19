import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import worker, { app } from '../src/index'
import type { Env } from '../src/env'

const start = Date.UTC(2026, 9, 20) / 1000, end = start + 86400
const bindings = { ...env, APP_ENV: 'development', DEV_AUTO_LOGIN: '1' } as Env
const body = (ws = 'a') => ({ name: 'Aviso de atendimento', content: 'Nosso atendimento começa em instantes.',
  audience: { tag: `tag-${ws}`, channel: 'telegram', channel_id: `channel-${ws}` }, status: 'draft' })
const request = (path: string, workspace = 'a', payload?: unknown) => app.request(`https://engine.test/api/${path}`, {
  method: payload === undefined ? 'GET' : 'POST',
  headers: { 'x-workspace': workspace, 'content-type': 'application/json', origin: 'https://engine.test' },
  ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
}, bindings)

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM workspaces').run()
  await env.DB.prepare('DELETE FROM "user"').run()
  for (const ws of ['a', 'b']) {
    await env.DB.prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)')
      .bind(`user-${ws}`, ws, `${ws}@example.test`, start * 1000, start * 1000).run()
    await env.DB.prepare('INSERT INTO workspaces (id,name) VALUES (?,?)').bind(ws, ws).run()
    await env.DB.prepare("INSERT INTO workspace_members (id,workspace_id,user_id,role) VALUES (?,?,?,'owner')")
      .bind(`member-${ws}`, ws, `user-${ws}`).run()
    await env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES (?,?,'telegram',?)")
      .bind(`channel-${ws}`, ws, `external-${ws}`).run()
    await env.DB.prepare('INSERT INTO tags (id,workspace_id,name) VALUES (?,?,?)').bind(`tag-${ws}`, ws, `Grupo ${ws}`).run()
    await env.DB.prepare('INSERT INTO contacts (id,workspace_id,subscribed_at) VALUES (?,?,?)').bind(`contact-${ws}`, ws, start * 1000).run()
    await env.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES (?,?,?,?,?,1)")
      .bind(`cc-${ws}`, ws, `contact-${ws}`, `channel-${ws}`, `external-contact-${ws}`).run()
    await env.DB.prepare('INSERT INTO contact_tags (workspace_id,contact_id,tag_id) VALUES (?,?,?)').bind(ws, `contact-${ws}`, `tag-${ws}`).run()
    await env.DB.prepare('INSERT INTO conversations (id,workspace_id,contact_channel_id) VALUES (?,?,?)').bind(`conversation-${ws}`, ws, `cc-${ws}`).run()
    for (const [suffix, at] of [['inside', start], ['boundary', end]] as const) {
      await env.DB.prepare(`INSERT INTO messages (id,workspace_id,conversation_id,direction,source,external_message_id,content,created_at)
        VALUES (?,?,?,'out','human',?,'{"sender":"human","status":"sent","text":"Aviso"}',?)`)
        .bind(`message-${ws}-${suffix}`, ws, `conversation-${ws}`, `ext-${ws}-${suffix}`, at * 1000).run()
    }
  }
})

it('rotas criam rascunho, listam opções/audiência e isolam IDs por workspace', async () => {
  const created = await request('broadcasts', 'a', body())
  expect(created.status).toBe(201)
  const broadcast = await created.json() as { id: string; workspace_id: string; status: string }
  expect(broadcast).toMatchObject({ workspace_id: 'a', status: 'draft' })
  expect(await (await request('broadcasts')).json()).toMatchObject([{ id: broadcast.id }])
  expect(await (await request('broadcasts', 'b')).json()).toEqual([])
  expect((await request(`broadcasts/${broadcast.id}`)).status).toBe(200)
  expect((await request(`broadcasts/${broadcast.id}`, 'b')).status).toBe(404)
  expect((await request('broadcasts', 'b', { ...body('b'), id: broadcast.id })).status).toBe(404)
  expect((await request(`broadcasts/${broadcast.id}/pause`, 'b', {})).status).toBe(404)
  expect((await request(`broadcasts/${broadcast.id}/resume`, 'b', {})).status).toBe(404)
  const options = await (await request('broadcasts/options')).json() as { channels: { id: string }[]; tags: { value: string }[] }
  expect(options.channels.map(c => c.id)).toEqual(['channel-a'])
  expect(options.tags.map(t => t.value)).toEqual(['all', 'tag-a'])
  const audience = await request('broadcasts/audience?tag=tag-a&channel=telegram&channel_id=channel-a')
  expect(audience.status).toBe(200)
  expect(await audience.json()).toEqual({ count: 1, eligible: 1 })
  expect((await request('broadcasts/audience?tag=tag-b&channel=telegram&channel_id=channel-a')).status).toBe(404)
})

it('rotas validam corpo, canal, filtros e agendamento antes de enviar', async () => {
  expect((await request('broadcasts', 'a', { ...body(), content: '' })).status).toBe(400)
  expect((await request('broadcasts', 'a', { ...body(), status: 'scheduled', scheduled_at: '2020-01-01T00:00:00Z' })).status).toBe(400)
  expect((await request('broadcasts', 'a', { ...body(), audience: { ...body().audience, channel: 'whatsapp' } })).status).toBe(400)
  expect((await request('broadcasts', 'a', { ...body(), audience: body('b').audience })).status).toBe(404)
  expect((await request('broadcasts?status=unknown')).status).toBe(400)
  expect((await request('broadcasts?extra=1')).status).toBe(400)
})

it('rotas dashboard/insights usam período em segundos, canal e dados do tenant', async () => {
  const query = `from=${start}&to=${end}&channel=telegram`
  const insights = await request(`insights?${query}`)
  expect(insights.status).toBe(200)
  expect(await insights.json()).toMatchObject({ totals: { contacts: 1, messages: 1, clicks: 0 },
    points: [{ date: '2026-10-20', contacts: 1, messages: 1, clicks: 0 }] })
  const dashboard = await request(`dashboard?${query}`)
  expect(dashboard.status).toBe(200)
  expect(await dashboard.json()).toMatchObject({ metrics: expect.arrayContaining([expect.objectContaining({ key: 'contacts', value: 1 }), expect.objectContaining({ key: 'new_contacts', value: 1 })]) })
  expect(await (await request(`insights?from=${start}&to=${end}&channel=email`)).json())
    .toMatchObject({ totals: { contacts: 0, messages: 0, clicks: 0, clickRate: null } })
  for (const path of ['dashboard', 'insights']) {
    expect((await request(`${path}?from=${end}&to=${start}`)).status).toBe(400)
    expect((await request(`${path}?from=${start}&to=${end}&channel=fax`)).status).toBe(400)
    expect((await request(`${path}?from=NaN&to=${end}`)).status).toBe(400)
  }
})

it('oculta automação interna soft-deleted do broadcast nas tabelas e preserva mensagens reais', async () => {
  await env.DB.prepare("INSERT INTO automations (id,workspace_id,name,status,deleted_at) VALUES ('internal','a','Envio interno','stopped',1)").run()
  await env.DB.prepare(`INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph)
    VALUES ('internal-version','a','internal',1,'{"nodes":[],"edges":[]}')`).run()
  await env.DB.prepare(`INSERT INTO flow_runs (id,workspace_id,contact_id,automation_version_id,channel_id,created_at)
    VALUES ('internal-run','a','contact-a','internal-version','channel-a',?)`).bind(start * 1000).run()
  await env.DB.prepare(`INSERT INTO node_events (workspace_id,automation_id,node_id,contact_id,flow_run_id,type,created_at)
    VALUES ('a','internal','send','contact-a','internal-run','sent',?)`).bind(start * 1000).run()
  const query = `from=${start}&to=${end}&channel=telegram`
  expect(await (await request(`dashboard?${query}`)).json()).toMatchObject({ most_used: [] })
  expect(await (await request(`insights?${query}`)).json()).toMatchObject({ automations: [], totals: { messages: 1 } })
})

it('o wrapper queue encaminha broadcast para consumo dedicado e confirma item ausente sem enviar', async () => {
  let acked = 0, retried = 0
  const message = { body: { kind: 'broadcast', workspaceId: 'a', broadcastId: 'absent' },
    ack() { acked++ }, retry() { retried++ } }
  await worker.queue({ messages: [message] } as unknown as MessageBatch<unknown>, bindings)
  expect(acked).toBe(1)
  expect(retried).toBe(0)
})
