import * as React from "react"
import { MoreVertical } from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

/** Menu ⋮ de uma linha. O nome acessível é "Mais ações de <item>"; as ações são `RowMenuItem`. */
function RowMenu({ item, children }: { item: string; children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Mais ações de ${item}`}
        className="grid size-8 shrink-0 place-items-center rounded-md text-text-muted hover:bg-border/40 hover:text-text data-[state=open]:bg-border/40"
      >
        <MoreVertical className="size-4" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>{children}</DropdownMenuContent>
    </DropdownMenu>
  )
}

const RowMenuItem = DropdownMenuItem

export { RowMenu, RowMenuItem }
