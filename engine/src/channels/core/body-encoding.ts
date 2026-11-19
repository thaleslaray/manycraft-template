import { HTTPException } from 'hono/http-exception'
import { MAX_WEBHOOK_BYTES } from './webhook-http'

/** A provider may compress its deliveries (Omni Z-API does from 1024 bytes: webhooks/signature.md). The provider's verification and the
 * parsing both work on the decompressed bytes. The size limit applies to the inflated body too, so a small gzip cannot become a large one:
 * four times the default limit, or the provider's own limit when it is larger (WhatsApp: 3 MB). */
export async function decodedBody(headers: Headers, bytes: Uint8Array, providerLimit = MAX_WEBHOOK_BYTES): Promise<Uint8Array> {
  const inflatedLimit = Math.max(providerLimit, MAX_WEBHOOK_BYTES * 4)
  const encoding = (headers.get('content-encoding') ?? '').trim().toLowerCase()
  if (!encoding || encoding === 'identity') return bytes
  if (encoding !== 'gzip') throw new HTTPException(415)
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes   // the platform already decoded it
  const reader = new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip')).getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > inflatedLimit) { await reader.cancel(); throw new HTTPException(413) }
      parts.push(value)
    }
  } catch (error) {
    if (error instanceof HTTPException) throw error
    throw new HTTPException(400)   // not a valid gzip stream
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.byteLength }
  return out
}
