import type { IntegrationEnv } from '../../integrations'
import type { Credentials, StoredProvider } from '../contract'
import { resolveProvider } from '../providers'
import type { ChannelType } from '../types'
import { decryptCredentials } from './crypto'

/** The shape the pre-contract adapter classes read their secrets from. It is built per connection from the decrypted
 * credentials (see adapterEnv) and is never part of the Worker environment. */
export interface ChannelEnv {
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_WEBHOOK_SECRET?: string
  TELEGRAM_CHANNEL_ID?: string
  META_APP_SECRET?: string
  META_VERIFY_TOKEN?: string
  IG_ACCESS_TOKEN?: string
  IG_ACCOUNT_ID?: string
  IG_APP_SECRET?: string
  WHATSAPP_ACCESS_TOKEN?: string
  WHATSAPP_PHONE_NUMBER_ID?: string
  /** What a provider adapter built after the contract reads, whatever the provider: the connection's decrypted credentials and settings (both JSON). */
  CONNECTION_CREDENTIALS?: string
  CONNECTION_SETTINGS?: string
}
export type AdapterEnv = IntegrationEnv & ChannelEnv

type Sealed = { credentials_ciphertext: string | null; credentials_iv: string | null; credentials_key_version: number | null }

/** Decrypted credentials of one connection ({} when none are stored). Only the layer calls this. */
export async function loadCredentials(env: IntegrationEnv, workspaceId: string, connectionId: string): Promise<Credentials> {
  const row = await env.DB.prepare('SELECT credentials_ciphertext,credentials_iv,credentials_key_version FROM channels WHERE workspace_id=? AND id=?')
    .bind(workspaceId, connectionId).first<Sealed>()
  return openRow(env, workspaceId, connectionId, row)
}
export async function openRow(env: IntegrationEnv, workspaceId: string, connectionId: string, row: Sealed | null): Promise<Credentials> {
  if (!row?.credentials_ciphertext || !row.credentials_iv || !row.credentials_key_version) return {}
  return decryptCredentials(env, { workspaceId, connectionId },
    { ciphertext: row.credentials_ciphertext, iv: row.credentials_iv, keyVersion: row.credentials_key_version })
}

const pick = (entries: Record<string, string | undefined>): Credentials =>
  Object.fromEntries(Object.entries(entries).filter((entry): entry is [string, string] => entry[1] !== undefined))

/** Adapter-facing view of one connection's credentials. `meta.settings` is the connection's own settings (JSON). */
export function adapterEnv(env: IntegrationEnv, kind: ChannelType, credentials: Credentials, connectionId: string,
  meta: { settings?: string } = {}): AdapterEnv {
  const view: ChannelEnv = kind === 'telegram'
    ? { TELEGRAM_BOT_TOKEN: credentials.botToken, TELEGRAM_WEBHOOK_SECRET: credentials.webhookSecret, TELEGRAM_CHANNEL_ID: connectionId }
    : kind === 'whatsapp'
      ? { WHATSAPP_ACCESS_TOKEN: credentials.accessToken, WHATSAPP_PHONE_NUMBER_ID: credentials.phoneNumberId, META_APP_SECRET: credentials.appSecret, META_VERIFY_TOKEN: credentials.webhookSecret }
      : kind === 'instagram'
        ? { IG_ACCESS_TOKEN: credentials.accessToken, IG_ACCOUNT_ID: credentials.accountId, IG_APP_SECRET: credentials.appSecret, META_VERIFY_TOKEN: credentials.webhookSecret ?? credentials.verifyToken }
        : {}
  return { ...env, ...view, CONNECTION_CREDENTIALS: JSON.stringify(credentials), CONNECTION_SETTINGS: meta.settings ?? '{}' }
}

/** Environment a send for this connection runs with. */
export async function adapterEnvFor(env: IntegrationEnv, workspaceId: string, connectionId: string, kind: ChannelType): Promise<AdapterEnv> {
  const row = await env.DB.prepare('SELECT settings FROM channels WHERE workspace_id=? AND id=?').bind(workspaceId, connectionId).first<{ settings: string }>()
  return adapterEnv(env, kind, await loadCredentials(env, workspaceId, connectionId), connectionId, row ? { settings: row.settings } : {})
}

/** Inverse of adapterEnv for the Telegram facade, which still hands credentials to the contract provider. */
export function viewCredentials(kind: ChannelType, view: ChannelEnv): Credentials {
  if (kind === 'telegram') return pick({ botToken: view.TELEGRAM_BOT_TOKEN, webhookSecret: view.TELEGRAM_WEBHOOK_SECRET })
  if (kind === 'whatsapp') return pick({ accessToken: view.WHATSAPP_ACCESS_TOKEN, phoneNumberId: view.WHATSAPP_PHONE_NUMBER_ID, appSecret: view.META_APP_SECRET, webhookSecret: view.META_VERIFY_TOKEN })
  if (kind === 'instagram') return pick({ accessToken: view.IG_ACCESS_TOKEN, accountId: view.IG_ACCOUNT_ID, appSecret: view.IG_APP_SECRET, webhookSecret: view.META_VERIFY_TOKEN })
  return {}
}

/** Does this connection hold everything its provider needs to send? Used before accepting a broadcast. */
export async function channelConfigured(env: IntegrationEnv, kind: ChannelType, connection: { id: string; workspaceId: string; provider?: StoredProvider }): Promise<boolean> {
  const spec = resolveProvider(kind, connection.provider).connect
  if (!spec) return false
  const credentials = await loadCredentials(env, connection.workspaceId, connection.id)
  return spec.fields.every(field => field.optional || !!credentials[field.key])
}
