import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authenticatedRequest as request, seedAuth } from './auth-helpers'
import { receiveReply } from '../src/email-channel/receive'
import { sendEmailPart } from '../src/email-channel/service'
import { consumeEmailSendingEvent, isEmailSendingEvent } from '../src/email-channel/sending-events'
import { cloudflareEmail, sendEmailBinding } from '../src/channels/cloudflare-email'
import { capabilities } from '../src/channels/capabilities'
import { effectiveProfile } from '../src/channels/core/profile-merge'
import { connectionRuntime } from '../src/channels/core/runtime'
import type { Connection } from '../src/channels/contract'

beforeEach(async () => { await seedAuth() })
const write = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) })
const json = async (path: string, init?: RequestInit) => (await request(`email/${path}`, 'a', init)).json() as Promise<any>

/** Sends one simulated message and pretends Cloudflare returned this messageId (shape from event-subscriptions.md). */
async function sentMail(to: string, providerId = '0101018f7d0c4d9a-msg-deadbeef') {
  const settings = await json('settings')
  await json('settings', write('PATCH', { company: { name: 'Empresa', address: 'Rua teste' } }))
  const sent = await json('test', write('POST', { senderId: settings.defaultSenderId, to, subject: 'Pedido 42', text: 'Seu pedido', consent: true }))
  await env.DB.prepare('UPDATE email_messages SET provider_message_id=? WHERE id=?').bind(providerId, sent.id).run()
  return (await env.DB.prepare('SELECT * FROM email_messages WHERE id=?').bind(sent.id).first<any>())!
}
const sendingEvent = (type: string, payload: Record<string, unknown>) => ({
  type: `cf.email.sending.message.${type}`, source: { type: 'email.sending', zoneId: 'z', domain: 'example.com' },
  payload: { eventId: `evt-${type}-${Math.random()}`, messageId: '0101018f7d0c4d9a-msg-deadbeef', recipient: 'ana@example.test', terminal: true, ...payload },
  metadata: { accountId: 'a', eventSubscriptionId: 's', eventSchemaVersion: 1, eventTimestamp: '2026-06-01T02:48:57.132Z' },
})
const queueMessage = (body: unknown) => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn() })
const optedIn = (contactId: string) => env.DB.prepare('SELECT opted_in FROM contact_channels WHERE contact_id=?').bind(contactId).first<{ opted_in: number }>()
const eventTypes = (messageId: string) => env.DB.prepare('SELECT type FROM email_events WHERE message_id=? ORDER BY created_at,rowid').bind(messageId).all<{ type: string }>().then(r => r.results.map(x => x.type))

