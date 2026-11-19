import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-pill bg-border-input transition-colors duration-(--duration-fast) data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-5 translate-x-0.5 rounded-pill bg-surface shadow-node transition-transform duration-(--duration-fast) data-[state=checked]:translate-x-[1.125rem]" />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
