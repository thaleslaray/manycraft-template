import { env as runtime } from 'cloudflare:workers'
import { introspectWorkflow, type WorkflowIntrospector } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectionAdapter, type SendContext } from '../src/channels'
import { rotateCredentials } from '../src/channels/core/connections'
import { broadcastOptions, getBroadcast, processBroadcastBatch, resumeBroadcast, saveBroadcast } from '../src/db/broadcasts'
import { ChannelLimiter } from '../src/flow/limiter'
import type { Env } from '../src/env'
import type { IntegrationEnv } from '../src/integrations'
import type { Principal } from '../src/permissions'
import { giveCredentials, testKeyring } from './credentials'
import { seed } from './fixtures'

// Auditoria "quem recebe mensagem", item 2: conexão com token recusado, desligada ou pareando não envia nada automático; consertada, volta a enviar.
const owner: Principal = { userId: 'test-owner', workspaceId: 'a', role: 'owner' }
const state = (id: string) => runtime.DB.prepare('SELECT connection_state FROM channels WHERE id=?').bind(id).first<string>('connection_state')

describe('Instagram (login unificado): token recusado e token novo', () => {
  const ACCOUNT = '17841400000000001', USER = '987654321012345', HOST = 'https://graph.facebook.com/v26.0'
  const graph = { nodes: [
    { id: 'start', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'offer', type: 'message', position: { x: 1, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Oi' }] } },
  ], edges: [{ from: 'start', port: 'next', to: 'offer' }] }
  const refused = () => Response.json({ error: { message: 'Invalid OAuth access token', type: 'OAuthException', code: 190 } }, { status: 401 })
  let env: IntegrationEnv, context: SendContext, answer: () => Response
  const sends = () => vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === `${HOST}/${ACCOUNT}/messages`).length
  const send = async (step: number) => (await connectionAdapter(env, 'a', 'ch-u', 'instagram')).send({ ...context, step }, { kind: 'text', text: 'Oi' })

  beforeEach(async () => {
    await seed()
    env = { DB: runtime.DB, ...testKeyring } as IntegrationEnv
    await runtime.DB.batch([
      runtime.DB.prepare("INSERT INTO channels (id,workspace_id,type,provider,external_id) VALUES ('ch-u','a','instagram','instagram_unified',?)").bind(ACCOUNT),
      runtime.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in,window_expires_at) VALUES ('cc-u','a','c-a','ch-u',?,1,?)").bind(USER, Date.now() + 86400000),
      runtime.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('ig-v','a','auto-a',1,?)").bind(JSON.stringify(graph)),
    ])
    await runtime.DB.prepare("INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,channel_id,current_node_id) VALUES ('ig-run','a','c-a','ig-v','ch-u','offer')").run()
    await giveCredentials(runtime, 'ch-u', { accessToken: 'TESTONLY-ANTIGO', accountId: ACCOUNT, appSecret: 'segredo' })
    context = { runId: 'ig-run', step: 1, part: 0, channelId: 'ch-u', externalUserId: USER, mode: { ok: true, mode: 'free' },
      run: { id: 'ig-run', workspace_id: 'a', contact_id: 'c-a', channel_id: 'ch-u', external_user_id: USER, channel_type: 'instagram',
        automation_version_id: 'ig-v', automation_id: 'auto-a', graph: JSON.stringify(graph), start_node_id: null, depth: 0 } }
    answer = () => Response.json({ recipient_id: USER, message_id: `mid.${sends()}` })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input instanceof Request ? input.url : input)
      if (url === `${HOST}/${ACCOUNT}/messages`) return answer()
      if (url === `${HOST}/${ACCOUNT}?fields=id,username`) return Response.json({ id: ACCOUNT, username: 'loja' })
      return Response.json({ success: true })
    })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('a Meta recusa o token (190): a conexão fica com erro e o envio automático seguinte é barrado antes da rede', async () => {
    answer = refused
    expect(await send(1)).toMatchObject({ ok: false, reason: 'rejected', code: '190' })
    expect(await state('ch-u')).toBe('error')
    expect(await send(2)).toMatchObject({ ok: false, reason: 'rejected', code: 'connection_unavailable' })
    expect(sends()).toBe(1)
  })
  it('token novo colado: a conexão fica pendente até o primeiro webhook e já envia; outra recusa nesse estado volta a marcar erro', async () => {
    await runtime.DB.prepare("UPDATE channels SET connection_state='error' WHERE id='ch-u'").run()
    await rotateCredentials(runtime as unknown as Env, 'a', 'ch-u', { accessToken: 'TESTONLY-NOVO', accountId: ACCOUNT, appSecret: 'segredo' }, 'https://engine.test')
    expect(await state('ch-u')).toBe('pending')
    expect(await send(1)).toMatchObject({ ok: true })
    answer = refused
    expect(await send(2)).toMatchObject({ ok: false, reason: 'rejected', code: '190' })
    expect(await state('ch-u')).toBe('error')
  })
})

