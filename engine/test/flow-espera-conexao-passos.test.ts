import { env as runtime } from 'cloudflare:workers'
import { createExecutionContext, createMessageBatch, getQueueResult, introspectWorkflow, type WorkflowIntrospector } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelLimiter } from '../src/flow/limiter'
import { wakeConnectionWaits } from '../src/flow/connection-wait'
import type { FlowEnv } from '../src/flow/types'
import type { InboundEvent } from '../src/integrations'
import { consumeInbound } from '../src/jobs'
import { giveCredentials } from './credentials'
import { seed } from './fixtures'

// Pergunta, resposta privada a comentário, conexão desligada pela equipe e clique durante a espera de um lembrete:
// todos esperam a conexão do mesmo jeito que a mensagem comum (connection-wait.ts).
vi.setConfig({ testTimeout: 30000 })
const flowEnv = runtime as unknown as FlowEnv
const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, config })
const run = (id: string) => runtime.DB.prepare('SELECT status,wait_reason,error,wait_until,current_node_id FROM flow_runs WHERE id=?').bind(id)
  .first<{ status: string; wait_reason: string | null; error: string | null; wait_until: number | null; current_node_id: string | null }>()
const waiting = (id: string) => vi.waitFor(async () => expect(await run(id)).toMatchObject({ status: 'waiting_delay', wait_reason: 'connection' }), { timeout: 20000 })
let workflow: WorkflowIntrospector | undefined
let calls: { url: string; body: Record<string, any> }[] = []
/** Chamado depois de cada envio aceito (ex.: derrubar a conexão logo depois da primeira mensagem). */
let afterSend: ((count: number) => Promise<void>) | undefined
const telegramSends = () => calls.filter(c => c.url.endsWith('/sendMessage'))
const privateReplies = () => calls.filter(c => c.url.includes('graph.facebook.com') && c.url.endsWith('/messages'))

async function publish(id: string, graph: unknown) {
  await runtime.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES (?,'a','auto-a',?,?)")
    .bind(id, Math.floor(Math.random() * 1e9), JSON.stringify(graph)).run()
}
async function start(id: string, channel: string, state: string, version: string, extra: { comment_context?: string } = {}, timeouts: string[] = []) {
  workflow = await introspectWorkflow(runtime.FLOW_RUN!)
  await workflow.modifyAll(async modifier => {
    await modifier.disableSleeps(); await modifier.disableRetryDelays()
    for (const name of timeouts) await modifier.forceEventTimeout({ name })
  })
  await runtime.DB.batch([
    runtime.DB.prepare('UPDATE channels SET connection_state=? WHERE id=?').bind(state, channel),
    runtime.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,automation_version_id,channel_id,workflow_created_at,comment_context) VALUES (?,'a','c-a',?,?,?,?)")
      .bind(id, version, channel, Date.now(), extra.comment_context ?? null),
  ])
  await runtime.FLOW_RUN!.create({ id, params: { runId: id } })
  const [instance] = await workflow.get()
  return instance
}

beforeEach(async () => {
  await seed()
  calls = []; afterSend = undefined
  vi.spyOn(ChannelLimiter.prototype, 'acquire').mockResolvedValue({ allowed: true, retryAfter: 0 })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    const body = request.method === 'GET' ? {} : await request.json() as Record<string, any>
    if (request.url.includes('api.telegram.org')) {
      expect(request.url).toMatch(/^https:\/\/api\.telegram\.org\/botTESTONLY\/(sendMessage|sendChatAction|answerCallbackQuery)$/)
      calls.push({ url: request.url, body })
      if (request.url.endsWith('/sendMessage')) await afterSend?.(telegramSends().length)
      return Response.json({ ok: true, result: request.url.endsWith('/sendMessage') ? { message_id: 10 + calls.length, date: 1, chat: { id: 100 }, text: 'x' } : true })
    }
    expect(request.url).toMatch(/^https:\/\/graph\.facebook\.com\//)
    if (request.method === 'GET') return Response.json({ data: [] })
    calls.push({ url: request.url, body })
    return Response.json(request.url.endsWith('/messages') ? { message_id: `private-${calls.length}` } : { id: `public-${calls.length}`, success: true })
  })
  await runtime.DB.batch([
    runtime.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('tg-a','a','telegram','test-bot')"),
    runtime.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('cc-tg','a','c-a','tg-a','100',1)"),
    runtime.DB.prepare("UPDATE automations SET status='live' WHERE id='auto-a'"),
    runtime.DB.prepare("UPDATE channels SET external_id='17840001',provider='instagram_unified' WHERE id='ch-a'"),
  ])
  await giveCredentials(runtime, 'tg-a', { botToken: 'TESTONLY', webhookSecret: 'secret-tg-a' })
  await giveCredentials(runtime, 'ch-a', { accessToken: 'TESTONLY', accountId: '17840001' })
})
afterEach(async () => { await workflow?.dispose(); workflow = undefined; vi.restoreAllMocks() })

