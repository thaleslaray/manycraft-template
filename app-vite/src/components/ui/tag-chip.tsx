import { Plus, X } from "lucide-react"
import { cn } from "@/lib/utils"

const base =
  "inline-flex h-7 items-center gap-1 rounded-pill border px-3 text-xs font-medium"

type Props =
  | { variant?: "static"; label: string; className?: string }
  | { variant: "removable"; label: string; onRemove: () => void; className?: string }
  | { variant: "add"; label: string; onAdd: () => void; className?: string }

function TagChip(props: Props) {
  if (props.variant === "removable") {
    return (
      <span className={cn(base, "border-border bg-surface", props.className)}>
        {props.label}
        <button
          type="button"
          aria-label={`Remover tag ${props.label}`}
          onClick={props.onRemove}
          className="grid size-4 place-items-center rounded-pill text-text-muted hover:text-text"
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      </span>
    )
  }
  if (props.variant === "add") {
    return (
      <button
        type="button"
        onClick={props.onAdd}
        className={cn(base, "border-dashed border-border-input bg-transparent text-text-muted hover:text-text", props.className)}
      >
        <Plus className="size-3" aria-hidden="true" />
        {props.label}
      </button>
    )
  }
  return <span className={cn(base, "border-border bg-surface", props.className)}>{props.label}</span>
}

export { TagChip }
