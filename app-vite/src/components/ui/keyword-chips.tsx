import * as React from "react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { mergeKeywords } from "./keyword-merge"

const MAX = 10

type Props = {
  value: string[]
  onChange: (next: string[]) => void
  variant?: "include" | "exclude"
  label: string
  placeholder?: string
  max?: number
  /** Texto digitado e ainda não confirmado: o pai soma ao salvar. */
  onPendingChange?: (draft: string) => void
}

/** Enter, vírgula ou sair do campo cria; Backspace no vazio remove o último; colar "a, b" cria 2. */
function KeywordChips({ value, onChange, variant = "include", label, placeholder = "+ Palavra-chave", max = MAX, onPendingChange }: Props) {
  const [draft, setDraft] = React.useState("")
  const [warning, setWarning] = React.useState("")
  const [shakeKey, setShakeKey] = React.useState(0)
  const uid = React.useId()
  const full = value.length >= max

  function commit(raw: string[]) {
    const { next, dup, full: over } = mergeKeywords(value, raw, max)
    if (over) setWarning(`Limite de ${max} palavras atingido.`)
    if (dup) {
      setWarning(`"${dup}" já está na lista.`)
      setShakeKey((k) => k + 1)
    } else if (!over && next.length < max) {
      setWarning("")
    }
    if (next.length !== value.length) onChange(next)
    changeDraft("")
  }

  function changeDraft(text: string) {
    setDraft(text)
    onPendingChange?.(text)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault()
      commit([draft])
    } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1))
      setWarning("")
    }
  }

  function onPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text")
    if (/[,\n]/.test(text)) {
      e.preventDefault()
      commit(text.split(/[,\n]/))
    }
  }

  return (
    <div>
      <ul role="list" aria-label={label} className="flex flex-wrap gap-2">
        {value.map((w) => (
          <li
            key={w}
            className={cn(
              "inline-flex h-8 items-center gap-1 rounded-pill bg-bg px-3 text-sm",
              variant === "exclude" && "text-text-muted"
            )}
          >
            {w}
            <button
              type="button"
              aria-label={`remover ${w}`}
              onClick={() => onChange(value.filter((x) => x !== w))}
              className="grid size-4 place-items-center rounded-pill text-text-muted hover:text-text"
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </li>
        ))}
        <li key={`input-${shakeKey}`} className={cn(shakeKey > 0 && warning.includes("já está") && "animate-shake")}>
          <input
            aria-label={`Nova palavra: ${label}`}
            aria-describedby={warning ? `${uid}-aviso` : undefined}
            value={draft}
            disabled={full}
            placeholder={full ? "Limite atingido" : placeholder}
            onChange={(e) => changeDraft(e.target.value)}
            onBlur={() => { if (draft.trim()) commit([draft]) }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            className="h-8 w-36 rounded-pill border border-dashed border-border-input bg-transparent px-3 text-sm placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-60"
          />
        </li>
      </ul>
      <p id={`${uid}-aviso`} role="status" className="mt-1 min-h-4 text-xs text-warning">
        {warning}
      </p>
    </div>
  )
}

export { KeywordChips }
