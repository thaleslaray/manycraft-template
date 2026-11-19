import { phoneProblem } from '../../shared/phone'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize } from './permissions'
import { json } from './security'
import { getContact } from './db/contacts'
import { getField } from './db/fields'
import { parseContactCsv } from '../../shared/contact-csv'

export const contactImports = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
export const importEmail = z.string().trim().toLowerCase().pipe(z.email().max(254))
export const importPhone = z.string().trim().regex(/^\+?[\d().\s-]+$/).transform(value => value.replace(/\D/g, ''))
  .superRefine((digits, ctx) => { const problem = phoneProblem(digits); if (problem) ctx.addIssue({ code: 'custom', message: problem }) })
export const contactCreateSchema = z.object({
  first_name: z.string().trim().max(60).optional(), last_name: z.string().trim().max(60).optional(),
  email: importEmail, phone: importPhone,
}).strict()

contactImports.post('/contacts', async c => {
  authorize(c.var.principal, 'edit')
  const input = contactCreateSchema.parse(await json(c.req.raw))
  const workspace = c.var.principal.workspaceId, id = crypto.randomUUID()
  try {
    await c.env.DB.prepare(`INSERT INTO contacts(id,workspace_id,first_name,last_name,email,phone,optin_source)
      VALUES (?,?,?,?,?,?,'manual')`).bind(id, workspace, input.first_name || null, input.last_name || null, input.email, input.phone).run()
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed: contacts\.(workspace_id|email|phone)/.test(error.message)) {
      throw new HTTPException(409, { message: 'Já existe um contato com este telefone ou e-mail.' })
    }
    throw error
  }
  return c.json((await getContact(c.env.DB, workspace, id))!.contact, 201)
})

const identifier = z.string().min(1).max(128)
export const contactImportSchema = z.object({
  file_name: z.string().trim().min(1).max(128), csv: z.string().min(1).max(1024 * 1024),
  consent: z.literal(true), tag_ids: z.array(identifier).max(20).default([]),
  mapping: z.record(z.string().regex(/^(first_name|last_name|email|phone|field:.+)$/), z.number().int().min(0).max(99)),
}).strict()

export async function importReport(db: D1Database, workspace: string, id: string) {
  const job = await db.prepare('SELECT id,file_name,status,total,error FROM contact_imports WHERE workspace_id=? AND id=?')
    .bind(workspace, id).first<{ id: string; file_name: string; status: string; total: number; error: string | null }>()
  if (!job) throw new HTTPException(404, { message: 'Importação não encontrada neste espaço.' })
  const counts = await db.prepare(`SELECT count(outcome) AS processed,coalesce(sum(outcome='created'),0) AS created,
    coalesce(sum(outcome='updated'),0) AS updated,coalesce(sum(outcome='ignored'),0) AS ignored
    FROM contact_import_rows WHERE workspace_id=? AND import_id=?`).bind(workspace, id)
    .first<{ processed: number; created: number; updated: number; ignored: number }>()
  const ignored = await db.prepare(`SELECT line,reason FROM contact_import_rows WHERE workspace_id=? AND import_id=? AND outcome='ignored' ORDER BY line LIMIT 100`)
    .bind(workspace, id).all<{ line: number; reason: string }>()
  return { ...job, ...counts!, ignored_rows: ignored.results }
}

