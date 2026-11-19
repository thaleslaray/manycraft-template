import type { IntegrationEnv } from '../../integrations'
import { connectionColumns, type ConnectionRow } from './connection'
import { stateInSql } from './connection-state'
import { inboundEventSchema, sourceOf } from './queue'
import { runtimeFromRow } from './runtime'
import { resolveProviderAdapter } from '../registry'

/** For providers that never redeliver a webhook: ask the provider for what it has seen since the last run and queue what the
 * webhook did not bring. The event key is the webhook's own, so an event that arrives both ways lands once (inbound_events.id is unique).
 * Runs every 5 minutes from the scheduled handler. One connection failing never stops the others. */
export async function reconcileConnections(env: IntegrationEnv, now = Date.now()): Promise<{ connections: number; queued: number }> {
  if (!env.INBOUND) return { connections: 0, queued: 0 }
  const rows = await env.DB.prepare(`SELECT ${connectionColumns}, sync_cursor FROM channels
    WHERE ${stateInSql(['connected'])} AND archived_at IS NULL AND credentials_ciphertext IS NOT NULL`)
    .all<ConnectionRow & { sync_cursor: number | null }>()
  let connections = 0, queued = 0
  for (const row of rows.results) {
    if (!resolveProviderAdapter(row.type, row.provider)?.pull) continue
    connections++
    try {
      const rt = await runtimeFromRow(env, row)
      // A connection that never reconciled starts from now: its history is not a missed webhook.
      if (row.sync_cursor === null) {
        await env.DB.prepare('UPDATE channels SET sync_cursor=? WHERE id=? AND sync_cursor IS NULL').bind(now, row.id).run()
        continue
      }
      const { parts, cursor } = await rt.provider!.pull!({ connection: rt.connection, credentials: await rt.credentials(), fetch: rt.fetch }, row.sync_cursor)
      for (const part of parts) {
        await env.INBOUND.send(inboundEventSchema.parse({ version: 1, provider: sourceOf(row.type), workspaceId: row.workspace_id, channelId: row.id,
          eventId: part.eventKey, receivedAt: now, payload: part.payload }))
        queued++
      }
      // Only after every part was accepted: a failed send makes the next run ask again.
      if (cursor > row.sync_cursor) await env.DB.prepare('UPDATE channels SET sync_cursor=? WHERE id=?').bind(cursor, row.id).run()
    } catch { /* No payload or identifier in logs; the next run tries again. */ }
  }
  return { connections, queued }
}
