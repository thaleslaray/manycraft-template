import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize, can } from './permissions'
import { assertUnlocked } from './automation-actions'
import { notifyParent } from './flow/nodes'
import type { FlowEnv } from './flow/types'
import { activeRunStatusSql } from './flow/run-status'
import { deleteFolder, duplicateAutomation, listAutomationLibrary, listFolders, permanentlyDeleteAutomation, restoreAutomation, saveFolder, trashAutomation } from './db/automation-library'

export const automationLibrary = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const id = z.string().min(1).max(128)
const name = z.string().trim().min(1).max(100)
export const folderCreateSchema = z.object({ name, parent_id: id.nullable().optional() }).strict()
export const folderPatchSchema = folderCreateSchema.partial().refine(value => Object.keys(value).length > 0, 'Informe uma alteração.')
export const folderDeleteQuerySchema = z.object({ move_items: z.enum(['1', '0']).optional() }).strict()
async function body(request: Request): Promise<unknown> {
  try { return await request.json() } catch { throw new HTTPException(400, { message: 'JSON inválido.' }) }
}
for (const path of ['/folders', '/folders/*', '/automation-library', '/automations/:id/duplicate', '/automations/:id/trash', '/automations/:id/restore']) {
  automationLibrary.use(path, async (c, next) => {
    authorize(c.var.principal, ['GET', 'HEAD'].includes(c.req.method) ? 'automation:read' : 'edit')
    await next()
  })
}
automationLibrary.get('/folders', async c => {
  z.object({}).strict().parse(c.req.query())
  return c.json({ ...await listFolders(c.env.DB, c.var.principal.workspaceId), can_edit: can(c.var.principal, 'edit', { workspace_id: c.var.principal.workspaceId }) })
})
automationLibrary.post('/folders', async c => c.json(await saveFolder(c.env.DB, c.var.principal.workspaceId, folderCreateSchema.parse(await body(c.req.raw))), 201))
automationLibrary.patch('/folders/:id', async c => c.json(await saveFolder(c.env.DB, c.var.principal.workspaceId, folderPatchSchema.parse(await body(c.req.raw)), id.parse(c.req.param('id')))))
automationLibrary.delete('/folders/:id', async c => {
  const query = folderDeleteQuerySchema.parse(c.req.query())
  const workspace = c.var.principal.workspaceId, folder = id.parse(c.req.param('id'))
  // Mover os itens para Sem pasta é "mover" cada automação (até as da lixeira): uma trancada para isso barra a exclusão inteira.
  if (query.move_items === '1') for (const row of (await c.env.DB.prepare('SELECT id FROM automations WHERE workspace_id=? AND folder_id=?').bind(workspace, folder).all<{ id: string }>()).results)
    await assertUnlocked(c.env.DB, workspace, row.id, 'move', c.var.principal)
  return c.json(await deleteFolder(c.env.DB, workspace, folder, query.move_items === '1'))
})
automationLibrary.get('/automation-library', async c => {
  const query = automationLibraryQuerySchema.parse(c.req.query())
  return c.json(await listAutomationLibrary(c.env.DB, c.var.principal.workspaceId, {
    ...query, trash: query.trash === '1' || query.trash === 'true', folder_id: query.folder_id === 'null' ? null : query.folder_id,
  }))
})
export const automationLibraryQuerySchema = z.object({
    folder_id: id.optional(), trash: z.enum(['1', '0', 'true', 'false']).optional(), status: z.enum(['draft','live','stopped']).optional(),
    trigger_type: z.enum(['dm_keyword','ig_comment','ig_story_reply','ig_story_mention','ig_live_comment','ig_share_to_dm','ref_url','welcome','default_reply','new_contact','api']).optional(),
    trigger_status: z.enum(['active','draft','initial','inactive','disabled']).optional(), search: z.string().max(500).optional(), cursor: z.string().max(2000).optional(),
  }).strict()
automationLibrary.post('/automations/:id/duplicate', async c => c.json(await duplicateAutomation(c.env.DB, c.var.principal.workspaceId, id.parse(c.req.param('id'))), 201))
automationLibrary.post('/automations/:id/trash', async c => {
  const workspace = c.var.principal.workspaceId, key = id.parse(c.req.param('id'))
  // Execuções desta automação que outras esperam (Iniciar automação): vão ser canceladas junto, e quem espera precisa saber.
  const called = (await c.env.DB.prepare(`SELECT r.id FROM flow_runs r JOIN automation_versions v ON v.workspace_id=r.workspace_id AND v.id=r.automation_version_id
    WHERE r.workspace_id=? AND v.automation_id=? AND r.parent_run_id IS NOT NULL AND r.status IN (${activeRunStatusSql})`)
    .bind(workspace, key).all<{ id: string }>()).results
  const trashed = await trashAutomation(c.env.DB, workspace, key)
  if (c.env.FLOW_RUN) for (const run of called) await notifyParent(c.env as FlowEnv, run.id)
  return c.json(trashed)
})
automationLibrary.post('/automations/:id/restore', async c => c.json(await restoreAutomation(c.env.DB, c.var.principal.workspaceId, id.parse(c.req.param('id')))))
automationLibrary.delete('/automations/:id', async c => {
  authorize(c.var.principal, 'edit')
  return c.json(await permanentlyDeleteAutomation(c.env.DB, c.var.principal.workspaceId, id.parse(c.req.param('id'))))
})
