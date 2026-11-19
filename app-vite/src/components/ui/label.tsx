import * as React from "react"
import { cn } from "@/lib/utils"

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label className={cn("block text-xs font-medium text-text-muted", className)} {...props} />
}

export { Label }
