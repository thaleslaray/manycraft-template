import { CornerDownRight } from "lucide-react"

/** Selo curto da primeira mensagem depois de um comentário (resposta privada). */
export function PrivateReplyBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm bg-accent-soft px-2 py-0.5 text-2xs font-bold text-text">
      <CornerDownRight className="size-3" aria-hidden="true" />
      Resposta ao comentário
    </span>
  )
}
