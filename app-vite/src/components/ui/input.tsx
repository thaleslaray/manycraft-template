import * as React from "react"
import { cn } from "@/lib/utils"

const field =
  "w-full rounded-md border border-border-input bg-surface px-3 text-sm text-text placeholder:text-text-muted transition-colors duration-(--duration-fast) hover:border-text-muted read-only:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger"

/** Campo de arquivo com botão e texto em pt-BR (o nativo mostra "Choose File / No file chosen" no idioma do navegador). */
function FileInput({ className, onChange, ...props }: React.ComponentProps<"input">) {
  const ref = React.useRef<HTMLInputElement>(null)
  const [name, setName] = React.useState("")
  return (
    <div data-slot="input" className={cn(field, "flex h-auto min-h-10 items-center gap-3 py-1.5 has-focus-visible:ring-2 has-focus-visible:ring-accent", className)}>
      <input
        ref={ref}
        type="file"
        className="sr-only"
        onChange={(event) => { setName(event.target.files?.[0]?.name ?? ""); onChange?.(event) }}
        {...props}
      />
      <button type="button" tabIndex={-1} aria-hidden="true" disabled={props.disabled} onClick={() => ref.current?.click()}
        className="shrink-0 rounded-md border border-border-input bg-surface-muted px-3 py-1 text-sm font-medium text-text hover:bg-border/40 disabled:opacity-50">
        Escolher arquivo
      </button>
      <span className="min-w-0 truncate text-text-muted">{name || "Nenhum arquivo escolhido"}</span>
    </div>
  )
}

function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  if (type === "file") return <FileInput className={className} {...props} />
  return <input type={type} data-slot="input" className={cn(field, "h-10", className)} {...props} />
}

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn(field, "min-h-20 py-2", className)} {...props} />
}

export { Input, Textarea, field }
