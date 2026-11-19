import { mediaPublicBase } from './media-blocks'
import { matches, types as uploadTypes } from './media'
import { isManychatMediaUrl, type MediaCopy, type MediaResolver } from './flow/manychat-import'
import type { Env } from './env'

/** Limites da cópia: a mídia da ManyChat é de terceiros, então tamanho, tipo, tempo e quantidade são contidos. */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024
export const MAX_MEDIA_FILES = 60
const TIMEOUT_MS = 15_000
const PARALLEL = 4
const accepted = new Set<string>([...uploadTypes.options, 'image/gif'])
const byExtension: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' }

export type MediaOutcome = { source_url: string; status: 'copied' | 'reused' | 'failed'; media_id?: string; mime?: string; size?: number; reason?: string }
class Refused extends Error {}
const mb = MAX_MEDIA_BYTES / 1024 / 1024

/** Id estável por (workspace, endereço): reimportar reencontra o arquivo em vez de baixar e guardar de novo. */
async function stableId(workspace: string, url: string): Promise<string> {
  const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${workspace}\n${url}`)))].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const sniff = (bytes: Uint8Array, type: string) => type === 'image/gif' ? new TextDecoder().decode(bytes.slice(0, 4)) === 'GIF8' : matches(bytes, type)

async function readBounded(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) throw new Refused(`arquivo acima do limite de ${mb} MB`)
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_MEDIA_BYTES) { await reader.cancel(); throw new Refused(`arquivo acima do limite de ${mb} MB`) }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength }
  return out
}

async function download(url: string): Promise<{ bytes: Uint8Array; type: string }> {
  // Sem seguir redirecionamento: o endereço já passou pela lista de hosts da ManyChat e não pode sair dela.
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: '*/*' } })
  if (response.status !== 200) { await response.body?.cancel(); throw new Refused(`HTTP ${response.status}`) }
  let type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (!accepted.has(type) && (!type || /octet-stream|binary/.test(type))) type = byExtension[new URL(url).pathname.split('.').pop()?.toLowerCase() ?? ''] ?? type
  if (!accepted.has(type)) { await response.body?.cancel(); throw new Refused(`tipo de arquivo não aceito (${type || 'desconhecido'})`) }
  const bytes = await readBounded(response)
  if (!sniff(bytes, type)) throw new Refused('o conteúdo não corresponde ao tipo do arquivo')
  return { bytes, type }
}

/** Copia para o nosso armazenamento a mídia da ManyChat citada no fluxo. Nunca lança por causa de uma mídia: cada falha vira um motivo. */
export async function copyManychatMedia(env: Env, workspace: string, sources: string[]): Promise<{ resolver: MediaResolver; outcomes: MediaOutcome[] }> {
  const urls = [...new Set(sources.filter(isManychatMediaUrl))]
  const copies = new Map<string, MediaCopy | { error: string }>(), outcomes = new Map<string, MediaOutcome>()
  let base: string | undefined
  try { base = mediaPublicBase(env) } catch { base = undefined }
  const fail = (url: string, reason: string) => { copies.set(url, { error: reason }); outcomes.set(url, { source_url: url, status: 'failed', reason }) }
  const one = async (url: string, index: number) => {
    if (!env.MEDIA || !base) return fail(url, 'armazenamento não configurado')
    if (index >= MAX_MEDIA_FILES) return fail(url, `limite de ${MAX_MEDIA_FILES} arquivos por importação`)
    try {
      const id = await stableId(workspace, url)
      const known = await env.DB.prepare('SELECT content_type,size FROM media_objects WHERE workspace_id=? AND id=?').bind(workspace, id).first<{ content_type: string; size: number }>()
      let mime: string, size: number, status: 'copied' | 'reused'
      if (known) { mime = known.content_type; size = known.size; status = 'reused' }
      else {
        const { bytes, type } = await download(url)
        await env.MEDIA.put(id, bytes, { httpMetadata: { contentType: type, contentDisposition: 'attachment', cacheControl: 'private, no-store' } })
        try { await env.DB.prepare('INSERT INTO media_objects(id,workspace_id,object_key,content_type,size,created_at) VALUES (?,?,?,?,?,?)').bind(id, workspace, id, type, bytes.byteLength, Date.now()).run() } catch (error) { await env.MEDIA.delete(id); throw error }
        mime = type; size = bytes.byteLength; status = 'copied'
      }
      copies.set(url, { mediaId: id, url: `${base}/${id}`, mime, size })
      outcomes.set(url, { source_url: url, status, media_id: id, mime, size })
    } catch (error) {
      fail(url, error instanceof Refused ? error.message : error instanceof DOMException && error.name === 'TimeoutError' ? 'tempo esgotado ao baixar' : 'não foi possível baixar o arquivo')
    }
  }
  for (let i = 0; i < urls.length; i += PARALLEL) await Promise.all(urls.slice(i, i + PARALLEL).map((url, k) => one(url, i + k)))
  return { resolver: url => copies.get(url), outcomes: urls.map(url => outcomes.get(url)!) }
}
