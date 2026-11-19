import { z } from 'zod'
import { emailEvent, markUnreachable, type StoredEmail } from './service'
import { normalizeEmail, type EmailEnv } from './store'
import { logTaskError } from '../log-error'

/** Email Sending events delivered by an Event Subscription to a Queue.
 * https://developers.cloudflare.com/email-service/reference/event-subscriptions/ (coleta 2026-10-26).
 * Only the fields used here are read; unknown fields are ignored. */
const sendingEventSchema = z.object({
  type: z.string().startsWith('cf.email.sending.message.'),
  payload: z.object({
    eventId: z.string().min(1).max(512),
    messageId: z.string().min(1).max(512),
    recipient: z.string().min(1).max(512),
    bounce: z.object({ type: z.string().optional() }).partial().optional(),
    rejection: z.object({ reason: z.string().optional() }).partial().optional(),
  }),
})

export const isEmailSendingEvent = (body: unknown): boolean =>
  !!body && typeof body === 'object' && typeof (body as { type?: unknown }).type === 'string' && (body as { type: string }).type.startsWith('cf.email.sending.message.')

/** Consumes one Email Sending event. Every outcome acks: an unknown message, an unreadable payload or an event with no
 * action must not retry forever nor land in the DLQ. Only a database failure retries (the event is recorded afterwards). */
export async function consumeEmailSendingEvent(message: Message<unknown>, env: EmailEnv) {
  const parsed = sendingEventSchema.safeParse(message.body)
  if (!parsed.success) { message.ack(); return }
  const { type, payload } = parsed.data
  const name = type.slice('cf.email.sending.message.'.length)
  try {
    // deferred: delivery retries are still pending (not final). failed: internal error with no recipient verdict.
    const action = name === 'delivered' ? 'delivered'
      : name === 'bounced' ? (payload.bounce?.type === 'hard' ? 'hard_bounce' : 'soft_bounce')
      : name === 'complained' ? 'complaint'
      // Suppression means the address is unreachable; other rejections (validation, spam) say nothing about the contact.
      : name === 'rejected' && payload.rejection?.reason === 'suppressed' ? 'suppressed'
      : null
    if (!action) { message.ack(); return }
    const mail = await env.DB.prepare("SELECT * FROM email_messages WHERE provider_message_id=? AND recipient=? AND status='sent' LIMIT 1")
      .bind(payload.messageId, normalizeEmail(payload.recipient)).first<StoredEmail>()
    if (!mail) { message.ack(); return }
    // Queues deliver at least once: the claim makes the event idempotent.
    const claim = await env.DB.prepare('INSERT INTO email_sending_events(event_id,received_at) VALUES (?,?) ON CONFLICT(event_id) DO NOTHING')
      .bind(payload.eventId, Date.now()).run()
    if (!claim.meta.changes) { message.ack(); return }
    try {
      if (action === 'suppressed') await markUnreachable(env, mail.workspace_id, mail.contact_id)
      else await emailEvent(env, mail, action)
    } catch (error) {
      await env.DB.prepare('DELETE FROM email_sending_events WHERE event_id=?').bind(payload.eventId).run()
      throw error
    }
    message.ack()
  } catch (error) {
    logTaskError('email_sending_event_unavailable', error)
    if (message.attempts >= 10) message.ack()
    else message.retry({ delaySeconds: Math.min(60, 2 ** message.attempts) })
  }
}
