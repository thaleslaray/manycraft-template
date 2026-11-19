import type { InboundEvent as QueuedEvent, IntegrationEnv } from '../../integrations'
import { recordInstagramReceipt, syncInstagramContact } from '../instagram'
import type { InboundEvent } from '../types'
import { recordWhatsappReceipt, syncWhatsappContact } from '../whatsapp'
import { legacyEvents } from './legacy-events'
import { adapterEnv } from './credentials'
import type { ConnectionRuntime } from './runtime'

/** Queued payload -> events the flow executor understands, read by the connection's provider (the webhook was verified before queueing). */
export async function normalizeInbound(rt: ConnectionRuntime, event: QueuedEvent): Promise<InboundEvent[]> {
  const parsed = rt.provider.parseInbound(event.payload, rt.connection)
  const keyed = parsed.filter(e => 'eventKey' in e && e.eventKey !== undefined)
  // Items queued before the per-event envelope carry the whole delivery: keep the part this item stands for.
  const events = parsed.filter(e => !('eventKey' in e) || e.eventKey === undefined || e.eventKey === event.eventId)
  if (keyed.length && !keyed.some(e => 'eventKey' in e && e.eventKey === event.eventId)) throw new Error('Mismatched event')
  return legacyEvents(events)
}

/** Who wrote, when the provider can say (stored at ingestion so erasure does not depend on payload layouts). */
export function senderOf(rt: ConnectionRuntime, event: QueuedEvent): string | null {
  try {
    for (const e of rt.provider.parseInbound(event.payload, rt.connection)) {
      if (e.kind === 'message' || e.kind === 'click' || e.kind === 'reaction' || e.kind === 'comment' || e.kind === 'story_mention') return e.from.externalUserId   // the author of a group message too: erasure reaches it
      if (e.kind === 'own_message' && e.thread.kind === 'direct') return e.to.externalUserId
    }
  } catch { /* An unreadable payload is dispatched (and fails) later; ingestion must not depend on it. */ }
  return null
}

/** Providers that own their contact rows and receipts (not yet on the contract) run their own sync here. */
export async function syncInbound(env: IntegrationEnv, rt: ConnectionRuntime, event: QueuedEvent, items: InboundEvent[]): Promise<void> {
  // A provider that books its whole delivery itself (see ProviderAdapter.syncDelivery) skips the shared per-kind bookkeeping.
  if (rt.provider.syncDelivery) return rt.provider.syncDelivery({ connection: rt.connection, credentials: await rt.credentials(), fetch: rt.fetch, env, event })
  const kind = rt.connection.kind
  const view = adapterEnv(env, kind, await rt.credentials(), rt.connection.id)
  for (const item of items) {
    if (kind === 'whatsapp') {
      if (item.kind === 'receipt') await recordWhatsappReceipt(event, item, view)
      if (item.kind === 'message' || item.kind === 'click') await syncWhatsappContact(event, item, view)
    }
    if (kind === 'instagram') {
      if (item.kind === 'receipt') await recordInstagramReceipt(event, item, view)
      if (item.kind === 'message' || item.kind === 'click' || item.kind === 'story_mention' || item.kind === 'referral') await syncInstagramContact(event, item, view, rt.provider)
    }
    await rt.provider.sync?.({ connection: rt.connection, credentials: await rt.credentials(), fetch: rt.fetch, env, event }, item)
  }
}
