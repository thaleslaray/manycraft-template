import * as React from "react"

function NumberedStep({
  n,
  title,
  children,
}: {
  n: number
  title: string
  children?: React.ReactNode
}) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 font-semibold">
        <span
          aria-hidden="true"
          className="grid size-6 shrink-0 place-items-center rounded-pill border border-border text-xs"
        >
          {n}
        </span>
        <span>
          <span className="sr-only">Passo {n}: </span>
          {title}
        </span>
      </h3>
      {children}
    </section>
  )
}

export { NumberedStep }
