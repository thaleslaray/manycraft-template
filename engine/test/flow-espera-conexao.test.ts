import { env as runtime } from 'cloudflare:workers'
import { introspectWorkflow, type WorkflowIntrospector } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelLimiter } from '../src/flow/limiter'
import { wakeConnectionWaits } from '../src/flow/connection-wait'
import type { FlowEnv } from '../src/flow/types'
import { giveCredentials } from './credentials'
import { seed } from './fixtures'

// Fluxo comum numa conexão restrita (ou fora do ar): a execução espera o conserto em vez de falhar, e sai depois dele.
const graph = { nodes: [
  { id: 'start', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
  { id: 'message', type: 'message', position: { x: 1, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Mensagem automática' }] } },
], edges: [{ from: 'start', port: 'next', to: 'message' }] }
const run = (id: string) => runtime.DB.prepare('SELECT status,wait_reason,error,wait_until FROM flow_runs WHERE id=?').bind(id)
  .first<{ status: string; wait_reason: string | null; error: string | null; wait_until: number | null }>()
const sends = () => vi.mocked(fetch).mock.calls.length
let workflow: WorkflowIntrospector | undefined

async function start(id: string, state: string, modify?: Parameters<WorkflowIntrospector['modifyAll']>[0], version = 'v-tg') {
  workflow = await introspectWorkflow(runtime.FLOW_RUN!)
  await workflow.modifyAll(async modifier => { await modifier.disableSleeps(); await modifier.disableRetryDelays(); await modify?.(modifier) })
  await runtime.DB.batch([
    runtime.DB.prepare("UPDATE channels SET connection_state=? WHERE id='tg-a'").bind(state),
    runtime.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,automation_version_id,channel_id,workflow_created_at) VALUES (?,'a','c-a',?,'tg-a',?)").bind(id, version, Date.now()),
  ])
  await runtime.FLOW_RUN!.create({ id, params: { runId: id } })
  const [instance] = await workflow.get()
  return instance
}
const waiting = (id: string) => vi.waitFor(async () => expect(await run(id)).toMatchObject({ status: 'waiting_delay', wait_reason: 'connection' }), { timeout: 20000 })

beforeEach(async () => {
  await seed()
  vi.spyOn(ChannelLimiter.prototype, 'acquire').mockResolvedValue({ allowed: true, retryAfter: 0 })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    expect(String(input instanceof Request ? input.url : input)).toBe('https://api.telegram.org/botTESTONLY/sendMessage')
    return Response.json({ ok: true, result: { message_id: 10 + sends(), date: 1, chat: { id: 100 }, text: 'x' } })
  })
  await runtime.DB.batch([
    runtime.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('tg-a','a','telegram','test-bot')"),
    runtime.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('cc-tg','a','c-a','tg-a','100',1)"),
    runtime.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('v-tg','a','auto-a',1,?)").bind(JSON.stringify(graph)),
    runtime.DB.prepare("UPDATE automations SET status='live',published_version_id='v-tg' WHERE id='auto-a'"),
  ])
  await giveCredentials(runtime, 'tg-a', { botToken: 'TESTONLY', webhookSecret: 'secret-tg-a' })
})
afterEach(async () => { await workflow?.dispose(); workflow = undefined; vi.restoreAllMocks() })

