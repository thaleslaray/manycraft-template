import type { IntegrationEnv } from '../integrations'
import type { AdapterEnv } from './core/credentials'
import type { ChannelKind } from './contract'
import { channelKinds, type ChannelAdapter } from './types'
import { TikTokAdapter } from './stubs'
import { hasDefaultProvider } from './providers'
import { resolveAdapter } from './registry'
import { connectionRuntime } from './core/runtime'

export * from './types'
export { RateLimited } from './errors'
export { TelegramAdapter } from './telegram'
export { WhatsAppAdapter } from './whatsapp'
export { InstagramAdapter } from './instagram'
export { MessengerAdapter } from './messenger'
export * from './stubs'
export { broadcastKinds, canBroadcast, resolveProvider } from './providers'
export { channelConfigured, adapterEnvFor } from './core/credentials'

/** The channel's default provider, from the registry (one line there); only the declared-only channels are listed here.
 * Nothing that sends should use this for a stored connection: use connectionAdapter, which asks the connection which provider it is. */
export function channelAdapter(type: string, env: AdapterEnv): ChannelAdapter {
  if ((channelKinds as readonly string[]).includes(type) && hasDefaultProvider(type as ChannelKind)) return resolveAdapter(type as ChannelKind, undefined, env)
  const declared: Record<string, () => ChannelAdapter> = { tiktok: () => new TikTokAdapter() }
  if (!Object.hasOwn(declared, type)) throw new Error(`No channel adapter registered for type: ${type}`)
  return declared[type]()
}

/** The adapter of one stored connection, chosen by the connection's own provider and wired with its credentials and settings.
 * `secrets: false` is for callers that only fit or check permissions and must not fail on an unreadable credential. */
export async function connectionAdapter(env: IntegrationEnv, workspaceId: string, connectionId: string, type: string, options: { secrets?: boolean } = {}): Promise<ChannelAdapter> {
  if (!(channelKinds as readonly string[]).includes(type) || !hasDefaultProvider(type as ChannelKind)) return channelAdapter(type, env as AdapterEnv)
  return (await connectionRuntime(env, workspaceId, connectionId, options)).adapter
}
