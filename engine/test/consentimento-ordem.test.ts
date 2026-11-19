import { env } from 'cloudflare:workers'
import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { seed } from './fixtures'
import { giveCredentials } from './credentials'
import { consumeInbound } from '../src/jobs'
import { ChannelLimiter } from '../src/flow/limiter'
import type { InboundEvent } from '../src/integrations'
import { editorActionStatements } from '../src/flow/editor-actions'
import { consumeQuestionAnswer } from '../src/flow/questions'
import type { FlowAction } from '../src/schemas/actions'
import type { FlowEnv, Run } from '../src/flow/types'

// B3 (auditoria de segurança): a ordem de START/STOP vale pelo horário do evento no provedor, não pela ordem em que a fila entrega.
const T = Math.floor(Date.now() / 1000) - 100   // segundos (o `date` do Telegram)
let update = 0
beforeEach(async () => {
  await seed()
  update = 0
  vi.spyOn(ChannelLimiter.prototype, 'acquire').mockResolvedValue({ allowed: true, retryAfter: 0 })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ ok: true, result: { message_id: 1, date: 1, chat: { id: 100 }, text: 'x' } }))
  await env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('tg-a','a','telegram','test-bot')").run()
  await giveCredentials(env, 'tg-a', { botToken: 'TESTONLY', webhookSecret: 'secret-tg-a' })
})
afterEach(() => { vi.restoreAllMocks() })

function word(text: string, date?: number, id = ++update) {
  return { update_id: id, message: { message_id: id, ...(date === undefined ? {} : { date }), from: { id: 100, first_name: 'Pessoa de teste' }, chat: { id: 100, type: 'private' }, text } }
}
async function inbound(payload: Record<string, unknown> & { update_id: number }) {
  const event: InboundEvent = { version: 1, provider: 'telegram', workspaceId: 'a', channelId: 'tg-a', eventId: String(payload.update_id), receivedAt: Date.now(), payload }
  const batch = createMessageBatch('inbound', [{ id: `queue-${crypto.randomUUID()}`, timestamp: new Date(), attempts: 1, body: event }])
  await consumeInbound(batch, env)
  expect((await getQueueResult(batch, createExecutionContext())).retryMessages).toEqual([])
}
const consent = () => env.DB.prepare("SELECT opted_in,broadcast_opt_in,consent_changed_at FROM contact_channels WHERE channel_id='tg-a'").first<{ opted_in: number; broadcast_opt_in: number; consent_changed_at: number | null }>()

it('STOP (t=2) processado antes de START (t=1) termina com opt-out', async () => {
  await inbound(word('parar', T + 2))
  expect(await consent()).toMatchObject({ opted_in: 0, consent_changed_at: (T + 2) * 1000 })
  await inbound(word('voltar', T + 1))
  expect(await consent()).toMatchObject({ opted_in: 0, consent_changed_at: (T + 2) * 1000 })
})

it('START (t=3) depois de STOP (t=2) volta a aceitar', async () => {
  await inbound(word('parar', T + 2))
  await inbound(word('voltar', T + 3))
  expect(await consent()).toMatchObject({ opted_in: 1, broadcast_opt_in: 1, consent_changed_at: (T + 3) * 1000 })
})

it('a mesma mensagem entregue duas vezes não muda nada', async () => {
  await inbound(word('parar', T + 2, 501))
  await inbound(word('voltar', T + 3, 502))
  await inbound(word('parar', T + 2, 501))
  expect(await consent()).toMatchObject({ opted_in: 1, consent_changed_at: (T + 3) * 1000 })
  expect(await env.DB.prepare("SELECT count(*) n FROM messages WHERE id LIKE 'system-consent-%'").first('n')).toBe(2)
})

it('evento sem horário do provedor usa o de recebimento', async () => {
  const before = Date.now()
  await inbound(word('parar'))
  const row = await consent()
  expect(row?.opted_in).toBe(0)
  expect(row!.consent_changed_at).toBeGreaterThanOrEqual(before)
})

// Item 4 (auditoria "quem recebe mensagem"): ação de fluxo e pergunta também gravam o horário da mudança.
const contactId = async () => (await env.DB.prepare("SELECT contact_id FROM contact_channels WHERE channel_id='tg-a'").first<string>('contact_id'))!
async function action(type: string) {
  const run = { id: `acao-${type}`, workspace_id: 'a', contact_id: await contactId(), channel_id: 'tg-a' } as Run
  const step = (type.endsWith('_account') ? { type, connection_id: 'tg-a' } : { type }) as FlowAction
  await env.DB.batch((await editorActionStatements(env as never, run, step, 1, 0))!)
}

it.each(['unsubscribe_to_account', 'set_telegram_opt_out'])('ação de fluxo %s grava o horário: "voltar" mais antigo, entregue depois, não reinscreve', async type => {
  await inbound(word('oi', T))
  const before = Date.now()
  await action(type)
  const row = await consent()
  expect(row?.opted_in).toBe(0)
  expect(row!.consent_changed_at).toBeGreaterThanOrEqual(before)
  await inbound(word('voltar', T + 1))
  expect(await consent()).toMatchObject({ opted_in: 0 })
})

it.each(['subscribe_to_account', 'set_telegram_opt_in'])('ação de fluxo %s grava o horário: "parar" mais antigo, entregue depois, não descadastra', async type => {
  await inbound(word('oi', T))
  await env.DB.prepare("UPDATE contact_channels SET opted_in=0 WHERE channel_id='tg-a'").run()
  await action(type)
  expect(await consent()).toMatchObject({ opted_in: 1 })
  await inbound(word('parar', T + 1))
  expect(await consent()).toMatchObject({ opted_in: 1 })
})

