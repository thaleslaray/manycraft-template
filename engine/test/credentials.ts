import { encryptCredentials, type KeyringEnv } from '../src/channels/core/crypto'
import { digest } from '../src/channels/core/webhook-http'

/** Test-only master key (32 bytes of 0x07). Real keys only ever come from Worker secrets. */
export const TEST_KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
export const testKeyring: KeyringEnv = { CONNECTIONS_KEK_V1: TEST_KEK, CONNECTIONS_KEK_ACTIVE: '1' }

type Db = { DB: D1Database } & KeyringEnv
/** Stores encrypted credentials on an existing connection row, the way the connections service does. */
export async function giveCredentials(env: Db, channelId: string, credentials: Record<string, string>) {
  const row = await env.DB.prepare('SELECT workspace_id FROM channels WHERE id=?').bind(channelId).first<{ workspace_id: string }>()
  if (!row) throw new Error(`Connection not found: ${channelId}`)
  const sealed = await encryptCredentials({ ...testKeyring, ...env }, { workspaceId: row.workspace_id, connectionId: channelId }, credentials)
  await env.DB.prepare(`UPDATE channels SET credentials_ciphertext=?, credentials_iv=?, credentials_key_version=?, credentials_rotated_at=?, webhook_secret_hash=? WHERE id=?`)
    .bind(sealed.ciphertext, sealed.iv, sealed.keyVersion, Date.now(), credentials.webhookSecret ? await digest(credentials.webhookSecret) : null, channelId).run()
}
