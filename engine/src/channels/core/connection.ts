import type { Connection, ConnectionStatus, ProfilePatch, StoredProvider } from '../contract'
import { providerFor } from '../providers'
import type { ChannelType } from '../types'
import { effectiveProfile } from './profile-merge'
import { effectiveStateSql } from './connection-state'

/** A channels row as the layer reads it. `connection_state` is the effective state (connection-state.ts): a connection the team turned off reads 'disconnected'. */
export type ConnectionRow = { id: string; workspace_id: string; type: ChannelType; provider: StoredProvider; external_id: string
  display_name: string | null; connection_state: ConnectionStatus; settings: string; capabilities_override: string | null
  credentials_ciphertext: string | null; credentials_iv: string | null; credentials_key_version: number | null }
export const connectionColumns = `id, workspace_id, type, provider, external_id, display_name, ${effectiveStateSql()} AS connection_state, settings, capabilities_override, credentials_ciphertext, credentials_iv, credentials_key_version`

export function connectionFromRow(row: ConnectionRow): Connection {
  const override = row.capabilities_override ? JSON.parse(row.capabilities_override) as ProfilePatch : undefined
  return {
    id: row.id, workspaceId: row.workspace_id, kind: row.type, provider: providerFor(row.type, row.provider),
    externalId: row.external_id, displayName: row.display_name, status: row.connection_state,
    settings: JSON.parse(row.settings) as Record<string, unknown>,
    profile: effectiveProfile(row.type, row.provider, override),
  }
}

/** For callers that know the channel but have no row at hand (legacy webhook route, adapter facades). */
export function liteRow(kind: ChannelType, id: string, workspaceId: string): ConnectionRow {
  return { id, workspace_id: workspaceId, type: kind, provider: 'legacy', external_id: '', display_name: null,
    connection_state: 'connected', settings: '{}', capabilities_override: null,
    credentials_ciphertext: null, credentials_iv: null, credentials_key_version: null }
}
