import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize } from './permissions'
import { connectionRuntime } from './channels/core/runtime'
import { mediaPublicBase } from './media-blocks'
import { mediaKinds } from './schemas/message-media'
import { limit } from './security'
import { ACCOUNT_PHOTO_MAX_BYTES, ACCOUNT_PHOTO_PATH, ACCOUNT_PHOTO_TYPES } from './account-photo'
export const types = z.enum(['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/plain', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr', 'audio/ogg', 'audio/wav', 'video/mp4', 'video/3gpp', 'video/ogg', 'video/avi', 'video/quicktime', 'video/webm'])
export function matches(bytes: Uint8Array, type: string) {
  const ascii = (start: number, length: number) => new TextDecoder().decode(bytes.slice(start, start + length))
  if (type === 'image/png') return bytes.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10'
  if (type === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (type === 'image/webp') return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP'
  if (type === 'application/pdf') return ascii(0, 5) === '%PDF-'
  // Office 2007+ files are zip containers; the older formats are OLE compound files; plain text has no signature, so it must at least be valid text.
  if (/\.(?:wordprocessingml|spreadsheetml|presentationml)\./.test(type)) return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4
  if (['application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint'].includes(type)) return bytes.slice(0, 8).join(',') === '208,207,17,224,161,177,26,225'
  if (type === 'text/plain') { const start = bytes.slice(0, 65536); try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(start, { stream: true }); return !start.includes(0) } catch { return false } }   // the first 64 KB are enough to tell text from a binary
  if (type === 'audio/mpeg') return ascii(0, 3) === 'ID3' || bytes[0] === 255 && (bytes[1] & 224) === 224
  if (type === 'audio/amr') return ascii(0, 5) === '#!AMR'
  if (type.endsWith('/ogg')) return ascii(0, 4) === 'OggS'
  if (type === 'audio/wav' || type === 'video/avi') return ascii(0, 4) === 'RIFF' && ascii(8, 4) === (type === 'audio/wav' ? 'WAVE' : 'AVI ')
  if (type === 'video/webm') return bytes.slice(0, 4).join(',') === '26,69,223,163'
  if (type === 'audio/aac') return bytes[0] === 255 && (bytes[1] & 246) === 240
  return ascii(4, 4) === 'ftyp' || type === 'video/quicktime' && ascii(4, 4) === 'moov'
}
/** Some connections take OGG audio only with the Opus codec and a single channel (the Cloud API media page does). Opus starts with an "OpusHead" packet: version, channel count. */
export function oggError(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 128)).indexOf('OpusHead')
  if (head < 0) return 'O áudio OGG precisa usar o codec Opus (a conexão não aceita outros codecs em OGG).'
  if (bytes[head + 9] !== 1) return 'O áudio OGG precisa ser mono (um canal); estéreo não é aceito.'
}
/** Quanto do começo do arquivo basta para conferir o formato (o texto simples olha os primeiros 64 KB; o OGG, os primeiros 128 bytes). */
const HEAD_BYTES = 64 * 1024
export const mediaUploadQuerySchema = z.object({ connection_id: z.string().min(1).max(128).optional(), media: z.enum(mediaKinds).optional(), name: z.string().max(255).optional(), purpose: z.literal('account_photo').optional() }).strict()
export const media = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
media.post('/media', async c => {
  authorize(c.var.principal, 'upload')
  const query = mediaUploadQuerySchema.parse(c.req.query())
  const contentType = types.parse(c.req.header('content-type'))
  // A foto da conta é servida pelo próprio motor (workspace-settings/photo): só imagem, até 2 MB, sem domínio de mídia.
  const photo = query.purpose === 'account_photo'
  if (photo && !ACCOUNT_PHOTO_TYPES.includes(contentType)) throw new HTTPException(400, { message: 'A foto precisa ser PNG, JPG ou WebP.' })
  // Legacy uploads still require a separate media domain. Local serving is explicit for connection media only.
  const base = photo ? ACCOUNT_PHOTO_PATH : query.connection_id ? mediaPublicBase(c.env) : c.env.MEDIA_PUBLIC_URL
  if (!c.env.MEDIA || !base) throw new HTTPException(503, { message: 'Armazenamento não configurado.' })
  if (c.env.MEDIA_PUBLIC_URL && !photo) mediaPublicBase(c.env)
  let maxBytes = photo ? ACCOUNT_PHOTO_MAX_BYTES : 5 * 1024 * 1024
  if (query.connection_id) {
    if (!query.media) throw new HTTPException(400)
    const rt = await connectionRuntime(c.env, c.var.principal.workspaceId, query.connection_id, { secrets: false, requireConnected: true })
    const caps = rt.connection.profile.media?.[query.media]
    if (!caps?.maxBytes || !caps.mime.includes(contentType)) throw new HTTPException(409, { message: 'Tipo de anexo não aceito pela conexão.' })
    maxBytes = Math.min(caps.maxBytes, 100 * 1024 * 1024)
  }
  await limit(c.env, `upload:${c.var.userId}`, 20)
  // O tamanho vem declarado (Content-Length) e é conferido antes de ler. Só o começo do arquivo é lido para validar o formato; o resto segue em fluxo para o R2.
  const declared = c.req.header('content-length')
  const refuse = (status: 411 | 413, message?: string): never => { c.req.raw.body?.cancel().catch(() => undefined); throw new HTTPException(status, message ? { message } : undefined) }
  if (declared === undefined || !/^\d+$/.test(declared)) refuse(411, 'Informe o tamanho do arquivo (Content-Length).')
  const size = Number(declared)
  if (size > maxBytes) refuse(413)
  const source = c.req.raw.body?.getReader()
  const head: Uint8Array[] = []; let headSize = 0
  while (source && headSize < Math.min(size, HEAD_BYTES)) {
    const { value, done } = await source.read()
    if (done) break
    head.push(value); headSize += value.byteLength
  }
  const start = new Uint8Array(headSize); let at = 0
  for (const chunk of head) { start.set(chunk, at); at += chunk.byteLength }
  if (!matches(start, contentType)) { source?.cancel().catch(() => undefined); throw new HTTPException(400, { message: 'Conteúdo do arquivo não corresponde ao tipo declarado.' }) }
  if (contentType === 'audio/ogg') { const error = oggError(start); if (error) { source?.cancel().catch(() => undefined); throw new HTTPException(400, { message: error }) } }
  const key = crypto.randomUUID()
  // Unguessable key, then the file's name: apps that show a file card (a PDF in a DM) name it from the last part of the URL.
  // The name is reduced to safe characters and always ends in the type's extension; workspace identifiers never enter media URLs.
  const fileName = safeFileName(query.name, contentType), objectKey = `${key}/${fileName}`
  // O R2 exige tamanho conhecido: o fluxo passa por um FixedLengthStream, que recusa corpo maior ou menor que o declarado.
  const fixed = new FixedLengthStream(size)
  let sent = headSize, overflow = false
  const pump = (async () => {
    const writer = fixed.writable.getWriter()
    writer.closed.catch(() => undefined)
    try {
      for (const chunk of head) await writer.write(chunk)
      while (source) {
        const { value, done } = await source.read()
        if (done) break
        sent += value.byteLength
        if (sent > size) { overflow = true; source.cancel().catch(() => undefined); throw new Error('Corpo maior que o Content-Length') }
        await writer.write(value)
      }
      await writer.close()
    } catch (error) { await writer.abort(error).catch(() => undefined) }
  })()
  try {
    await Promise.all([pump, c.env.MEDIA.put(objectKey, fixed.readable, { httpMetadata: { contentType, contentDisposition: `attachment; filename="${fileName}"`, cacheControl: 'private, no-store' } })])
  } catch {
    await c.env.MEDIA.delete(objectKey).catch(() => undefined)
    throw new HTTPException(overflow ? 413 : 400, { message: 'O corpo do envio não tem o tamanho declarado em Content-Length.' })
  }
  try {
    await c.env.DB.prepare('INSERT INTO media_objects(id,workspace_id,object_key,content_type,size,created_at) VALUES (?,?,?,?,?,?)').bind(key, c.var.principal.workspaceId, objectKey, contentType, size, Date.now()).run()
  } catch (error) { await c.env.MEDIA.delete(objectKey); throw error }
  return c.json({ id: key, url: `${base.replace(/\/$/, '')}/${objectKey}`, mime: contentType, size }, 201)
})

