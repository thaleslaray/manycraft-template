import { cn } from "@/lib/utils"

export type Status = "live" | "stopped" | "draft" | "error"

const map: Record<Status, { label: string; cls: string }> = {
  live: { label: "Ao vivo", cls: "bg-success-soft text-success" },
  stopped: { label: "Parada", cls: "border border-border bg-bg text-text-muted" },
  draft: { label: "Rascunho", cls: "bg-warning-soft text-warning" },
  error: { label: "Com erro", cls: "bg-danger text-on-danger" },
}

function StatusBadge({ status, className }: { status: Status; className?: string }) {
  const { label, cls } = map[status]
  return (
    <span className={cn("inline-flex items-center rounded-sm px-2 py-0.5 text-2xs font-bold uppercase", cls, className)}>
      {label}
    </span>
  )
}

export { StatusBadge }
