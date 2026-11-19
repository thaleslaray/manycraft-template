import { env } from 'cloudflare:workers'
import { afterEach, expect, it, vi } from 'vitest'
import { seed } from './fixtures'
import { testKeyring } from './credentials'
import { hooks } from '../src/channels/core/hooks'
import type { InboundEvent, IntegrationEnv } from '../src/integrations'

afterEach(() => vi.restoreAllMocks())
it('confirma o clique pelo endpoint da conexão, mantendo o transporte falso isolado', async () => {
  await seed()
  await env.DB.prepare(`UPDATE channels SET type='telegram',provider='telegram_bot',settings=? WHERE id='ch-a'`)
    .bind(JSON.stringify({ apiBase: 'http://127.0.0.1:6030' })).run()
  const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true, result: true }))
  const bindings = { DB: env.DB, ...testKeyring, INBOUND: { send: async (_: InboundEvent) => {} } as unknown as Queue<InboundEvent> } satisfies IntegrationEnv
  const click = { update_id: 7, callback_query: { id: 'clique-falso', from: { id: 100 }, data: `b:${'a'.repeat(24)}`, message: { chat: { id: 100, type: 'private' } } } }
  const pending: Promise<void>[] = []
  const response = await hooks.request('/ch-a', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'seed-secret-a' }, body: JSON.stringify(click) },
    bindings, { waitUntil: (p: Promise<void>) => pending.push(p), passThroughOnException() {}, props: {} })
  expect(response.status).toBe(200)
  await Promise.all(pending)
  expect(transport).toHaveBeenCalledWith('http://127.0.0.1:6030/botTESTONLY/answerCallbackQuery', expect.any(Object))
})
