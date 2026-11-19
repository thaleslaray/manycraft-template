import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { json } from './security'
import { sendAlertEmail } from './email'
import type { IntegrationEnv } from './integrations'
import { chatLinkTarget, chatLinkUrl, linkableChats, newChatLinkCode, sendToChat } from './channels/team-alert-chat'
export { handleAlertStart } from './channels/team-alert-chat'

/** Avisos da equipe fora do painel (e-mail e chat). Push fica de fora: a réplica não tem app móvel. */

/** Trava contra excesso: no máximo um aviso por pessoa, por conversa e por origem (caixa ou fluxo) neste intervalo. */
export const ALERT_INTERVAL_MINUTES = 5
export type AlertChannel = 'email' | 'chat'
type Kind = 'assigned_message' | 'unassigned' | 'assigned_to_me' | 'flow'
type AlertEnv = IntegrationEnv & { EMAIL_FROM?: string }
/** Este isolado guardou avisos novos: quem acabou de receber o evento entrega já, sem esperar o cron (e sem consulta a mais quando não há nada). */
let queuedHere = false
export function takeQueuedAlerts(): boolean { const queued = queuedHere; queuedHere = false; return queued }
const snippet = (text: string) => [...text.replace(/\s+/g, ' ').trim()].slice(0, 140).join('')

async function insertAlerts(env: Pick<Env, 'DB'>, ws: string, members: string[], a: { scope: string; origin: 'inbox' | 'flow'; kind: Kind; subject: string; body: string; channels?: AlertChannel[] }) {
  const now = Date.now(), cutoff = now - ALERT_INTERVAL_MINUTES * 60_000
  if (!members.length) return
  const results = await env.DB.batch([...new Set(members)].map(member => env.DB.prepare(`INSERT INTO member_alerts(id,workspace_id,member_id,scope_id,origin,kind,subject,body,channels,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM member_alerts WHERE workspace_id=? AND member_id=? AND scope_id=? AND origin=? AND created_at>?)`)
    .bind(crypto.randomUUID(), ws, member, a.scope, a.origin, a.kind, a.subject, a.body, a.channels ? JSON.stringify(a.channels) : null, now, ws, member, a.scope, a.origin, cutoff)))
  if (results.some(r => r.meta.changes)) queuedHere = true
}
async function interested(env: Pick<Env, 'DB'>, ws: string, column: 'on_assigned_message' | 'on_unassigned' | 'on_assigned_to_me', only?: string): Promise<string[]> {
  const rows = await env.DB.prepare(`SELECT s.member_id FROM member_alert_settings s JOIN workspace_members m ON m.id=s.member_id
    WHERE s.workspace_id=? AND s.${column}=1 AND (m.inbox_seat=1 OR m.role='owner')${only ? ' AND s.member_id=?' : ''}`).bind(ws, ...(only ? [only] : [])).all<{ member_id: string }>()
  return rows.results.map(r => r.member_id)
}
async function describe(env: Pick<Env, 'DB'>, ws: string, conversationId: string) {
  return await env.DB.prepare(`SELECT v.assignee_id,trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')) AS name,coalesce(h.display_name,h.type) AS channel
    FROM conversations v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id JOIN contacts c ON c.workspace_id=cc.workspace_id AND c.id=cc.contact_id
    JOIN channels h ON h.workspace_id=cc.workspace_id AND h.id=cc.channel_id WHERE v.workspace_id=? AND v.id=?`).bind(ws, conversationId).first<{ assignee_id: string | null; name: string; channel: string }>()
}
const who = (name: string) => name || 'Contato sem nome'

