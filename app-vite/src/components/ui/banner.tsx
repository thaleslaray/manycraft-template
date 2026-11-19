import * as React from "react"
import { AlertTriangle, Info, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"

type Variant = "info" | "warning" | "danger"

const styles: Record<Variant, { cls: string; icon: React.ElementType; role: "status" | "alert" }> = {
  info: { cls: "border border-border bg-surface-muted text-text", icon: Info, role: "status" },
  warning: { cls: "bg-warning-soft text-warning", icon: AlertTriangle, role: "status" },
  danger: { cls: "bg-danger text-on-danger", icon: XCircle, role: "alert" },
}

function Banner({
  variant = "info",
  children,
  className,
}: {
  variant?: Variant
  children: React.ReactNode
  className?: string
}) {
  const { cls, icon: Icon, role } = styles[variant]
  return (
    <div role={role} className={cn("flex items-center gap-2 rounded-md px-4 py-2 text-sm", cls, className)}>
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <div>{children}</div>
    </div>
  )
}

export { Banner }