/** Local R2 object preview/provider URL. Production serves from its isolated media domain. */
const extensions: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/ogg': 'ogg' }
/** "Proposta Março (final).PDF" -> "Proposta-Marco-final.pdf"; nothing usable -> "arquivo.<ext>". */
function safeFileName(name: string | undefined, contentType: string) {
  const ext = extensions[contentType] ?? 'bin'
  const stem = (name ?? '').replace(/\.[^.]*$/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  return `${stem || 'arquivo'}.${ext}`
}

export const mediaPublic = new Hono<{ Bindings: Env }>()
mediaPublic.get('/media/public/:id/:name?', async c => {
  const id = c.req.param('id'), name = c.req.param('name')
  if (c.env.APP_ENV !== 'development' || !c.env.MEDIA || !/^[a-f0-9-]{36}$/.test(id) || name !== undefined && !/^[A-Za-z0-9_-]{1,80}\.[a-z0-9]{1,5}$/.test(name)) throw new HTTPException(404)
  // What a contact sent is private: only the authenticated inbox route opens it.
  if (await c.env.DB.prepare('SELECT 1 FROM inbound_media WHERE media_id=?').bind(id).first()) throw new HTTPException(404)
  const object = await c.env.MEDIA.get(name ? `${id}/${name}` : id)
  if (!object) throw new HTTPException(404)
  return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream', ...(object.httpMetadata?.contentDisposition ? { 'Content-Disposition': object.httpMetadata.contentDisposition } : {}), 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'private, no-store' } })
})
