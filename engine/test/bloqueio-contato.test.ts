import { env as runtime } from 'cloudflare:workers'
import { introspectWorkflow, type WorkflowIntrospector } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectionAdapter } from '../src/channels'
import { consumeInbound } from '../src/jobs'
import { webhooks, type InboundEvent, type IntegrationEnv } from '../src/integrations'
import { ChannelLimiter } from '../src/flow/limiter'
import { giveCredentials, testKeyring } from './credentials'
import { seed } from './fixtures'

// Auditoria "quem recebe mensagem", item 3: quem bloqueou a conta (blocked_at) não recebe automação; uma mensagem nova dele tira o bloqueio.
const ACCOUNT = '17841400000000001', USER = '987654321012345', KEY = 'CHAVE-DO-APP', HOST = 'https://graph.facebook.com/v26.0'
const blockedAt = () => runtime.DB.prepare("SELECT blocked_at FROM contact_channels WHERE channel_id='ch-u'").first<number | null>('blocked_at')

describe('Instagram (login unificado)', () => {
  let env: IntegrationEnv, accepted: InboundEvent[]
  beforeEach(async () => {
    await seed()
    accepted = []
    env = { DB: runtime.DB, ...testKeyring,
      INBOUND: { send: async (event: InboundEvent) => { accepted.push(event) } } as unknown as Queue<InboundEvent>,
      FLOW_RUN: { create: async () => ({}), get: async () => ({ sendEvent: async () => {}, status: async () => ({ status: 'running' }) }) } as unknown as NonNullable<IntegrationEnv['FLOW_RUN']> }
    await runtime.DB.prepare("INSERT INTO channels (id,workspace_id,type,provider,external_id) VALUES ('ch-u','a','instagram','instagram_unified',?)").bind(ACCOUNT).run()
    await giveCredentials(runtime, 'ch-u', { accessToken: 'TESTONLY', accountId: ACCOUNT, appSecret: KEY })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.startsWith(`${HOST}/${USER}?`)) return Response.json({ name: 'Maria Souza', username: 'maria' })
      return Response.json({ recipient_id: USER, message_id: 'mid.out' })
    })
  })
  afterEach(() => { vi.restoreAllMocks() })

  async function receive(mid: string, timestamp: number) {
    const body = JSON.stringify({ object: 'instagram', entry: [{ id: ACCOUNT, time: Math.floor(Date.now() / 1000),
      messaging: [{ sender: { id: USER }, recipient: { id: ACCOUNT }, timestamp, message: { mid, text: 'oi' } }] }] })
    const hmac = await crypto.subtle.importKey('raw', new TextEncoder().encode(KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const hex = [...new Uint8Array(await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(body)))].map(n => n.toString(16).padStart(2, '0')).join('')
    accepted = []
    expect((await webhooks.request('/meta', { method: 'POST', body, headers: { 'X-Hub-Signature-256': `sha256=${hex}` } }, env)).status).toBe(200)
    const messages = accepted.map(event => ({ body: event, attempts: 1, ack: vi.fn(), retry: vi.fn(), id: crypto.randomUUID(), timestamp: new Date() }))
    await consumeInbound({ messages } as unknown as MessageBatch<unknown>, env)
    for (const message of messages) expect(message.ack).toHaveBeenCalledOnce()
  }

  it('contato que bloqueou a conta não recebe automação: a recusa sai antes da Meta', async () => {
    await runtime.DB.batch([
      runtime.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in,window_expires_at,blocked_at) VALUES ('cc-u','a','c-a','ch-u',?,1,?,?)")
        .bind(USER, Date.now() + 86400000, Date.now() - 1000),
      runtime.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('ig-v','a','auto-a',1,'{}')"),
    ])
    await runtime.DB.prepare("INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,channel_id,current_node_id) VALUES ('ig-run','a','c-a','ig-v','ch-u','offer')").run()
    const adapter = await connectionAdapter(env, 'a', 'ch-u', 'instagram')
    const result = await adapter.send({ runId: 'ig-run', step: 1, part: 0, channelId: 'ch-u', externalUserId: USER, mode: { ok: true, mode: 'free' },
      run: { id: 'ig-run', workspace_id: 'a', contact_id: 'c-a', channel_id: 'ch-u', external_user_id: USER, channel_type: 'instagram',
        automation_version_id: 'ig-v', automation_id: 'auto-a', graph: '{}', start_node_id: null, depth: 0 } }, { kind: 'text', text: 'Oi' })
    expect(result).toMatchObject({ ok: false, reason: 'blocked' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('mensagem nova do contato tira o bloqueio; mensagem mais antiga que o bloqueio, entregue depois, não tira', async () => {
    await receive('ig.1', Date.now() - 60000)
    const at = Date.now() - 30000
    await runtime.DB.prepare("UPDATE contact_channels SET blocked_at=? WHERE channel_id='ch-u'").bind(at).run()
    await receive('ig.2', Date.now() - 45000)
    expect(await blockedAt()).toBe(at)
    await receive('ig.3', Date.now())
    expect(await blockedAt()).toBeNull()
  })
})

describe('Telegram: fluxo para contato bloqueado', () => {
  let workflow: WorkflowIntrospector | undefined
  beforeEach(async () => {
    await seed()
    vi.spyOn(ChannelLimiter.prototype, 'acquire').mockResolvedValue({ allowed: true, retryAfter: 0 })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ ok: true, result: { message_id: 10, date: 1, chat: { id: 100 }, text: 'x' } }))
    const graph = { nodes: [
      { id: 'start', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
      { id: 'message', type: 'message', position: { x: 1, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Mensagem automática' }] } },
    ], edges: [{ from: 'start', port: 'next', to: 'message' }] }
    await runtime.DB.batch([
      runtime.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('tg-a','a','telegram','test-bot')"),
      runtime.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in,blocked_at) VALUES ('cc-tg','a','c-a','tg-a','100',1,?)").bind(Date.now() - 1000),
      runtime.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('v-tg','a','auto-a',1,?)").bind(JSON.stringify(graph)),
    ])
    await giveCredentials(runtime, 'tg-a', { botToken: 'TESTONLY', webhookSecret: 'secret-tg-a' })
  })
  afterEach(async () => { await workflow?.dispose(); workflow = undefined; vi.restoreAllMocks() })

  it('termina em channel_blocked sem chamar o Telegram', async () => {
    workflow = await introspectWorkflow(runtime.FLOW_RUN!)
    await workflow.modifyAll(async modifier => { await modifier.disableSleeps(); await modifier.disableRetryDelays() })
    await runtime.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,automation_version_id,channel_id) VALUES ('run-bloq','a','c-a','v-tg','tg-a')").run()
    await runtime.FLOW_RUN!.create({ id: 'run-bloq', params: { runId: 'run-bloq' } })
    const [instance] = await workflow.get()
    await instance.waitForStatus('errored')
    expect(await runtime.DB.prepare("SELECT status,error FROM flow_runs WHERE id='run-bloq'").first()).toEqual({ status: 'failed', error: 'channel_blocked' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