/** Mensagem do contato recebida: avisa quem pediu. `autoAssigned` é quem a atribuição automática escolheu agora (esse recebe "atribuída a você"). */
export async function queueInboundAlerts(env: Pick<Env, 'DB'>, ws: string, conversationId: string, text: string, autoAssigned: string | null) {
  const info = await describe(env, ws, conversationId)
  if (!info) return
  const line = `${who(info.name)} (${info.channel}): "${snippet(text)}"`
  if (autoAssigned) return insertAlerts(env, ws, await interested(env, ws, 'on_assigned_to_me', autoAssigned), { scope: conversationId, origin: 'inbox', kind: 'assigned_to_me', subject: 'Uma conversa foi atribuída a você', body: line })
  if (info.assignee_id) return insertAlerts(env, ws, await interested(env, ws, 'on_assigned_message', info.assignee_id), { scope: conversationId, origin: 'inbox', kind: 'assigned_message', subject: 'Nova mensagem em uma conversa sua', body: line })
  return insertAlerts(env, ws, await interested(env, ws, 'on_unassigned'), { scope: conversationId, origin: 'inbox', kind: 'unassigned', subject: 'Nova conversa sem responsável', body: line })
}
/** Conversa atribuída a um membro por outra pessoa ou por automação (quem se atribuiu a si mesmo não precisa de aviso). */
export async function queueAssignedAlert(env: Pick<Env, 'DB'>, ws: string, conversationId: string, memberId: string, actorMemberId?: string) {
  if (memberId === actorMemberId) return
  const info = await describe(env, ws, conversationId)
  if (!info) return
  await insertAlerts(env, ws, await interested(env, ws, 'on_assigned_to_me', memberId), { scope: conversationId, origin: 'inbox', kind: 'assigned_to_me', subject: 'Uma conversa foi atribuída a você', body: `${who(info.name)} (${info.channel}) agora está com você.` })
}
/** Ação "Notificar responsáveis" com e-mail e/ou chat: um aviso por destinatário, nos meios escolhidos. */
export async function queueFlowAlert(env: Pick<Env, 'DB'>, ws: string, contactId: string, channelId: string, recipient: string | null, message: string, via: AlertChannel[]) {
  const conversation = await env.DB.prepare(`SELECT v.id FROM conversations v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id
    WHERE cc.workspace_id=? AND cc.contact_id=? AND cc.channel_id=?`).bind(ws, contactId, channelId).first<{ id: string }>()
  const contact = await env.DB.prepare("SELECT trim(coalesce(first_name,'')||' '||coalesce(last_name,'')) AS name FROM contacts WHERE workspace_id=? AND id=?").bind(ws, contactId).first<{ name: string }>()
  const members = recipient ? [recipient] : (await env.DB.prepare("SELECT id FROM workspace_members WHERE workspace_id=? AND (inbox_seat=1 OR role='owner')").bind(ws).all<{ id: string }>()).results.map(r => r.id)
  await insertAlerts(env, ws, members, { scope: conversation?.id ?? contactId, origin: 'flow', kind: 'flow', subject: 'Aviso de uma automação', body: `${message}\n\nContato: ${who(contact?.name ?? '')}`, channels: via })
}

type Pending = { id: string; workspace_id: string; member_id: string; subject: string; body: string; channels: string | null }
type Member = { account_email: string; email_enabled: number | null; alert_email: string | null; chat_id: string | null; chat_channel_id: string | null }
/** Entrega os avisos na fila (cron a cada minuto e logo depois dos eventos). Cada meio falha sozinho: o outro segue. Nunca lança. */
export async function drainMemberAlerts(env: AlertEnv): Promise<number> {
  const rows = await env.DB.prepare("SELECT id,workspace_id,member_id,subject,body,channels FROM member_alerts WHERE status='pending' ORDER BY created_at,id LIMIT 50").all<Pending>()
  let done = 0
  for (const alert of rows.results) {
    const claimed = await env.DB.prepare("UPDATE member_alerts SET status='done' WHERE id=? AND status='pending' RETURNING id").bind(alert.id).first()
    if (!claimed) continue
    const result: Record<string, string> = {}
    const member = await env.DB.prepare(`SELECT u.email AS account_email,s.email_enabled,s.alert_email,s.chat_id,s.chat_channel_id FROM workspace_members m JOIN "user" u ON u.id=m.user_id
      LEFT JOIN member_alert_settings s ON s.member_id=m.id WHERE m.id=? AND m.workspace_id=?`).bind(alert.member_id, alert.workspace_id).first<Member>()
    if (member) {
      const wanted: AlertChannel[] = alert.channels ? JSON.parse(alert.channels) : ['email', 'chat']
      if (wanted.includes('email')) {
        if (alert.channels === null && member.email_enabled === 0) result.email = 'desligado'
        else try { await sendAlertEmail(env as unknown as Env, member.alert_email ?? member.account_email, alert.subject, alert.body); result.email = 'enviado' } catch { result.email = 'falhou' }
      }
      if (wanted.includes('chat')) {
        if (!member.chat_id || !member.chat_channel_id) result.chat = 'sem vínculo'
        else try { result.chat = await sendToChat(env, alert.workspace_id, member.chat_channel_id, member.chat_id, `${alert.subject}\n${alert.body}`) ? 'enviado' : 'falhou' } catch { result.chat = 'falhou' }
      }
    }
    await env.DB.prepare('UPDATE member_alerts SET result=? WHERE id=?').bind(JSON.stringify(result), alert.id).run()
    done++
  }
  return done
}

