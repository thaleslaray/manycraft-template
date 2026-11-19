import { HTTPException } from 'hono/http-exception'
import type { IntegrationEnv } from './integrations'
import type { MediaBlock } from './schemas/message-media'

export function mediaPublicBase(env: Pick<IntegrationEnv, 'APP_ENV' | 'MEDIA_PUBLIC_URL' | 'PUBLIC_BASE_URL' | 'BETTER_AUTH_URL'>): string | undefined {
  if (env.MEDIA_PUBLIC_URL) {
    const url = new URL(env.MEDIA_PUBLIC_URL)
    if (url.protocol !== 'https:' || url.origin === new URL(env.BETTER_AUTH_URL!).origin) throw new HTTPException(503)
    return env.MEDIA_PUBLIC_URL.replace(/\/$/, '')
  }
  if (env.APP_ENV === 'development' && env.PUBLIC_BASE_URL) {
    const url = new URL(env.PUBLIC_BASE_URL)
    // Local, or an https tunnel to this machine: the only way a real provider can fetch a file uploaded in development.
    if (['localhost', '127.0.0.1'].includes(url.hostname) || url.protocol === 'https:') return `${url.origin}/api/media/public`
  }
}
/** Stored metadata is authoritative; another workspace's id never authorizes attachment access. */
export async function storedMedia(env: IntegrationEnv, workspace: string, block: MediaBlock): Promise<MediaBlock> {
  if (!block.mediaId) return block
  const row = await env.DB.prepare('SELECT object_key,content_type,size,bucket FROM media_objects WHERE workspace_id=? AND id=?').bind(workspace, block.mediaId)
    .first<{ object_key: string; content_type: string; size: number; bucket: string }>()
  if (!row) throw new HTTPException(409, { message: 'O anexo não está disponível neste espaço.' })
  // O que o contato mandou fica no bucket privado: nunca ganha endereço público, nem para reenviar.
  if (row.bucket === 'inbound') throw new HTTPException(409, { message: 'Arquivos que o contato enviou não podem ser reenviados como anexo.' })
  const base = mediaPublicBase(env)
  if (!base) throw new HTTPException(503, { message: 'Armazenamento não configurado.' })
  return { ...block, url: `${base}/${row.object_key}`, mime: row.content_type, size: row.size }
}
/** Which bucket holds an object: files contacts sent are private (INBOUND_MEDIA), everything else (and every older row) is in MEDIA. */
export const bucketOf = (env: { MEDIA?: R2Bucket; INBOUND_MEDIA?: R2Bucket }, bucket: string) => bucket === 'inbound' ? env.INBOUND_MEDIA : env.MEDIA
