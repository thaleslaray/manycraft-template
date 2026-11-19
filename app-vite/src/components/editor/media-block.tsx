import { useEffect, useId, useRef, useState } from 'react'
import { File, Image, Music, Upload, Video } from 'lucide-react'
import { apiRequest } from '@/data/api'
import type { Connection } from '@/data/connections'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { mediaError, mediaLabels, mediaProfiles, type MediaBlock } from './media'
import { VariablePicker, type VariableCatalogProps } from './variable-picker'

export const mediaIcons = { image: Image, audio: Music, video: Video, file: File }
/** `compact`: miniatura no nó do mapa, para a imagem não esticar o passo. */
export function MediaPreview({ block, compact = false }: { block: MediaBlock; compact?: boolean }) {
  const maxH = compact ? 'max-h-24' : 'max-h-44'
  const Icon = mediaIcons[block.media]
  if (!block.url || block.url.includes('{{')) return <div className={`grid ${compact ? 'min-h-12' : 'min-h-20'} place-items-center rounded-md bg-surface-muted text-text-muted`}><Icon className="size-8" aria-hidden="true" /></div>
  if (block.media === 'image') return <img src={block.url} alt="Prévia da imagem" className={`${maxH} w-full rounded-md object-contain`} />
  if (block.media === 'audio') return <audio controls preload="none" src={block.url} aria-label="Prévia do áudio" className="w-full" />
  if (block.media === 'video') return <video controls preload="metadata" src={block.url} aria-label="Prévia do vídeo" className={`${maxH} w-full rounded-md`} />
  return <div className="flex items-center gap-2 rounded-md bg-surface-muted p-3"><Icon className="size-5" aria-hidden="true" /><span className="truncate text-sm">{block.name || 'Arquivo anexado'}</span></div>
}

export function MediaEditor({ block, disabled, connections, variables, onChange }: { block: MediaBlock; disabled: boolean; connections: Connection[]; variables: VariableCatalogProps; onChange: (b: MediaBlock) => void }) {
  const id = useId(), ref = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const profiles = mediaProfiles(connections)
  const limits = profiles.map(p => p.media[block.media])
  const limit = limits.length && limits.every(Boolean) ? Math.min(...limits.map(l => l!.maxBytes)) : 0
  const mime = limits.length ? limits[0]?.mime.filter(m => limits.every(l => l?.mime.includes(m))) ?? [] : []
  const issue = error || mediaError(block, profiles)
  const changeUrl = (url: string) => { setError(''); onChange({ kind: 'media', media: block.media, url }) }
  async function upload(file?: globalThis.File) {
    if (!file || disabled || busy) return
    const bad = mediaError({ ...block, url: 'https://media.example.test/upload', mime: file.type, size: file.size }, profiles)
    if (bad) { setError(bad); return }
    setBusy(true); setError('')
    try {
      const saved = await apiRequest<{ id: string; url: string; mime: string; size: number }>(`/media?connection_id=${encodeURIComponent(connections[0].id)}&media=${block.media}&name=${encodeURIComponent(file.name.slice(0, 255))}`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file })
      if (mounted.current) onChange({ kind: 'media', media: block.media, url: saved.url, mediaId: saved.id, mime: saved.mime, size: saved.size, name: file.name.slice(0, 255) })
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível anexar o arquivo.') }
    finally { setBusy(false) }
  }
  return <div className="space-y-3">
    <MediaPreview block={block} />
    <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border-input p-3 text-sm font-medium hover:bg-surface-muted">
      <Upload className="size-4" aria-hidden="true" />{busy ? 'Enviando arquivo…' : 'Escolher arquivo'}
      <input className="sr-only" type="file" aria-label={`Enviar arquivo de ${mediaLabels[block.media]}`} accept={mime.join(',')} disabled={disabled || busy || !limit} onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }} />
    </label>
    <p className="text-xs text-text-muted">{limit ? `Até ${limit < 1_000_000 ? `${limit.toLocaleString('pt-BR')} bytes` : `${(limit / 1_000_000).toLocaleString('pt-BR')} MB`} · ${mime.join(', ')}` : 'Selecione uma conexão compatível no gatilho.'}</p>
    <div className="space-y-1"><Label htmlFor={id}>URL da mídia</Label><Input id={id} ref={ref} value={block.url} disabled={disabled || busy} placeholder="https:// ou uma variável de contato" onChange={e => changeUrl(e.target.value)} />
      <VariablePicker {...variables} targetRef={ref} value={block.url} disabled={disabled || busy} onChange={changeUrl} />
    </div>
    {block.name ? <p className="truncate text-xs text-text-muted">{block.name} · {block.size?.toLocaleString('pt-BR')} bytes</p> : null}
    {issue ? <p role="status" className="text-xs text-danger">{issue}</p> : null}
  </div>
}