describe('pergunta espera a conexão', () => {
  const question = { nodes: [node('start', 'trigger'), node('ask', 'question', { text: 'Qual é o seu nome?', answer_type: 'text', field_id: 'system:first_name',
    retry_message: 'De novo, por favor.', max_attempts: 1, timeout: { value: 1, unit: 'days' } })], edges: [{ from: 'start', port: 'next', to: 'ask' }] }

  it('restrita: não falha com channel_rejected; espera, e depois do conserto envia a pergunta com o prazo de resposta contado do envio', async () => {
    await publish('v-q', question)
    await start('run-q', 'tg-a', 'restricted', 'v-q')
    await waiting('run-q')
    expect(telegramSends()).toHaveLength(0)
    // Dias de espera: o prazo da resposta, contado da abertura, já venceu quando a conexão volta.
    await runtime.DB.prepare("UPDATE flow_questions SET expires_at=? WHERE run_id='run-q'").bind(Date.now() - 1000).run()
    await runtime.DB.prepare("UPDATE channels SET connection_state='connected' WHERE id='tg-a'").run()
    expect(await wakeConnectionWaits(flowEnv)).toBe(1)
    // question-renew passa a execução para waiting_input antes do envio: espera os dois (conferir o envio logo depois do estado era uma corrida).
    await vi.waitFor(async () => {
      expect(await run('run-q')).toMatchObject({ status: 'waiting_input' })
      expect(telegramSends()).toHaveLength(1)
    }, { timeout: 20000 })
    const expires = await runtime.DB.prepare("SELECT expires_at FROM flow_questions WHERE run_id='run-q'").first<number>('expires_at')
    expect(expires).toBeGreaterThan(Date.now() + 23 * 3600_000)
    expect((await run('run-q'))!.wait_until).toBe(expires)
  })
})

describe('conexão desligada pela equipe', () => {
  const message = { nodes: [node('start', 'trigger'), node('message', 'message', { blocks: [{ kind: 'text', text: 'Mensagem automática' }] })], edges: [{ from: 'start', port: 'next', to: 'message' }] }

  it('desligada durante a espera: não falha com "Contact channel state missing"; segue esperando e só acorda quando religada', async () => {
    await publish('v-m', message)
    const instance = await start('run-off', 'tg-a', 'error', 'v-m')
    await waiting('run-off')
    await runtime.DB.prepare("UPDATE channels SET status='disconnected',connection_state='disconnected' WHERE id='tg-a'").run()
    expect(await wakeConnectionWaits(flowEnv)).toBe(0)
    // Prazo da espera (ou um aviso fora de hora): a execução tenta de novo e, com a conexão desligada, volta a esperar.
    await (await runtime.FLOW_RUN!.get('run-off')).sendEvent({ type: 'connection_restored', payload: {} })
    await instance.waitForStepResult({ name: 'connection-wait:send:1:1' })
    expect(await run('run-off')).toMatchObject({ status: 'waiting_delay', wait_reason: 'connection' })
    expect(telegramSends()).toHaveLength(0)
    await runtime.DB.prepare("UPDATE channels SET status='connected',connection_state='connected' WHERE id='tg-a'").run()
    expect(await wakeConnectionWaits(flowEnv)).toBe(1)
    await instance.waitForStatus('complete')
    expect(await run('run-off')).toMatchObject({ status: 'done' })
    expect(telegramSends()).toHaveLength(1)
  })
})

