import { marketingKey, sendViaResend } from './marketing-provider'
import { classifySendError } from '../channels/cloudflare-email-errors'
import type { Connection, SendTarget } from '../channels/contract'
import type { OutboundMessage, SendResult } from '../channels/types'
import { ensureConversation, recordMessage } from '../inbox/service'
import { changeConsent } from '../channels/core/consent'
import {
  emailContact,
  escapeHtml,
  initialize,
  normalizeEmail,
  usage,
  type EmailEnv,
  type Sender,
} from './store'
export type { EmailEnv } from './store'
export type StoredEmail = {
  id: string
  workspace_id: string
  connection_id: string
  contact_id: string
  sender_id: string
  recipient: string
  message_id: string
  provider_message_id: string | null
  reply_to: string
  token: string
  subject: string
  preheader: string
  text: string
  html: string
  intent: string
  status: string
  created_at: number
  metadata: string | null
}
const rejected = (code: string, detail: string): SendResult => ({
  ok: false,
  reason: 'rejected',
  code,
  detail,
})
/** Cloudflare Email Service supports transactional mail only. Production marketing is intentionally blocked.
 * https://developers.cloudflare.com/email-service/reference/faq/ (consultado 2026-10-24). */
export async function sendEmailPart(
  env: EmailEnv,
  connection: Connection,
  target: SendTarget,
  message: OutboundMessage,
  intent: 'automation' | 'human' | 'broadcast',
): Promise<SendResult> {
  if (message.kind !== 'text' || target.kind !== 'direct')
    return {
      ok: false,
      reason: 'unsupported',
      detail: 'E-mail requer texto ou HTML e destinatário direto.',
    }
  const ws = connection.workspaceId,
    marketing = intent !== 'human'
  if (!connection.profile.email)
    return {
      ok: false,
      reason: 'unsupported',
      detail: 'A ficha efetiva desta conexão não permite e-mail.',
    }
  if (connection.status !== 'connected')
    return rejected('email_disconnected', 'Conecte o e-mail antes de enviar.')
  const supplied = (
    message as typeof message & {
      email?: { subject?: string; preheader?: string; html?: string }
    }
  ).email
  if (supplied?.subject && (supplied.subject.length > 998 || /[\r\n]/.test(supplied.subject)))
    return rejected('invalid_subject', 'Assunto inválido: use até 998 caracteres sem quebra de linha.')
  if (new TextEncoder().encode(message.text + (supplied?.html ?? '')).byteLength > 5 * 1024 * 1024)
    return rejected('message_too_large', 'O e-mail excede o limite de 5 MiB.')
  const providerKey = marketing && env.APP_ENV !== 'development' ? await marketingKey(env, ws) : null
  if (marketing && env.APP_ENV !== 'development' && !providerKey)
    return rejected(
      'marketing_cloudflare_unsupported',
      'O Cloudflare Email Service permite somente e-mails transacionais. Marketing permanece em simulação local.',
    )
  await initialize(env, ws)
  const settings = await env.DB.prepare('SELECT * FROM email_settings WHERE workspace_id=?')
    .bind(ws)
    .first<any>()
  const detail = message.email
  const sender = await env.DB.prepare('SELECT * FROM email_senders WHERE workspace_id=? AND id=?')
    .bind(ws, detail?.senderId ?? settings.default_sender_id)
    .first<Sender>()
  if (!sender || sender.status !== 'verified')
    return rejected('sender_unverified', 'Escolha um endereço remetente verificado.')
  if (/[\r\n]/.test(sender.name + sender.address + sender.reply_to))
    return rejected('sender_invalid', 'A configuração do remetente contém caracteres inválidos.')
  const to = normalizeEmail(target.externalUserId)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return rejected('email_invalid', 'Endereço de e-mail inválido.')
  const cc = await env.DB.prepare(
    "SELECT cc.contact_id,cc.opted_in FROM contact_channels cc JOIN contacts c ON c.id=cc.contact_id AND c.workspace_id=cc.workspace_id WHERE cc.workspace_id=? AND cc.channel_id=? AND lower(cc.external_user_id)=? AND c.status<>'deleted'",
  )
    .bind(ws, connection.id, to)
    .first<{ contact_id: string; opted_in: number }>()
  if (marketing && !cc?.opted_in) return { ok: false, reason: 'not_opted_in' }
  if (marketing && (!settings.company_name.trim() || !settings.company_address.trim()))
    return rejected('company_required', 'Preencha nome e endereço da empresa antes de enviar marketing.')
  const quota = await usage(env, ws)
  if (marketing && quota.paused) return rejected('email_paused', 'Envio pausado: confira a reputação do envio.')
  const contactId = cc?.contact_id ?? (await emailContact(env, ws, connection.id, to, false))
  const previousOutbound = await env.DB.prepare(
    "SELECT coalesce(provider_message_id,message_id) AS message_id,subject FROM email_messages WHERE workspace_id=? AND connection_id=? AND contact_id=? AND status='sent' ORDER BY created_at DESC,rowid DESC LIMIT 1",
  )
    .bind(ws, connection.id, contactId)
    .first<{ message_id: string; subject: string }>()
  const previousInbound =
    intent === 'human'
      ? await env.DB.prepare(
          "SELECT m.external_message_id FROM messages m JOIN conversations v ON v.workspace_id=m.workspace_id AND v.id=m.conversation_id JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id WHERE m.workspace_id=? AND cc.contact_id=? AND cc.channel_id=? AND m.direction='in' AND m.external_message_id LIKE 'email:%' ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1",
        )
          .bind(ws, contactId, connection.id)
          .first<{ external_message_id: string }>()
      : null
  const inboundThreadId = previousInbound?.external_message_id.match(/^email:[^:]+:[^:]+:(.+)$/)?.[1]
  const replySubject =
    intent === 'human' && previousOutbound
      ? /^re:/i.test(previousOutbound.subject)
        ? previousOutbound.subject
        : `Re: ${previousOutbound.subject}`
      : 'Mensagem da equipe'
  const id = crypto.randomUUID(),
    token = crypto.randomUUID(),
    domain = sender.address.split('@')[1]
  // Our own Message-ID is only a local key (dev simulator and fallback id): Cloudflare generates the real header and
  // rejects ours with E_HEADER_NOT_ALLOWED (reference/headers.md), so it is never put in `headers` below.
  const mid = `<${id}@${domain}>`,
    replyTo =
      sender.is_platform && sender.reply_to === `reply@${sender.address.split('@')[1]}`
        ? `reply+${token}@${env.EMAIL_DEFAULT_DOMAIN ?? 'mail.replica.test'}`
        : sender.reply_to
  const base = (env.PUBLIC_BASE_URL ?? 'http://localhost:5602').replace(/\/$/, '')
  const unsub = `${base}/api/email-public/unsubscribe/${token}`
  let text = message.text,
    html = detail?.html ?? `<p>${escapeHtml(text).replaceAll('\n', '<br>')}</p>`
  for (const button of message.buttons ?? [])
    if (button.type === 'url') {
      text += `\n${button.title}: ${button.url}`
      html += `<p><a href="${escapeHtml(button.url)}">${escapeHtml(button.title)}</a></p>`
    }
  const contact = await env.DB.prepare(
    'SELECT first_name,last_name FROM contacts WHERE workspace_id=? AND id=?',
  )
    .bind(ws, contactId)
    .first<Record<string, string | null>>()
  const fields = await env.DB.prepare(
    'SELECT f.name,v.value FROM contact_field_values v JOIN custom_fields f ON f.id=v.field_id AND f.workspace_id=v.workspace_id WHERE v.workspace_id=? AND v.contact_id=?',
  )
    .bind(ws, contactId)
    .all<{ name: string; value: string }>()
  const variables: Record<string, unknown> = {
    first_name: contact?.first_name,
    last_name: contact?.last_name,
    email: to,
    ...Object.fromEntries(fields.results.map((v) => [v.name, JSON.parse(v.value)])),
  }
  const render = (str: string, safe = false) =>
    str.replace(/\{\{\s*([^{}|]+?)(?:\s*\|\s*([^{}]*))?\s*\}\}/g, (_m, k: string, fallback: string) => {
      const value = String(variables[k.trim()] ?? fallback ?? '')
      return safe ? escapeHtml(value) : value
    })
  text = render(text)
  html = render(html, true)
  const subject = render(detail?.subject?.trim() || replySubject),
    preheader = render(detail?.preheader ?? '')
  if (subject.length > 998 || /[\r\n]/.test(subject))
    return rejected(
      'invalid_subject',
      'Assunto resolvido inválido: use até 998 caracteres sem quebra de linha.',
    )
  if (preheader)
    html = `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(preheader)}</div>${html}`
  if (marketing) {
    text += `\n\n${settings.company_name}\n${settings.company_address}\nDescadastrar: ${unsub}`
    html += `<footer><p>${escapeHtml(settings.company_name)}<br>${escapeHtml(settings.company_address)}</p><a href="${unsub}">Descadastrar do e-mail</a></footer>`
  }
  if (sender.branding) html += '<p>Enviado pela plataforma</p>'
  // Store each destination server-side; public redirects never accept a target supplied by a caller.
  const links: Record<string, string> = {}
  html = html.replace(/href=(['"])(https?:\/\/[^'"\s]+)\1/gi, (match, quote: string, url: string) => {
    if (url.includes('/api/email-public/unsubscribe/')) return match
    const key = crypto.randomUUID()
    links[key] = url.replaceAll('&amp;', '&')
    return `href=${quote}${base}/api/email-public/click/${token}/${key}${quote}`
  })
  html += `<img src="${base}/api/email-public/open/${token}.gif" width="1" height="1" alt="" />`
  if (new TextEncoder().encode(text + html + subject).byteLength + 16384 > 5 * 1024 * 1024)
    return rejected('message_too_large', 'O e-mail excede o limite de 5 MiB.')
  const headers: Record<string, string> = {
    ...(marketing
      ? {
          'List-Unsubscribe': `<${unsub}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        }
      : {}),
    ...(intent === 'human' && (inboundThreadId || previousOutbound)
      ? {
          'In-Reply-To': inboundThreadId ?? previousOutbound!.message_id,
          References: previousOutbound?.message_id ?? inboundThreadId!,
        }
      : {}),
  }
  await env.DB.prepare(
    'INSERT INTO email_messages(id,workspace_id,connection_id,contact_id,sender_id,recipient,message_id,reply_to,token,subject,preheader,text,html,intent,metadata,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  )
    .bind(
      id,
      ws,
      connection.id,
      contactId,
      sender.id,
      to,
      mid,
      replyTo,
      token,
      subject,
      preheader,
      text,
      html,
      intent,
      JSON.stringify(detail ?? {}),
      Date.now(),
    )
    .run()
  if (Object.keys(links).length)
    await env.DB.prepare(
      'INSERT INTO email_message_links(message_id,link_id,url) VALUES ' +
        Object.keys(links)
          .map(() => '(?,?,?)')
          .join(','),
    )
      .bind(...Object.entries(links).flatMap(([key, url]) => [id, key, url]))
      .run()
  let providerId: string | null = null
  if (env.APP_ENV !== 'development' && providerKey) {
    // Marketing pelo provedor com chave própria (o serviço transacional não aceita marketing).
    const sent = await sendViaResend(providerKey, { from: { email: sender.address, name: sender.name }, to, ...(replyTo ? { replyTo: String(replyTo) } : {}), subject, text, ...(html ? { html } : {}), ...(headers ? { headers: headers as Record<string, string> } : {}) })
    if (!sent.ok) {
      await env.DB.prepare('UPDATE email_messages SET status=? WHERE id=?').bind(sent.uncertain ? 'uncertain' : 'failed', id).run()
      return sent.uncertain ? { ok: false, reason: 'uncertain', detail: 'O provedor não confirmou o envio. Confira antes de repetir.' } : rejected(sent.code, 'O provedor recusou o envio. Confira o remetente e o conteúdo.')
    }
    providerId = sent.id
  } else if (env.APP_ENV !== 'development') {
    if (!env.EMAIL) {
      await env.DB.prepare("UPDATE email_messages SET status='failed' WHERE id=?").bind(id).run()
      return rejected('email_binding_missing', 'Binding de envio de e-mail não configurado.')
    }
    try {
      const response = await env.EMAIL.send({
        to,
        from: { email: sender.address, name: sender.name },
        replyTo,
        subject,
        text,
        html,
        headers,
      })
      providerId =
        typeof response?.messageId === 'string' && response.messageId.trim() ? response.messageId : null
      if (!providerId) {
        await env.DB.prepare("UPDATE email_messages SET status='uncertain' WHERE id=?").bind(id).run()
        return {
          ok: false,
          reason: 'uncertain',
          detail: 'O serviço não retornou o identificador do envio. Confira antes de repetir.',
        }
      }
    } catch (error) {
      const failure = classifySendError(error)
      // Only an unclear outcome is 'uncertain'; an unclear outcome stays 'uncertain' and is never auto-retried.
      await env.DB.prepare('UPDATE email_messages SET status=? WHERE id=?')
        .bind(failure.kind === 'uncertain' ? 'uncertain' : 'failed', id)
        .run()
      // The daily quota only comes back the next day: waiting seconds would burn every retry.
      if (failure.kind === 'rate_limited') return { ok: false, reason: 'rate_limited', retryAfterSec: failure.retryAfterSec }
      if (failure.kind === 'rejected') {
        // E_ACCOUNT_SUSPENDED: Cloudflare paused sending for the account (poor reputation); E_RECIPIENT_SUPPRESSED: unreachable address.
        if (failure.effect === 'pause_sending') await env.DB.prepare("UPDATE email_settings SET paused=1,pause_reason='provider' WHERE workspace_id=?").bind(ws).run()
        if (failure.effect === 'recipient_unreachable') await markUnreachable(env, ws, contactId)
        return rejected(failure.code, 'O serviço recusou o envio. Confira a configuração e o conteúdo.')
      }
      return {
        ok: false,
        reason: 'uncertain',
        detail: 'O serviço não confirmou o envio. Confira o registro antes de repetir.',
      }
    }
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE email_messages SET status='sent',provider_message_id=? WHERE id=?").bind(
      providerId,
      id,
    ),
    env.DB.prepare(
      "INSERT INTO email_events(id,workspace_id,message_id,contact_id,type,created_at) VALUES (?,?,?,?,'sent',?)",
    ).bind(crypto.randomUUID(), ws, id, contactId, Date.now()),
  ])
  // The flow/inbox callers already record their own outbound entry; only test-specific routes mirror it.
  return { ok: true, externalId: providerId ?? mid, parts: 1 }
}
export async function mirrorOutbound(env: EmailEnv, mail: StoredEmail) {
  const conversationId = await ensureConversation(env, mail.workspace_id, mail.contact_id, mail.connection_id)
  await recordMessage(env, {
    id: `email-out-${mail.id}`,
    workspaceId: mail.workspace_id,
    conversationId,
    direction: 'out',
    sender: 'automation',
    text: mail.text,
    email_subject: mail.subject,
    externalMessageId: mail.message_id,
    connectionId: mail.connection_id,
  })
  return conversationId
}
/** The contact can no longer be reached by email: drop the opt-in on every email channel of the workspace. */
export async function markUnreachable(env: EmailEnv, workspaceId: string, contactId: string) {
  await changeConsent(env.DB, { optedIn: false, where: { sql: "workspace_id=? AND contact_id=? AND channel_id IN (SELECT id FROM channels WHERE workspace_id=? AND type='email')", binds: [workspaceId, contactId, workspaceId] } }).run()
}
export async function emailEvent(
  env: EmailEnv,
  mail: StoredEmail,
  type: 'opened' | 'clicked' | 'hard_bounce' | 'soft_bounce' | 'unsubscribed' | 'complaint' | 'delivered',
  url?: string,
) {
  if (
    !(await env.DB.prepare("SELECT id FROM contacts WHERE workspace_id=? AND id=? AND status<>'deleted'")
      .bind(mail.workspace_id, mail.contact_id)
      .first())
  )
    return
  const eventId = crypto.randomUUID()
  await env.DB.prepare(
    'INSERT INTO email_events(id,workspace_id,message_id,contact_id,type,url,created_at) VALUES (?,?,?,?,?,?,?)',
  )
    .bind(eventId, mail.workspace_id, mail.id, mail.contact_id, type, url ?? null, Date.now())
    .run()
  if (['hard_bounce', 'unsubscribed', 'complaint'].includes(type)) await markUnreachable(env, mail.workspace_id, mail.contact_id)
  if (type === 'hard_bounce' || type === 'soft_bounce') {
    const name = type === 'hard_bounce' ? 'E-mail: bounce permanente' : 'E-mail: bounce temporário',
      tagId = `email-${type}-${mail.workspace_id}`
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO tags(id,workspace_id,name) VALUES (?,?,?) ON CONFLICT(workspace_id,name) DO NOTHING',
      ).bind(tagId, mail.workspace_id, name),
      env.DB.prepare(
        'INSERT INTO contact_tags(workspace_id,contact_id,tag_id) SELECT ?,?,id FROM tags WHERE workspace_id=? AND name=? ON CONFLICT(contact_id,tag_id) DO NOTHING',
      ).bind(mail.workspace_id, mail.contact_id, mail.workspace_id, name),
    ])
  }
  const conversationId = await ensureConversation(env, mail.workspace_id, mail.contact_id, mail.connection_id)
  const labels = {
    opened: 'E-mail aberto',
    clicked: 'Link do e-mail clicado',
    hard_bounce: 'E-mail recusado permanentemente',
    soft_bounce: 'E-mail temporariamente indisponível',
    unsubscribed: 'Descadastrado do marketing por e-mail',
    complaint: 'Reclamação de spam recebida',
    delivered: 'E-mail entregue ao servidor destinatário',
  }
  await recordMessage(env, {
    workspaceId: mail.workspace_id,
    conversationId,
    direction: 'out',
    sender: 'system',
    text: `${labels[type]}: ${mail.subject}${url ? ` — ${url}` : ''}`,
  })
  if (type === 'opened' || type === 'clicked') {
    const { runEmailInteraction } = await import('./events')
    await runEmailInteraction(env, mail, type, eventId, url)
  }
  const since = Date.now() - 30 * 86400_000
  const rates = await env.DB.prepare(
    "SELECT count(DISTINCT CASE WHEN type IN('hard_bounce','soft_bounce') THEN message_id END) AS bounces,count(DISTINCT CASE WHEN type='unsubscribed' THEN message_id END) AS unsubscribes,count(DISTINCT CASE WHEN type='complaint' THEN message_id END) AS complaints FROM email_events WHERE workspace_id=? AND created_at>=?",
  )
    .bind(mail.workspace_id, since)
    .first<any>()
  const sent = await env.DB.prepare(
    "SELECT count(*) AS n FROM email_messages WHERE workspace_id=? AND status='sent' AND created_at>=?",
  )
    .bind(mail.workspace_id, since)
    .first<{ n: number }>()
  const limits = await env.DB.prepare(
    'SELECT bounce_threshold,unsubscribe_threshold,complaint_threshold FROM email_settings WHERE workspace_id=?',
  )
    .bind(mail.workspace_id)
    .first<any>()
  // Poucos envios não medem reputação: um descadastro em três e-mails não é 33% de rejeição.
  if (!sent?.n || sent.n < REPUTATION_MIN_SENT || !limits) return
  const reason =
    rates.complaints / sent.n > limits.complaint_threshold ? 'complaint'
    : rates.bounces / sent.n > limits.bounce_threshold ? 'bounce'
    : rates.unsubscribes / sent.n > limits.unsubscribe_threshold ? 'unsubscribe'
    : null
  if (reason)
    await env.DB.prepare('UPDATE email_settings SET paused=1,pause_reason=? WHERE workspace_id=? AND paused=0')
      .bind(reason, mail.workspace_id)
      .run()
}

/** Envios nos últimos 30 dias a partir dos quais as taxas de reputação passam a pausar o espaço. */
export const REPUTATION_MIN_SENT = 20
