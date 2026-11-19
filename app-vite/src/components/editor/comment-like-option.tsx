import { Heart } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

/** Curtir o comentário: só aparece quando a conexão declara a capacidade. Sem ela, uma linha explica o porquê (e a curtida de um gatilho antigo é ignorada pelo motor). */
export function CommentLikeOption({ comments, checked, disabled, onChange }: {
  comments?: { posts: boolean; like: boolean }
  checked: boolean
  disabled: boolean
  onChange: (value: boolean) => void
}) {
  if (comments?.like) return <div className="flex items-center gap-3 rounded-md border border-border p-3">
    <Heart className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
    <Label htmlFor="comment-like" className="flex-1">Curtir comentário</Label>
    <Switch id="comment-like" checked={checked} disabled={disabled} onCheckedChange={onChange} />
  </div>
  return comments ? <p className="text-xs text-text-muted">Curtir o comentário não está disponível nesta conexão: a Meta só libera curtidas para contas conectadas pelo login com Facebook.</p> : null
}
