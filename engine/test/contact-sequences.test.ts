import { env } from 'cloudflare:workers'
import worker from '../src/index'
import { graph } from './fixtures'
import type { Env } from '../src/env'
import { beforeEach, expect, it, vi } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'

const request = (path: string, method = 'GET', body?: unknown) => authenticatedRequest(path, 'a', {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
beforeEach(async () => {
  await seedAuth()
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sequences(id,workspace_id,name) VALUES ('series-a','a','Conteúdo'),('series-b','b','Outro espaço')"),
    env.DB.prepare("INSERT INTO sequence_steps(id,workspace_id,sequence_id,position,delay_seconds,status) VALUES ('first-a','a','series-a',0,60,'live')"),
    env.DB.prepare("UPDATE channels SET status='connected' WHERE id='ch-a'"),
  ])
})

it('lote e perfil preservam progresso, cancelam e reiniciam sem rede; usam a última conexão de entrada', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sem rede real'))
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE contact_channels SET last_inbound_at=1000 WHERE id='cc-a'"),
      env.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id,display_name,status) VALUES ('ch-recent','a','telegram','test-recent','Conexão recente','connected')"),
      env.DB.prepare("INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('cc-recent','a','c-a','ch-recent','test-recent',1)"),
      env.DB.prepare("INSERT INTO conversations(id,workspace_id,contact_channel_id) VALUES ('recent-conv','a','cc-recent')"),
      env.DB.prepare(`INSERT INTO messages(id,workspace_id,conversation_id,direction,source,content,created_at) VALUES ('recent-message','a','recent-conv','in','contact','{"text":"Quero conteúdo"}',2000)`),
    ])
    const enroll = () => request('contacts/bulk-sequence', 'POST', { ids: ['c-a', 'c-a'], sequence_id: 'series-a' })
    expect((await enroll()).status).toBe(200)
    const read = async () => (await (await request('contacts/c-a/sequences')).json()) as { enrollment_id: string; next_at: number; next_step: number; connection_name: string }[]
    const original = (await read())[0]
    expect(original.connection_name).toBe('Conexão recente')
    expect(original.next_step).toBe(0)
    expect(original.next_at).toBeGreaterThan(Date.now() + 50_000)
    await enroll()
    expect(await read()).toEqual([original])
    expect((await request('contacts/c-a/sequences/series-a', 'DELETE')).status).toBe(200)
    expect(await read()).toEqual([])
    await enroll()
    expect((await read())[0].enrollment_id).not.toBe(original.enrollment_id)
    expect(network).not.toHaveBeenCalled()
  } finally { network.mockRestore() }
})

it('recusa lote misto, sequência de outro espaço, falta de consentimento e papel sem edição', async () => {
  const enroll = (ids = ['c-a'], sequence_id = 'series-a') => request('contacts/bulk-sequence', 'POST', { ids, sequence_id })
  const read = async () => (await (await request('contacts/c-a/sequences')).json())
  expect((await enroll(['c-a', 'c-b'])).status).toBe(409)
  expect(await read()).toEqual([])
  expect((await enroll(['c-a'], 'series-b')).status).toBe(404)
  expect((await request('contacts/c-b/sequences')).status).toBe(404)
  await env.DB.prepare("UPDATE contact_channels SET opted_in=0 WHERE id='cc-a'").run()
  expect((await enroll()).status).toBe(409)
  expect(await read()).toEqual([])
  await env.DB.prepare("UPDATE contact_channels SET opted_in=1 WHERE id='cc-a'").run()
  await env.DB.prepare("UPDATE channels SET connection_state='disconnected' WHERE id='ch-a'").run()
  expect((await enroll()).status).toBe(409)
  await env.DB.prepare("UPDATE channels SET connection_state='connected',archived_at=1 WHERE id='ch-a'").run()
  expect((await enroll()).status).toBe(409)
  await env.DB.prepare("UPDATE channels SET archived_at=NULL WHERE id='ch-a'").run()
  expect((await enroll()).status).toBe(200)
  expect((await request('contacts/c-b/sequences/series-a', 'DELETE')).status).toBe(200)
  expect(await read()).toHaveLength(1)
  await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE workspace_id='a'").run()
  expect((await enroll()).status).toBe(403)
  expect((await request('contacts/c-a/sequences/series-a', 'DELETE')).status).toBe(403)
  expect(await read()).toHaveLength(1)
})

it('tick de sequência planeja o passo elegível sem reconciliar provedores nem enviar fora do executor', async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('seq-version','a','auto-a',1,?)").bind(JSON.stringify(graph)),
    env.DB.prepare("UPDATE automations SET status='live',published_version_id='seq-version' WHERE id='auto-a'"),
    env.DB.prepare("UPDATE sequence_steps SET automation_id='auto-a',delay_seconds=0 WHERE id='first-a'"),
  ])
  expect((await request('contacts/bulk-sequence', 'POST', { ids: ['c-a'], sequence_id: 'series-a' })).status).toBe(200)
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sem rede real'))
  const create = vi.fn(async () => ({}))
  try {
    await worker.scheduled({ cron: '* * * * *' } as ScheduledController, { ...env, FLOW_RUN: { create } } as unknown as Env)
    const subscriptions = await (await request('contacts/c-a/sequences')).json() as { pending_run_id: string }[]
    expect(subscriptions[0].pending_run_id).toMatch(/^sequence-/)
    expect(create).toHaveBeenCalledTimes(1)
    expect(network).not.toHaveBeenCalled()
  } finally { network.mockRestore() }
})