describe('fluxo comum espera a conexão restrita', () => {
  it('para durante a restrição sem chamar o canal, avisa na conversa e sai depois do conserto', async () => {
    const instance = await start('run-restrita', 'restricted')
    await waiting('run-restrita')
    expect(sends()).toBe(0)
    expect((await run('run-restrita'))!.wait_until).toBeGreaterThan(Date.now() + 6 * 86_400_000)
    expect(await runtime.DB.prepare("SELECT json_extract(content,'$.text') AS text FROM messages WHERE id='connection-wait:run-restrita'").first('text'))
      .toMatch(/^Envio em espera: o número está restrito/)
    // Ainda restrita e sem mensagem nova do contato: o cron não acorda ninguém.
    expect(await wakeConnectionWaits(runtime as unknown as FlowEnv)).toBe(0)
    await runtime.DB.prepare("UPDATE channels SET connection_state='connected' WHERE id='tg-a'").run()
    expect(await wakeConnectionWaits(runtime as unknown as FlowEnv)).toBe(1)
    await instance.waitForStatus('complete')
    expect(await run('run-restrita')).toMatchObject({ status: 'done', wait_reason: null })
    expect(sends()).toBe(1)
  })
  it('conexão com token recusado (error) também espera; consertada (pending), envia', async () => {
    const instance = await start('run-erro', 'error')
    await waiting('run-erro')
    await runtime.DB.prepare("UPDATE channels SET connection_state='pending' WHERE id='tg-a'").run()
    expect(await wakeConnectionWaits(runtime as unknown as FlowEnv, { workspaceId: 'a', channelId: 'tg-a' })).toBe(1)
    await instance.waitForStatus('complete')
    expect(await run('run-erro')).toMatchObject({ status: 'done' })
    expect(sends()).toBe(1)
  })
  it('restrita: a resposta a quem escreveu dentro da janela sai na hora, sem esperar', async () => {
    await runtime.DB.prepare("UPDATE contact_channels SET last_inbound_at=? WHERE id='cc-tg'").bind(Date.now() - 3600_000).run()
    const instance = await start('run-janela', 'restricted')
    await instance.waitForStatus('complete')
    expect(await run('run-janela')).toMatchObject({ status: 'done' })
    expect(sends()).toBe(1)
  })
  it('restrita e o contato escreve durante a espera: a execução acorda e responde dentro da janela', async () => {
    const instance = await start('run-escreveu', 'restricted')
    await waiting('run-escreveu')
    await runtime.DB.prepare("UPDATE contact_channels SET last_inbound_at=? WHERE id='cc-tg'").bind(Date.now() + 1000).run()
    expect(await wakeConnectionWaits(runtime as unknown as FlowEnv)).toBe(1)
    await instance.waitForStatus('complete')
    expect(sends()).toBe(1)
  })
  it('prazo vencido: a execução falha com motivo próprio e nada sai', async () => {
    const instance = await start('run-prazo', 'restricted', async modifier => {
      await modifier.mockStepResult({ name: 'connection-deadline:send:1' }, Date.now() - 1)
    })
    await instance.waitForStatus('errored')
    expect(await run('run-prazo')).toMatchObject({ status: 'failed', error: 'channel_connection_wait_expired', wait_reason: null })
    expect(sends()).toBe(0)
  })
  it('contato que saiu (STOP) durante a espera não recebe, mesmo com a conexão consertada e a execução acordada', async () => {
    const instance = await start('run-stop', 'restricted')
    await waiting('run-stop')
    // O mesmo que o descadastro grava (dispatch.ts): consentimento retirado e execuções ativas canceladas.
    await runtime.DB.batch([
      runtime.DB.prepare("UPDATE contact_channels SET opted_in=0,opted_out_at=? WHERE id='cc-tg'").bind(Date.now()),
      runtime.DB.prepare("UPDATE flow_runs SET status='cancelled',wait_until=NULL,error=NULL WHERE id='run-stop' AND status IN ('running','waiting_delay','waiting_click','waiting_input')"),
      runtime.DB.prepare("UPDATE channels SET connection_state='connected' WHERE id='tg-a'"),
    ])
    expect(await run('run-stop')).toMatchObject({ status: 'cancelled', wait_reason: null })
    expect(await wakeConnectionWaits(runtime as unknown as FlowEnv)).toBe(0)
    await (await runtime.FLOW_RUN!.get('run-stop')).sendEvent({ type: 'connection_restored', payload: {} })
    await instance.waitForStatus('complete')
    expect(await run('run-stop')).toMatchObject({ status: 'cancelled' })
    expect(sends()).toBe(0)
  })
})

