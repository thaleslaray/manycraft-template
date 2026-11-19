import { z } from 'zod'
import type { MediaDownload, ProviderCtx } from './contract'
import type { InboundMedia } from './types'

type Failure = Extract<MediaDownload, { ok: false }>
const fail = (code: Failure['code'], transient: boolean): Failure => ({ ok: false, transient, code })
const graphError = z.object({ error: z.object({ code: z.number().optional() }).passthrough() })
/** 4/17/32/613: Graph API limits; 80007/130429/131056: WhatsApp's own (account, throughput, pair). */
const limited = [4, 17, 32, 613, 80007, 130429, 131056]

/** Media API (P/business-phone-numbers/media.md): GET /{media-id} answers with a link that lives 5 minutes, and the link is then fetched with the same token.
 * A media id from a webhook is good for 7 days, so every attempt asks for a new link instead of trusting one that may have expired.
 * `apiBase` is the Graph root with its version; a connection that points the API elsewhere (a local fake) only gets links on that same origin. */
export async function downloadMetaMedia(ctx: ProviderCtx, apiBase: string, media: InboundMedia, maxBytes: number): Promise<MediaDownload> {
  const headers = { Authorization: `Bearer ${ctx.credentials.accessToken}` }
  let lookup: Response
  try { lookup = await ctx.fetch(`${apiBase}/${encodeURIComponent(media.ref)}`, { headers, signal: AbortSignal.timeout(15_000) }) } catch { return fail('network', true) }
  let data: unknown
  try { data = await lookup.json() } catch { return fail(lookup.status >= 500 ? 'server' : 'invalid', lookup.status >= 500) }
  if (!lookup.ok) {
    const code = graphError.safeParse(data)
    const number = code.success ? code.data.error.code : undefined
    if (lookup.status === 429 || limited.includes(number ?? 0)) return fail('rate_limited', true)
    if (lookup.status >= 500) return fail('server', true)
    if (lookup.status === 401 || number === 190) return fail('auth', false)
    // 100 / 404: the id is unknown, was deleted or is older than its 7 days.
    return fail('not_found', false)
  }
  const info = z.object({ url: z.string().max(4096), mime_type: z.string().max(255).optional(), file_size: z.coerce.number().int().nonnegative().optional() }).safeParse(data)
  if (!info.success) return fail('invalid', false)
  // The contract sends `file_size` as a string ("303833"); a response without it is still usable, the byte count is then checked while reading.
  const size = info.data.file_size
  if (size !== undefined && size > maxBytes) return fail('too_large', false)
  let link: URL
  try { link = new URL(info.data.url) } catch { return fail('invalid', false) }
  const root = new URL(apiBase)
  // The token travels only to https links (or to the origin of an overridden API root).
  if (link.protocol !== 'https:' && link.origin !== root.origin) return fail('invalid', false)
  if (link.username || link.password) return fail('invalid', false)
  let file: Response
  try { file = await ctx.fetch(link, { headers, signal: AbortSignal.timeout(60_000) }) } catch { return fail('network', true) }
  if (!file.ok || !file.body) {
    // The link lives 5 minutes: a refusal here usually means it expired, and a new lookup gets another.
    if (file.status === 401 || file.status === 403) return fail('auth', false)
    return fail(file.status >= 500 ? 'server' : file.status === 429 ? 'rate_limited' : 'expired', true)
  }
  const declared = Number(file.headers.get('content-length'))
  const known = Number.isFinite(declared) && declared > 0 ? declared : undefined
  if (size !== undefined && known !== undefined && known !== size) return fail('invalid', false)
  const mime = (info.data.mime_type ?? media.mime ?? file.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  const length = size ?? known
  if (length !== undefined) {
    if (length > maxBytes) return fail('too_large', false)
    return { ok: true, body: file.body, mime, size: length }
  }
  // Neither the lookup nor the link announced a size: count while reading, with the same ceiling.
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    const reader = file.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) { await reader.cancel(); return fail('too_large', false) }
      chunks.push(value)
    }
  } catch { return fail('network', true) }
  return { ok: true, body: new Blob(chunks).stream(), mime, size: total }
}