describe('email-cloudflare: eventos reais de envio (Queues)', () => {
  it('reconhece só o prefixo cf.email.sending.message.* e deixa o resto para o consumidor inbound', () => {
    expect(isEmailSendingEvent(sendingEvent('bounced', {}))).toBe(true)
    expect(isEmailSendingEvent({ type: 'cf.email.routing.x' })).toBe(false)
    expect(isEmailSendingEvent({ kind: 'broadcast' })).toBe(false)
    expect(isEmailSendingEvent(null)).toBe(false)
  })
  it('bounce permanente (hard) retira o opt-in; entrega é registrada; repetição do mesmo eventId não duplica', async () => {
    const mail = await sentMail('ana@example.test')
    const delivered = queueMessage(sendingEvent('delivered', { recipient: 'ana@example.test', delivery: { status: 'delivered' } }))
    await consumeEmailSendingEvent(delivered as never, env)
    expect(delivered.ack).toHaveBeenCalled()
    expect(await optedIn(mail.contact_id)).toEqual({ opted_in: 1 })
    const hard = sendingEvent('bounced', { delivery: { status: 'bounced' }, bounce: { type: 'hard', classification: 'permanent_failure', reason: '550 5.1.1 User unknown' } })
    await consumeEmailSendingEvent(queueMessage(hard) as never, env)
    await consumeEmailSendingEvent(queueMessage(hard) as never, env)
    expect(await optedIn(mail.contact_id)).toEqual({ opted_in: 0 })
    expect((await eventTypes(mail.id)).filter(t => t === 'hard_bounce')).toHaveLength(1)
    expect(await eventTypes(mail.id)).toContain('delivered')
  })
  it('bounce soft, adiado e falha interna não retiram opt-in; reclamação (complained) retira', async () => {
    const mail = await sentMail('ana@example.test')
    await consumeEmailSendingEvent(queueMessage(sendingEvent('deferred', { terminal: false, bounce: { type: 'soft' } })) as never, env)
    await consumeEmailSendingEvent(queueMessage(sendingEvent('failed', { failure: { reason: 'delivery_failed' } })) as never, env)
    await consumeEmailSendingEvent(queueMessage(sendingEvent('bounced', { bounce: { type: 'soft', reason: 'x' } })) as never, env)
    expect(await optedIn(mail.contact_id)).toEqual({ opted_in: 1 })
    expect(await eventTypes(mail.id)).toEqual(['sent', 'soft_bounce'])
    await consumeEmailSendingEvent(queueMessage(sendingEvent('complained', { complaint: { type: 'abuse' } })) as never, env)
    expect(await optedIn(mail.contact_id)).toEqual({ opted_in: 0 })
  })
  it('rejeição por supressão do destinatário trata como inalcançável; outras rejeições são só registradas no log', async () => {
    const mail = await sentMail('ana@example.test')
    await consumeEmailSendingEvent(queueMessage(sendingEvent('rejected', { rejection: { reason: 'spam', party: 'sender' } })) as never, env)
    expect(await optedIn(mail.contact_id)).toEqual({ opted_in: 1 })
    await consumeEmailSendingEvent(queueMessage(sendingEvent('rejected', { rejection: { reason: 'suppressed', party: 'recipient' } })) as never, env)
    expect(await optedIn(mail.contact_id)).toEqual({ opted_in: 0 })
  })
  it('mensagem desconhecida ou destinatário diferente é confirmada sem efeito; payload inválido não vai para a DLQ', async () => {
    const mail = await sentMail('ana@example.test')
    const unknown = queueMessage(sendingEvent('bounced', { messageId: 'outra', bounce: { type: 'hard' } }))
    await consumeEmailSendingEvent(unknown as never, env)
    const other = queueMessage(sendingEvent('bounced', { recipient: 'outra@example.test', bounce: { type: 'hard' } }))
    await consumeEmailSendingEvent(other as never, env)
    const broken = queueMessage({ type: 'cf.email.sending.message.bounced', payload: 'x' })
    await consumeEmailSendingEvent(broken as never, env)
    for (const m of [unknown, other, broken]) { expect(m.ack).toHaveBeenCalled(); expect(m.retry).not.toHaveBeenCalled() }
    expect(await optedIn(mail.contact_id)).toEqual({ opted_in: 1 })
  })
  it('o canal declara recibo de entrega, já que message.delivered tem consumidor', () => {
    expect(capabilities('email').receipts.delivered).toBe(true)
  })
})

describe('email-cloudflare: resposta do cliente casa sem depender do Message-ID', () => {
  it('remetente do próprio domínio (sem token): casa pelo endereço de resposta e pelo destinatário', async () => {
    const mail = await sentMail('ana@example.test')
    // In-Reply-To carries Cloudflare's own Message-ID, which the API never reveals to us.
    const reply = { from: 'ana@example.test', to: mail.reply_to, messageId: '<in-1@example.test>', inReplyTo: '<gerado-pela-cloudflare@send.example.com>', text: 'Oi' }
    expect(await receiveReply(env, reply)).toMatchObject({ accepted: true })
  })
  it('References também é consultado', async () => {
    const mail = await sentMail('ana@example.test', '<ref-1@example.test>')
    expect(await receiveReply(env, { from: 'ana@example.test', to: 'qualquer@mail.replica.test', messageId: 'r2', references: ['<outro@x>', '<ref-1@example.test>'], text: 'Oi' }))
      .toMatchObject({ accepted: true })
    expect(mail.id).toBeTruthy()
  })
  it('quem nunca recebeu e-mail, ou escreve para outro endereço sem In-Reply-To, continua recusado', async () => {
    const mail = await sentMail('ana@example.test')
    expect(await receiveReply(env, { from: 'intruso@example.test', to: mail.reply_to, messageId: 'x1', inReplyTo: '<a@b>', text: 'Oi' })).toEqual({ accepted: false })
    expect(await receiveReply(env, { from: 'ana@example.test', to: 'outro@mail.replica.test', messageId: 'x2', inReplyTo: '<a@b>', text: 'Oi' })).toEqual({ accepted: false })
  })
})

