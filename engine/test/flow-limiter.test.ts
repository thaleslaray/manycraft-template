import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, expect, it, vi } from 'vitest'
import { connectionAdapter, type SendContext } from '../src/channels'
import { seed } from './fixtures'

afterEach(() => vi.restoreAllMocks())

it('limitador conserva limite de chat após evicção e libera quando a janela passa', async () => {
  const limiter = env.CHANNEL_LIMITER!.getByName(crypto.randomUUID())
  expect(await limiter.acquire('100')).toEqual({ allowed: true, retryAfter: 0 })
  await evictDurableObject(limiter)
  expect(await limiter.acquire('100')).toEqual({ allowed: false, retryAfter: 1 })
  expect(await limiter.acquire('200')).toEqual({ allowed: true, retryAfter: 0 })
  await runInDurableObject(limiter, async (_instance, state) => {
    await state.storage.put('chat:100', { tokens: 0, at: Date.now() - 1001 })
  })
  expect(await limiter.acquire('100')).toEqual({ allowed: true, retryAfter: 0 })
})

it('limitador coordena teto global do bot e limpa chats inativos pelo alarm', async () => {
  const limiter = env.CHANNEL_LIMITER!.getByName(crypto.randomUUID())
  await runInDurableObject(limiter, async (_instance, state) => {
    await state.storage.put('channel', { tokens: 0, at: Date.now() + 10000 })
    await state.storage.put('chat:old', { tokens: 0, at: Date.now() - 120000 })
    await state.storage.put('chat:recent', { tokens: 0, at: Date.now() })
    await state.storage.setAlarm(Date.now() + 60000)
  })
  expect(await limiter.acquire('new-chat')).toEqual({ allowed: false, retryAfter: 1 })
  await runDurableObjectAlarm(limiter)
  await runInDurableObject(limiter, async (_instance, state) => {
    expect(await state.storage.get('chat:old')).toBeUndefined()
    expect(await state.storage.get('chat:recent')).toBeDefined()
  })
})

it('na entrega da automação, o limite do chat barra a rede e deixa a parte pronta; contexto de outra conexão não tem efeito', async () => {
  await seed()
  await env.DB.batch([
    env.DB.prepare("UPDATE channels SET type='telegram',provider='telegram_bot' WHERE id='ch-a'"),
    env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('limit-v','a','auto-a',1,'{}')"),
    env.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,automation_version_id,channel_id) VALUES ('limit-run','a','c-a','limit-v','ch-a')"),
  ])
  const fetch = vi.spyOn(globalThis, 'fetch')
  const context: SendContext = { runId: 'limit-run', step: 1, part: 0, channelId: 'ch-a', externalUserId: 'user-a', mode: { ok: true, mode: 'free' },
    run: { id: 'limit-run', workspace_id: 'a', contact_id: 'c-a', channel_id: 'ch-a', channel_type: 'telegram', automation_version_id: 'limit-v',
      automation_id: 'auto-a', graph: '{}', start_node_id: null, depth: 0, external_user_id: 'user-a' } }
  // This chat already used its second on the connection's limiter.
  await runInDurableObject(env.CHANNEL_LIMITER!.getByName('ch-a'), async (_instance, state) => { await state.storage.put('chat:user-a', { tokens: 0, at: Date.now() }) })
  const adapter = await connectionAdapter(env, 'a', 'ch-a', 'telegram')
  expect(await adapter.send({ ...context, channelId: 'ch-b' }, { kind: 'text', text: 'Teste' })).toMatchObject({ ok: false, reason: 'rejected', code: 'context_mismatch' })
  expect(await adapter.send(context, { kind: 'text', text: 'Teste' })).toEqual({ ok: false, reason: 'rate_limited', retryAfterSec: 1 })
  expect(fetch).not.toHaveBeenCalled()
  expect(await env.DB.prepare("SELECT status FROM flow_outbound WHERE run_id='limit-run'").first('status')).toBe('ready')
  expect(await env.DB.prepare("SELECT count(*) AS n FROM messages WHERE source='automation'").first('n')).toBe(0)
})