describe('resposta privada a comentário espera a conexão', () => {
  const opening = { nodes: [node('start', 'trigger'), node('reply', 'message', { blocks: [{ kind: 'text', text: 'Seu material está aqui.' }] })], edges: [{ from: 'start', port: 'next', to: 'reply' }] }
  const context = (createdAt: number) => JSON.stringify({ commentId: 'comment-1', createdAt, postId: 'post-1', postSnapshot: null, like: false })

  it('fora do ar: nada sai, espera e responde depois do conserto', async () => {
    await publish('v-c', opening)
    const instance = await start('run-c', 'ch-a', 'error', 'v-c', { comment_context: context(Date.now()) })
    await waiting('run-c')
    expect(privateReplies()).toHaveLength(0)
    await runtime.DB.prepare("UPDATE channels SET connection_state='connected' WHERE id='ch-a'").run()
    expect(await wakeConnectionWaits(flowEnv)).toBe(1)
    await instance.waitForStatus('complete')
    expect(await run('run-c')).toMatchObject({ status: 'done' })
    expect(privateReplies()).toHaveLength(1)
    expect(privateReplies()[0].body).toMatchObject({ recipient: { comment_id: 'comment-1' } })
  })

  it('desligada pela equipe durante a espera: segue esperando em vez de falhar', { timeout: 30000 }, async () => {
    await publish('v-c2', opening)
    const instance = await start('run-c2', 'ch-a', 'error', 'v-c2', { comment_context: context(Date.now()) })
    await waiting('run-c2')
    await runtime.DB.prepare("UPDATE channels SET status='disconnected',connection_state='disconnected' WHERE id='ch-a'").run()
    expect(await wakeConnectionWaits(flowEnv)).toBe(0)
    await (await runtime.FLOW_RUN!.get('run-c2')).sendEvent({ type: 'connection_restored', payload: {} })
    await instance.waitForStepResult({ name: 'connection-wait:send:1:1' })
    expect(await run('run-c2')).toMatchObject({ status: 'waiting_delay', wait_reason: 'connection' })
    expect(privateReplies()).toHaveLength(0)
  })

  it('a espera não passa da janela da resposta privada (7 dias do comentário) e, vencida a janela, falha com channel_comment_too_old', async () => {
    await publish('v-c3', opening)
    const createdAt = Date.now() - 7 * 86_400_000 + 4000
    const instance = await start('run-c3', 'ch-a', 'error', 'v-c3', { comment_context: context(createdAt) })
    await waiting('run-c3')
    expect((await run('run-c3'))!.wait_until).toBeLessThanOrEqual(createdAt + 7 * 86_400_000)
    await instance.waitForStatus('errored')
    expect(await run('run-c3')).toMatchObject({ status: 'failed', error: 'channel_comment_too_old' })
    expect(privateReplies()).toHaveLength(0)
  }, 30000)
})