describe('pergunta', () => {
  const flowEnv = () => ({ ...env, FLOW_RUN: { get: async () => ({ sendEvent: async () => {} }) } }) as unknown as FlowEnv
  /** Pergunta aberta na conexão Telegram; o contato também tem identidade num número de WhatsApp. */
  async function openQuestion(config: Record<string, unknown>) {
    await inbound(word('oi', T))
    const contact = await contactId()
    await env.DB.batch([
      env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('wa-q','a','whatsapp','5511900000000')"),
      env.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,identity_kind,opted_in) VALUES ('cc-wa','a',?,'wa-q','BR.q1','bsuid',0)").bind(contact),
      env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('v-q','a','auto-a',1,'{}')"),
      env.DB.prepare("INSERT INTO flow_runs (id,workspace_id,contact_id,automation_version_id,channel_id,status) VALUES ('run-q','a',?,'v-q','tg-a','waiting_input')").bind(contact),
      env.DB.prepare("INSERT INTO flow_questions (run_id,step_index,workspace_id,contact_id,channel_id,node_id,config,token,expires_at) VALUES ('run-q',1,'a',?,'tg-a','q',?,?,?)")
        .bind(contact, JSON.stringify({ text: 'Qual seu telefone?', retry_message: 'De novo', max_attempts: 2, timeout: { value: 1, unit: 'days' }, ...config }), 'a'.repeat(24), Date.now() + 86400000),
      env.DB.prepare("INSERT INTO inbound_events (workspace_id,id,channel_id,payload) VALUES ('a','in-q','tg-a','{}')"),
    ])
    return contact
  }
  const wa = () => env.DB.prepare("SELECT opted_in,consent_changed_at FROM contact_channels WHERE id='cc-wa'").first<{ opted_in: number; consent_changed_at: number | null }>()
  const phone = { answer_type: 'phone', field_id: 'system:phone', opt_in: ['whatsapp'], consent_phrase: 'Aceito receber mensagens por WhatsApp.' }

  it('opt-in pela resposta grava o horário dela', async () => {
    const contact = await openQuestion(phone)
    const at = Date.now() - 5000
    expect(await consumeQuestionAnswer(flowEnv(), 'a', 'tg-a', contact, 'in-q', '+55 11 98888-7777', undefined, undefined, at)).toBe(true)
    expect(await wa()).toEqual({ opted_in: 1, consent_changed_at: at })
  })
  it('resposta atrasada, mais antiga que um STOP no WhatsApp, não reinscreve aquele número', async () => {
    const contact = await openQuestion(phone)
    const at = Date.now() - 5000
    await env.DB.prepare("UPDATE contact_channels SET consent_changed_at=? WHERE id='cc-wa'").bind(at + 1000).run()
    await consumeQuestionAnswer(flowEnv(), 'a', 'tg-a', contact, 'in-q', '+55 11 98888-7777', undefined, undefined, at)
    expect(await wa()).toEqual({ opted_in: 0, consent_changed_at: at + 1000 })
  })
  it('"Parar" tocado na pergunta descadastra e grava o horário do toque', async () => {
    const contact = await openQuestion({ answer_type: 'multiple_choice', field_id: 'system:first_name', choices: ['Sim', 'Parar'] })
    const at = Date.now() - 5000
    await consumeQuestionAnswer(flowEnv(), 'a', 'tg-a', contact, 'in-q', 'Parar', 'a'.repeat(24), undefined, at)
    expect(await consent()).toMatchObject({ opted_in: 0, consent_changed_at: at })
  })
  it('"Parar" atrasado, mais antigo que a última mudança de consentimento, não descadastra, não cancela a execução nem fecha a pergunta como parada', async () => {
    const contact = await openQuestion({ answer_type: 'multiple_choice', field_id: 'system:first_name', choices: ['Sim', 'Parar'] })
    const at = Date.now() - 5000
    await env.DB.prepare("UPDATE contact_channels SET consent_changed_at=? WHERE channel_id='tg-a'").bind(at + 1000).run()
    await consumeQuestionAnswer(flowEnv(), 'a', 'tg-a', contact, 'in-q', 'Parar', 'a'.repeat(24), undefined, at)
    expect(await consent()).toMatchObject({ opted_in: 1, consent_changed_at: at + 1000 })
    expect(await env.DB.prepare("SELECT status FROM flow_runs WHERE id='run-q'").first('status')).toBe('waiting_input')
    expect(await env.DB.prepare("SELECT status FROM flow_questions WHERE run_id='run-q'").first('status')).not.toBe('stopped')
  })
})

// Bloqueio (Telegram my_chat_member ou envio recusado) só sai com mensagem mais nova que ele: quem decide é o reopenWindow (flow/dispatch.ts).
it('Telegram: mensagem mais antiga que o bloqueio, entregue depois, não tira o bloqueio; a mais nova tira', async () => {
  await inbound(word('oi', T))
  const blocked = () => env.DB.prepare("SELECT blocked_at FROM contact_channels WHERE channel_id='tg-a'").first<number | null>('blocked_at')
  await env.DB.prepare("UPDATE contact_channels SET blocked_at=? WHERE channel_id='tg-a'").bind((T + 5) * 1000).run()
  await inbound(word('mensagem velha', T + 1))
  expect(await blocked()).toBe((T + 5) * 1000)
  await inbound(word('mensagem nova', T + 10))
  expect(await blocked()).toBeNull()
})
