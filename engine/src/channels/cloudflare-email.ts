import { z } from 'zod'
import type { ConnectContext, Connection, EmailSendBinding, ProviderAdapter, ProviderCtx, SendTarget } from './contract'
import type { ChannelCapabilities, ChannelAdapter, OutboundMessage, SendResult } from './types'
import { cloudflareEmailMeta } from './cloudflare-email-meta'
import { classifySendError } from './cloudflare-email-errors'

export const normalizeEmail = (value: string): string => value.trim().toLowerCase()
export const validEmail = (value: string): boolean => /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value) && !/[\r\n]/.test(value)
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))
const reject = (code: string): SendResult => ({ ok: false, reason: 'rejected', code, detail: 'O e-mail não foi enviado. Confira a configuração e o conteúdo.' })
const unsupported = (): Extract<SendResult, { reason: 'unsupported' }> => ({ ok: false, reason: 'unsupported', detail: 'Este recurso não é transportado por e-mail.' })
const uncertain = (): SendResult => ({ ok: false, reason: 'uncertain', detail: 'Envio de e-mail sem confirmação; confira antes de reenviar.' })
export const emailSettingsSchema = z.object({ senderAddress: z.email().optional(), senderName: z.string().max(200).optional(), replyTo: z.email().optional(), defaultSubject: z.string().max(998).optional(), domain: z.string().optional(), platformBranding: z.boolean().optional() }).passthrough()

