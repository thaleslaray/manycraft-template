import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize } from './permissions'
import { json } from './security'
import { connectionColumns, connectionFromRow, type ConnectionRow } from './channels/core/connection'
import { automationTemplates as models, templateWarnings } from './templates/automation-catalog'
import { validateGraph } from './schemas/graph'
import { decode, nextKeywordPrioritySql, requireRow, type Row } from './db/shared'
import type { Automation } from './contracts'

export const automationTemplates = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const id = z.string().min(1).max(128)
export const automationTemplatesQuerySchema = z.object({ connection_id: id.optional() }).strict()
export const automationTemplateInstallSchema = z.object({ template_id: id, version: z.number().int().positive(), connection_id: id,
  folder_id: id.nullable().optional(), word: z.string().trim().min(1).max(100).optional(),
  url: z.url({ protocol: /^https?$/ }).max(2000).optional(),
}).strict()
async function connection(db: D1Database, workspace: string, id: string) {
  const row = await db.prepare(`SELECT ${connectionColumns} FROM channels WHERE workspace_id=? AND id=? AND archived_at IS NULL`)
    .bind(workspace, id).first<ConnectionRow>()
  if (!row) throw new HTTPException(404, { message: 'Conexão não encontrada.' })
  return connectionFromRow(row)
}
automationTemplates.get('/automation-templates', async c => {
  authorize(c.var.principal, 'automation:read')
  const query = automationTemplatesQuerySchema.parse(c.req.query())
  const target = query.connection_id ? await connection(c.env.DB, c.var.principal.workspaceId, query.connection_id) : null
  return c.json({ templates: models.map(model => ({ ...model, warnings: target ? templateWarnings(model, target.profile) : [] })) })
})
/** Modelos instalados neste espaço, com quem instalou e a automação gerada (se ainda existir). */
automationTemplates.get('/automation-templates/installed', async c => {
  authorize(c.var.principal, 'automation:read')
  const rows = await c.env.DB.prepare(`SELECT i.id,i.template_id,i.template_version,i.automation_id,i.installed_at,coalesce(nullif(u.name,''),u.email) AS installed_by,
      a.name AS automation_name,(a.id IS NOT NULL AND a.deleted_at IS NULL) AS automation_exists
    FROM template_installs i LEFT JOIN "user" u ON u.id=i.user_id LEFT JOIN automations a ON a.workspace_id=i.workspace_id AND a.id=i.automation_id
    WHERE i.workspace_id=? ORDER BY i.installed_at DESC LIMIT 200`).bind(c.var.principal.workspaceId).all<{ template_id: string }>()
  return c.json({ items: rows.results.map(r => ({ ...r, template_name: models.find(m => m.id === r.template_id)?.name ?? r.template_id })) })
})
automationTemplates.post('/automation-templates', async c => {
  authorize(c.var.principal, 'edit')
  const input = automationTemplateInstallSchema.parse(await json(c.req.raw))
  const model = models.find(m => m.id === input.template_id)
  if (!model) throw new HTTPException(404, { message: 'Modelo não encontrado.' })
  if (model.version !== input.version) throw new HTTPException(409, { message: 'Este modelo mudou. Abra a prévia novamente.' })
  const workspace = c.var.principal.workspaceId
  const target = await connection(c.env.DB, workspace, input.connection_id)
  const warnings = templateWarnings(model, target.profile)
  if (warnings.length) throw new HTTPException(409, { message: warnings.join(' ') })
  if (input.folder_id) requireRow(await c.env.DB.prepare('SELECT id FROM folders WHERE workspace_id=? AND id=?').bind(workspace, input.folder_id).first<Row>())
  const graph = structuredClone(model.graph)
  const automationId = crypto.randomUUID(), triggerId = crypto.randomUUID()
  const word = input.word ?? model.trigger.word
  graph.nodes[0]!.config = { trigger_id: triggerId }
  if (input.url && model.link) {
    const blocks = graph.nodes[1]!.config.blocks as { kind: string; action?: { type: string; url: string } }[]
    const button = blocks.find(b => b.kind === 'button')
    if (button?.action) button.action.url = input.url
  }
  const parsed = validateGraph(graph)
  // Automação, gatilho e palavra entram juntos. O estado draft da automação impede qualquer disparo antes de publicar.
  const statements = [
    c.env.DB.prepare('INSERT INTO automations(id,workspace_id,name,folder_id,draft_graph) VALUES (?,?,?,?,?)')
      .bind(automationId, workspace, model.name, input.folder_id ?? null, JSON.stringify(parsed)),
    c.env.DB.prepare(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config)
      VALUES (?,?,?,?,?,?,'active',?,?)`).bind(triggerId, workspace, automationId, input.connection_id, model.name, model.trigger.kind,
      model.trigger.kind === 'welcome_message' ? 'once' : 'every_time', JSON.stringify({ node_id: 'inicio', include: word ? [word] : [], exclude: [] })),
  ]
  statements.push(c.env.DB.prepare('INSERT INTO template_installs(id,workspace_id,template_id,template_version,automation_id,user_id,installed_at) VALUES (?,?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), workspace, model.id, model.version, automationId, c.var.principal.userId, Date.now()))
  if (word) statements.push(c.env.DB.prepare(`INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES (?,?,?,'contains',?,'live',${nextKeywordPrioritySql})`)
    .bind(crypto.randomUUID(), workspace, triggerId, JSON.stringify([word]), workspace))
  await c.env.DB.batch(statements)
  const created = requireRow(await c.env.DB.prepare('SELECT * FROM automations WHERE workspace_id=? AND id=?').bind(workspace, automationId).first<Row>())
  return c.json(decode<Automation>(created), 201)
})
