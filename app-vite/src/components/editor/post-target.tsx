import * as React from "react"
import { Link, useParams } from "react-router"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { ChooseExisting } from "@/components/ui/choose-existing"
import type { TriggerConfig } from "@/data"
import type { PostChoice, PostLike } from "./post-choice"

function Thumb({ post, className }: { post?: PostLike; className: string }) {
  const src = post?.thumbnailUrl ?? post?.mediaUrl
  return src ? <img src={src} alt="" className={`${className} shrink-0 rounded object-cover`} /> : <div aria-hidden="true" className={`${className} shrink-0 rounded bg-surface-muted`} />
}

function Counts({ post }: { post: PostLike }) {
  return post.likes !== undefined || post.comments !== undefined
    ? <span className="block text-xs text-text-muted">{post.likes ?? 0} curtidas · {post.comments ?? 0} comentários</span>
    : null
}

/** Alvo do gatilho: o item escolhido como miniatura com legenda; a escolha acontece num pop-up com prévia. */
export function PostTarget({ noun, config, choices, allLabel, nextHint, loading, error, onReload, disabled, onChoose, empty }: {
  noun: "publicação" | "story"
  config: TriggerConfig
  choices: PostChoice[]
  allLabel: string
  nextHint?: string
  loading: boolean
  error?: Error | null
  onReload: () => void
  disabled: boolean
  onChoose: (choice: PostChoice) => void
  empty?: string
}) {
  const [open, setOpen] = React.useState(false)
  const { workspace = "" } = useParams()
  const snapshot = config.post_snapshot
  const label = noun === "story" ? "Story alvo" : "Publicação alvo"
  return <div className="space-y-2">
    <section role="region" aria-label={label} className="flex items-center gap-3 rounded-md border border-border bg-surface p-3">
      {config.target === "specific" && snapshot ? <>
        <Thumb post={snapshot} className="size-16" />
        <p className="min-w-0 break-words text-sm">{snapshot.caption || `${noun === "story" ? "Story" : "Publicação"} ${snapshot.id}`}<Counts post={snapshot} /></p>
      </> : config.target === "specific" ? <p className="text-sm text-text-muted">Escolha {noun === "story" ? "um story" : "uma publicação"}.</p>
        : config.target === "next" ? <p className="text-sm font-semibold">A próxima publicação</p>
        : <p className="text-sm font-semibold">{allLabel}</p>}
    </section>
    {config.target === "next" ? <p className="text-xs text-text-muted">{snapshot ? "A publicação reservada para este gatilho aparece acima." : nextHint}</p> : null}
    {error ? <Banner variant="danger"><span role="alert">{error.message}</span> <span className="block text-xs">Se continuar, o acesso da conta pode ter expirado ou faltar permissão: reconecte em <Link className="underline" to={`/${workspace}/settings/channels`}>Configurações &gt; Canais</Link>.</span><Button variant="secondary" size="sm" onClick={onReload}>Tentar de novo</Button></Banner> : null}
    <Button variant="secondary" size="sm" disabled={disabled || loading} onClick={() => setOpen(true)}>{loading ? "Carregando…" : noun === "story" ? "Escolher story" : "Escolher publicação"}</Button>
    {!loading && !error && choices.length <= (noun === "story" ? 1 : 2) && empty ? <p className="text-sm text-text-muted">{empty}</p> : null}
    <ChooseExisting
      open={open}
      onOpenChange={setOpen}
      title={noun === "story" ? "Escolher story" : "Escolher publicação"}
      searchLabel={noun === "story" ? "Buscar story" : "Buscar publicação"}
      items={choices}
      onChoose={onChoose}
      renderPreview={item => item.post
        ? <div className="space-y-3"><Thumb post={item.post} className="aspect-square w-40" /><p className="break-words text-sm">{item.label}<Counts post={item.post} /></p></div>
        : <p className="text-sm">{item.kind === "next" ? "O gatilho vale para a primeira publicação feita depois da ativação." : allLabel}</p>}
    />
  </div>
}
