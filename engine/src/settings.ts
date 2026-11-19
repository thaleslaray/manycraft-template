import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize } from './permissions'
import { createField, updateField, deleteField, fieldUsage, setFieldValue } from './db/fields'
import { createTag, updateTag, deleteTag } from './db/tags'
import { listSettingsFolders, saveSettingsFolder, deleteSettingsFolder, settingsKind, settingsName } from './db/settings-folders'

export const settings = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const identifier = z.string().min(1).max(128)
const folderId = identifier.nullable().optional()
export const fieldCreateSchema = z.object({
  name: settingsName,
  type: z.enum(['text', 'number', 'date', 'datetime', 'boolean', 'array']),
  scope: z.enum(['contact', 'bot']).optional(),
  description: z.string().max(2000).nullable().optional(),
  bot_value: z.unknown().optional(),
  folder_id: folderId,
}).strict()
export const fieldPatchSchema = fieldCreateSchema.pick({ name: true, description: true, bot_value: true, folder_id: true })
  .partial().extend({ archived: z.boolean().optional() }).strict().refine(value => Object.keys(value).length > 0)
export const tagCreateSchema = z.object({ name: settingsName, folder_id: folderId }).strict()
export const tagPatchSchema = tagCreateSchema.partial().extend({ archived: z.boolean().optional() }).strict().refine(value => Object.keys(value).length > 0)
export const fieldDeleteQuerySchema = z.object({ confirm: z.enum(['true', 'false']).optional() }).strict()
export const settingsFolderListQuerySchema = z.object({ kind: settingsKind }).strict()
export const settingsFolderCreateSchema = z.object({ name: settingsName, kind: settingsKind }).strict()
export const settingsFolderPatchSchema = z.object({ name: settingsName }).strict()
async function body(request: Request): Promise<unknown> {
  try { return await request.json() } catch { throw new HTTPException(400, { message: 'JSON inválido.' }) }
}
for (const path of ['/fields', '/fields/*', '/tags', '/tags/*', '/settings-folders', '/settings-folders/*', '/contacts/:id/fields/:fieldId']) settings.use(path, async (c, next) => {
  authorize(c.var.principal, ['GET', 'HEAD'].includes(c.req.method) ? 'read' : 'edit')
  await next()
})
settings.post('/fields', async c => c.json(await createField(c.env.DB, c.var.principal.workspaceId, fieldCreateSchema.parse(await body(c.req.raw))), 201))
settings.patch('/fields/:id', async c => c.json(await updateField(c.env.DB, c.var.principal.workspaceId, identifier.parse(c.req.param('id')), fieldPatchSchema.parse(await body(c.req.raw)))))
settings.get('/fields/:id/usage', async c => c.json({ automations: await fieldUsage(c.env.DB, c.var.principal.workspaceId, identifier.parse(c.req.param('id'))) }))
settings.delete('/fields/:id', async c => {
  const { confirm } = fieldDeleteQuerySchema.parse(c.req.query())
  const id = identifier.parse(c.req.param('id'))
  const automations = await fieldUsage(c.env.DB, c.var.principal.workspaceId, id)
  if (automations.length && confirm !== 'true') {
    return c.json({ error: 'Este campo é usado em automações publicadas. Confirme a exclusão para continuar.', automations }, 409)
  }
  return c.json(await deleteField(c.env.DB, c.var.principal.workspaceId, id))
})
export const contactFieldValueSchema = z.object({ value: z.unknown().refine(value => value !== undefined, 'Informe o valor do campo.') }).strict()
settings.put('/contacts/:id/fields/:fieldId', async c => {
  const input = contactFieldValueSchema.parse(await body(c.req.raw))
  return c.json(await setFieldValue(c.env.DB, c.var.principal.workspaceId, identifier.parse(c.req.param('id')), identifier.parse(c.req.param('fieldId')), input.value))
})
settings.post('/tags', async c => {
  const input = tagCreateSchema.parse(await body(c.req.raw))
  return c.json(await createTag(c.env.DB, c.var.principal.workspaceId, input.name, input.folder_id), 201)
})
settings.patch('/tags/:id', async c => c.json(await updateTag(c.env.DB, c.var.principal.workspaceId, identifier.parse(c.req.param('id')), tagPatchSchema.parse(await body(c.req.raw)))))
settings.delete('/tags/:id', async c => c.json(await deleteTag(c.env.DB, c.var.principal.workspaceId, identifier.parse(c.req.param('id')))))
settings.get('/settings-folders', async c => {
  const { kind } = settingsFolderListQuerySchema.parse(c.req.query())
  return c.json(await listSettingsFolders(c.env.DB, c.var.principal.workspaceId, kind))
})
settings.post('/settings-folders', async c => {
  const input = settingsFolderCreateSchema.parse(await body(c.req.raw))
  return c.json(await saveSettingsFolder(c.env.DB, c.var.principal.workspaceId, input.name, input.kind), 201)
})
settings.patch('/settings-folders/:id', async c => {
  const input = settingsFolderPatchSchema.parse(await body(c.req.raw))
  return c.json(await saveSettingsFolder(c.env.DB, c.var.principal.workspaceId, input.name, undefined, identifier.parse(c.req.param('id'))))
})
settings.delete('/settings-folders/:id', async c => c.json(await deleteSettingsFolder(c.env.DB, c.var.principal.workspaceId, identifier.parse(c.req.param('id')))))
