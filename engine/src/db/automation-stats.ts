import { assertWorkspace, requireRow, type Row } from './shared'

export type AutomationStats = {
  automation_id: string; period_days: number; runs: number; unique_contacts: number
  nodes: Record<string, Record<string, number> & { buttons?: Record<string, number> }>
}

/** Node counters from node_events (one row per run/node/button/type), same shape the panel's fake layer returns. */
export async function getAutomationStats(db: D1Database, workspaceId: string, automationId: string, periodDays: number): Promise<AutomationStats> {
  assertWorkspace(workspaceId)
  const since = Date.now() - periodDays * 86400000
  // A checagem da automação sai junto com as contagens (uma onda); sem automação, 404 antes de devolver qualquer número.
  const [exists, counts, contacts] = await Promise.all([
    db.prepare('SELECT id FROM automations WHERE workspace_id=? AND id=? AND deleted_at IS NULL')
      .bind(workspaceId, automationId).first<Row>(),
    db.prepare(`SELECT node_id,button_id,type,COUNT(*) AS n FROM node_events
      WHERE workspace_id=? AND automation_id=? AND created_at>=? GROUP BY node_id,button_id,type`)
      .bind(workspaceId, automationId, since).all<{ node_id: string; button_id: string | null; type: string; n: number }>(),
    db.prepare('SELECT COUNT(DISTINCT contact_id) AS n FROM node_events WHERE workspace_id=? AND automation_id=? AND created_at>=?')
      .bind(workspaceId, automationId, since).first<{ n: number }>(),
  ])
  requireRow(exists)
  const nodes: AutomationStats['nodes'] = {}
  for (const r of counts.results) {
    const node = (nodes[r.node_id] ??= {})
    node[r.type] = (node[r.type] ?? 0) + r.n
    if (r.button_id) (node.buttons ??= {})[r.button_id] = (node.buttons[r.button_id] ?? 0) + r.n
  }
  const runs = Object.values(nodes).reduce((m, n) => Math.max(m, n.sent ?? 0), 0)
  return { automation_id: automationId, period_days: periodDays, nodes, runs, unique_contacts: contacts?.n ?? 0 }
}