describe('espera da conexão: botões e a regra da janela', () => {
  it('botões enviados depois da espera valem o prazo inteiro a partir do envio (o token não sai vencido)', async () => {
    const buttons = { nodes: [graph.nodes[0], { id: 'message', type: 'message', position: { x: 1, y: 0 }, config: { click_timeout: { value: 2, unit: 'hours' },
      blocks: [{ kind: 'text', text: 'Escolha' }, { kind: 'button', id: 'sim', label: 'Sim', action: { type: 'go_to_node' } }] } }], edges: graph.edges }
    await runtime.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('v-botoes','a','auto-a',2,?)").bind(JSON.stringify(buttons)).run()
    await start('run-botoes', 'restricted', undefined, 'v-botoes')
    await waiting('run-botoes')
    // Dias de espera: o token nascido em tokens:<i> já venceu quando a conexão volta.
    await runtime.DB.prepare("UPDATE button_tokens SET expires_at=? WHERE run_id='run-botoes'").bind(Date.now() - 1000).run()
    await runtime.DB.prepare("UPDATE channels SET connection_state='connected' WHERE id='tg-a'").run()
    expect(await wakeConnectionWaits(runtime as unknown as FlowEnv)).toBe(1)
    await vi.waitFor(async () => expect(await run('run-botoes')).toMatchObject({ status: 'waiting_click' }), { timeout: 20000 })
    expect(sends()).toBe(1)
    const token = await runtime.DB.prepare("SELECT expires_at FROM button_tokens WHERE run_id='run-botoes'").first<number>('expires_at')
    expect(token).toBeGreaterThan(Date.now() + 3600_000)
    expect((await run('run-botoes'))!.wait_until).toBe(token)
  })
  it('restrita: acorda quem está dentro da janela mesmo tendo escrito antes do início da espera (mesma regra da entrega)', async () => {
    // O contato escreveu há uma hora; a conexão estava fora do ar (a espera começa depois da mensagem dele) e passa a restrita.
    await runtime.DB.prepare("UPDATE contact_channels SET last_inbound_at=? WHERE id='cc-tg'").bind(Date.now() - 3600_000).run()
    const instance = await start('run-antes', 'error')
    await waiting('run-antes')
    await runtime.DB.prepare("UPDATE channels SET connection_state='restricted' WHERE id='tg-a'").run()
    expect(await wakeConnectionWaits(runtime as unknown as FlowEnv)).toBe(1)
    await instance.waitForStatus('complete')
    expect(sends()).toBe(1)
  })
  it('restrita: não acorda quem escreveu depois do início da espera mas já saiu da janela (a entrega recusaria de novo)', async () => {
    await start('run-fora', 'restricted')
    await waiting('run-fora')
    await runtime.DB.batch([
      runtime.DB.prepare("UPDATE flow_runs SET updated_at=? WHERE id='run-fora'").bind(Date.now() - 3 * 86_400_000),
      runtime.DB.prepare("UPDATE contact_channels SET last_inbound_at=? WHERE id='cc-tg'").bind(Date.now() - 2 * 86_400_000),
    ])
    expect(await wakeConnectionWaits(runtime as unknown as FlowEnv)).toBe(0)
  })
  it('restrita com duas identidades do contato no mesmo canal: acorda uma vez só', async () => {
    await start('run-duas', 'restricted')
    await waiting('run-duas')
    await runtime.DB.batch([
      runtime.DB.prepare("UPDATE contact_channels SET last_inbound_at=? WHERE id='cc-tg'").bind(Date.now()),
      runtime.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in,last_inbound_at) VALUES ('cc-tg-2','a','c-a','tg-a','101',1,?)").bind(Date.now()),
    ])
    expect(await wakeConnectionWaits(runtime as unknown as FlowEnv)).toBe(1)
  })
})
