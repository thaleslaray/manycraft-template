import type { ContactOrigin } from '../types'

/** Saves where the contact came from, once: the first origin stays, a later ad click never overwrites it (`ad_referred_at` is the latch).
 * Returns the statement so the caller books it in the same batch as the contact's other inbound bookkeeping. */
export function recordContactOrigin(db: D1Database, workspace: string, contactId: string, origin: ContactOrigin, at: number): D1PreparedStatement {
  return db.prepare(`UPDATE contacts SET ad_source_id=?,ad_source_type=?,ad_headline=?,ad_click_id=?,ad_source_url=?,ad_referred_at=?
    WHERE workspace_id=? AND id=? AND ad_referred_at IS NULL AND status<>'deleted'`)
    .bind(origin.sourceId ?? null, origin.sourceType ?? null, origin.headline ?? null, origin.clickId ?? null, origin.sourceUrl ?? null, at, workspace, contactId)
}
