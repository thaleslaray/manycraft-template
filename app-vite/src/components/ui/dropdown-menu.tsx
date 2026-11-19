import * as React from "react"
import { DropdownMenu as DM } from "radix-ui"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"

const DropdownMenu = DM.Root
const DropdownMenuTrigger = DM.Trigger

function DropdownMenuContent({ className, ...props }: React.ComponentProps<typeof DM.Content>) {
  return (
    <DM.Portal>
      <DM.Content
        align="end"
        sideOffset={4}
        className={cn(
          "z-50 min-w-48 rounded-md border border-border bg-surface p-1 shadow-pop data-[state=open]:animate-in data-[state=open]:fade-in-0",
          className
        )}
        {...props}
      />
    </DM.Portal>
  )
}

function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof DM.Item>) {
  return (
    <DM.Item
      className={cn(
        "flex h-9 cursor-default select-none items-center gap-2 rounded-sm px-3 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-border/40",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuCheckboxItem({ className, children, ...props }: React.ComponentProps<typeof DM.CheckboxItem>) {
  return (
    <DM.CheckboxItem
      className={cn(
        "flex h-9 cursor-default select-none items-center gap-2 rounded-sm px-3 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-border/40",
        className
      )}
      {...props}
    >
      <span aria-hidden="true" className="grid size-4 place-items-center rounded-sm border border-border-input">
        <DM.ItemIndicator><Check className="size-3" /></DM.ItemIndicator>
      </span>
      {children}
    </DM.CheckboxItem>
  )
}

function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof DM.Label>) {
  return <DM.Label className={cn("px-3 py-1 text-xs text-text-muted", className)} {...props} />
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DM.Separator>) {
  return <DM.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />
}

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuLabel, DropdownMenuSeparator }
