import { createExecutionContext, createMessageBatch, getQueueResult, introspectWorkflow, type WorkflowIntrospector } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'
import { giveCredentials } from './credentials'
import { graph } from './fixtures'
import { consumeInbound } from '../src/jobs'
import { ChannelLimiter } from '../src/flow/limiter'
import type { InboundEvent } from '../src/integrations'

// A política de disparo é gravada pela mesma rota que o painel usa (PATCH do gatilho) e vale no disparo seguinte.
let workflow: WorkflowIntrospector | undefined
let update = 0
let outgoing = 0
beforeEach(async () => {
  await seedAuth()
  update = 0
  outgoing = 0
  vi.spyOn(ChannelLimiter.prototype, 'acquire').mockResolvedValue({ allowed: true, retryAfter: 0 })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const body = await new Request(input, init).json() as { chat_id: number; text: string }
    return Response.json({ ok: true, result: { message_id: 5000 + ++outgoing, date: 1, chat: { id: body.chat_id }, text: body.text } })
  })
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('tg-a','a','telegram','test-bot')"),
    env.DB.prepare("UPDATE triggers SET channel_id='tg-a',repeat_mode='every_time',config='{\"node_id\":\"t\"}' WHERE id='trg-a'"),
    env.DB.prepare("UPDATE keywords SET status='live',rule='contains' WHERE id='key-a'"),
    env.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('v1','a','auto-a',1,?)").bind(JSON.stringify(graph)),
    env.DB.prepare("UPDATE automations SET status='live',published_version_id='v1' WHERE id='auto-a'"),
  ])
  await giveCredentials(env, 'tg-a', { botToken: 'TESTONLY', webhookSecret: 'secret-tg-a' })
  workflow = await introspectWorkflow(env.FLOW_RUN!)
  await workflow.modifyAll(async modifier => { await modifier.disableSleeps(); await modifier.disableRetryDelays() })
})
afterEach(async () => { await workflow?.dispose(); workflow = undefined; vi.restoreAllMocks() })

const patchPolicy = (repeat_mode: string) => authenticatedRequest('automations/auto-a/triggers/trg-a', 'a', { method: 'PATCH', body: JSON.stringify({ repeat_mode }) })
const reopened = async () => ((await (await authenticatedRequest('automations/auto-a/triggers')).json()) as { rows: { id: string; repeat_mode: string }[] }).rows.find(r => r.id === 'trg-a')!.repeat_mode
async function say(text = 'quero', user = 100) {
  const payload = { update_id: ++update, message: { message_id: update, from: { id: user, first_name: 'Pessoa' }, chat: { id: user, type: 'private' }, text } }
  const event: InboundEvent = { version: 1, provider: 'telegram', workspaceId: 'a', channelId: 'tg-a', eventId: String(update), receivedAt: Date.now(), payload }
  const batch = createMessageBatch('inbound', [{ id: `q-${crypto.randomUUID()}`, timestamp: new Date(), attempts: 1, body: event }])
  await consumeInbound(batch, env)
  expect((await getQueueResult(batch, createExecutionContext())).retryMessages).toEqual([])
}
const firings = async () => Number(await env.DB.prepare('SELECT count(*) n FROM trigger_firings').first('n'))

it('Sempre: o mesmo contato dispara a cada mensagem', async () => {
  expect((await patchPolicy('every_time')).status).toBe(200)
  expect(await reopened()).toBe('every_time')
  await say(); await say(); await say()
  expect(await firings()).toBe(3)
})

it('Uma vez a cada 24 horas: bloqueia dentro da janela e libera depois dela; outro contato não é afetado', async () => {
  expect((await patchPolicy('once_per_24_hours')).status).toBe(200)
  expect(await reopened()).toBe('once_per_24_hours')
  await say(); await say()
  expect(await firings()).toBe(1)
  await say('quero', 200)
  expect(await firings()).toBe(2)
  await env.DB.prepare('UPDATE trigger_firings SET fired_at=? WHERE trigger_id=?').bind(Date.now() - 86_400_001, 'trg-a').run()
  await say()
  expect(await firings()).toBe(3)
})

it('Uma vez por contato: nunca repete para o mesmo contato, mesmo depois de 24 horas', async () => {
  expect((await patchPolicy('once')).status).toBe(200)
  expect(await reopened()).toBe('once')
  await say(); await say()
  await env.DB.prepare('UPDATE trigger_firings SET fired_at=? WHERE trigger_id=?').bind(Date.now() - 90 * 86_400_000, 'trg-a').run()
  await say()
  expect(await firings()).toBe(1)
  await say('quero', 200)
  expect(await firings()).toBe(2)
})

it('mudar a política vale já no próximo disparo, sem republicar', async () => {
  await patchPolicy('once')
  await say(); await say()
  expect(await firings()).toBe(1)
  await patchPolicy('every_time')
  await say()
  expect(await firings()).toBe(2)
})

it('gatilho de comentário grava e devolve as três políticas pela mesma rota do painel', async () => {
  await env.DB.prepare("UPDATE channels SET external_id='17840001',provider='instagram_unified' WHERE id='ch-a'").run()
  await giveCredentials(env, 'ch-a', { accessToken: 'TESTONLY', accountId: '17840001' })
  await env.DB.prepare(`UPDATE triggers SET channel_id='ch-a',kind='widget',widget_type='feed_comment',post_scope='all',target_post_id=NULL,
    config='{"node_id":"t","include":[],"exclude":[]}' WHERE id='trg-a'`).run()
  for (const mode of ['once_per_24_hours', 'once', 'every_time']) {
    const response = await patchPolicy(mode)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: 'trg-a', repeat_mode: mode })
    expect(await env.DB.prepare("SELECT repeat_mode FROM triggers WHERE id='trg-a'").first('repeat_mode')).toBe(mode)
  }
  expect((await patchPolicy('sempre')).status).toBe(400)
})
