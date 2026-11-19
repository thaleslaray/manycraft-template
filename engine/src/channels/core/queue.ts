import { z } from 'zod'
import type { ChannelType } from '../types'

/** Queue envelope shared by every webhook entry point. `provider` is the ingestion family, not the transport:
 * values already persisted in inbound_events ids keep their spelling. */
const identifier = z.string().min(1).max(512)
export const inboundEventSchema = z.object({
  version: z.literal(1), provider: z.enum(['telegram', 'meta']),
  workspaceId: identifier, channelId: identifier, eventId: identifier,
  receivedAt: z.number().int().nonnegative(), payload: z.record(z.string(), z.unknown()),
})
export type InboundEvent = z.infer<typeof inboundEventSchema>

/** Which ingestion family a channel's events travel in. */
export const sourceOf = (kind: ChannelType): InboundEvent['provider'] => kind === 'telegram' ? 'telegram' : 'meta'
