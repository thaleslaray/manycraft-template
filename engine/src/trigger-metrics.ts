import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { repositoryFor } from './db'

export const triggerMetrics = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const filters = z.object({ period_days: z.coerce.number().int().min(1).max(365).default(30), trigger_id: z.string().min(1).max(128).optional() })
export const triggerMetricsQuerySchema = filters.strict()
export const metricContactsQuerySchema = filters.extend({ metric: z.enum(['runs','optins','sent','delivered','read','clicked','ctr']), cursor: z.string().max(128).optional() }).strict()
triggerMetrics.get('/automations/:id/trigger-metrics', async c => {
  const input = triggerMetricsQuerySchema.parse(c.req.query())
  const id = z.string().min(1).max(128).parse(c.req.param('id'))
  return c.json(await repositoryFor(c.env, c.var.principal.workspaceId, c.var.principal).getAutomationTriggerMetrics(id, input))
})
triggerMetrics.get('/automations/:id/metric-contacts', async c => {
  const input = metricContactsQuerySchema.parse(c.req.query())
  const id = z.string().min(1).max(128).parse(c.req.param('id'))
  return c.json(await repositoryFor(c.env, c.var.principal.workspaceId, c.var.principal).getAutomationMetricContacts(id, input))
})
