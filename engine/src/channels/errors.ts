export class RateLimited extends Error {
  constructor(readonly retryAfter: number) { super('Channel rate limited') }
}
