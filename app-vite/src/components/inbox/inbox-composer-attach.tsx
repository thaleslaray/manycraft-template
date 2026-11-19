import * as React from "react"
import { Paperclip, Smile, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { attachmentError, emojiGroups, formatLimit, type AttachmentOption } from "./inbox-compose"

export type StagedAttachment = { option: AttachmentOption; file: File }

/** One button per kind of file the conversation's connection takes (its capability sheet), each with its limit. Nothing is uploaded until the message is sent. */
export function InboxAttachButtons({ options, disabled, onPick, onError }: {
  options: AttachmentOption[]; disabled: boolean; onPick: (attachment: StagedAttachment) => void; onError: (message: string) => void
}) {
  if (!options.length) return null
  return <div role="group" aria-label="Anexar à resposta" className="contents">
    {options.map(option => <label key={option.kind} title={`${option.label} ${option.limit}`} className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium hover:bg-surface-muted focus-within:ring-2 focus-within:ring-accent ${disabled ? "pointer-events-none opacity-50" : ""}`}>
      <Paperclip className="size-3.5" aria-hidden="true" />{option.label}
      <input className="sr-only" type="file" accept={option.accept} disabled={disabled} aria-label={`Anexar ${option.label.toLocaleLowerCase("pt-BR")} (${option.limit})`}
        onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ""
          if (!file) return
          const problem = attachmentError(option, file)
          if (problem) onError(problem); else onPick({ option, file })
        }} />
    </label>)}
  </div>
}

export function InboxStagedAttachment({ attachment, disabled, onRemove }: { attachment: StagedAttachment; disabled: boolean; onRemove: () => void }) {
  return <div role="status" className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-surface-muted p-2 text-xs">
    <Paperclip className="size-4 shrink-0" aria-hidden="true" />
    <span className="min-w-0 truncate font-medium" title={attachment.file.name}>{attachment.file.name}</span>
    <span className="shrink-0 text-text-muted">{attachment.option.label} · {formatLimit(attachment.file.size)}</span>
    <Button type="button" size="sm" variant="ghost" className="ml-auto" disabled={disabled} aria-label={`Remover anexo ${attachment.file.name}`} onClick={onRemove}><X className="size-4" aria-hidden="true" /></Button>
  </div>
}

/** A short list of common emoji, no library: pressing one puts it where the cursor is in the message. */
export function InboxEmojiPicker({ disabled, onPick }: { disabled: boolean; onPick: (emoji: string) => void }) {
  const [open, setOpen] = React.useState(false)
  const root = React.useRef<HTMLDivElement>(null)
  // Esc e clique fora fecham o seletor (sem isso ele cobre o compositor e bloqueia os botões seguintes).
  React.useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false) }
    const onPointer = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false) }
    document.addEventListener("keydown", onKey)
    document.addEventListener("pointerdown", onPointer)
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onPointer) }
  }, [open])
  return <div ref={root} className="relative">
    <Button type="button" size="sm" variant="ghost" disabled={disabled} aria-expanded={open} aria-haspopup="true" aria-label="Inserir emoji" onClick={() => setOpen(value => !value)}><Smile className="size-4" aria-hidden="true" />Emoji</Button>
    {open ? <div role="group" aria-label="Emojis" className="absolute bottom-full left-0 z-10 mb-1 w-72 max-w-[80vw] space-y-2 rounded-md border border-border bg-surface p-2 shadow-lg" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false) } }}>
      {emojiGroups.map(group => <div key={group.label}>
        <p className="mb-1 text-2xs text-text-muted">{group.label}</p>
        <div className="flex flex-wrap gap-1">{group.emojis.map(emoji => <button key={emoji} type="button" aria-label={`Emoji ${emoji}`} className="size-8 rounded-md text-lg hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-accent" onClick={() => { onPick(emoji); setOpen(false) }}>{emoji}</button>)}</div>
      </div>)}
    </div> : null}
  </div>
}
