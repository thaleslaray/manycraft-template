import type { InboundEvent as QueuedEvent, IntegrationEnv } from '../../integrations'
import type { MediaDownload } from '../contract'
import type { InboundMedia } from '../types'
import type { ConnectionRuntime } from './runtime'

/** Files a contact sends are fetched here, not in the webhook: the webhook only queues the event, and this runs in the queue consumer.
 * A transient failure throws so the queue retries with its own backoff; after MAX_ATTEMPTS (or a failure that retrying cannot fix) the
 * message is kept without its file and the reason is recorded. Nothing the contact sent is ever dropped. */
export const INBOUND_MEDIA_MAX_BYTES = 100 * 1024 * 1024
export const INBOUND_MEDIA_MAX_ATTEMPTS = 8

export type SettledMedia = { status: 'stored'; id: string; mime: string; size: number } | { status: 'failed'; error: string }
/** Thrown while attempts remain; the queue consumer turns it into a retry. */
export class MediaRetry extends Error { constructor(readonly code: string) { super(`Inbound media not downloaded yet: ${code}`) } }

const notices: Record<string, string> = {
  not_found: 'O arquivo não está mais disponível no canal (o prazo para baixar já passou).',
  expired: 'O arquivo não está mais disponível no canal (o prazo para baixar já passou).',
  too_large: 'O arquivo é maior que o limite aceito (100 MB) e não foi guardado.',
  auth: 'O canal recusou o acesso ao arquivo. Confira a conexão do canal.',
  invalid: 'O canal devolveu o arquivo de um jeito que não foi possível ler.',
  unavailable: 'Este espaço não guarda arquivos recebidos neste canal.',
  blocked: 'Este tipo de arquivo (página da web, imagem vetorial ou script) não é guardado por segurança.',
}
/** The sentence the inbox shows for a file that could not be downloaded. */
export const mediaFailureNotice = (code: string | undefined) => notices[code ?? ''] ?? 'Não foi possível baixar o arquivo, mesmo depois de várias tentativas.'

/** Same file, same key: a retry after a half-finished attempt overwrites instead of leaving an orphan. */
async function objectKey(inboundId: string): Promise<string> {
  const hex = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`inbound-media:${inboundId}`))), b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}
/** Types a browser runs instead of showing: never kept, whatever the contact declared. */
const active = /^(?:text\/(?:html|xml|javascript|css)|application\/(?:xhtml\+xml|xml|(?:x-)?javascript|ecmascript)|image\/svg\+xml)$/
export const isActiveContent = (mime: string) => active.test(mime.split(';')[0]!.trim().toLowerCase())
const safeMime = (mime: string) => /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime) ? mime : 'application/octet-stream'

export async function receiveMedia(env: IntegrationEnv, rt: ConnectionRuntime, event: QueuedEvent, inboundId: string, media: InboundMedia): Promise<SettledMedia> {
  const row = await env.DB.prepare('SELECT status,attempts,media_id,error FROM inbound_media WHERE inbound_id=?').bind(inboundId)
    .first<{ status: string; attempts: number; media_id: string | null; error: string | null }>()
  if (row?.status === 'failed') return { status: 'failed', error: row.error ?? 'unavailable' }
  if (row?.status === 'stored') {
    const object = row.media_id ? await env.DB.prepare('SELECT content_type,size FROM media_objects WHERE workspace_id=? AND id=?').bind(event.workspaceId, row.media_id).first<{ content_type: string; size: number }>() : null
    return object ? { status: 'stored', id: row.media_id!, mime: object.content_type, size: object.size } : { status: 'failed', error: 'not_found' }
  }
  const book = (status: 'pending' | 'failed', attempts: number, error: string | null) => env.DB.prepare(`INSERT INTO inbound_media(inbound_id,workspace_id,channel_id,kind,status,attempts,error,updated_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(inbound_id) DO UPDATE SET status=excluded.status,attempts=excluded.attempts,error=excluded.error,updated_at=excluded.updated_at`)
    .bind(inboundId, event.workspaceId, event.channelId, media.type, status, attempts, error, Date.now()).run()
  const settleFailure = async (code: string, attempts: number): Promise<SettledMedia> => {
    await book('failed', attempts, code)
    console.warn(JSON.stringify({ event: 'inbound_media_failed', provider: rt.connection.provider, channelId: event.channelId, code, attempts }))
    return { status: 'failed', error: code }
  }
  const attempts = (row?.attempts ?? 0) + 1
  if (!env.INBOUND_MEDIA || !rt.provider?.downloadMedia) return settleFailure('unavailable', attempts)
  // Counted before the try, so a crash in the middle of an attempt still uses one up.
  await book('pending', attempts, row?.error ?? null)
  let result: MediaDownload
  try {
    result = await rt.provider.downloadMedia({ env, connection: rt.connection, credentials: await rt.credentials(), fetch: rt.fetch }, media, INBOUND_MEDIA_MAX_BYTES)
  } catch { result = { ok: false, transient: true, code: 'network' } }
  if (result.ok && isActiveContent(result.mime)) {
    await result.body.cancel().catch(() => {})
    return settleFailure('blocked', attempts)
  }
  if (result.ok) {
    const key = await objectKey(inboundId), mime = safeMime(result.mime)
    try {
      // Fixed length: the file streams into storage without being held in memory, and a body that is not the size announced fails the write.
      await env.INBOUND_MEDIA.put(key, result.body.pipeThrough(new FixedLengthStream(result.size)), { httpMetadata: { contentType: mime, contentDisposition: 'attachment', cacheControl: 'private, no-store' } })
    } catch { result = { ok: false, transient: true, code: 'network' } }
    if (result.ok) {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO media_objects(id,workspace_id,object_key,content_type,size,created_at,bucket) VALUES (?,?,?,?,?,?,'inbound') ON CONFLICT(id) DO NOTHING").bind(key, event.workspaceId, key, mime, result.size, Date.now()),
        env.DB.prepare("UPDATE inbound_media SET status='stored',media_id=?,error=NULL,updated_at=? WHERE inbound_id=?").bind(key, Date.now(), inboundId),
      ])
      return { status: 'stored', id: key, mime, size: result.size }
    }
  }
  if (result.transient && attempts < INBOUND_MEDIA_MAX_ATTEMPTS) {
    await book('pending', attempts, result.code)
    console.warn(JSON.stringify({ event: 'inbound_media_retry', provider: rt.connection.provider, channelId: event.channelId, code: result.code, attempts }))
    throw new MediaRetry(result.code)
  }
  return settleFailure(result.code, attempts)
}
