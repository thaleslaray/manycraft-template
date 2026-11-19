import { DurableObject } from 'cloudflare:workers'

type Bucket = { tokens: number; at: number }
export type Permit = { allowed: boolean; retryAfter: number }

/** One object per bot/channel coordinates both Workflow and human sends, including after eviction. */
export class ChannelLimiter extends DurableObject {
  async acquire(chatId: string): Promise<Permit> {
    if (!chatId || chatId.length > 512) throw new Error('Invalid chat')
    const now = Date.now()
    return this.ctx.storage.transaction(async tx => {
      const chatKey = `chat:${chatId}`
      const refill = (bucket: Bucket | undefined, capacity: number, perSecond: number): Bucket => ({
        tokens: bucket ? Math.min(capacity, bucket.tokens + Math.max(0, now - bucket.at) * perSecond / 1000) : capacity,
        at: now,
      })
      const channel = refill(await tx.get<Bucket>('channel'), 30, 30)
      const chat = refill(await tx.get<Bucket>(chatKey), 1, 1)
      const delay = Math.max((1 - channel.tokens) / 30, 1 - chat.tokens, 0)
      if (delay > 0) return { allowed: false, retryAfter: Math.max(1, Math.ceil(delay)) }
      channel.tokens--
      chat.tokens--
      await tx.put({ channel, [chatKey]: chat })
      // Clean idle chat buckets so a long-lived bot does not grow without bound.
      const alarm = await tx.getAlarm()
      if (alarm === null) await tx.setAlarm(now + 60000)
      return { allowed: true, retryAfter: 0 }
    })
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    const rows = await this.ctx.storage.list<Bucket>({ prefix: 'chat:' })
    const expired = Array.from(rows).filter(([, bucket]) => now - bucket.at >= 60000).map(([key]) => key)
    if (expired.length) await this.ctx.storage.delete(expired)
    if (rows.size > expired.length) await this.ctx.storage.setAlarm(now + 60000)
  }
}
