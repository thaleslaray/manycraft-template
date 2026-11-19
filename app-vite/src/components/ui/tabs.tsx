import * as React from "react"
import { Tabs as TabsPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col gap-4", className)} {...props} />
}

type Variant = "underline" | "segmented"

/** `scrollable`: faixa numa linha só que rola na horizontal quando não cabe (celular). */
function TabsList({
  className,
  variant = "underline",
  scrollable = false,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & { variant?: Variant; scrollable?: boolean }) {
  const list = (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(
        "group/tabs inline-flex items-center",
        variant === "underline" ? "gap-6 border-b border-border" : "gap-1 self-start rounded-md bg-border/40 p-1",
        scrollable && "min-w-full flex-nowrap",
        className
      )}
      {...props}
    />
  )
  if (!scrollable) return list
  return (
    <div data-slot="tabs-scroll" className="max-w-full overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {list}
    </div>
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex items-center gap-2 whitespace-nowrap text-sm font-semibold text-text-muted transition-colors duration-(--duration-fast) hover:text-text data-[state=active]:text-text disabled:opacity-50",
        "group-data-[variant=underline]/tabs:-mb-px group-data-[variant=underline]/tabs:h-10 group-data-[variant=underline]/tabs:border-b-2 group-data-[variant=underline]/tabs:border-transparent group-data-[variant=underline]/tabs:data-[state=active]:border-accent",
        "group-data-[variant=segmented]/tabs:h-8 group-data-[variant=segmented]/tabs:rounded-sm group-data-[variant=segmented]/tabs:px-3 group-data-[variant=segmented]/tabs:data-[state=active]:bg-surface group-data-[variant=segmented]/tabs:data-[state=active]:shadow-node",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("outline-none", className)} {...props} />
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