/** Configurações > Notificações, por membro: contatos de aviso e preferências. Cada pessoa mexe só nos próprios. */
export const memberAlerts = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const me = (c: { var: AuthVariables }) => c.var.memberId
export const memberAlertsSchema = z.object({ email_enabled: z.boolean(), alert_email: z.email().max(254).nullable().optional(), on_assigned_message: z.boolean(), on_unassigned: z.boolean(), on_assigned_to_me: z.boolean() }).strict()
export const alertChatLinkSchema = z.object({ channel_id: z.string().min(1).max(128) }).strict()
memberAlerts.get('/me/alerts', async c => {
  const ws = c.var.principal.workspaceId, id = me(c)
  const [s, chats] = await Promise.all([c.env.DB.prepare('SELECT * FROM member_alert_settings WHERE member_id=?').bind(id).first<Record<string, number | string | null>>(), linkableChats(c.env, ws)])
  const bots = { results: chats }
  return c.json({ account_email: c.var.email, email_enabled: (s?.email_enabled ?? 1) === 1, alert_email: (s?.alert_email as string | null) ?? null,
    chat_linked: !!s?.chat_id, chat_bot: s?.chat_id ? (s.chat_channel_id as string) : null, chat_bots: bots.results,
    on_assigned_message: s?.on_assigned_message === 1, on_unassigned: s?.on_unassigned === 1, on_assigned_to_me: s?.on_assigned_to_me === 1, interval_minutes: ALERT_INTERVAL_MINUTES })
})
memberAlerts.put('/me/alerts', async c => {
  const ws = c.var.principal.workspaceId, id = me(c)
  const i = memberAlertsSchema.parse(await json(c.req.raw))
  await c.env.DB.prepare(`INSERT INTO member_alert_settings(member_id,workspace_id,email_enabled,alert_email,on_assigned_message,on_unassigned,on_assigned_to_me) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(member_id) DO UPDATE SET email_enabled=excluded.email_enabled,alert_email=excluded.alert_email,on_assigned_message=excluded.on_assigned_message,on_unassigned=excluded.on_unassigned,on_assigned_to_me=excluded.on_assigned_to_me`)
    .bind(id, ws, i.email_enabled ? 1 : 0, i.alert_email ?? null, i.on_assigned_message ? 1 : 0, i.on_unassigned ? 1 : 0, i.on_assigned_to_me ? 1 : 0).run()
  return c.json(i)
})
memberAlerts.post('/me/alerts/chat-link', async c => {
  const ws = c.var.principal.workspaceId, id = me(c)
  const { channel_id } = alertChatLinkSchema.parse(await json(c.req.raw))
  const bot = await chatLinkTarget(c.env, ws, channel_id)
  if (!bot) throw new HTTPException(404, { message: 'Conexão de chat não encontrada.' })
  const { code, expires_at } = newChatLinkCode()
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM alert_chat_codes WHERE member_id=? AND used_chat_id IS NULL').bind(id),
    c.env.DB.prepare('INSERT INTO alert_chat_codes(code,workspace_id,member_id,channel_id,expires_at) VALUES (?,?,?,?,?)').bind(code, ws, id, channel_id, expires_at),
  ])
  return c.json({ code, expires_at, bot: bot.display_name, url: chatLinkUrl(bot.display_name, code) }, 201)
})
memberAlerts.delete('/me/alerts/chat', async c => {
  await c.env.DB.prepare('UPDATE member_alert_settings SET chat_id=NULL,chat_channel_id=NULL WHERE member_id=?').bind(await me(c)).run()
  return c.body(null, 204)
})
