import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize } from './permissions'
import { json } from './security'
import { contactQueryFilterSchema, filterAccounts, filterConnections, queryFilteredContacts } from './db/contact-filter'
import { getSegment, listSegments, saveSegment } from './db/segments'
import { requireRow } from './db/shared'

export const segments = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const id = z.string().min(1).max(128)
export const segmentInputSchema = z.object({ name: z.string().trim().min(1).max(160), filter: contactQueryFilterSchema }).strict()
export const contactQuerySchema = z.object({ filter: contactQueryFilterSchema, cursor: z.string().max(2048).nullable().optional(), search: z.string().max(200).optional() }).strict()
segments.post('/contacts/query', async c => {
  authorize(c.var.principal, 'read')
  const data = contactQuerySchema.parse(await json(c.req.raw))
  return c.json(await queryFilteredContacts(c.env.DB, c.var.principal.workspaceId, data.filter, data.cursor, data.search))
})
segments.get('/segments/options', async c => {
  const workspace = c.var.principal.workspaceId
  const [fields, tags, connections, triggers, accounts] = await Promise.all([
    c.env.DB.prepare("SELECT id,name,type FROM custom_fields WHERE workspace_id=? AND scope='contact' AND archived=0 ORDER BY name,id").bind(workspace).all(),
    c.env.DB.prepare('SELECT id,name FROM tags WHERE workspace_id=? AND archived=0 ORDER BY name,id').bind(workspace).all(),
    filterConnections(c.env.DB, workspace),
    c.env.DB.prepare('SELECT t.id,t.name FROM triggers t JOIN automations a ON a.workspace_id=t.workspace_id AND a.id=t.automation_id WHERE t.workspace_id=? AND a.deleted_at IS NULL ORDER BY t.name,t.id LIMIT 200').bind(workspace).all(),
    filterAccounts(c.env.DB, workspace),
  ])
  return c.json({ fields: fields.results, tags: tags.results, connections, triggers: triggers.results, accounts })
})
segments.get('/segments', async c => c.json(await listSegments(c.env.DB, c.var.principal.workspaceId)))
segments.get('/segments/:id', async c => c.json(await getSegment(c.env.DB, c.var.principal.workspaceId, id.parse(c.req.param('id')))))
segments.post('/segments', async c => {
  authorize(c.var.principal, 'edit')
  const data = segmentInputSchema.parse(await json(c.req.raw))
  return c.json(await saveSegment(c.env.DB, c.var.principal.workspaceId, data.name, data.filter), 201)
})
segments.put('/segments/:id', async c => {
  authorize(c.var.principal, 'edit')
  const data = segmentInputSchema.parse(await json(c.req.raw))
  return c.json(await saveSegment(c.env.DB, c.var.principal.workspaceId, data.name, data.filter, id.parse(c.req.param('id'))))
})
segments.delete('/segments/:id', async c => {
  authorize(c.var.principal, 'edit')
  requireRow(await c.env.DB.prepare('DELETE FROM segments WHERE workspace_id=? AND id=? RETURNING id').bind(c.var.principal.workspaceId, id.parse(c.req.param('id'))).first())
  return c.json({ ok: true })
})
