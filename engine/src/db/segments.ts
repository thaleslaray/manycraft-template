import type { ContactQueryFilter } from '../../../shared/contact-filter'
import { HTTPException } from 'hono/http-exception'
import { compileContactFilter, contactQueryFilterSchema, type SqlFilter } from './contact-filter'
import { compileAnyContactFilter } from '../email-channel/filters'
import { assertWorkspace, requireRow, RepositoryError } from './shared'

type SegmentRow = { id: string; name: string; filter: string }
export async function segmentFilter(db: D1Database, workspace: string, id: string): Promise<SqlFilter> {
  assertWorkspace(workspace)
  const row = requireRow(await db.prepare('SELECT filter FROM segments WHERE workspace_id=? AND id=?').bind(workspace, id).first<{ filter: string }>())
  const clause = await compileAnyContactFilter(db, workspace, JSON.parse(row.filter), [id])
  return { sql: `(c.status<>'deleted' AND (${clause.sql}))`, values: clause.values }
}
type SegmentDto = { id: string; name: string; filter: ContactQueryFilter; total: number | null; error?: string; filterKind: 'general' | 'email' }
async function dto(db: D1Database, workspace: string, row: SegmentRow): Promise<SegmentDto> {
  const filter = JSON.parse(row.filter)
  const filterKind = contactQueryFilterSchema.safeParse(filter).success ? 'general' as const : 'email' as const
  const base = { id: row.id, name: row.name, filter: filter as ContactQueryFilter, filterKind }
  try {
    const clause = await compileAnyContactFilter(db, workspace, base.filter, [row.id])
    const total = await db.prepare(`SELECT count(*) AS total FROM contacts c WHERE c.workspace_id=? AND c.status<>'deleted' AND (${clause.sql})`)
      .bind(workspace, ...clause.values).first<number>('total')
    return { ...base, total: total ?? 0 }
  } catch (error) {
    const status = error instanceof RepositoryError ? error.status : error instanceof HTTPException ? error.status : 0
    if (![400, 404].includes(status)) throw error
    return { ...base, total: null, error: status === 404
      ? 'Este filtro usa uma tag, um campo, uma conexão ou um segmento que não está mais disponível.' : (error as Error).message }
  }
}
export async function getSegment(db: D1Database, workspace: string, id: string) {
  assertWorkspace(workspace)
  return dto(db, workspace, requireRow(await db.prepare('SELECT id,name,filter FROM segments WHERE workspace_id=? AND id=?').bind(workspace, id).first<SegmentRow>()))
}
export async function listSegments(db: D1Database, workspace: string) {
  assertWorkspace(workspace)
  const rows = await db.prepare('SELECT id,name,filter FROM segments WHERE workspace_id=? ORDER BY name,id LIMIT 200').bind(workspace).all<SegmentRow>()
  return Promise.all(rows.results.map(row => dto(db, workspace, row)))
}
export async function saveSegment(db: D1Database, workspace: string, name: string, filter: ContactQueryFilter, id?: string) {
  await compileContactFilter(db, workspace, filter)
  const now = Date.now(), key = id ?? crypto.randomUUID()
  try {
    if (id) requireRow(await db.prepare('UPDATE segments SET name=?,filter=?,updated_at=? WHERE workspace_id=? AND id=? RETURNING id')
      .bind(name, JSON.stringify(filter), now, workspace, id).first())
    else await db.prepare('INSERT INTO segments(id,workspace_id,name,filter,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .bind(key, workspace, name, JSON.stringify(filter), now, now).run()
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: segments')) throw new RepositoryError('Já existe um segmento com este nome.', 409)
    throw error
  }
  return getSegment(db, workspace, key)
}
