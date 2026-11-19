import { Hono } from 'hono'
import { legacyHooks } from './channels/core/hooks'
import type { KeyringEnv } from './channels/core/crypto'
import type { InboundEvent } from './channels/core/queue'
import { webhookErrors } from './channels/core/webhook-http'

export interface IntegrationEnv extends KeyringEnv {
  DB: D1Database
  APP_ENV?: string
  PUBLIC_BASE_URL?: string
  MEDIA?: R2Bucket
  INBOUND_MEDIA?: R2Bucket
  MEDIA_PUBLIC_URL?: string
  BETTER_AUTH_URL?: string
  DEV_PROVIDER_API_BASE?: string
  EMAIL?: SendEmail
  EMAIL_DEFAULT_DOMAIN?: string
  INBOX_HUB?: DurableObjectNamespace<import('./inbox/hub').InboxHub>
  CHANNEL_LIMITER?: DurableObjectNamespace<import('./flow/limiter').ChannelLimiter>
  FLOW_RUN?: Workflow<{ runId: string }>
  INBOUND?: Queue<InboundEvent>
  /** "off" desliga o caminho rápido do webhook; padrão ligado. */
  FAST_INBOUND?: string
}

export { inboundEventSchema, type InboundEvent } from './channels/core/queue'
export { MAX_WEBHOOK_BYTES, readLimitedBody, verifyMetaSignature } from './channels/core/webhook-http'

export const webhooks = new Hono<{ Bindings: IntegrationEnv }>()
webhooks.route('/', legacyHooks)

webhooks.onError(webhookErrors)
