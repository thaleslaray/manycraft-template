import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { getWorkspace } from "@/data/api"

export function initials(name: string) {
  const p = name.trim().split(/\s+/).filter(Boolean)
  return ((p[0]?.[0] ?? "?") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase()
}

/** Foto da pessoa quando houver; se faltar ou falhar ao carregar, iniciais sobre fundo suave. */
function AvatarInitials({ name, src, className }: { name: string; src?: string; className?: string }) {
  const [failed, setFailed] = useState(false)
  // Guarda qual foto terminou de carregar: um load que chega antes do efeito (imagem em cache, data:) não se perde.
  const [loadedSrc, setLoadedSrc] = useState<string | undefined>()
  const [resolved, setResolved] = useState<string | undefined>(src?.startsWith("/api/") ? undefined : src)
  // <img> não envia o header x-workspace; fotos servidas pelo motor levam o workspace na query (a sessão continua valendo).
  useEffect(() => {
    setFailed(false)
    if (!src?.startsWith("/api/")) { setResolved(src); return }
    let live = true
    getWorkspace().then(w => { if (live) setResolved(`${src}?workspace=${encodeURIComponent(w.workspace_id)}`) }).catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [src])
  const base = "grid size-8 shrink-0 place-items-center rounded-pill bg-accent-soft text-xs font-bold text-text"
  // As iniciais ficam até a foto carregar de fato; imagem que falha (403, 404) nunca vira círculo vazio.
  const photo = resolved && !failed
  const loaded = loadedSrc === resolved
  return (
    <span aria-hidden="true" className={cn(base, "relative overflow-hidden", className)}>
      {initials(name)}
      {photo ? <img src={resolved} alt="" referrerPolicy="no-referrer" ref={node => { if (node?.complete && node.naturalWidth > 0) setLoadedSrc(resolved) }} onLoad={() => setLoadedSrc(resolved)} onError={() => setFailed(true)}
        className={cn("absolute inset-0 size-full object-cover", !loaded && "opacity-0")} /> : null}
    </span>
  )
}

export { AvatarInitials }