contactImports.post('/contact-imports', async c => {
  authorize(c.var.principal, 'edit')
  const allowed = await c.env.DB.prepare('SELECT import_enabled FROM workspaces WHERE id=?').bind(c.var.principal.workspaceId).first<number>('import_enabled')
  if (allowed === 0) throw new HTTPException(403, { message: 'A importação de contatos não está liberada neste espaço. Peça a liberação ao suporte.' })
  if (!c.env.INBOUND) throw new HTTPException(503, { message: 'A fila de importação não está configurada.' })
  const input = contactImportSchema.parse(await json(c.req.raw))
  let csv: ReturnType<typeof parseContactCsv>
  try { csv = parseContactCsv(input.csv) } catch (error) { throw new HTTPException(400, { message: (error as Error).message }) }
  if ((!('email' in input.mapping) && !('phone' in input.mapping)) ||
    Object.values(input.mapping).some(column => column >= csv.headers.length) ||
    new Set(Object.values(input.mapping)).size !== Object.values(input.mapping).length) {
    throw new HTTPException(400, { message: 'Mapeie e-mail ou telefone e escolha um campo por coluna.' })
  }
  const workspace = c.var.principal.workspaceId
  for (const target of Object.keys(input.mapping).filter(key => key.startsWith('field:'))) {
    const field = await getField(c.env.DB, workspace, target.slice(6))
    if (!field || field.scope !== 'contact' || field.archived) throw new HTTPException(404, { message: 'Campo indisponível neste espaço.' })
  }
  const tags = [...new Set(input.tag_ids)]
  for (const id of tags) {
    if (!await c.env.DB.prepare('SELECT id FROM tags WHERE workspace_id=? AND id=? AND archived=0').bind(workspace, id).first()) {
      throw new HTTPException(404, { message: 'Tag indisponível neste espaço.' })
    }
  }
  const id = crypto.randomUUID(), now = Date.now()
  await c.env.DB.prepare(`INSERT INTO contact_imports(id,workspace_id,created_by,file_name,status,total,header_count,mapping,tag_ids,consent_confirmed_at,created_at,updated_at)
    VALUES (?,?,?,?,'uploading',?,?,?,?,?,?,?)`)
    .bind(id, workspace, c.var.principal.userId, input.file_name, csv.rows.length, csv.headers.length, JSON.stringify(input.mapping), JSON.stringify(tags), now, now, now).run()
  try {
    for (let start = 0; start < csv.rows.length; start += 50) {
      await c.env.DB.batch(csv.rows.slice(start, start + 50).map((cells, i) => c.env.DB.prepare(
        'INSERT INTO contact_import_rows(workspace_id,import_id,line,cells) VALUES (?,?,?,?)').bind(workspace, id, start + i + 2, JSON.stringify(cells))))
    }
  } catch (error) {
    await c.env.DB.prepare('DELETE FROM contact_imports WHERE workspace_id=? AND id=?').bind(workspace, id).run()
    throw error
  }
  await enqueueImport(c.env, workspace, id)
  return c.json(await importReport(c.env.DB, workspace, id), 202)
})

async function enqueueImport(env: Env, workspace: string, id: string) {
  await env.DB.prepare("UPDATE contact_imports SET status='queued',error=NULL,updated_at=? WHERE workspace_id=? AND id=?").bind(Date.now(), workspace, id).run()
  try { await env.INBOUND!.send({ kind: 'contact_import', workspaceId: workspace, importId: id }) }
  catch {
    await env.DB.prepare("UPDATE contact_imports SET status='failed',error='Não foi possível iniciar a fila. Tente novamente.',updated_at=? WHERE workspace_id=? AND id=?")
      .bind(Date.now(), workspace, id).run()
  }
}
contactImports.get('/contact-imports/:id', async c => c.json(await importReport(c.env.DB, c.var.principal.workspaceId, identifier.parse(c.req.param('id')))))
contactImports.post('/contact-imports/:id/retry', async c => {
  authorize(c.var.principal, 'edit')
  if (!c.env.INBOUND) throw new HTTPException(503, { message: 'A fila de importação não está configurada.' })
  const workspace = c.var.principal.workspaceId, id = identifier.parse(c.req.param('id'))
  const job = await importReport(c.env.DB, workspace, id)
  if (job.status !== 'failed') throw new HTTPException(409, { message: 'Esta importação não precisa ser retomada.' })
  await enqueueImport(c.env, workspace, id)
  return c.json(await importReport(c.env.DB, workspace, id), 202)
})
