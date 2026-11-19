import type { IntegrationEnv } from '../../integrations'
import { connectionRuntime } from './runtime'

/** Current photo of a contact, from the first connection whose provider can fetch one. Bytes only: the provider's file URL can carry its credential. */
export async function contactAvatar(env: IntegrationEnv, workspaceId: string, contactId: string): Promise<ArrayBuffer | null> {
  const links = await env.DB.prepare(`SELECT cc.channel_id,cc.external_user_id FROM contact_channels cc
    JOIN channels ch ON ch.workspace_id=cc.workspace_id AND ch.id=cc.channel_id
    WHERE cc.workspace_id=? AND cc.contact_id=? AND ch.status='connected' ORDER BY cc.created_at,cc.id`)
    .bind(workspaceId, contactId).all<{ channel_id: string; external_user_id: string }>()
  for (const link of links.results) {
    const rt = await connectionRuntime(env, workspaceId, link.channel_id)
    if (!rt.provider?.fetchProfile || rt.meta.profile?.avatar !== 'bytes') continue
    const credentials = await rt.credentials()
    if (!rt.provider.credentialsSchema.safeParse(credentials).success) continue
    const profile = await rt.provider.fetchProfile({ connection: rt.connection, credentials, fetch: rt.fetch },
      { externalUserId: link.external_user_id, addressKind: rt.connection.profile.identity.key === 'telegram_id' ? 'telegram_id' : 'phone_e164' })
    if (profile?.avatar && 'bytes' in profile.avatar) return profile.avatar.bytes
  }
  return null
}
