import { Hono } from 'hono'
import { z } from 'zod'
import { HTTPException } from 'hono/http-exception'
import type { AuthVariables } from '../team'
import { json } from '../security'
import { runtimeFromRow } from '../channels/core/runtime'
import { connectionColumns, type ConnectionRow } from '../channels/core/connection'
import type { EmailEnv } from './store'
import { contactFilterSchema, contactFilterSql } from './filters'

export const emailManagement = new Hono<{ Bindings: EmailEnv; Variables: AuthVariables }>()
const id = z.string().min(1).max(128)
export const emailRuleSchema = z.object({
  name: z.string().trim().min(1).max(200), event: z.enum(['email_defined', 'email_opened', 'email_clicked', 'contact_created']),
  automationId: id, frequency: z.enum(['once', 'always']).default('always'), active: z.boolean().default(false),
  filter: contactFilterSchema.default({ match: 'all', rules: [] }),
  eventFilter: z.object({ messageId: id.optional(), url: z.url({ protocol: /^https?$/ }).optional(), condition: z.enum(['is_set', 'changed']).optional() }).strict().default({}),
}).strict()
export const emailRulePatchSchema = emailRuleSchema.partial().extend({
  frequency: z.enum(['once', 'always']).optional(), active: z.boolean().optional(), filter: contactFilterSchema.optional(),
  eventFilter: emailRuleSchema.shape.eventFilter.removeDefault().optional(),
})
type Rule = z.infer<typeof emailRuleSchema> & { id: string }
function ruleFrom(row: any): Rule {
  const event = JSON.parse(row.event_config)
  return { id: row.id, name: row.name, event: event.email_event ?? (row.event_type === 'user_created' ? 'contact_created' : 'email_defined'), automationId: row.automation_id, frequency: row.frequency, active: row.status === 'active', filter: Object.keys(JSON.parse(row.contact_filter)).length ? JSON.parse(row.contact_filter) : { match: 'all', rules: [] }, eventFilter: event.filter ?? {} }
}
const ownedRule = async (env: EmailEnv, ws: string, ruleId: string) => {
  const row = await env.DB.prepare("SELECT * FROM rules WHERE workspace_id=? AND id=? AND (json_extract(event_config,'$.email_event') IS NOT NULL OR (event_type='change_system_field_value' AND json_extract(event_config,'$.field')='email')) AND status<>'trash'").bind(ws, ruleId).first()
  if (!row) throw new HTTPException(404, { message: 'Regra de e-mail não encontrada.' })
  return row
}
async function validateTarget(env: EmailEnv, ws: string, automationId: string) {
  if (!await env.DB.prepare("SELECT id FROM automations WHERE workspace_id=? AND id=? AND deleted_at IS NULL").bind(ws, automationId).first()) throw new HTTPException(404, { message: 'Automação não encontrada neste espaço.' })
}
async function saveRule(env: EmailEnv, ws: string, ruleId: string, input: z.infer<typeof emailRuleSchema>, create: boolean) {
  await validateTarget(env, ws, input.automationId)
  await contactFilterSql(env.DB, ws, input.filter)
  const config = JSON.stringify({ email_event: input.event, field: input.event === 'email_defined' ? 'email' : undefined, condition: input.eventFilter.condition ?? 'is_set', filter: input.eventFilter })
  const eventType = input.event === 'email_defined' ? 'change_system_field_value' : input.event === 'contact_created' ? 'user_created' : 'custom_event_triggered'
  if (create) await env.DB.prepare("INSERT INTO rules(id,workspace_id,name,kind,event_type,event_config,contact_filter,frequency,status,action_type,automation_id) VALUES (?,?,?,'internal_event',?,?,?,?,?,'start_flow',?)").bind(ruleId, ws, input.name, eventType, config, JSON.stringify(input.filter), input.frequency, input.active ? 'active' : 'inactive', input.automationId).run()
  else await env.DB.prepare('UPDATE rules SET name=?,event_type=?,event_config=?,contact_filter=?,frequency=?,status=?,automation_id=?,updated_at=? WHERE workspace_id=? AND id=?').bind(input.name, eventType, config, JSON.stringify(input.filter), input.frequency, input.active ? 'active' : 'inactive', input.automationId, Date.now(), ws, ruleId).run()
  return ruleFrom(await ownedRule(env, ws, ruleId))
}
emailManagement.get('/rules', async c => {
  const rows = await c.env.DB.prepare("SELECT * FROM rules WHERE workspace_id=? AND status<>'trash' AND (json_extract(event_config,'$.email_event') IS NOT NULL OR (event_type='change_system_field_value' AND json_extract(event_config,'$.field')='email')) ORDER BY created_at,id").bind(c.var.principal.workspaceId).all()
  return c.json(rows.results.map(ruleFrom))
})
emailManagement.post('/rules', async c => c.json(await saveRule(c.env, c.var.principal.workspaceId, crypto.randomUUID(), emailRuleSchema.parse(await json(c.req.raw)), true), 201))
emailManagement.patch('/rules/:id', async c => {
  const ws = c.var.principal.workspaceId, ruleId = id.parse(c.req.param('id')), previous = ruleFrom(await ownedRule(c.env, ws, ruleId))
  const patch = emailRulePatchSchema.parse(await json(c.req.raw))
  return c.json(await saveRule(c.env, ws, ruleId, emailRuleSchema.parse({ ...Object.fromEntries(Object.entries(previous).filter(([key]) => key !== 'id')), ...patch }), false))
})
emailManagement.delete('/rules/:id', async c => {
  const ws = c.var.principal.workspaceId, ruleId = id.parse(c.req.param('id')); await ownedRule(c.env, ws, ruleId)
  await c.env.DB.prepare("UPDATE rules SET status='trash',updated_at=? WHERE workspace_id=? AND id=?").bind(Date.now(), ws, ruleId).run()
  return c.json({ deleted: true })
})
export const emailSegmentSchema = z.object({ name: z.string().trim().min(1).max(200), filter: contactFilterSchema }).strict()
const segmentFrom = (row: any) => ({ id: row.id, name: row.name, filter: JSON.parse(row.filter) })
emailManagement.get('/segments', async c => c.json((await c.env.DB.prepare('SELECT * FROM segments WHERE workspace_id=? ORDER BY name,id').bind(c.var.principal.workspaceId).all()).results.map(segmentFrom)))
emailManagement.get('/segments/:id', async c => {
  const row = await c.env.DB.prepare('SELECT * FROM segments WHERE workspace_id=? AND id=?').bind(c.var.principal.workspaceId, c.req.param('id')).first()
  if (!row) throw new HTTPException(404)
  return c.json(segmentFrom(row))
})
emailManagement.post('/segments', async c => {
  const input = emailSegmentSchema.parse(await json(c.req.raw)), segmentId = crypto.randomUUID(), ws = c.var.principal.workspaceId
  await contactFilterSql(c.env.DB, ws, input.filter)
  await c.env.DB.prepare('INSERT INTO segments(id,workspace_id,name,filter) VALUES (?,?,?,?)').bind(segmentId, ws, input.name, JSON.stringify(input.filter)).run()
  return c.json({ id: segmentId, ...input }, 201)
})
emailManagement.delete('/segments/:id', async c => {
  const result = await c.env.DB.prepare('DELETE FROM segments WHERE workspace_id=? AND id=?').bind(c.var.principal.workspaceId, c.req.param('id')).run()
  if (!result.meta.changes) throw new HTTPException(404)
  return c.json({ deleted: true })
})
export const emailStopSchema = z.object({ subject: z.string().trim().max(998).refine(value => !/[\r\n]/.test(value)), text: z.string().trim().max(10000), enabled: z.boolean().default(true), automationId: id.nullable().default(null) }).strict()
export const getDefaultStopSettings = () => ({
  subject: 'Descadastro confirmado',
  text: 'Você foi descadastrado do marketing por e-mail. As respostas da nossa equipe continuam disponíveis nesta conversa.',
  enabled: true,
  automationId: null as string | null,
})
export async function stopSettings(env: EmailEnv, ws: string, connectionId: string) {
  // Uma ida só: a mesma linha da conexão serve ao runtime e às configurações.
  const row = await env.DB.prepare(`SELECT ${connectionColumns} FROM channels WHERE workspace_id=? AND id=?`).bind(ws, connectionId).first<ConnectionRow>()
  if (!row) throw new Error(`Connection not found: ${connectionId}`)
  const rt = await runtimeFromRow(env, row, { secrets: false })
  if (!rt.connection.profile.email) throw new HTTPException(400, { message: 'A ficha desta conexão não aceita e-mail.' })
  const settings = JSON.parse(row.settings ?? '{}')
  return { rt, settings, config: { ...getDefaultStopSettings(), ...settings.emailStop } }
}
emailManagement.get('/connections/:id/stop', async c => {
  const { config } = await stopSettings(c.env, c.var.principal.workspaceId, c.req.param('id'))
  return c.json(config)
})
emailManagement.put('/connections/:id/stop', async c => {
  const ws = c.var.principal.workspaceId, connectionId = c.req.param('id'), { settings } = await stopSettings(c.env, ws, connectionId), input = emailStopSchema.parse(await json(c.req.raw))
  if (input.automationId) await validateTarget(c.env, ws, input.automationId)
  await c.env.DB.prepare('UPDATE channels SET settings=? WHERE workspace_id=? AND id=?').bind(JSON.stringify({ ...settings, emailStop: input }), ws, connectionId).run()
  return c.json(input)
})