describe('Telegram: fluxo, transmissão e compositor numa conexão fora do ar', () => {
  const single = { nodes: [
    { id: 'start', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'message', type: 'message', position: { x: 1, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Mensagem automática' }] } },
  ], edges: [{ from: 'start', port: 'next', to: 'message' }] }
  let workflow: WorkflowIntrospector | undefined
  beforeEach(async () => {
    await seed()
    vi.spyOn(ChannelLimiter.prototype, 'acquire').mockResolvedValue({ allowed: true, retryAfter: 0 })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      expect(String(input instanceof Request ? input.url : input)).toBe('https://api.telegram.org/botTESTONLY/sendMessage')
      return Response.json({ ok: true, result: { message_id: 10, date: 1, chat: { id: 100 }, text: 'x' } })
    })
    await runtime.DB.batch([
      runtime.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('tg-a','a','telegram','test-bot')"),
      runtime.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('cc-tg','a','c-a','tg-a','100',1)"),
      runtime.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('v-tg','a','auto-a',1,?)").bind(JSON.stringify(single)),
      runtime.DB.prepare("UPDATE automations SET status='live',published_version_id='v-tg' WHERE id='auto-a'"),
    ])
    await giveCredentials(runtime, 'tg-a', { botToken: 'TESTONLY', webhookSecret: 'secret-tg-a' })
  })
  afterEach(async () => { await workflow?.dispose(); workflow = undefined; vi.restoreAllMocks() })

  it('o fluxo para sem chamar o Telegram enquanto a conexão está com erro (espera o conserto: flow-espera-conexao.test.ts)', async () => {
    workflow = await introspectWorkflow(runtime.FLOW_RUN!)
    await workflow.modifyAll(async modifier => { await modifier.disableSleeps(); await modifier.disableRetryDelays() })
    await runtime.DB.batch([
      runtime.DB.prepare("UPDATE channels SET connection_state='error' WHERE id='tg-a'"),
      runtime.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,automation_version_id,channel_id) VALUES ('run-erro','a','c-a','v-tg','tg-a')"),
    ])
    await runtime.FLOW_RUN!.create({ id: 'run-erro', params: { runId: 'run-erro' } })
    await vi.waitFor(async () => expect(await runtime.DB.prepare("SELECT status,wait_reason FROM flow_runs WHERE id='run-erro'").first())
      .toEqual({ status: 'waiting_delay', wait_reason: 'connection' }), { timeout: 20000 })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('a transmissão pausa com o motivo sem chamar o Telegram; retomada depois do conserto, envia', async () => {
    const env = { ...runtime, APP_ENV: 'development', CHANNEL_LIMITER: undefined, INBOUND: { send: vi.fn(async () => {}) } } as unknown as Env
    await runtime.DB.prepare("UPDATE channels SET connection_state='error' WHERE id='tg-a'").run()
    const b = await saveBroadcast(env, owner, { name: 'Aviso', content: 'Olá!', status: 'sending', audience: { tag: 'all', channel: 'telegram', channel_id: 'tg-a' } })
    await processBroadcastBatch(env, 'a', b.id)
    expect(fetch).not.toHaveBeenCalled()
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ status: 'paused', pause_reason: 'connection_unavailable', metrics: { sent: 0, queued: 1 } })
    await runtime.DB.prepare("UPDATE channels SET connection_state='connected' WHERE id='tg-a'").run()
    await resumeBroadcast(env, owner, b.id)
    await processBroadcastBatch(env, 'a', b.id)
    expect(fetch).toHaveBeenCalledOnce()
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ status: 'sent', metrics: { sent: 1 } })
  })
  it('401 do Telegram numa transmissão: pausa com token_refused e o relatório traz o motivo do adaptador, não um texto genérico', async () => {
    const env = { ...runtime, APP_ENV: 'development', CHANNEL_LIMITER: undefined, INBOUND: { send: vi.fn(async () => {}) } } as unknown as Env
    vi.mocked(fetch).mockImplementation(async () => Response.json({ ok: false, error_code: 401, description: 'Unauthorized' }, { status: 401 }))
    const b = await saveBroadcast(env, owner, { name: 'Aviso', content: 'Olá!', status: 'sending', audience: { tag: 'all', channel: 'telegram', channel_id: 'tg-a' } })
    await processBroadcastBatch(env, 'a', b.id)
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ status: 'paused', pause_reason: 'token_refused',
      pause_detail: expect.stringMatching(/recusado pelo Telegram.*Trocar credencial/), metrics: { sent: 0, queued: 1 } })
    expect(await runtime.DB.prepare("SELECT connection_state FROM channels WHERE id='tg-a'").first('connection_state')).toBe('error')
  })
  it('conexão restrita: quem está fora da janela não é queimado; a transmissão pausa com motivo próprio e envia quando a restrição acaba', async () => {
    const env = { ...runtime, APP_ENV: 'development', CHANNEL_LIMITER: undefined, INBOUND: { send: vi.fn(async () => {}) } } as unknown as Env
    await runtime.DB.prepare("UPDATE channels SET connection_state='restricted' WHERE id='tg-a'").run()
    const b = await saveBroadcast(env, owner, { name: 'Aviso', content: 'Olá!', status: 'sending', audience: { tag: 'all', channel: 'telegram', channel_id: 'tg-a' } })
    await processBroadcastBatch(env, 'a', b.id)
    expect(fetch).not.toHaveBeenCalled()
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ status: 'paused', pause_reason: 'connection_restricted', metrics: { sent: 0, queued: 1 } })
    expect(await runtime.DB.prepare('SELECT status FROM broadcast_recipients WHERE broadcast_id=?').bind(b.id).first('status')).toBe('queued')
    await runtime.DB.prepare("UPDATE channels SET connection_state='connected' WHERE id='tg-a'").run()
    await resumeBroadcast(env, owner, b.id)
    await processBroadcastBatch(env, 'a', b.id)
    expect(fetch).toHaveBeenCalledOnce()
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ status: 'sent', metrics: { sent: 1 } })
  })
  it('o compositor oferece a conexão pendente ou restrita, não a com token recusado, desligada ou pareando', async () => {
    const offered = async () => (await broadcastOptions(runtime as unknown as Env, owner)).channels.some(c => c.id === 'tg-a')
    for (const [connection, expected] of [['connected', true], ['pending', true], ['restricted', true], ['error', false], ['disconnected', false], ['connecting', false]] as const) {
      await runtime.DB.prepare("UPDATE channels SET connection_state=? WHERE id='tg-a'").bind(connection).run()
      expect(await offered(), connection).toBe(expected)
    }
  })
})

