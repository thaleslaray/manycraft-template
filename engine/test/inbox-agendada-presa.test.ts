import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendDueScheduledMessages } from '../src/inbox/routes'
import { ensureConversation, recordMessage } from '../src/inbox/service'
import { seedAuth } from './auth-helpers'
import { giveCredentials } from './credentials'

const now = Date.now()
const runtime = () => ({ ...env, CHANNEL_LIMITER: undefined }) as never
const semConfirmacao = 'Envio sem confirmação; verifique antes de reenviar.'
const agendar = (id: string, sendAt: number, status = 'scheduled') => env.DB.prepare(`INSERT INTO inbox_scheduled_messages (id,workspace_id,conversation_id,text,send_at,created_by,status)
  VALUES (?,'a','inbox-cc-a','Bom dia!',?,'test-owner',?)`).bind(id, sendAt, status).run()
const agendada = (id: string) => env.DB.prepare('SELECT status,error FROM inbox_scheduled_messages WHERE id=?').bind(id).first()
const aviso = (id: string) => env.DB.prepare("SELECT json_extract(content,'$.sender') AS sender,json_extract(content,'$.text') AS text FROM messages WHERE id=?").bind(`scheduled-failed-${id}`).first()
const telegramOk = () => Response.json({ ok: true, result: { message_id: 321 } })

beforeEach(async () => {
  await seedAuth()
  await env.DB.prepare("UPDATE channels SET type='telegram' WHERE id='ch-a'").run()
  await giveCredentials(env, 'ch-a', { botToken: 'TESTONLY-INBOX-BOT-TOKEN', webhookSecret: 'agendada-presa' })
  await ensureConversation(env, 'a', 'c-a', 'ch-a')
  await recordMessage(env, { id: 'entrada', workspaceId: 'a', conversationId: 'inbox-cc-a', direction: 'in', sender: 'contact', text: 'Olá' })
})
afterEach(() => { vi.restoreAllMocks() })

describe('mensagem agendada no chat que ficou em "enviando"', () => {
  it('rodada que morreu no meio: depois do prazo da rodada vira falha e avisa na conversa, sem reenviar', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => telegramOk())
    await agendar('presa', now - 20 * 60_000, 'sending')
    await agendar('em-curso', now - 60_000, 'sending')
    await sendDueScheduledMessages(runtime(), now)
    expect(await agendada('presa')).toEqual({ status: 'failed', error: semConfirmacao })
    expect(await aviso('presa')).toEqual({ sender: 'system', text: `Mensagem agendada não saiu: ${semConfirmacao}` })
    // Pega há um minuto: a rodada que a pegou pode estar falando com o canal agora.
    expect(await agendada('em-curso')).toEqual({ status: 'sending', error: null })
    expect(network).not.toHaveBeenCalled()
  })
  it('a rodada seguinte não dá como presa a agendada atrasada que a anterior acabou de pegar', async () => {
    await agendar('atrasada', now - 2 * 3600_000)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      // Enquanto esta rodada fala com o canal, começa a do minuto seguinte.
      await sendDueScheduledMessages(runtime(), now + 60_000)
      return telegramOk()
    })
    await sendDueScheduledMessages(runtime(), now)
    expect(await agendada('atrasada')).toEqual({ status: 'sent', error: null })
    expect(await aviso('atrasada')).toBeNull()
  })
  it('o resultado atrasado de uma rodada não troca a falha já registrada', async () => {
    await agendar('fechada', now - 60_000)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await env.DB.prepare("UPDATE inbox_scheduled_messages SET status='failed',error=? WHERE id='fechada'").bind(semConfirmacao).run()
      return telegramOk()
    })
    await sendDueScheduledMessages(runtime(), now)
    expect(await agendada('fechada')).toEqual({ status: 'failed', error: semConfirmacao })
  })
})

describe('mensagem agendada cujo envio falhou no canal', () => {
  const humana = () => env.DB.prepare("SELECT delivery_status,delivery_error FROM messages WHERE conversation_id='inbox-cc-a' AND json_extract(content,'$.sender')='human'").first<{ delivery_status: string; delivery_error: string }>()
  it('canal recusou: a agendada fica "falhou" com o motivo da conversa e avisa na conversa', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, { status: 403 }))
    await agendar('recusada', now - 60_000)
    await sendDueScheduledMessages(runtime(), now)
    const message = await humana()
    expect(message?.delivery_status).toBe('failed')
    expect(await agendada('recusada')).toEqual({ status: 'failed', error: message!.delivery_error })
    expect(await aviso('recusada')).toEqual({ sender: 'system', text: `Mensagem agendada não saiu: ${message!.delivery_error}` })
  })
  it('rede caiu no meio do envio: fica "falhou" sem confirmação e não é reenviada', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new TypeError('network down') })
    await agendar('sem-rede', now - 60_000)
    await sendDueScheduledMessages(runtime(), now)
    expect(await agendada('sem-rede')).toEqual({ status: 'failed', error: semConfirmacao })
    expect(await aviso('sem-rede')).toEqual({ sender: 'system', text: `Mensagem agendada não saiu: ${semConfirmacao}` })
    const calls = network.mock.calls.length
    await sendDueScheduledMessages(runtime(), now + 3600_000)
    expect(network.mock.calls.length).toBe(calls)
  })
})
