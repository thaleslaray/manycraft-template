import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { Env } from './env'

/** An opaque per-recipient link freezes its destination and survives queue retries. */
export async function broadcastLink(env: Env, recipient: { workspace: string; broadcast: string; contactChannel: string }, button: { id: string; url: string }) {
  const base = new URL(env.PUBLIC_BASE_URL ?? env.BETTER_AUTH_URL ?? '')
  const target = new URL(button.url)
  if (!['http:', 'https:'].includes(base.protocol) || !['http:', 'https:'].includes(target.protocol)) {
    throw new HTTPException(409, { message: 'Configure um endereço público e um link HTTP ou HTTPS válidos.' })
  }
  const token = crypto.randomUUID().replaceAll('-', '')
  await env.DB.prepare(`INSERT INTO broadcast_links(token,workspace_id,broadcast_id,contact_channel_id,button_id,target_url)
    VALUES (?,?,?,?,?,?) ON CONFLICT(broadcast_id,contact_channel_id,button_id) DO NOTHING`)
    .bind(token,recipient.workspace,recipient.broadcast,recipient.contactChannel,button.id,target.href).run()
  const saved = await env.DB.prepare('SELECT token FROM broadcast_links WHERE workspace_id=? AND broadcast_id=? AND contact_channel_id=? AND button_id=?')
    .bind(recipient.workspace,recipient.broadcast,recipient.contactChannel,button.id).first<{token:string}>()
  return new URL(`/api/broadcast-public/click/${saved!.token}`,base).href
}

// Mounted before workspace authentication: the random token selects only its stored destination.
export const publicBroadcastRoutes = new Hono<{ Bindings: Env }>()
publicBroadcastRoutes.get('/click/:token', async c => {
  const token = c.req.param('token')
  if (!/^[a-f0-9]{32}$/.test(token)) throw new HTTPException(404)
  const link = await c.env.DB.prepare(`UPDATE broadcast_links SET clicked_at=coalesce(clicked_at,?) WHERE token=?
    AND EXISTS(SELECT 1 FROM broadcast_recipients r WHERE r.workspace_id=broadcast_links.workspace_id
      AND r.broadcast_id=broadcast_links.broadcast_id AND r.contact_channel_id=broadcast_links.contact_channel_id AND r.status='sent')
    RETURNING target_url`).bind(Date.now(),token).first<{target_url:string}>()
  if (!link) throw new HTTPException(404)
  return c.redirect(link.target_url,302)
})
