import { z } from 'zod'
import type { Env } from './env'
import { getField, validateFieldValue } from './db/fields'
import { importEmail, importPhone } from './contact-imports'

const envelope = z.object({ kind: z.literal('contact_import'), workspaceId: z.string().min(1), importId: z.string().min(1) }).strict()
type Job = { id: string; workspace_id: string; status: string; header_count: number; mapping: string; tag_ids: string }
type ImportRow = { line: number; cells: string }
class InvalidRow extends Error {}

/** Each row and its receipt commit in one D1 transaction. Replayed queue messages skip committed rows. */
async function processRow(db: D1Database, job: Job, row: ImportRow) {
  const guard = 'EXISTS (SELECT 1 FROM contact_import_rows WHERE workspace_id=? AND import_id=? AND line=? AND outcome IS NULL)'
  const guardArgs = [job.workspace_id, job.id, row.line]
  try {
    const cells = JSON.parse(row.cells) as string[]
    if (cells.length !== job.header_count) throw new InvalidRow('Quantidade de colunas diferente do cabeçalho.')
    const mapped = Object.fromEntries(Object.entries(JSON.parse(job.mapping) as Record<string, number>).map(([key, column]) => [key, cells[column].trim()]))
    let email: string | null = null, phone: string | null = null
    if (mapped.email) {
      const parsed = importEmail.safeParse(mapped.email)
      if (!parsed.success) throw new InvalidRow('E-mail inválido.')
      email = parsed.data
    }
    if (mapped.phone) {
      const parsed = importPhone.safeParse(mapped.phone)
      if (!parsed.success) throw new InvalidRow('Telefone inválido. Use de 7 a 15 dígitos, com país e DDD.')
      phone = parsed.data
    }
    if (!email && !phone) throw new InvalidRow('Informe e-mail ou telefone.')
    for (const key of ['first_name', 'last_name']) if ((mapped[key]?.length ?? 0) > 60) throw new InvalidRow('Nome ou sobrenome excede 60 caracteres.')
    const values: { id: string; value: unknown }[] = []
    for (const [key, raw] of Object.entries(mapped)) {
      if (!key.startsWith('field:') || !raw) continue
      const field = await getField(db, job.workspace_id, key.slice(6))
      if (!field || field.scope !== 'contact' || field.archived) throw new InvalidRow('Campo personalizado indisponível.')
      let value: unknown = raw
      if (field.type === 'number') value = Number(raw.replace(',', '.'))
      if (field.type === 'boolean') value = ({ true: true, false: false, sim: true, não: false, nao: false, '1': true, '0': false } as Record<string, boolean>)[raw.toLowerCase()]
      if (field.type === 'array') { try { value = JSON.parse(raw) } catch { throw new InvalidRow(`Valor inválido para ${field.name}.`) } }
      try { validateFieldValue(field.type, value) } catch { throw new InvalidRow(`Valor inválido para ${field.name}.`) }
      values.push({ id: field.id, value })
    }
    const matches = await db.prepare("SELECT id FROM contacts WHERE workspace_id=? AND status<>'deleted' AND (email=? OR phone=?)")
      .bind(job.workspace_id, email, phone).all<{ id: string }>()
    if (matches.results.length > 1) throw new InvalidRow('E-mail e telefone pertencem a contatos diferentes. Revise os dados.')
    const existing = matches.results[0], id = existing?.id ?? crypto.randomUUID(), now = Date.now()
    const active = "EXISTS (SELECT 1 FROM contacts WHERE workspace_id=? AND id=? AND status<>'deleted')"
    const statements = [
      // Como na original: o contato novo da importação dispara a regra de novo contato; tags e campos da importação não disparam regras.
      ...['tags','fields'].map(type => db.prepare('INSERT INTO rule_event_suppressions(workspace_id,contact_id,type) VALUES(?,?,?)').bind(job.workspace_id,id,type)),
      existing
      ? db.prepare(`UPDATE contacts SET first_name=coalesce(?,first_name),last_name=coalesce(?,last_name),email=coalesce(?,email),phone=coalesce(?,phone),updated_at=?
          WHERE workspace_id=? AND id=? AND status<>'deleted' AND ${guard}`)
        .bind(mapped.first_name || null, mapped.last_name || null, email, phone, now, job.workspace_id, id, ...guardArgs)
      : db.prepare(`INSERT INTO contacts(id,workspace_id,first_name,last_name,email,phone,optin_source)
          SELECT ?,?,?,?,?,?,'import' WHERE ${guard}`)
        .bind(id, job.workspace_id, mapped.first_name || null, mapped.last_name || null, email, phone, ...guardArgs),
      ...values.map(field => db.prepare(`INSERT INTO contact_field_values(workspace_id,contact_id,field_id,value,updated_at)
        SELECT ?,?,?,?,? WHERE ${guard} AND ${active}
        ON CONFLICT(contact_id,field_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
        .bind(job.workspace_id, id, field.id, JSON.stringify(field.value), now, ...guardArgs, job.workspace_id, id)),
      ...([...new Set(JSON.parse(job.tag_ids) as string[])]).map(tag => db.prepare(`INSERT OR IGNORE INTO contact_tags(workspace_id,contact_id,tag_id)
        SELECT ?,?,t.id FROM tags t WHERE t.workspace_id=? AND t.id=? AND t.archived=0 AND ${guard} AND ${active}`)
        .bind(job.workspace_id, id, job.workspace_id, tag, ...guardArgs, job.workspace_id, id)),
      db.prepare(`UPDATE contact_import_rows SET outcome=CASE WHEN ${active} THEN ? ELSE 'ignored' END,
        reason=CASE WHEN ${active} THEN NULL ELSE 'Contato indisponível.' END,cells='[]' WHERE workspace_id=? AND import_id=? AND line=? AND outcome IS NULL`)
        .bind(job.workspace_id, id, existing ? 'updated' : 'created', job.workspace_id, id, ...guardArgs),
      db.prepare('DELETE FROM rule_event_suppressions WHERE workspace_id=? AND contact_id=?').bind(job.workspace_id,id),
    ]
    await db.batch(statements)
  } catch (error) {
    if (!(error instanceof InvalidRow)) throw error // Transient D1/uniqueness races retry against fresh state.
    await db.prepare("UPDATE contact_import_rows SET outcome='ignored',reason=?,cells='[]' WHERE workspace_id=? AND import_id=? AND line=? AND outcome IS NULL")
      .bind(error.message, ...guardArgs).run()
  }
}

export async function consumeContactImport(message: Message<unknown>, env: Env) {
  const parsed = envelope.safeParse(message.body)
  if (!parsed.success) { message.ack(); return }
  const { workspaceId, importId } = parsed.data
  try {
    const job = await env.DB.prepare('SELECT * FROM contact_imports WHERE workspace_id=? AND id=?').bind(workspaceId, importId).first<Job>()
    if (!job || !['queued', 'processing'].includes(job.status)) { message.ack(); return }
    await env.DB.prepare("UPDATE contact_imports SET status='processing',updated_at=? WHERE workspace_id=? AND id=?").bind(Date.now(), workspaceId, importId).run()
    const rows = await env.DB.prepare('SELECT line,cells FROM contact_import_rows WHERE workspace_id=? AND import_id=? AND outcome IS NULL ORDER BY line LIMIT 25')
      .bind(workspaceId, importId).all<ImportRow>()
    for (const row of rows.results) await processRow(env.DB, job, row)
    const pending = await env.DB.prepare('SELECT 1 FROM contact_import_rows WHERE workspace_id=? AND import_id=? AND outcome IS NULL LIMIT 1').bind(workspaceId, importId).first()
    if (pending) await env.INBOUND!.send(parsed.data)
    else await env.DB.prepare("UPDATE contact_imports SET status='completed',error=NULL,updated_at=? WHERE workspace_id=? AND id=?").bind(Date.now(), workspaceId, importId).run()
    message.ack()
  } catch {
    if (message.attempts >= 10) {
      await env.DB.prepare("UPDATE contact_imports SET status='failed',error='Não foi possível concluir o lote. Tente novamente.',updated_at=? WHERE workspace_id=? AND id=?")
        .bind(Date.now(), workspaceId, importId).run()
      message.ack()
    } else message.retry({ delaySeconds: Math.min(60, 2 ** message.attempts) })
  }
}
