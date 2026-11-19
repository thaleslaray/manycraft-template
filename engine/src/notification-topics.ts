import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize } from './permissions'
import { json } from './security'

/** Tópicos (listas) de notificação por conexão, com inscritos ativos e os que vencem nos próximos 7 dias (precisam de re-opt-in). */
export const notificationTopics = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const id = z.string().min(1).max(128)
export const notificationTopicCreateSchema = z.object({ channel_id: id, name: z.string().trim().min(1).max(100), frequency: z.enum(['daily', 'weekly', 'monthly']).default('weekly'),
  validity_days: z.number().int().min(1).max(365).default(180) }).strict()
notificationTopics.get('/notification-topics', async c => {
  authorize(c.var.principal, 'automation:read')
  const now = Date.now()
  const rows = await c.env.DB.prepare(`SELECT t.id,t.channel_id,t.name,t.frequency,t.validity_days,t.created_at,coalesce(ch.display_name,ch.type) AS channel_name,
      (SELECT count(*) FROM topic_subscriptions s WHERE s.topic_id=t.id AND s.status='subscribed' AND s.expires_at>?) AS subscribers,
      (SELECT count(*) FROM topic_subscriptions s WHERE s.topic_id=t.id AND s.status='subscribed' AND s.expires_at>? AND s.expires_at<=?) AS expiring,
      (SELECT count(*) FROM topic_subscriptions s WHERE s.topic_id=t.id AND (s.status='stopped' OR s.expires_at<=?)) AS lapsed
    FROM notification_topics t LEFT JOIN channels ch ON ch.workspace_id=t.workspace_id AND ch.id=t.channel_id WHERE t.workspace_id=? ORDER BY t.created_at`)
    .bind(now, now, now + 7 * 86_400_000, now, c.var.principal.workspaceId).all()
  return c.json({ items: rows.results })
})
notificationTopics.post('/notification-topics', async c => {
  authorize(c.var.principal, 'edit')
  const input = notificationTopicCreateSchema.parse(await json(c.req.raw))
  const ws = c.var.principal.workspaceId
  if (!await c.env.DB.prepare('SELECT 1 FROM channels WHERE workspace_id=? AND id=? AND archived_at IS NULL').bind(ws, input.channel_id).first()) throw new HTTPException(404, { message: 'Conexão não encontrada.' })
  const key = crypto.randomUUID()
  try {
    await c.env.DB.prepare('INSERT INTO notification_topics (id,workspace_id,channel_id,name,frequency,validity_days,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(key, ws, input.channel_id, input.name, input.frequency, input.validity_days, Date.now()).run()
  } catch { throw new HTTPException(409, { message: 'Já existe um tópico com este nome nesta conexão.' }) }
  return c.json({ id: key, ...input }, 201)
})
notificationTopics.delete('/notification-topics/:id', async c => {
  authorize(c.var.principal, 'edit')
  const r = await c.env.DB.prepare('DELETE FROM notification_topics WHERE workspace_id=? AND id=?').bind(c.var.principal.workspaceId, id.parse(c.req.param('id'))).run()
  if (!r.meta.changes) throw new HTTPException(404, { message: 'Tópico não encontrado.' })
  return c.body(null, 204)
})
