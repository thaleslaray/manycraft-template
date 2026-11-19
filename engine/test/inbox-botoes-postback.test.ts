import { env as runtime } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectionAdapter, type SendContext } from '../src/channels'
import type { IntegrationEnv } from '../src/integrations'
import { giveCredentials, testKeyring } from './credentials'
import { seed } from './fixtures'

// Vindo do antigo channels-sqlite.contract.ts (ponte node:sqlite, apagada): agora no D1 de verdade da suíte principal.
const context: SendContext = { runId: 'run-bt', step: 1, part: 0, channelId: 'tg-a', externalUserId: '100', mode: { ok: true, mode: 'free' },
  run: { id: 'run-bt', workspace_id: 'a', contact_id: 'c-a', channel_id: 'tg-a', channel_type: 'telegram', automation_version_id: 'v-bt',
    automation_id: 'auto-a', graph: '{}', start_node_id: null, depth: 0, external_user_id: '100' } }

beforeEach(async () => {
  await seed()
  await runtime.DB.batch([
    runtime.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('tg-a','a','telegram','test-bot')"),
    runtime.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('cc-bt','a','c-a','tg-a','100',1)"),
    runtime.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('v-bt','a','auto-a',1,'{}')"),
    runtime.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,automation_version_id,channel_id) VALUES ('run-bt','a','c-a','v-bt','tg-a')"),
  ])
  await giveCredentials(runtime, 'tg-a', { botToken: 'TESTONLY', webhookSecret: 'secret-tg-a' })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    expect(String(input instanceof Request ? input.url : input)).toBe('https://api.telegram.org/botTESTONLY/sendMessage')
    return Response.json({ ok: true, result: { message_id: 42 } })
  })
})
afterEach(() => { vi.restoreAllMocks() })

it('títulos repetidos mantêm o ID de cada postback na caixa de entrada', async () => {
  const adapter = await connectionAdapter({ DB: runtime.DB, ...testKeyring } as IntegrationEnv, 'a', 'tg-a', 'telegram')
  const buttons = ['first', 'second'].map(id => ({ type: 'postback' as const, id: `b:${id}`, title: 'Continuar' }))
  expect(await adapter.send({ ...context, inboxButtons: buttons.map(b => ({ id: b.id.slice(2), title: b.title, payload: b.id })) },
    { kind: 'text', text: 'Escolha', buttons })).toMatchObject({ ok: true })
  const row = await runtime.DB.prepare("SELECT content FROM messages WHERE external_message_id='telegram:tg-a:100:42'").first<{ content: string }>()
  expect(JSON.parse(row!.content).buttons).toEqual([{ id: 'first', title: 'Continuar' }, { id: 'second', title: 'Continuar' }])
})
