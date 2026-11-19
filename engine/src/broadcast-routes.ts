import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { json } from './security'
import { broadcastInput, broadcastOptions, cancelBroadcast, createBroadcastFromAutomation, deleteBroadcast, estimateBroadcastAudience, getBroadcast, listAudienceContacts, listBroadcasts, pauseBroadcast, resumeBroadcast, saveBroadcast, testBroadcast } from './db/broadcasts'

/** Inherits workspace membership and origin protection from the main router. */
export const broadcastRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const id = z.string().min(1).max(128)
export const broadcastListQuerySchema = z.object({ status: z.enum(['draft', 'scheduled', 'sending', 'paused', 'sent', 'cancelled']).optional(), search: z.string().max(160).optional() }).strict()
export const broadcastAudienceQuerySchema = broadcastInput.shape.audience
export const broadcastAudienceEstimateSchema = broadcastInput.shape.audience.extend({ template: broadcastInput.shape.template, window_kind: broadcastInput.shape.window_kind })
export const broadcastAudienceContactsSchema = broadcastInput.shape.audience.extend({ template: broadcastInput.shape.template, window_kind: broadcastInput.shape.window_kind, page: z.number().int().min(1).max(100000).default(1), limit: z.number().int().min(1).max(100).default(20) })
// Todas as rotas de /api/broadcasts moram aqui (antes metade ficava no index.ts); as fixas vêm antes de /:id.
broadcastRoutes.get('/options', async c => c.json(await broadcastOptions(c.env, c.var.principal)))
/** Na query, `conditions` vem repetido (`conditions=tag&conditions=segment`) ou separado por vírgula (`conditions=tag,segment`); o schema quer lista. */
function audienceQuery(c: { req: { query(): Record<string, string>; queries(key: string): string[] | undefined } }) {
  const conditions = c.req.queries('conditions')?.flatMap(v => v.split(',')).map(v => v.trim()).filter(Boolean)
  return { ...c.req.query(), ...(conditions ? { conditions } : {}) }
}
broadcastRoutes.get('/audience', async c => c.json(await estimateBroadcastAudience(c.env, c.var.principal, broadcastAudienceQuerySchema.parse(audienceQuery(c)))))
broadcastRoutes.get('/', async c => {
  const query = broadcastListQuerySchema.parse(c.req.query())
  return c.json(await listBroadcasts(c.env, c.var.principal, query))
})
broadcastRoutes.post('/', async c => c.json(await saveBroadcast(c.env, c.var.principal, await json(c.req.raw)), 201))
broadcastRoutes.post('/from-automation', async c => c.json(await createBroadcastFromAutomation(c.env, c.var.principal, await json(c.req.raw)), 201))
broadcastRoutes.post('/audience', async c => {
  const { template, window_kind, ...audience } = broadcastAudienceEstimateSchema.parse(await json(c.req.raw))
  return c.json(await estimateBroadcastAudience(c.env, c.var.principal, audience, template, window_kind))
})
broadcastRoutes.post('/audience/contacts', async c => {
  const { template, window_kind, page, limit, ...audience } = broadcastAudienceContactsSchema.parse(await json(c.req.raw))
  return c.json(await listAudienceContacts(c.env, c.var.principal, audience, template, window_kind, page, limit))
})
broadcastRoutes.post('/:id/test', async c => c.json(await testBroadcast(c.env, c.var.principal, id.parse(c.req.param('id')), await json(c.req.raw))))
broadcastRoutes.post('/:id/cancel', async c => c.json(await cancelBroadcast(c.env, c.var.principal, id.parse(c.req.param('id')))))
broadcastRoutes.delete('/:id', async c => c.json(await deleteBroadcast(c.env, c.var.principal, id.parse(c.req.param('id')))))
broadcastRoutes.get('/:id', async c => c.json(await getBroadcast(c.env, c.var.principal, id.parse(c.req.param('id')))))
broadcastRoutes.post('/:id/pause', async c => c.json(await pauseBroadcast(c.env, c.var.principal, id.parse(c.req.param('id')))))
broadcastRoutes.post('/:id/resume', async c => c.json(await resumeBroadcast(c.env, c.var.principal, id.parse(c.req.param('id')))))
