import { messageVariables } from './message-variables'

export type MediaProfile = { media: Partial<Record<MediaKind, { maxBytes: number; mime: string[] }>> }
export const mediaKinds = ['image', 'audio', 'video', 'file'] as const
export type MediaKind = typeof mediaKinds[number]
/** A transport that has no native media explicitly narrows every media limit. */
export const unavailableMedia = { image: { maxBytes: 0, mime: [] }, audio: { maxBytes: 0, mime: [] }, video: { maxBytes: 0, mime: [] }, file: { maxBytes: 0, mime: [] } }
export type MediaBlock = { kind: 'media'; media: MediaKind; url: string; mediaId?: string; mime?: string; size?: number; name?: string }
export const mediaLabels: Record<MediaKind, string> = { image: 'Imagem', audio: 'Áudio', video: 'Vídeo', file: 'Arquivo' }
export const mediaUrl = (value: string) => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password } catch { return false }
}
export function mediaError(block: MediaBlock, profiles: MediaProfile[] = [], allowVariables = true): string | undefined {
  if (!block.url.trim()) return 'Anexe um arquivo ou informe uma URL.'
  if (!(allowVariables && messageVariables(block.url).length) && !mediaUrl(block.url)) return 'Informe uma URL completa de mídia (http ou https).'
  if (!profiles.length) return 'Escolha uma conexão compatível no gatilho.'
  for (const profile of profiles) {
    const limit = profile.media?.[block.media]
    if (!limit?.maxBytes || !limit.mime.length) return `${mediaLabels[block.media]} não é aceita por uma das conexões do gatilho.`
    if (block.size !== undefined && block.size > limit.maxBytes) return `${mediaLabels[block.media]} excede o limite de ${limit.maxBytes.toLocaleString('pt-BR')} bytes da conexão.`
    if (block.mime && !limit.mime.includes(block.mime)) return 'O tipo do arquivo não é aceito por uma das conexões do gatilho.'
  }
}