describe('clique durante a espera da conexão de um lembrete', () => {
  const replies = { nodes: [node('start', 'trigger'),
    node('ask', 'message', { reply_attempts: 2, click_timeout: { value: 1, unit: 'hours' }, blocks: [{ kind: 'text', text: 'Qual caminho?' },
      { kind: 'quick_reply', id: 'a', label: 'Preços' }, { kind: 'quick_reply', id: 'b', label: 'Suporte' }] }),
    node('prices', 'message', { blocks: [{ kind: 'text', text: 'Segue a tabela.' }] })],
  edges: [{ from: 'start', port: 'next', to: 'ask' }, { from: 'ask', port: 'btn:a', to: 'prices' }] }

  it('o clique é aceito, encerra a espera, segue o ramo do botão e o lembrete não sai', async () => {
    await publish('v-r', replies)
    // A conexão cai logo depois da primeira mensagem: o lembrete encontra a conexão fora do ar.
    afterSend = async count => { if (count === 1) await runtime.DB.prepare("UPDATE channels SET connection_state='error' WHERE id='tg-a'").run() }
    const instance = await start('run-r', 'tg-a', 'connected', 'v-r', {}, ['click:1'])
    await waiting('run-r')
    expect(telegramSends()).toHaveLength(1)
    const token = await runtime.DB.prepare("SELECT token FROM button_tokens WHERE run_id='run-r' AND button_id='a'").first<string>('token')
    const payload = { update_id: 7001, callback_query: { id: 'cb-7001', from: { id: 100 }, data: `b:${token}`, message: { message_id: 1, chat: { id: 100, type: 'private' } } } }
    const event: InboundEvent = { version: 1, provider: 'telegram', workspaceId: 'a', channelId: 'tg-a', eventId: '7001', receivedAt: Date.now(), payload }
    const batch = createMessageBatch('inbound', [{ id: `queue-${crypto.randomUUID()}`, timestamp: new Date(), attempts: 1, body: event }])
    await consumeInbound(batch, runtime)
    expect((await getQueueResult(batch, createExecutionContext())).retryMessages).toEqual([])
    expect(await runtime.DB.prepare("SELECT delivered_at FROM flow_clicks WHERE run_id='run-r'").first('delivered_at')).not.toBeNull()
    // O ramo do botão também encontra a conexão fora do ar: a execução espera de novo, já no passo seguinte.
    await vi.waitFor(async () => expect(await run('run-r')).toMatchObject({ status: 'waiting_delay', wait_reason: 'connection', current_node_id: 'prices' }), { timeout: 20000 })
    await runtime.DB.prepare("UPDATE channels SET connection_state='connected' WHERE id='tg-a'").run()
    expect(await wakeConnectionWaits(flowEnv)).toBe(1)
    await instance.waitForStatus('complete')
    expect(telegramSends().map(c => c.body.text)).toEqual(['Qual caminho?', 'Segue a tabela.'])
  })
  /** Toque no botão "Preços" da mensagem já enviada, como o Telegram entrega. */
  async function tap(runId: string, updateId: number) {
    const token = await runtime.DB.prepare("SELECT token FROM button_tokens WHERE run_id=? AND button_id='a'").bind(runId).first<string>('token')
    const payload = { update_id: updateId, callback_query: { id: `cb-${updateId}`, from: { id: 100 }, data: `b:${token}`, message: { message_id: 1, chat: { id: 100, type: 'private' } } } }
    const event: InboundEvent = { version: 1, provider: 'telegram', workspaceId: 'a', channelId: 'tg-a', eventId: String(updateId), receivedAt: Date.now(), payload }
    const batch = createMessageBatch('inbound', [{ id: `queue-${crypto.randomUUID()}`, timestamp: new Date(), attempts: 1, body: event }])
    await consumeInbound(batch, runtime)
    expect((await getQueueResult(batch, createExecutionContext())).retryMessages).toEqual([])
  }

  it('o prazo do botão vence durante a espera da conexão: o contato ainda vê a mensagem e o clique vale', async () => {
    await publish('v-rv', replies)
    afterSend = async count => { if (count === 1) await runtime.DB.prepare("UPDATE channels SET connection_state='error' WHERE id='tg-a'").run() }
    const instance = await start('run-rv', 'tg-a', 'connected', 'v-rv', {}, ['click:1'])
    await waiting('run-rv')
    // A conexão ficou fora do ar mais que o prazo do botão.
    await runtime.DB.prepare("UPDATE button_tokens SET expires_at=? WHERE run_id='run-rv'").bind(Date.now() - 1000).run()
    await tap('run-rv', 7101)
    expect(await runtime.DB.prepare("SELECT delivered_at FROM flow_clicks WHERE run_id='run-rv'").first('delivered_at')).not.toBeNull()
    await vi.waitFor(async () => expect(await run('run-rv')).toMatchObject({ status: 'waiting_delay', wait_reason: 'connection', current_node_id: 'prices' }), { timeout: 20000 })
    await runtime.DB.prepare("UPDATE channels SET connection_state='connected' WHERE id='tg-a'").run()
    expect(await wakeConnectionWaits(flowEnv)).toBe(1)
    await instance.waitForStatus('complete')
    expect(telegramSends().map(c => c.body.text)).toEqual(['Qual caminho?', 'Segue a tabela.'])
  })

  it('token vencido fora da espera da conexão continua recusado (execução cancelada durante a espera)', async () => {
    await publish('v-rc', replies)
    afterSend = async count => { if (count === 1) await runtime.DB.prepare("UPDATE channels SET connection_state='error' WHERE id='tg-a'").run() }
    await start('run-rc', 'tg-a', 'connected', 'v-rc', {}, ['click:1'])
    await waiting('run-rc')
    await runtime.DB.batch([
      runtime.DB.prepare("UPDATE button_tokens SET expires_at=? WHERE run_id='run-rc'").bind(Date.now() - 1000),
      runtime.DB.prepare("UPDATE flow_runs SET status='cancelled',wait_reason=NULL WHERE id='run-rc'"),
    ])
    await tap('run-rc', 7102)
    expect(await runtime.DB.prepare("SELECT count(*) AS n FROM flow_clicks WHERE run_id='run-rc'").first('n')).toBe(0)
  })
})