/** A single email stays a single delivery. URL buttons become links in both bodies; unsupported interactions are refused. */
export const fitEmail: ChannelAdapter['fit'] = (message, caps) => {
  if (message.kind !== 'text' || message.quickReplies?.length || message.buttons?.some(button => button.type !== 'url')) return unsupported()
  if (message.text.length > caps.text.maxLength) return unsupported()
  const links = message.buttons?.filter(button => button.type === 'url') ?? []
  if (links.length > caps.buttons.maxPerMessage || links.some(button => button.title.length > caps.buttons.titleMax || !/^https?:\/\//i.test(button.url) || /[\r\n]/.test(button.url))) return unsupported()
  const text = message.text + links.map(link => `\n${link.title}: ${link.url}`).join('')
  if (text.length > caps.text.maxLength) return unsupported()
  const html = (message.email?.html ?? `<p>${escapeHtml(message.text).replace(/\n/g, '<br>')}</p>`) + links.map(link => `<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.title)}</a></p>`).join('')
  return { messages: [{ kind: 'text', text, ...(message.email || links.length ? { email: { subject: message.email?.subject ?? '', ...message.email, html } } : {}) }], degraded: [] }
}

/** Structured Workers API, verified 24/10/2026: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/ .
 * Never invokes the REST API; errors carry only safe codes and ambiguous outcomes are never retried. */
export async function sendEmailBinding(binding: EmailSendBinding | undefined, connection: Connection, target: SendTarget, part: OutboundMessage): Promise<SendResult> {
  if (target.kind !== 'direct' || part.kind !== 'text') return unsupported()
  const fitted = fitEmail(part, connection.profile)
  if (!('messages' in fitted)) return fitted
  const message = fitted.messages[0]
  if (message.kind !== 'text') return unsupported()
  const settings = connection.settings
  const from = String(settings.senderAddress ?? connection.externalId)
  const subject = message.email?.subject || String(settings.defaultSubject ?? 'Mensagem da equipe')
  const replyTo = settings.replyTo ? String(settings.replyTo) : undefined
  if (!binding || !validEmail(from) || !validEmail(target.externalUserId) || (replyTo && !validEmail(replyTo))) return reject('email_not_configured')
  if (/[\r\n]/.test(subject) || subject.length > (connection.profile.email?.subjectMaxLength ?? 998)) return reject('invalid_email_subject')
  const html = `${message.email?.preheader ? `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(message.email.preheader)}</div>` : ''}${message.email?.html ?? `<p>${escapeHtml(message.text).replace(/\n/g, '<br>')}</p>`}`
  // platform/limits.md: 5 MiB for the whole message including attachments (25 MiB applies only to verified destinations,
  // which we do not distinguish, so 5 MiB is always the safe bound). There are no attachments today; if they are added,
  // base64 grows them by about 4/3 and they must be counted here. Both body alternatives count; 16 KiB is our own MIME margin.
  if (new TextEncoder().encode(message.text + html + subject).byteLength + 16_384 > 5 * 1024 * 1024) return reject('email_too_large')
  try {
    const response = await binding.send({ to: normalizeEmail(target.externalUserId), from: { email: normalizeEmail(from), ...(settings.senderName ? { name: String(settings.senderName) } : {}) }, subject, text: message.text, html, ...(replyTo ? { replyTo } : {}) })
    return response && typeof response.messageId === 'string' && response.messageId ? { ok: true, externalId: response.messageId, parts: 1 } : uncertain()
  } catch (error) {
    // The daily quota only comes back the next day: waiting seconds would burn every retry.
    const failure = classifySendError(error)
    if (failure.kind === 'rate_limited') return { ok: false, reason: 'rate_limited', retryAfterSec: failure.retryAfterSec }
    if (failure.kind === 'rejected') return reject(failure.code)
    return uncertain()
  }
}

// Receiving is the native email() handler of the Worker (api/route-emails/email-handler.md) and there is no HTTP webhook
// for this channel, so no callback URL or token is exposed; the checklist is the whole guide.
const guide = (_ctx: ConnectContext) => ({ kind: 'manual_webhook' as const, callbackUrl: '', verifyToken: '', checklist: [
  'Cadastre o domínio no Cloudflare Email Service e copie os registros SPF e DKIM exibidos na sua conta.',
  'Publique os registros no DNS e aguarde a confirmação. Configure DMARC para o domínio remetente.',
  'No Email Routing, ative o domínio de respostas e adicione uma rota do endereço para este Worker.',
  'Configure o binding EMAIL no Worker. Somente uma resposta a um e-mail enviado abre uma conversa.',
  'Para registrar entrega, bounce e reclamação, crie uma Event Subscription (assinatura de eventos) do Email Sending para o domínio remetente, publicando na fila que este Worker consome (Queues, eventos cf.email.sending.message.*).',
  'A Cloudflare aceita apenas e-mail transacional. Transmissões de marketing ficam limitadas à simulação local.',
] })

export const cloudflareEmail: ProviderAdapter = {
  id: 'cloudflare_email', kinds: ['email'], patch: cloudflareEmailMeta.patch,
  credentialsSchema: z.object({ senderAddress: z.email().optional() }).catchall(z.string()), settingsSchema: emailSettingsSchema,
  async connect(ctx) {
    if (!this.credentialsSchema.safeParse(ctx.credentials).success) return { kind: 'failed', code: 'invalid_credentials', detail: 'Confira o endereço remetente.' }
    return guide(ctx)
  },
  async registerWebhook(ctx) { return { registered: false, manual: guide(ctx) } },
  // Inbound Email Routing is a native Worker event, never an unsigned HTTP delivery.
  async verifyWebhook() { return { ok: false, status: 403 } },
  // Not a Cloudflare payload: Cloudflare has no HTTP webhook for received mail. This is the platform's own internal event,
  // built by receiveReply() and queued on INBOUND after the native email() handler verified the reply. Open/click events
  // come from our own pixel and link rewriting (/api/email-public), never from Cloudflare (event-subscriptions.md has none).
  parseInbound(body, connection) {
    if (!body || typeof body !== 'object') return [{ kind: 'ignored', why: 'Evento de e-mail inválido', eventKey: 'email:unknown' }]
    const event = body as Record<string, unknown>
    const messageId = typeof event.messageId === 'string' ? event.messageId : ''
    const eventKey = String(event.eventId ?? messageId ?? 'email:unknown') || 'email:unknown'
    const from = typeof event.from === 'string' ? normalizeEmail(event.from) : ''
    if (!validEmail(from) || from === normalizeEmail(connection.externalId)) return [{ kind: 'ignored', why: 'E-mail sem remetente válido', eventKey }]
    if (event.type === 'reply' && event.verifiedReply === true && messageId && typeof event.inReplyTo === 'string') return [{ kind: 'message', eventKey, from: { externalUserId: from, addressKind: 'email' }, thread: { kind: 'direct' }, externalMessageId: messageId, text: typeof event.text === 'string' ? event.text : '', replyTo: event.inReplyTo }]
    if (event.type === 'click' && typeof event.url === 'string') return [{ kind: 'click', eventKey, from: { externalUserId: from, addressKind: 'email' }, thread: { kind: 'direct' }, payload: event.url }]
    return [{ kind: 'ignored', why: 'Somente respostas verificadas entram na caixa de entrada', eventKey }]
  },
  fit: fitEmail as (message: OutboundMessage, profile: ChannelCapabilities) => ReturnType<ChannelAdapter['fit']>,
  async send(ctx: ProviderCtx & { target: SendTarget }, part) {
    if (ctx.env) {
      const { sendEmailPart } = await import('../email-channel/service')
      return sendEmailPart(ctx.env, ctx.connection, ctx.target, part, ctx.intent ?? 'human')
    }
    if (ctx.intent && ctx.intent !== 'human') return reject('marketing_cloudflare_unsupported')
    return sendEmailBinding(ctx.bindings?.email, ctx.connection, ctx.target, part)
  },
}
