import { z } from 'zod'
import type { ProviderCtx } from './contract'
import { isInternalHost } from '../flow/external-url'
import { inspectToken } from './meta-whatsapp-account'
import { TemplateRequestError } from './meta-templates'

/** Types the Resumable Upload API takes (docs/graph-api/guides/upload, checked 2026-11-19: pdf, jpeg, jpg, png, mp4), crossed with what the
 * channel profile declares for the header kind; the size limit is the profile's. */
const uploadTypes = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'video/mp4']
const extensions: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'video/mp4': 'mp4' }
const kindOf = { image: 'image', video: 'video', document: 'file' } as const
const kindName = { image: 'imagem', video: 'vídeo', document: 'documento' } as const
const megabytes = (bytes: number) => `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(bytes / 1e6)} MB`
const refuse = (notice: string) => new TemplateRequestError(false, undefined, undefined, notice)
const META_REFUSED = 'A Meta recusou o envio da mídia do cabeçalho. Confira se o arquivo abre normalmente e tente de novo; se continuar, troque o arquivo.'

/** Downloads the header media from its address (public hosts only, redirects checked one by one, size capped while reading). */
async function download(ctx: ProviderCtx, address: string, maxBytes: number, accepted: string[], kind: keyof typeof kindName) {
  const unreachable = refuse('Não foi possível baixar a mídia do cabeçalho pelo endereço informado. Confira se o endereço abre no navegador sem login.')
  let url: URL
  try { url = new URL(address) } catch { throw unreachable }
  let response: Response | undefined
  for (let hop = 0; hop < 4; hop++) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || isInternalHost(url.hostname))
      throw refuse('O endereço da mídia do cabeçalho aponta para uma rede interna; use um endereço público.')
    try { response = await ctx.fetch(url.toString(), { redirect: 'manual', signal: AbortSignal.timeout(20_000) }) } catch { throw unreachable }
    const next = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
    if (!next) break
    try { url = new URL(next, url) } catch { throw unreachable }
    response = undefined
  }
  if (!response || !response.ok || !response.body) throw unreachable
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const allowed = accepted.map(t => extensions[t]?.toUpperCase()).filter((t, i, all) => t && all.indexOf(t) === i).join(' ou ')
  if (!accepted.includes(type)) throw refuse(`O tipo da mídia do cabeçalho não é aceito pela Meta para ${kindName[kind]}${type ? ` (${type})` : ''}. Use ${allowed}.`)
  const tooBig = refuse(`A mídia do cabeçalho é grande demais: o limite para ${kindName[kind]} é ${megabytes(maxBytes)}.`)
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) { await response.body.cancel().catch(() => {}); throw tooBig }
  const reader = response.body.getReader(), parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read().catch(() => { throw unreachable })
    if (done) break
    size += value.byteLength
    if (size > maxBytes) { await reader.cancel().catch(() => {}); throw tooBig }
    parts.push(value)
  }
  if (!size) throw unreachable
  const bytes = new Uint8Array(size)
  let at = 0
  for (const part of parts) { bytes.set(part, at); at += part.byteLength }
  return { bytes, type }
}

/** Header media of a template draft that has no example handle yet: download it from `mediaUrl` and upload it with the Resumable Upload API
 * (POST /{app-id}/uploads with file_name, file_length and file_type, then POST /upload:<session> with `Authorization: OAuth` and `file_offset: 0`;
 * the answer `{ h }` is the handle for `example.header_handle`). The app id comes from debug_token. Every failure is definite: nothing was created. */
export async function uploadHeaderMedia(ctx: ProviderCtx, base: string, kind: 'image' | 'video' | 'document', mediaUrl: string): Promise<string> {
  const limits = ctx.connection.profile.media?.[kindOf[kind]]
  const accepted = (limits?.mime ?? []).filter(type => uploadTypes.includes(type))
  if (!limits || !accepted.length) throw refuse(`Esta conexão não aceita ${kindName[kind]} no cabeçalho do modelo.`)
  const { bytes, type } = await download(ctx, mediaUrl, limits.maxBytes, accepted, kind)
  const token = ctx.credentials.accessToken
  const { appId } = await inspectToken({ base, token, fetch: ctx.fetch })
  if (!appId || !/^\d{1,64}$/.test(appId)) throw refuse('Não foi possível descobrir o app da Meta deste token para enviar a mídia do cabeçalho. Confira o token em Trocar credencial.')
  const session = new URL(`${base}/${appId}/uploads`)
  session.searchParams.set('file_name', `cabecalho.${extensions[type]}`)
  session.searchParams.set('file_length', String(bytes.byteLength))
  session.searchParams.set('file_type', type)
  const headers = { Authorization: `OAuth ${token}` }
  let id: string
  try {
    const started = z.object({ id: z.string().regex(/^upload:[^\s/#]+$/) }).safeParse(await (await ctx.fetch(session.toString(), { method: 'POST', headers, signal: AbortSignal.timeout(15_000) })).json())
    if (!started.success) throw refuse(META_REFUSED)
    id = started.data.id
  } catch (error) { throw error instanceof TemplateRequestError ? error : refuse(META_REFUSED) }
  try {
    const sent = z.object({ h: z.string().min(1).max(2048) }).safeParse(await (await ctx.fetch(`${base}/${id}`, { method: 'POST', headers: { ...headers, file_offset: '0' },
      body: bytes.buffer as ArrayBuffer, signal: AbortSignal.timeout(60_000) })).json())
    if (!sent.success) throw refuse(META_REFUSED)
    return sent.data.h
  } catch (error) { throw error instanceof TemplateRequestError ? error : refuse(META_REFUSED) }
}
