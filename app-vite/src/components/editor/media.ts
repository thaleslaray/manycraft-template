import type { Connection } from '@/data/connections'
import type { Trigger } from '@/data'
import type { MediaProfile } from '../../../../engine/src/schemas/message-media'
export { mediaKinds, mediaLabels, mediaError, type MediaBlock, type MediaKind } from '../../../../engine/src/schemas/message-media'

/** A generic trigger targets all live connections; otherwise use only the connections named by its triggers. */
export function mediaConnections(triggers: Trigger[], connections: Connection[]) {
  const all = triggers.some(t => !t.channel_id)
  const ids = new Set(triggers.map(t => t.channel_id))
  return connections.filter(c => c.status === 'connected' && (all || ids.has(c.id)))
}
export const mediaProfiles = (connections: Connection[]): MediaProfile[] => connections.map(c => ({ media: c.profile?.media ?? {} }))
