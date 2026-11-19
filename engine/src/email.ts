import { HTTPException } from 'hono/http-exception'
import type { Env } from './env'
import { limit } from './security'
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
const titles = { verification: 'Confirme seu endereço de e-mail', reset: 'Escolha uma nova senha', invite: 'Seu espaço de trabalho está esperando', magic: 'Seu acesso seguro ao painel', notice: 'Há um aviso novo na sua conta' }
export async function sendEmail(env: Env, to: string, kind: keyof typeof titles, url: string) {
  await limit(env, `email:${to.toLowerCase()}`, 5, 3600_000)
  const subject = titles[kind]
  const text = `${subject}. Abra este link para continuar: ${url}\nSe você não pediu esta mensagem, pode ignorá-la.`
  const html = `<h1>${escape(subject)}</h1><p>Use o link abaixo para continuar com segurança.</p><p><a href="${escape(url)}">Continuar</a></p><p>Se você não pediu esta mensagem, pode ignorá-la.</p>`
  if (env.APP_ENV === 'development') {
    await env.DB.prepare('INSERT INTO email_outbox VALUES (?,?,?,?,?,?,?)').bind(crypto.randomUUID(), to, kind, subject, html, text, Date.now()).run()
    return
  }
  if (!env.EMAIL || !env.EMAIL_FROM) throw new HTTPException(503, { message: 'Envio de e-mail não configurado.' })
  await env.EMAIL.send({ to, from: env.EMAIL_FROM, subject, html, text })
}

/** Aviso à equipe (sem link de ação). Não passa pelo limite de 5 por hora dos e-mails de conta: a trava de excesso é dos avisos (team-alerts.ts). */
export async function sendAlertEmail(env: Pick<Env, 'DB' | 'APP_ENV' | 'EMAIL' | 'EMAIL_FROM'>, to: string, subject: string, body: string) {
  const text = `${body}\n\nVocê recebe este aviso porque ligou os avisos por e-mail em Configurações > Notificações.`
  const html = `<h1>${escape(subject)}</h1><p>${escape(body).replace(/\n/g, '<br>')}</p><p>Você recebe este aviso porque ligou os avisos por e-mail em Configurações &gt; Notificações.</p>`
  if (env.APP_ENV === 'development') {
    await env.DB.prepare('INSERT INTO email_outbox VALUES (?,?,?,?,?,?,?)').bind(crypto.randomUUID(), to, 'alert', subject, html, text, Date.now()).run()
    return
  }
  if (!env.EMAIL || !env.EMAIL_FROM) throw new HTTPException(503, { message: 'Envio de e-mail não configurado.' })
  await env.EMAIL.send({ to, from: env.EMAIL_FROM, subject, html, text })
}
