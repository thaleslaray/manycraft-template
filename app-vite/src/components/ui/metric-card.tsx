import * as React from "react"
import { Skeleton } from "./skeleton"
import { cn } from "@/lib/utils"

function MetricCard({
  label,
  value,
  delta,
  loading,
  emptyText = "Sem dados ainda",
  action,
  className,
}: {
  label: string
  value?: string | number
  delta?: string
  loading?: boolean
  emptyText?: string
  action?: React.ReactNode
  className?: string
}) {
  const empty = !loading && (value === undefined || value === null)
  return (
    <section
      aria-label={label}
      className={cn("rounded-lg border border-border bg-surface p-4 shadow-card", className)}
    >
      <h3 className="text-xs font-medium text-text-muted">{label}</h3>
      {loading ? (
        <Skeleton className="mt-2 h-8 w-24" />
      ) : empty ? (
        <div className="mt-2 space-y-2">
          <p className="text-sm text-text-muted">{emptyText}</p>
          {action}
        </div>
      ) : (
        <p className="mt-1 flex items-baseline gap-2">
          <span className="text-display font-bold">{value}</span>
          {delta ? <span className="text-xs font-medium text-success">{delta}</span> : null}
        </p>
      )}
    </section>
  )
}

export { MetricCard }
