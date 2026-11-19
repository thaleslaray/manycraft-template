import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'

beforeEach(async () => {
  await seedAuth()
  await authenticatedRequest('automations/auto-a/publish', 'a', { method: 'POST' })
})
const input = () => ({ name: 'Acolhimento', steps: [{ id: 'step-a', delay_seconds: 60,
  status: 'live', automation_id: 'auto-a', sending_time_settings: { type: 'timelimit', from: '09:00', to: '24:00', weekdays: [1, 2, 3, 4, 5] } }] })
const request = (path: string, method = 'GET', body?: unknown, workspace = 'a', cookie?: string) => authenticatedRequest(path, workspace,
  { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, cookie, { ...env, DEV_AUTO_LOGIN: '0' })

it('persiste CRUD com segundos, janela e dias e permite sequência vazia e nomes repetidos', async () => {
  const created = await request('sequences', 'POST', input())
  expect(created.status).toBe(201)
  const sequence = await created.json() as any
  expect(sequence).toMatchObject({ workspace_id: 'a', name: input().name, steps: input().steps, subscribers: 0, status: 'active' })
  expect(await (await request(`sequences/${sequence.id}`)).json()).toEqual(sequence)
  expect(await (await request('sequences')).json()).toEqual([sequence])
  const patch = { name: 'Novo '.repeat(12).trim(), steps: [{ ...input().steps[0], delay_seconds: 86400, sending_time_settings: { type: 'all' } }] }
  const updated = await request(`sequences/${sequence.id}`, 'PATCH', patch)
  expect(updated.status).toBe(200)
  expect(await updated.json()).toMatchObject(patch)
  expect((await request('sequences', 'POST', { name: patch.name, steps: [] })).status).toBe(201)
  expect((await request(`sequences/${sequence.id}`, 'DELETE')).status).toBe(200)
  expect((await request(`sequences/${sequence.id}`)).status).toBe(404)
  expect((await request(`sequences/${sequence.id}`, 'DELETE')).status).toBe(404)
})

it('recusa entidades estrangeiras e não altera nenhum workspace por IDs conhecidos', async () => {
  const a = await (await request('sequences', 'POST', input())).json() as any
  const b = await (await request('sequences', 'POST', { name: 'Outro', steps: [{ ...input().steps[0], id: 'step-b', status: 'draft', automation_id: 'auto-b' }] }, 'b')).json() as any
  expect((await request(`sequences/${b.id}`)).status).toBe(404)
  expect((await request(`sequences/${b.id}`, 'PATCH', { name: 'Inválida', steps: [] })).status).toBe(404)
  expect((await request(`sequences/${b.id}`, 'DELETE')).status).toBe(404)
  expect((await request('sequences', 'POST', { ...input(), steps: [{ ...input().steps[0], id: 'new-step', automation_id: 'auto-b' }] })).status).toBe(404)
  expect((await request(`sequences/${a.id}`, 'PATCH', { ...input(), steps: [{ ...input().steps[0], id: 'step-b' }] })).status).toBe(404)
  expect(await (await request(`sequences/${b.id}`, 'GET', undefined, 'b')).json()).toEqual(b)
  expect(await (await request(`sequences/${a.id}`)).json()).toEqual(a)
})

it('valida Zod, fluxo publicado e rollback sem substituir os passos ao falhar', async () => {
  const sequence = await (await request('sequences', 'POST', input())).json() as any
  const invalid = [ {}, { ...input(), name: ' ' }, { ...input(), extra: true }, { ...input(), steps: [input().steps[0], input().steps[0]] },
    ...[
      { delay_seconds: -1 }, { delay_seconds: 1.5 }, { delay_seconds: 99999 * 86400 + 1 }, { status: 'active' },
      { automation_id: null }, { unknown: true },
      ...[
        { type: 'all', weekdays: [1] }, { type: 'timelimit', from: '09:30', to: '18:00', weekdays: [1] },
        { type: 'timelimit', from: '18:00', to: '09:00', weekdays: [1] },
        { type: 'timelimit', from: '09:00', to: '18:00', weekdays: [] },
        { type: 'timelimit', from: '09:00', to: '18:00', weekdays: [1, 1] },
        { type: 'timelimit', from: '09:00', to: '18:00', weekdays: [7] },
      ].map(sending_time_settings => ({ sending_time_settings })),
    ].map(patch => ({ ...input(), steps: [{ ...input().steps[0], ...patch }] })),
  ]
  for (const body of invalid) expect((await request(`sequences/${sequence.id}`, 'PATCH', body)).status, JSON.stringify(body)).toBe(400)
  expect((await authenticatedRequest('sequences', 'a', { method: 'POST', body: '{bad' })).status).toBe(400)
  expect((await request('sequences?unknown=1')).status).toBe(400)
  expect(await (await request(`sequences/${sequence.id}`)).json()).toEqual(sequence)
  await env.DB.prepare("UPDATE automations SET status='stopped' WHERE id='auto-a'").run()
  expect((await request(`sequences/${sequence.id}`, 'PATCH', input())).status).toBe(400)
  expect((await request(`sequences/${sequence.id}`, 'PATCH', { ...input(), steps: [{ ...input().steps[0], status: 'draft' }] })).status).toBe(200)
})

it('autoriza leitura e edição por papel e lista apenas fluxos do workspace', async () => {
  expect(await (await request('sequences/flows')).json()).toEqual([{ id: 'auto-a', name: 'Automação a', published: true }])
  await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE user_id='user-a'").run()
  expect((await request('sequences')).status).toBe(200)
  expect((await request('sequences', 'POST', input())).status).toBe(403)
  await env.DB.prepare("UPDATE workspace_members SET role='livechat_agent' WHERE user_id='user-a'").run()
  expect((await request('sequences')).status).toBe(403)
  expect((await request('sequences/flows')).status).toBe(403)
  await env.DB.prepare("UPDATE workspace_members SET role='editor' WHERE user_id='user-a'").run()
  expect((await request('sequences', 'POST', input())).status).toBe(201)
})

it('mede envios, recibos e cliques reais por passo e sequência, sem duplicar eventos nem estimar recibos', async () => {
  const sequence = await (await request('sequences', 'POST', { ...input(), steps: [input().steps[0],
    { ...input().steps[0], id: 'step-second' }] })).json() as any
  const version = await env.DB.prepare("SELECT published_version_id FROM automations WHERE id='auto-a'").first<string>('published_version_id')
  for (const [run, step] of [['run-one', 'step-a'], ['run-two', 'step-second'], ['run-no-receipt', 'step-second']] as const) {
    await env.DB.prepare("INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,channel_id) VALUES (?,'a','c-a',?,'ch-a')")
      .bind(run, version).run()
    await env.DB.prepare("INSERT INTO sequence_flow_runs(run_id,workspace_id,sequence_id,step_id,contact_id,enrollment_id) VALUES (?,'a',?,?,'c-a','enrollment')")
      .bind(run, sequence.id, step).run()
  }
  const events = [
    ['run-one', 'one', 'sent'], ['run-one', 'one', 'sent'], ['run-one', 'one', 'read'],
    ['run-one', 'one', 'read'], ['run-one', 'one', 'clicked'], ['run-one', 'one', 'clicked'],
    ['run-one', 'two', 'sent'], ['run-one', 'two', 'delivered'],
    ['run-two', 'one', 'sent'], ['run-two', 'one', 'delivered'], ['run-no-receipt', 'one', 'sent'],
  ]
  for (const [run, node, type] of events) await env.DB.prepare("INSERT INTO node_events(workspace_id,automation_id,node_id,contact_id,flow_run_id,type) VALUES ('a','auto-a',?,'c-a',?,?) ON CONFLICT DO NOTHING")
    .bind(node, run, type).run()
  await env.DB.prepare("INSERT INTO node_events(workspace_id,automation_id,node_id,button_id,contact_id,flow_run_id,type) VALUES ('a','auto-a','one','other-button','c-a','run-one','clicked')").run()
  const actual = await (await request(`sequences/${sequence.id}`)).json() as any
  expect(actual.stats).toEqual({ sent: 4, delivered: 3, read: 1, clicked: 1, open_rate: 100 / 3, ctr: 100 / 3 })
  expect(actual.steps[0].stats).toEqual({ sent: 2, delivered: 2, read: 1, clicked: 1, open_rate: 50, ctr: 50 })
  expect(actual.steps[1].stats).toEqual({ sent: 2, delivered: 1, read: 0, clicked: 0, open_rate: 0, ctr: 0 })
  expect(await (await request('sequences')).json()).toEqual([actual])
  const empty = await (await request('sequences', 'POST', { name: 'Sem recibos', steps: [] })).json() as any
  expect(empty.stats).toEqual({ sent: 0, delivered: 0, read: 0, clicked: 0, open_rate: 0, ctr: 0 })
  expect((await request(`sequences/${sequence.id}`, 'GET', undefined, 'b')).status).toBe(404)
})
