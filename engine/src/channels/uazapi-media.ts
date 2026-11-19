import type { MediaDownload, ProviderCtx } from './contract'
import type { InboundMedia } from './types'

// Mídia recebida pela UAZAPI. Docs oficiais (skill docs-uazapi): paginas/operacoes/downloadMessage.md (POST /message/download: `id` da mensagem,
// resposta `fileURL` + `mimetype`, link público por 2 dias) e paginas/guias/media-downloads.md (prefira `fileURL` a base64; chame de novo para um link novo).

type Failure = Extract<MediaDownload, { ok: false }>
const fail = (code: Failure['code'], transient: boolean): Failure => ({ ok: false, transient, code })
const asString = (v: unknown) => typeof v === 'string' && v.length ? v : undefined
const record = (v: unknown): Record<string, unknown> | undefined => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined

/** `messageType` values the webhook reports for a file (docs: Message.messageType is free text; ImageMessage and VideoMessage appear in the guides,
 * the rest follow the same naming and were seen on a real server). */
const KINDS: [RegExp, InboundMedia['type']][] = [
  [/^image/i, 'image'], [/^video/i, 'video'], [/^(?:audio|ptt)/i, 'audio'], [/^document/i, 'file'], [/^sticker/i, 'sticker']]

/** Types a contact can send that this product shows only as a placeholder (never a silent drop). */
const VISIBLE_UNSUPPORTED = /^(?:location|livelocation|contact|contactsarray|poll|order|product|groupinvite)/i

const mime = (v: unknown) => asString(v)?.split(';')[0]!.trim().toLowerCase().slice(0, 255) || undefined

/** The file a media message carries, or undefined when `messageType` is not a file. `content` has "no single format" (docs); its mime and name
 * fields are read when present, but the download response is what the core trusts. */
export function inboundMedia(message: Record<string, unknown>, ref: string): InboundMedia | undefined {
  const type = asString(message.messageType)
  const kind = type && KINDS.find(([pattern]) => pattern.test(type))?.[1]
  if (!kind) return undefined
  let content: unknown = message.content
  if (typeof content === 'string') { try { content = JSON.parse(content) } catch { content = undefined } }
  const c = record(content)
  const declared = mime(c?.mimetype ?? c?.mimeType ?? c?.Mimetype)
  const filename = asString(c?.fileName ?? c?.FileName ?? c?.title)?.slice(0, 255)
  const voice = c?.PTT === true || c?.ptt === true || /^ptt/i.test(type) ? true : undefined
  return { type: kind, ref, ...(declared ? { mime: declared } : {}), ...(filename && kind === 'file' ? { filename } : {}), ...(voice && kind === 'audio' ? { voice } : {}) }
}

export const isVisibleUnsupported = (type: string | undefined) => !!type && VISIBLE_UNSUPPORTED.test(type)

/** `post` is the provider's own authenticated call (header `token`); the file link is then fetched WITHOUT the token. */
export async function downloadUazapiMedia(ctx: ProviderCtx, root: string,
  post: (path: string, body: unknown) => Promise<{ status: number; data: unknown }>, media: InboundMedia, maxBytes: number): Promise<MediaDownload> {
  let reply: { status: number; data: unknown }
  try { reply = await post('/message/download', { id: media.ref }) } catch { return fail('network', true) }
  if (reply.status === 401 || reply.status === 403) return fail('auth', false)
  if (reply.status === 404) return fail('not_found', false)
  if (reply.status === 429) return fail('rate_limited', true)
  if (reply.status >= 500) return fail('server', true)
  const data = record(reply.data), url = asString(data?.fileURL)
  if (reply.status !== 200 || !url) return fail('invalid', false)   // 400: "Unsupported media type or no media found in message"
  let link: URL
  try { link = new URL(url) } catch { return fail('invalid', false) }
  // The link is public: only https, or the origin of an overridden API root (a local fake), and never with credentials in it.
  if ((link.protocol !== 'https:' && link.origin !== new URL(root).origin) || link.username || link.password) return fail('invalid', false)
  let file: Response
  try { file = await ctx.fetch(link, { signal: AbortSignal.timeout(60_000) }) } catch { return fail('network', true) }
  if (!file.ok || !file.body) return fail(file.status >= 500 ? 'server' : file.status === 429 ? 'rate_limited' : 'expired', true)   // a stale link: asking again returns a new one
  const declared = Number(file.headers.get('content-length')), known = Number.isFinite(declared) && declared > 0 ? declared : undefined
  const type = (mime(data?.mimetype) ?? media.mime ?? mime(file.headers.get('content-type')) ?? '')
  if (known !== undefined) return known > maxBytes ? fail('too_large', false) : { ok: true, body: file.body, mime: type, size: known }
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
  return { ok: true, body: new Blob(chunks).stream(), mime: type, size: total }
}
