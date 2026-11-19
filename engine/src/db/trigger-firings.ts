import { assertWorkspace, RepositoryError, requireRow } from "./shared"

export type TriggerFiringInput = {
  trigger_id: string; contact_id: string; external_event_id: string; dedupe_key?: string | null
}

export async function recordTriggerFiring(db: D1Database, workspaceId: string, input: TriggerFiringInput): Promise<{ inserted: boolean; id: number | null }> {
  assertWorkspace(workspaceId)
  if (!input.external_event_id.trim()) throw new RepositoryError("Evento obrigatório.", 400)
  requireRow(await db.prepare(`SELECT t.id FROM triggers t
    JOIN contacts c ON c.workspace_id = t.workspace_id AND c.id = ?
    JOIN automations a ON a.workspace_id = t.workspace_id AND a.id = t.automation_id
    LEFT JOIN channels ch ON ch.workspace_id = t.workspace_id AND ch.id = t.channel_id
    WHERE t.workspace_id = ? AND t.id = ? AND a.deleted_at IS NULL AND (t.channel_id IS NULL OR ch.id IS NOT NULL)`)
    .bind(input.contact_id, workspaceId, input.trigger_id).first())
  const row = await db.prepare(`INSERT INTO trigger_firings (workspace_id, trigger_id, contact_id, external_event_id, dedupe_key, fired_at)
    SELECT t.workspace_id, t.id, c.id, ?, ?, ? FROM triggers t JOIN contacts c ON c.workspace_id = t.workspace_id AND c.id = ?
    WHERE t.workspace_id = ? AND t.id = ? ON CONFLICT (trigger_id, contact_id, dedupe_key) DO NOTHING RETURNING id`)
    .bind(input.external_event_id, input.dedupe_key ?? null, Date.now(), input.contact_id, workspaceId, input.trigger_id).first<{ id: number }>()
  return { inserted: row !== null, id: row?.id ?? null }
}
