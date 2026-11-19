import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize } from './permissions'
import { json } from './security'
import { RepositoryError } from './db/shared'
import { actionSchema } from './schemas/actions'
import { logStatement, performExternalRequest } from './flow/external-request'
import { staticUrlIssue } from './flow/external-url'

/** Test button and error log of the external request action. */
export const externalRequests = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const id = z.string().min(1).max(128)
export const externalRequestTestSchema = z.object({ action: actionSchema, contact_id: id, automation_id: id.optional() }).strict()

externalRequests.post('/external-requests/test', async c => {
  authorize(c.var.principal, 'edit')
  const workspace = c.var.principal.workspaceId
  const input = externalRequestTestSchema.parse(await json(c.req.raw))
  const action = input.action
  if (action.type !== 'external_request') throw new RepositoryError('A ação precisa ser uma requisição externa.', 400)
  const issue = staticUrlIssue(action.url)
  if (issue) throw new RepositoryError(issue, 400)
  if (!await c.env.DB.prepare('SELECT id FROM contacts WHERE workspace_id=? AND id=?').bind(workspace, input.contact_id).first()) throw new RepositoryError('Contato não encontrado.', 404)
  const result = await performExternalRequest(c.env, workspace, input.contact_id, action)
  const logId = `extreq-test-${crypto.randomUUID()}`
  await c.env.DB.batch([
    logStatement(c.env, { id: logId, workspace_id: workspace, automation_id: input.automation_id, contact_id: input.contact_id, source: 'test', method: action.method }, result),
    c.env.DB.prepare('DELETE FROM external_request_logs WHERE workspace_id=? AND created_at<?').bind(workspace, Date.now() - LOG_RETENTION_MS),
  ])
  return c.json({ ok: !result.error, status: result.status, duration_ms: result.duration_ms, error: result.error ?? null, preview: result.preview ?? null, mapped: result.mapped })
})

/** Registros valem 2 semanas; o nível sai do resultado: erro (falhou), aviso (respondeu fora de 2xx ou passou de 5 s) e informação. */
export const LOG_RETENTION_MS = 14 * 86_400_000
const levelSql = "CASE WHEN l.outcome='error' THEN 'error' WHEN l.status>=300 OR l.duration_ms>5000 THEN 'warning' ELSE 'info' END"
export const externalRequestLogsQuerySchema = z.object({ automation_id: id.optional(), limit: z.coerce.number().int().min(1).max(100).default(30), errors: z.enum(['1']).optional(),
  kind: z.enum(['external_request', 'dynamic']).optional(), level: z.enum(['error', 'warning', 'info']).optional() }).strict()
externalRequests.get('/external-requests/logs', async c => {
  authorize(c.var.principal, 'automation:read')
  const query = externalRequestLogsQuerySchema.parse(c.req.query())
  const rows = await c.env.DB.prepare(`SELECT l.id,l.automation_id,l.contact_id,l.source,l.method,l.target,l.status,l.outcome,l.error_code,l.message,l.duration_ms,l.created_at,l.node_id,
      CASE WHEN l.error_code='dynamic' THEN 'dynamic' ELSE 'external_request' END AS kind,${levelSql} AS level,a.name AS automation_name,
      TRIM(COALESCE(ct.first_name,'')||' '||COALESCE(ct.last_name,'')) AS contact_name
    FROM external_request_logs l LEFT JOIN contacts ct ON ct.workspace_id=l.workspace_id AND ct.id=l.contact_id
    LEFT JOIN automations a ON a.workspace_id=l.workspace_id AND a.id=l.automation_id
    WHERE l.workspace_id=? AND (? IS NULL OR l.automation_id=?) AND (? IS NULL OR l.outcome='error')
    AND (? IS NULL OR (CASE WHEN l.error_code='dynamic' THEN 'dynamic' ELSE 'external_request' END)=?)
    AND (? IS NULL OR ${levelSql}=?) AND l.created_at>=?
    ORDER BY l.created_at DESC,l.id DESC LIMIT ?`)
    .bind(c.var.principal.workspaceId, query.automation_id ?? null, query.automation_id ?? null, query.errors ?? null, query.kind ?? null, query.kind ?? null, query.level ?? null, query.level ?? null, Date.now() - LOG_RETENTION_MS, query.limit).all()
  return c.json({ items: rows.results })
})
