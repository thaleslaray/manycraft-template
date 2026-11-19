import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z, ZodError } from 'zod'
import type { Credentials, RawWebhook, WebhookVerdict } from '../contract'

export const MAX_WEBHOOK_BYTES = 64 * 1024
/** WhatsApp Cloud API (replica/contratos/meta-whatsapp/limites.md, Webhooks): up to 3 MB per POST and 1,000 updates per POST. */
export const WHATSAPP_MAX_WEBHOOK_BYTES = 3 * 1024 * 1024
export const WHATSAPP_MAX_WEBHOOK_EVENTS = 1000

/** A refused delivery is never silent: one line with the provider and the reason (no body, ids, phones or signatures). */
export function noteRefused(provider: string, reason: string, detail: Record<string, number> = {}): void {
  console.warn(JSON.stringify({ event: 'webhook_rejected', provider, reason, ...detail }))
}

export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('')
}
/** Constant-time comparison of two secrets (compares their digests). */
export async function equalSecret(actual: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(actual), digest(expected)])
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
export async function verifyMetaSignature(bytes: Uint8Array, signature: string, secret: string): Promise<boolean> {
  if (!/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const raw = Uint8Array.from(signature.slice(7).match(/../g)!, (hex) => parseInt(hex, 16))
  return crypto.subtle.verify('HMAC', key, raw, bytes)
}
export async function readLimitedBody(request: Request, limit: { bytes: number; provider: string } = { bytes: MAX_WEBHOOK_BYTES, provider: 'unknown' }): Promise<Uint8Array> {
  const tooLarge = () => { noteRefused(limit.provider, 'payload_too_large', { limitBytes: limit.bytes }); return new HTTPException(413) }
  const length = Number(request.headers.get('content-length'))
  if (length > limit.bytes) throw tooLarge()
  const reader = request.body?.getReader()
  if (!reader) throw new HTTPException(400)
  const parts: Uint8Array[] = []
  let lengthRead = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      lengthRead += value.byteLength
      if (lengthRead > limit.bytes) { await reader.cancel(); throw tooLarge() }
      parts.push(value)
    }
  } finally { reader.releaseLock() }
  const result = new Uint8Array(lengthRead)
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.byteLength }
  return result
}
export function parseJson(bytes: Uint8Array): unknown { return JSON.parse(new TextDecoder().decode(bytes)) }

/** Shared by every webhook entry point: never echo body, ids, signatures or SQL values. */
export function webhookErrors(error: Error, c: Context): Response {
  if (error instanceof ZodError || error instanceof SyntaxError) return c.json({ error: 'Webhook inválido.' }, 400)
  if (error instanceof HTTPException) return c.json({ error: 'Webhook recusado.' }, error.status)
  return c.json({ error: 'Webhook temporariamente indisponível.' }, 503)
}

const metaHandshake = z.object({
  'hub.mode': z.literal('subscribe'), 'hub.verify_token': z.string().min(1).max(512),
  'hub.challenge': z.string().min(1).max(1024).regex(/^[a-zA-Z0-9_-]+$/),
})
/** Meta's two proofs: GET handshake against the connection's verify token, POST signature against the app secret (credential `appSecret`). */
export async function verifyMetaWebhook(raw: RawWebhook, secrets: { webhookSecret: string; credentials: Credentials }): Promise<WebhookVerdict> {
  if (raw.method === 'GET') {
    const query = metaHandshake.safeParse(Object.fromEntries(raw.query))
    if (!query.success) return { ok: false, status: 400 }
    return secrets.webhookSecret && await equalSecret(query.data['hub.verify_token'], secrets.webhookSecret)
      ? { ok: true, challenge: query.data['hub.challenge'] } : { ok: false, status: 403 }
  }
  const appSecret = secrets.credentials.appSecret
  if (!appSecret) return { ok: false, status: 503 }
  return await verifyMetaSignature(raw.body, raw.headers.get('X-Hub-Signature-256') ?? '', appSecret) ? { ok: true } : { ok: false, status: 401 }
}
