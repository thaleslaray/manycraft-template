import { assertWorkspace, requireRow, type Row } from './shared'

export type CalledBy = { id: string; name: string; waits: boolean }

/** Automações publicadas e ativas cujo passo "Iniciar automação" aponta para esta (a mais recente versão publicada de cada uma). */
export async function calledBy(db: D1Database, ws: string, id: string): Promise<CalledBy[]> {
  assertWorkspace(ws)
  // A checagem da automação e a busca saem juntas (uma onda); sem automação, 404 antes de devolver qualquer linha.
  const [exists, rows] = await Promise.all([db.prepare('SELECT id FROM automations WHERE workspace_id=? AND id=? AND deleted_at IS NULL').bind(ws, id).first<Row>(), db.prepare(`SELECT a.id,a.name,v.graph FROM automations a JOIN automation_versions v ON v.workspace_id=a.workspace_id AND v.id=a.published_version_id
    WHERE a.workspace_id=? AND a.id<>? AND a.status='live' AND a.deleted_at IS NULL AND instr(v.graph,?)>0 ORDER BY a.name COLLATE NOCASE,a.id`)
    .bind(ws, id, JSON.stringify(id)).all<{ id: string; name: string; graph: string }>()])
  requireRow(exists)
  const found: CalledBy[] = []
  for (const row of rows.results) {
    let nodes: { type?: string; config?: Record<string, unknown> }[] = []
    try { nodes = (JSON.parse(row.graph) as { nodes?: typeof nodes }).nodes ?? [] } catch { continue }
    const calls = nodes.filter(n => n.type === 'start_automation' && n.config?.automation_id === id)
    if (calls.length) found.push({ id: row.id, name: row.name, waits: calls.some(n => n.config?.wait_for_finish === true) })
  }
  return found
}
