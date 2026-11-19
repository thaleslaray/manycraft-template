import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize } from './permissions'
import { json } from './security'
import { sendEmail } from './email'
import { logTaskError } from './log-error'
import { enabledSchema } from './schemas/enabled'

/** Avisos da conta: os gatilhos do banco criam (conexão caída, restrição); o painel lê e marca como lidos. */
export const notices = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const kinds = ['connection', 'restriction'] as const
export const noticePreferencesSchema = z.object(Object.fromEntries(kinds.map(k => [k, z.boolean()])) as Record<typeof kinds[number], z.ZodBoolean>).strict()
notices.get('/notices', async c => {
  const ws = c.var.principal.workspaceId
  const [items, unread, w] = await Promise.all([
    c.env.DB.prepare('SELECT id,kind,message,created_at,read_at FROM workspace_notices WHERE workspace_id=? ORDER BY id DESC LIMIT 50').bind(ws).all(),
    c.env.DB.prepare('SELECT count(*) AS n FROM workspace_notices WHERE workspace_id=? AND read_at IS NULL').bind(ws).first<number>('n'),
    c.env.DB.prepare('SELECT restricted_reason,notice_prefs FROM workspaces WHERE id=?').bind(ws).first<{ restricted_reason: string | null; notice_prefs: string }>(),
  ])
  return c.json({ items: items.results, unread: unread ?? 0, restriction: w?.restricted_reason ?? null, preferences: JSON.parse(w?.notice_prefs ?? '{}') })
})
notices.post('/notices/read', async c => {
  await c.env.DB.prepare('UPDATE workspace_notices SET read_at=? WHERE workspace_id=? AND read_at IS NULL').bind(Date.now(), c.var.principal.workspaceId).run()
  return c.json({ ok: true })
})
notices.put('/notices/preferences', async c => {
  authorize(c.var.principal, 'team')
  const prefs = noticePreferencesSchema.parse(await json(c.req.raw))
  await c.env.DB.prepare('UPDATE workspaces SET notice_prefs=? WHERE id=?').bind(JSON.stringify(prefs), c.var.principal.workspaceId).run()
  return c.json(prefs)
})
export const connectionDisconnectionSchema = z.object({ notify: z.boolean(), pause_broadcasts: z.boolean() }).strict()
/** Condições de desconexão da conexão: avisar a equipe e/ou pausar as transmissões dela quando cair. */
notices.put('/connections/:id/disconnection', async c => {
  authorize(c.var.principal, 'team')
  const input = connectionDisconnectionSchema.parse(await json(c.req.raw))
  const r = await c.env.DB.prepare("UPDATE channels SET settings=json_set(settings,'$.disconnection',json(?)) WHERE workspace_id=? AND id=? AND archived_at IS NULL")
    .bind(JSON.stringify(input), c.var.principal.workspaceId, c.req.param('id')).run()
  if (!r.meta.changes) throw new HTTPException(404, { message: 'Conexão não encontrada.' })
  return c.json(input)
})

/** Encurtador de links do corpo do texto nesta conexão (cliques contados; sem ele, não há taxa de cliques no texto). */
notices.put('/connections/:id/shorten-links', async c => {
  authorize(c.var.principal, 'team')
  const { enabled } = enabledSchema.parse(await json(c.req.raw))
  const r = await c.env.DB.prepare("UPDATE channels SET settings=json_set(settings,'$.shortenLinks',json(?)) WHERE workspace_id=? AND id=? AND archived_at IS NULL")
    .bind(enabled ? 'true' : 'false', c.var.principal.workspaceId, c.req.param('id')).run()
  if (!r.meta.changes) throw new HTTPException(404, { message: 'Conexão não encontrada.' })
  return c.json({ enabled })
})
/** Cron: avisos ainda não enviados vão por e-mail ao dono quando a preferência do tipo está ligada. */
export async function emailPendingNotices(env: Env) {
  const rows = await env.DB.prepare(`SELECT n.id,n.kind,n.workspace_id,w.notice_prefs,u.email FROM workspace_notices n JOIN workspaces w ON w.id=n.workspace_id
    JOIN workspace_members m ON m.workspace_id=n.workspace_id AND m.role='owner' JOIN "user" u ON u.id=m.user_id
    WHERE n.emailed_at IS NULL ORDER BY n.id LIMIT 50`).all<{ id: number; kind: string; workspace_id: string; notice_prefs: string; email: string }>()
  for (const n of rows.results) {
    const wanted = (JSON.parse(n.notice_prefs) as Record<string, boolean>)[n.kind] !== false
    if (wanted) { try { await sendEmail(env, n.email, 'notice', `${env.BETTER_AUTH_URL ?? ''}/${n.workspace_id}/settings/notices`) } catch (error) { logTaskError('notice_email_failed', error) } }
    await env.DB.prepare('UPDATE workspace_notices SET emailed_at=? WHERE id=?').bind(Date.now(), n.id).run()
  }
}
