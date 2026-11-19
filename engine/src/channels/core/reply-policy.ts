import type { IntegrationEnv } from '../../integrations'
import type { ChannelKind, ChannelProfile, ProfilePatch, StoredProvider } from '../contract'
import { canSend } from '../policy'
import { effectiveProfile } from './profile-merge'

export type ReplyState = { window_expires_at: number | null; human_window_expires_at: number | null; last_inbound_at: number | null; opted_in: number }
/** Bound the stored human deadline to the effective profile, including a shorter connection override. */
export function humanReplyMode(profile: ChannelProfile, state: ReplyState, now = Date.now()) {
  const standardExpires = profile.window && state.window_expires_at !== null
    ? Math.min(state.window_expires_at, state.last_inbound_at === null ? Infinity : state.last_inbound_at + profile.window.standardHours * 3600_000) : state.window_expires_at
  const days = profile.window?.humanAgentDays
  const humanExpires = days && state.human_window_expires_at !== null
    ? Math.min(state.human_window_expires_at, state.last_inbound_at === null ? Infinity : state.last_inbound_at + days * 86400_000) : null
  const mode = canSend(profile, { optedIn: !!state.opted_in, windowExpiresAt: standardExpires, humanWindowExpiresAt: humanExpires }, now, 'human')
  return { mode, humanExpires, standardExpires }
}

/** D7: shared by the composer policy and delivery, with stable ordering on ties. */
export async function latestReplyTarget(env: Pick<IntegrationEnv, 'DB'>, workspaceId: string, contactId: string, kind: ChannelKind) {
  return env.DB.prepare(`SELECT cc.channel_id,cc.external_user_id,cc.window_expires_at,cc.human_window_expires_at,cc.last_inbound_at,cc.opted_in,
    ch.type,ch.provider,ch.capabilities_override FROM contact_channels cc
    JOIN channels ch ON ch.workspace_id=cc.workspace_id AND ch.id=cc.channel_id
    WHERE cc.workspace_id=? AND cc.contact_id=? AND ch.type=? AND ch.status='connected' AND ch.archived_at IS NULL AND cc.last_inbound_at IS NOT NULL
    ORDER BY cc.last_inbound_at DESC,cc.id LIMIT 1`).bind(workspaceId, contactId, kind)
    .first<ReplyState & { channel_id: string; external_user_id: string; type: ChannelKind; provider: StoredProvider; capabilities_override: string | null }>()
}
export async function humanReplyPolicy(env: Pick<IntegrationEnv, 'DB'>, input: {
  workspaceId: string; contactId: string; connectionId: string; profile: ChannelProfile;
  windowExpiresAt: number | null; humanWindowExpiresAt: number | null; lastInboundAt: number | null; optedIn: boolean
}) {
  const latest = await latestReplyTarget(env, input.workspaceId, input.contactId, input.profile.type)
  const profile = latest ? effectiveProfile(latest.type, latest.provider, latest.capabilities_override ? JSON.parse(latest.capabilities_override) as ProfilePatch : undefined) : input.profile
  const state = latest ?? { opted_in: Number(input.optedIn), window_expires_at: input.windowExpiresAt, human_window_expires_at: input.humanWindowExpiresAt, last_inbound_at: input.lastInboundAt }
  const { mode, humanExpires, standardExpires } = humanReplyMode(profile, state)
  const allowed = !profile.window || mode.ok && (mode.mode === 'free' || mode.mode === 'human_agent')
  const expires = profile.window ? mode.ok && mode.mode === 'human_agent' ? humanExpires : standardExpires : null
  return { can_reply: allowed, expires_at: expires === null ? null : new Date(expires).toISOString(),
    ...(mode.ok && mode.mode === 'human_agent' ? { mode: 'human_agent' as const } : {}),
    ...(profile.window && humanExpires !== null ? { human_expires_at: new Date(humanExpires).toISOString() } : {}),
    ...(profile.templates && state.opted_in ? { template_connection_id: latest?.channel_id ?? input.connectionId } : {}) }
}
