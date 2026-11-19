import { inlineMemo, peekInline } from '../../flow/inline-timing'
import type { IntegrationEnv } from '../../integrations'
import type { ChannelAdapter } from '../types'
import type { Connection, Credentials, ProviderAdapter } from '../contract'
import { resolveAdapter, resolveProviderAdapter } from '../registry'
import { providers, type ProviderMeta } from '../providers'
import { connectionColumns, connectionFromRow, type ConnectionRow } from './connection'
import { adapterEnv, openRow } from './credentials'

export type ConnectionRuntime = {
  connection: Connection
  meta: ProviderMeta
  adapter: ChannelAdapter                 // pre-layer interface the flow executor and broadcasts still send through
  provider: ProviderAdapter
  credentials: () => Promise<Credentials>
  webhookSecret: () => Promise<string | undefined>
  fetch: typeof fetch
}

// Looked up on every call so test doubles and platform patches of the global are honoured.
const liveFetch = ((input, init) => fetch(input, init)) as typeof fetch

/** Decrypts the connection's credentials once; the adapter and the contract provider both work from that copy.
 * `secrets: false` is for ingestion, which only needs to know what the connection is: the adapter then has no credentials. */
export async function runtimeFromRow(env: IntegrationEnv, row: ConnectionRow, options: { secrets?: boolean } = {}): Promise<ConnectionRuntime> {
  const connection = connectionFromRow(row)
  let secrets = options.secrets === false ? undefined : await openRow(env, row.workspace_id, row.id, row)
  const credentials = async () => secrets ??= await openRow(env, row.workspace_id, row.id, row)
  return {
    connection, meta: providers[connection.provider], adapter: resolveAdapter(row.type, row.provider, adapterEnv(env, row.type, secrets ?? {}, row.id, { settings: row.settings })),
    provider: resolveProviderAdapter(row.type, row.provider),
    credentials, webhookSecret: async () => (await credentials()).webhookSecret, fetch: liveFetch,
  }
}

/** Single door for engine/inbox/editor: effective profile + adapter. Credentials come from the connection's encrypted columns. */
export async function connectionRuntime(env: IntegrationEnv, workspaceId: string, connectionId: string,
  options: { requireConnected?: boolean; secrets?: boolean } = {}): Promise<ConnectionRuntime> {
  // Execução em linha (webhook): a mesma conexão é lida uma vez só no processamento do evento.
  // Uma conexão já lida como conectada serve também a quem aceita qualquer estado.
  const row = (options.requireConnected ? undefined : await peekInline<ConnectionRow | null>(`chan:c:${workspaceId}:${connectionId}`)) ?? await inlineMemo(`chan:${options.requireConnected ? 'c' : 'a'}:${workspaceId}:${connectionId}`, () =>
    env.DB.prepare(`SELECT ${connectionColumns} FROM channels WHERE workspace_id = ? AND id = ?${options.requireConnected ? " AND status = 'connected'" : ''}`)
      .bind(workspaceId, connectionId).first<ConnectionRow>())
  if (!row) throw new Error(`Connection not found: ${connectionId}`)
  return runtimeFromRow(env, row, options)
}