describe('Telegram: token recusado (401) leva a conexão a erro; erro temporário não', () => {
  const graph = { nodes: [
    { id: 'start', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'offer', type: 'message', position: { x: 1, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Oi' }] } },
  ], edges: [{ from: 'start', port: 'next', to: 'offer' }] }
  let env: IntegrationEnv, context: SendContext, answer: () => Response
  const sends = () => vi.mocked(fetch).mock.calls.length
  const send = async (step: number) => (await connectionAdapter(env, 'a', 'tg-r', 'telegram')).send({ ...context, step }, { kind: 'text', text: 'Oi' })
  beforeEach(async () => {
    await seed()
    env = { DB: runtime.DB, ...testKeyring } as IntegrationEnv
    await runtime.DB.batch([
      runtime.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id,connection_state) VALUES ('tg-r','a','telegram','test-bot','connected')"),
      runtime.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('cc-tg-r','a','c-a','tg-r','100',1)"),
      runtime.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('v-tg-r','a','auto-a',1,?)").bind(JSON.stringify(graph)),
    ])
    await runtime.DB.prepare("INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,channel_id,current_node_id) VALUES ('tg-run','a','c-a','v-tg-r','tg-r','offer')").run()
    await giveCredentials(runtime, 'tg-r', { botToken: 'TESTONLY', webhookSecret: 'secret-tg-r' })
    context = { runId: 'tg-run', step: 1, part: 0, channelId: 'tg-r', externalUserId: '100', mode: { ok: true, mode: 'free' },
      run: { id: 'tg-run', workspace_id: 'a', contact_id: 'c-a', channel_id: 'tg-r', external_user_id: '100', channel_type: 'telegram',
        automation_version_id: 'v-tg-r', automation_id: 'auto-a', graph: JSON.stringify(graph), start_node_id: null, depth: 0 } }
    answer = () => Response.json({ ok: true, result: { message_id: 10, date: 1, chat: { id: 100 }, text: 'Oi' } })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => answer())
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('401 do Telegram: conexão com erro, motivo em pt-BR, e o envio seguinte é barrado antes da rede', async () => {
    answer = () => Response.json({ ok: false, error_code: 401, description: 'Unauthorized' }, { status: 401 })
    expect(await send(1)).toMatchObject({ ok: false, reason: 'rejected', code: 'token_refused', detail: expect.stringMatching(/recusado pelo Telegram.*Trocar credencial/) })
    expect(await state('tg-r')).toBe('error')
    expect(await runtime.DB.prepare("SELECT status_detail FROM channels WHERE id='tg-r'").first('status_detail')).toMatch(/recusado pelo Telegram.*Trocar credencial/)
    expect(await send(2)).toMatchObject({ ok: false, reason: 'rejected', code: 'connection_unavailable' })
    expect(sends()).toBe(1)
  })
  it.each([
    ['500', () => Response.json({ ok: false, error_code: 500, description: 'Internal Server Error' }, { status: 500 })],
    ['429', () => Response.json({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } }, { status: 429 })],
    ['400', () => Response.json({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, { status: 400 })],
    ['rede', () => { throw new TypeError('network down') }],
  ])('%s do Telegram não marca a conexão', async (_, reply) => {
    answer = reply
    expect(await send(1)).toMatchObject({ ok: false })
    expect(await state('tg-r')).toBe('connected')
  })
})