describe('email-cloudflare: erros do binding', () => {
  const profile = effectiveProfile('email', 'cloudflare_email')
  const connection: Connection = { id: 'mail', workspaceId: 'w', kind: 'email', provider: 'cloudflare_email', externalId: 'oi@example.test', displayName: 'Equipe', status: 'connected', settings: { senderAddress: 'oi@example.test' }, profile }
  const target = { kind: 'direct' as const, externalUserId: 'ana@example.test' }
  const failing = (code: string) => ({ send: vi.fn(async () => { throw Object.assign(new Error('x'), { code }) }) })
  it('E_DELIVERY_FAILED não é tratado como recusa definitiva: pode ser transitório e nunca é reenviado sozinho', async () => {
    expect(await sendEmailBinding(failing('E_DELIVERY_FAILED'), connection, target, { kind: 'text', text: 'Oi' })).toMatchObject({ ok: false, reason: 'uncertain' })
  })
  it('E_ACCOUNT_SUSPENDED e E_RECIPIENT_SUPPRESSED têm código próprio, sem texto bruto', async () => {
    for (const code of ['E_ACCOUNT_SUSPENDED', 'E_RECIPIENT_SUPPRESSED', 'E_SENDER_NOT_VERIFIED']) {
      expect(await sendEmailBinding(failing(code), connection, target, { kind: 'text', text: 'Oi' })).toMatchObject({ ok: false, reason: 'rejected', code })
    }
  })
  it('conta suspensa pausa o envio do espaço; destinatário suprimido fica inalcançável (serviço)', async () => {
    const settings = await json('settings')
    const mail = await sentMail('sup@example.test')
    const runtimeEnv = { ...env, APP_ENV: 'production', EMAIL: failing('E_RECIPIENT_SUPPRESSED') } as never
    const conn = { id: mail.connection_id, workspaceId: 'a', kind: 'email', provider: 'cloudflare_email', externalId: 'x@mail.replica.test', displayName: 'E', status: 'connected', settings: {}, profile } as Connection
    const result = await sendEmailPart(runtimeEnv, conn, { kind: 'direct', externalUserId: 'sup@example.test' }, { kind: 'text', text: 'Oi', email: { subject: 'S', senderId: settings.defaultSenderId } } as never, 'human')
    expect(result).toMatchObject({ ok: false, reason: 'rejected', code: 'E_RECIPIENT_SUPPRESSED' })
    expect(await optedIn(mail.contact_id)).toEqual({ opted_in: 0 })
    ;(runtimeEnv as any).EMAIL = failing('E_ACCOUNT_SUSPENDED')
    await sendEmailPart(runtimeEnv, conn, { kind: 'direct', externalUserId: 'sup@example.test' }, { kind: 'text', text: 'Oi', email: { subject: 'S', senderId: settings.defaultSenderId } } as never, 'human')
    expect((await json('settings')).usage.paused).toBe(true)
  })
})

describe('email-cloudflare: guia de conexão', () => {
  it('não expõe URL de webhook nem token (o recebimento é o handler email() do Worker) e orienta a assinar os eventos de envio', async () => {
    const step: any = await cloudflareEmail.connect({ credentials: { senderAddress: 'oi@example.test' }, hookUrl: 'https://x/hook', webhookSecret: 'segredo-do-teste' } as never)
    expect(step.callbackUrl).toBe('')
    expect(step.verifyToken).toBe('')
    expect(step.checklist.join(' ')).toMatch(/Event Subscription|assinatura de eventos/i)
    expect(JSON.stringify(step)).not.toContain('segredo-do-teste')
  })
})
void connectionRuntime
