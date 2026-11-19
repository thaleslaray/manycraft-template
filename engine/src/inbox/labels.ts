import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from '../env'
import type { AuthVariables } from '../team'
import { authorize } from '../permissions'
import { json } from '../security'
import { compileContactFilter, contactQueryFilterSchema } from '../db/contact-filter'
import { getConversation, notifyConversation } from './service'

export const inboxConversationLabelSchema = z.object({ label_id: z.string().min(1).max(256), on: z.boolean() }).strict()
export const inboxLabels = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const identifier = z.string().min(1).max(256)
export const inboxLabelSchema = z.object({ name: z.string().trim().min(1).max(40), color: z.enum(['neutral', 'accent', 'success', 'warning', 'danger']).default('neutral'),
  condition: contactQueryFilterSchema.nullable().default(null) }).strict()

inboxLabels.get('/labels', async c => {
  const rows = await c.env.DB.prepare(`SELECT l.id,l.name,l.color,l.condition,(SELECT count(*) FROM conversation_labels cl WHERE cl.label_id=l.id) AS conversations
    FROM inbox_labels l WHERE l.workspace_id=? ORDER BY l.name,l.id`).bind(c.var.principal.workspaceId).all<{ id: string; name: string; color: string; condition: string | null; conversations: number }>()
  return c.json(rows.results.map(r => ({ ...r, condition: r.condition ? JSON.parse(r.condition) : null })))
})
async function saveLabel(env: Pick<Env, 'DB'>, ws: string, id: string, input: z.infer<typeof inboxLabelSchema>, create: boolean) {
  if (input.condition) await compileContactFilter(env.DB, ws, input.condition)
  if (await env.DB.prepare('SELECT 1 FROM inbox_labels WHERE workspace_id=? AND name=? AND id<>?').bind(ws, input.name, id).first()) throw new HTTPException(409, { message: 'Já existe uma etiqueta com esse nome.' })
  const condition = input.condition?.rules.length ? JSON.stringify(input.condition) : null
  await (create ? env.DB.prepare('INSERT INTO inbox_labels (id,workspace_id,name,color,condition) VALUES (?,?,?,?,?)').bind(id, ws, input.name, input.color, condition)
    : env.DB.prepare('UPDATE inbox_labels SET name=?,color=?,condition=? WHERE workspace_id=? AND id=?').bind(input.name, input.color, condition, ws, id)).run()
}
inboxLabels.post('/labels', async c => {
  authorize(c.var.principal, 'edit')
  const input = inboxLabelSchema.parse(await json(c.req.raw)), id = crypto.randomUUID()
  await saveLabel(c.env, c.var.principal.workspaceId, id, input, true)
  return c.json({ id }, 201)
})
inboxLabels.put('/labels/:id', async c => {
  authorize(c.var.principal, 'edit')
  const ws = c.var.principal.workspaceId, id = identifier.parse(c.req.param('id'))
  if (!await c.env.DB.prepare('SELECT 1 FROM inbox_labels WHERE workspace_id=? AND id=?').bind(ws, id).first()) throw new HTTPException(404, { message: 'Etiqueta não encontrada.' })
  await saveLabel(c.env, ws, id, inboxLabelSchema.parse(await json(c.req.raw)), false)
  return c.json({ id })
})
inboxLabels.delete('/labels/:id', async c => {
  authorize(c.var.principal, 'edit')
  await c.env.DB.prepare('DELETE FROM inbox_labels WHERE workspace_id=? AND id=?').bind(c.var.principal.workspaceId, identifier.parse(c.req.param('id'))).run()
  return c.body(null, 204)
})
/** Etiqueta manual na conversa (põe ou tira). Liberado a quem responde conversas. */
inboxLabels.post('/conversations/:id/labels', async c => {
  const ws = c.var.principal.workspaceId, id = identifier.parse(c.req.param('id'))
  await getConversation(c.env, ws, id)
  const body = inboxConversationLabelSchema.parse(await json(c.req.raw))
  if (!await c.env.DB.prepare('SELECT 1 FROM inbox_labels WHERE workspace_id=? AND id=?').bind(ws, body.label_id).first()) throw new HTTPException(404, { message: 'Etiqueta não encontrada.' })
  await (body.on ? c.env.DB.prepare('INSERT INTO conversation_labels (conversation_id,label_id) VALUES (?,?) ON CONFLICT DO NOTHING').bind(id, body.label_id)
    : c.env.DB.prepare('DELETE FROM conversation_labels WHERE conversation_id=? AND label_id=?').bind(id, body.label_id)).run()
  return c.json(await notifyConversation(c.env, ws, id))
})

/** Etiquetas automáticas: ao chegar mensagem, a conversa ganha as etiquetas cuja condição o contato atende. */
export async function applyAutoLabels(env: Pick<Env, 'DB'>, ws: string, conversationId: string) {
  const labels = await env.DB.prepare('SELECT id,condition FROM inbox_labels WHERE workspace_id=? AND condition IS NOT NULL').bind(ws).all<{ id: string; condition: string }>()
  if (!labels.results.length) return
  const contact = await env.DB.prepare('SELECT cc.contact_id FROM conversations v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id WHERE v.workspace_id=? AND v.id=?')
    .bind(ws, conversationId).first<string>('contact_id')
  if (!contact) return
  for (const label of labels.results) {
    try {
      const filter = await compileContactFilter(env.DB, ws, JSON.parse(label.condition))
      if (await env.DB.prepare(`SELECT 1 FROM contacts c WHERE c.workspace_id=? AND c.id=? AND ${filter.sql}`).bind(ws, contact, ...filter.values).first())
        await env.DB.prepare('INSERT INTO conversation_labels (conversation_id,label_id) VALUES (?,?) ON CONFLICT DO NOTHING').bind(conversationId, label.id).run()
    } catch { /* condição com tag ou campo apagado não marca */ }
  }
}
