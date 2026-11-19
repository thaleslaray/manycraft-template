import type { InboundEventV2 } from '../contract'
import type { InboundEvent } from '../types'

/** Neutral event -> the shape the flow executor still uses. A group message keeps its group (F6). */
export function legacyEvents(events: InboundEventV2[]): InboundEvent[] {
  return events.map((e): InboundEvent => {
    if (e.kind === 'ignored') return { kind: 'ignored', why: e.why }
    if (e.kind === 'own_message') return { kind: 'ignored', why: 'Message written from the account itself' }
    if (e.kind === 'connection') return { kind: 'ignored', why: 'Connection state events are not handled yet' }
    if (e.kind === 'receipt') return { kind: 'receipt', externalMessageId: e.externalMessageId, status: e.status, ...(e.occurredAt === undefined ? {} : { occurredAt: e.occurredAt }), ...(e.errors?.length ? { errors: e.errors } : {}) }
    if (e.kind === 'comment') return { kind: 'comment', externalUserId: e.from.externalUserId, commentId: e.commentId, postId: e.postId, text: e.text, createdAt: e.createdAt, ...(e.live ? { live: true } : {}) }
    if (e.kind === 'story_mention') return { kind: 'story_mention', externalUserId: e.from.externalUserId, externalMessageId: e.externalMessageId,
      ...(e.storyUrl === undefined ? {} : { storyUrl: e.storyUrl }), ...(e.occurredAt === undefined ? {} : { occurredAt: e.occurredAt }) }
    if (e.kind === 'reaction') return e.thread.kind === 'group' ? { kind: 'ignored', why: 'Reactions in groups are not supported' }
      : { kind: 'reaction', externalUserId: e.from.externalUserId, targetMessageId: e.targetMessageId, ...(e.emoji === undefined ? {} : { emoji: e.emoji }), ...(e.occurredAt === undefined ? {} : { occurredAt: e.occurredAt }) }
    if (!('thread' in e)) return { kind: e.kind, externalUserId: e.from.externalUserId, ...(e.ref === undefined ? {} : { ref: e.ref }) }
    const group = e.thread.kind === 'group' ? { externalGroupId: e.thread.externalGroupId, ...(e.thread.subject ? { subject: e.thread.subject } : {}), mentionsMe: e.kind === 'message' && e.mentionsMe === true } : undefined
    if (group && e.kind === 'click') return { kind: 'ignored', why: 'Clicks in groups are not supported' }
    if (e.kind === 'click') return { kind: 'click', externalUserId: e.from.externalUserId, payload: e.payload, ...(e.label === undefined ? {} : { label: e.label }),
      ...(e.ackToken === undefined ? {} : { ackToken: e.ackToken }), ...(e.occurredAt === undefined ? {} : { occurredAt: e.occurredAt }) }
    const profile = e.from.profile || e.from.phoneE164 ? { ...e.from.profile, ...(e.from.phoneE164 ? { phoneE164: e.from.phoneE164 } : {}) } : undefined
    return { kind: 'message', externalUserId: e.from.externalUserId, externalMessageId: e.externalMessageId,
      ...(e.text === undefined ? {} : { text: e.text }), ...(e.occurredAt === undefined ? {} : { occurredAt: e.occurredAt }),
      ...(e.storyReply === undefined ? {} : { storyReply: e.storyReply }), ...(e.storyId === undefined ? {} : { storyId: e.storyId }), ...(e.like ? { like: true } : {}),
      ...(profile ? { profile } : {}), ...(group ? { group } : {}),
      ...(e.media ? { media: e.media } : {}), ...(e.location ? { location: e.location } : {}), ...(e.sharedContacts ? { sharedContacts: e.sharedContacts } : {}),
      ...(e.order ? { order: e.order } : {}), ...(e.shared ? { shared: e.shared } : {}), ...(e.origin ? { origin: e.origin } : {}), ...(e.unsupported ? { unsupported: e.unsupported } : {}) }
  })
}
