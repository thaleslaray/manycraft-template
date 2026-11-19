import * as React from "react"
import { cn } from "@/lib/utils"

/** Ilustração própria: linhas simples, sem arte de terceiros. */
function Illustration() {
  return (
    <svg viewBox="0 0 96 64" className="h-16 w-24 text-border-input" fill="none" aria-hidden="true">
      <rect x="4" y="8" width="88" height="48" rx="8" stroke="currentColor" strokeWidth="2" />
      <path d="M16 24h32M16 34h56M16 44h24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="76" cy="24" r="4" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}

function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-surface px-6 py-12 text-center",
        className
      )}
    >
      <Illustration />
      <h2 className="text-lg font-semibold">{title}</h2>
      {description ? <p className="max-w-sm text-text-muted">{description}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}

export { EmptyState }
