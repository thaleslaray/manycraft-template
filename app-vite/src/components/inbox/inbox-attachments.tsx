import { useEffect, useState } from "react"
import { LoaderCircle, MapPin, Paperclip, ShoppingBag, TriangleAlert, UserRound } from "lucide-react"
import type { InboxMedia, InboxRich } from "@/data/inbox"
import { getWorkspace } from "@/data/api"
import { cn } from "@/lib/utils"

/** <img>, <audio> e <video> não mandam o cabeçalho x-workspace: o arquivo do motor leva o espaço na consulta (a sessão continua valendo). */
export const fileSrc = (url: string, workspaceId: string) => `${url}?workspace=${encodeURIComponent(workspaceId)}`
function useWorkspaceId(given?: string) {
  const [id, setId] = useState(given)
  useEffect(() => {
    if (given) { setId(given); return }
    let live = true
    getWorkspace().then(w => { if (live) setId(w.workspace_id) }).catch(() => {})
    return () => { live = false }
  }, [given])
  return id
}
const size = (bytes?: number) => bytes === undefined ? "" : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`
const kindLabel = { image: "Imagem", audio: "Áudio", video: "Vídeo", file: "Arquivo", sticker: "Figurinha" }
const price = (value: number, currency: string) => { try { return value.toLocaleString("pt-BR", { style: "currency", currency }) } catch { return `${currency} ${value}` } }

/** O arquivo que o contato mandou: no próprio balão quando o navegador sabe mostrar, como link quando não. */
function InboxFile({ media, workspaceId, own }: { media: InboxMedia; workspaceId?: string; own?: boolean }) {
  const workspace = useWorkspaceId(workspaceId)
  const by = own ? "enviada pela equipe" : "enviada pelo contato"
  const label = kindLabel[media.kind]
  if (media.status === "pending") return <p role="status" className="flex items-center gap-2 text-xs text-text-muted"><LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" />Baixando {label.toLocaleLowerCase("pt-BR")}…</p>
  if (media.status === "failed" || !media.url) return <p role="alert" className="flex items-start gap-2 text-xs text-danger"><TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><span>{label} não disponível. {media.error}</span></p>
  if (!workspace) return <div aria-hidden="true" className="h-24 w-40 animate-pulse rounded-md bg-surface-muted" />
  const src = fileSrc(media.url, workspace)
  if (media.kind === "image" || media.kind === "sticker") return (
    <a href={src} target="_blank" rel="noopener noreferrer" aria-label={`Abrir ${label.toLocaleLowerCase("pt-BR")} ${by}`}>
      <img src={src} alt={media.caption ?? `${label} ${by}`} loading="lazy" referrerPolicy="no-referrer" className={cn("block rounded-md object-contain", media.kind === "sticker" ? "max-h-32" : "max-h-64 max-w-full border border-border")} />
    </a>
  )
  if (media.kind === "audio") return <audio controls preload="none" src={src} aria-label={own ? "Áudio enviado pela equipe" : media.voice ? "Mensagem de voz do contato" : "Áudio enviado pelo contato"} className="w-full max-w-xs" />
  if (media.kind === "video") return <video controls preload="metadata" src={src} aria-label={own ? "Vídeo enviado pela equipe" : "Vídeo enviado pelo contato"} className="max-h-64 max-w-full rounded-md" />
  return (
    <a href={src} download={media.name} target="_blank" rel="noopener noreferrer" className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-surface p-2 text-xs hover:bg-surface-muted">
      <Paperclip className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate font-medium" title={media.name}>{media.name ?? "Arquivo"}</span>
      {media.size !== undefined ? <span className="shrink-0 text-text-muted">{size(media.size)}</span> : null}
    </a>
  )
}

/** Tudo o que o contato mandou além do texto: arquivo, localização, contatos, pedido. Sem nada disso, não renderiza. */
export function InboxAttachments({ message, workspaceId, own }: { message: InboxRich; workspaceId?: string; own?: boolean }) {
  const { media, location, shared_contacts, order } = message
  if (!media && !location && !shared_contacts?.length && !order) return null
  return (
    <div className="space-y-2">
      {media ? <InboxFile media={media} workspaceId={workspaceId} own={own} /> : null}
      {location ? (
        <div className="flex gap-2 rounded-md border border-border bg-surface p-2 text-xs">
          <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0 space-y-0.5">
            <p className="font-medium wrap-anywhere">{location.name ?? "Localização compartilhada"}</p>
            {location.address ? <p className="text-text-muted wrap-anywhere">{location.address}</p> : null}
            <p className="text-text-muted">{location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}</p>
            <a className="inline-block font-medium text-accent underline" target="_blank" rel="noopener noreferrer" href={`https://www.google.com/maps?q=${location.latitude},${location.longitude}`}>Abrir no mapa</a>
          </div>
        </div>
      ) : null}
      {shared_contacts?.length ? (
        <ul aria-label="Contatos compartilhados" className="space-y-2">
          {shared_contacts.map((contact, i) => (
            <li key={i} className="flex gap-2 rounded-md border border-border bg-surface p-2 text-xs">
              <UserRound className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-medium wrap-anywhere">{contact.name}</p>
                {contact.company ? <p className="text-text-muted wrap-anywhere">{contact.company}</p> : null}
                {[...contact.phones, ...contact.emails].map(value => <p key={value} className="text-text-muted wrap-anywhere">{value}</p>)}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {order ? (
        <div className="rounded-md border border-border bg-surface p-2 text-xs">
          <p className="mb-1 flex items-center gap-2 font-medium"><ShoppingBag className="size-4 shrink-0" aria-hidden="true" />Pedido do catálogo</p>
          <ul className="space-y-0.5">{order.items.map((item, i) => <li key={i} className="flex justify-between gap-2"><span className="min-w-0 wrap-anywhere">{item.quantity} × {item.productId}</span><span className="shrink-0 text-text-muted">{price(item.price * item.quantity, item.currency)}</span></li>)}</ul>
          {order.text ? <p className="mt-1 text-text-muted wrap-anywhere">{order.text}</p> : null}
        </div>
      ) : null}
    </div>
  )
}

/** A reação do contato a uma mensagem, junto ao balão. */
export function InboxReaction({ emoji }: { emoji: string }) {
  return <p className="text-sm" title="Reação do contato" aria-label={`Reação do contato: ${emoji}`}><span aria-hidden="true" className="inline-block rounded-pill border border-border bg-surface px-2 py-0.5">{emoji}</span></p>
}
