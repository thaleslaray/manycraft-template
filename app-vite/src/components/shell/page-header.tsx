import * as React from "react"
import { createPortal } from "react-dom"
import { Link } from "react-router"
import { cn } from "@/lib/utils"
import { ChevronLeft, ChevronRight, MoreVertical } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

type Slot = { target: HTMLElement | null; claim: () => () => void }
export const PageHeaderContext = React.createContext<Slot | null>(null)

export type PageAction = { label: string; icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>; onSelect: () => void; primary?: boolean; iconOnly?: boolean }
export type PageMenuItem = { label: string; onSelect: () => void; danger?: boolean }

/**
 * Cabeçalho da página na barra do topo: título à esquerda e ações à direita, antes do sino.
 * No celular as ações viram um menu ⋮. Sem a barra do shell (testes, galeria), renderiza no lugar.
 */
export type Crumb = { label: string; to: string }

export function PageHeader({ title, titleSlot, crumbs, status, badge, center, actions = [], menu = [], menuLabel = "Mais ações" }: { title: string; titleSlot?: React.ReactNode; crumbs?: Crumb[]; status?: React.ReactNode; badge?: React.ReactNode; center?: React.ReactNode; actions?: PageAction[]; menu?: PageMenuItem[]; menuLabel?: string }) {
  const slot = React.useContext(PageHeaderContext)
  React.useEffect(() => slot?.claim(), [slot])
  const all = [...actions.map(a => ({ label: a.label, onSelect: a.onSelect })), ...menu]
  const body = (
    <>
      {crumbs?.length ? <nav aria-label="Você está em" className="shrink-0"><ol className="flex items-center gap-1 text-sm text-text-muted">{crumbs.map((crumb, index) => <li key={crumb.to} className={cn("items-center gap-1", index === 0 ? "flex" : "hidden sm:flex")}><Link to={crumb.to} className="inline-flex items-center hover:text-text hover:underline">{index === 0 ? <ChevronLeft className="size-5 sm:hidden" aria-hidden="true" /> : null}<span className={index === 0 ? "sr-only sm:not-sr-only" : undefined}>{crumb.label}</span></Link><ChevronRight className="hidden size-3.5 sm:block" aria-hidden="true" /></li>)}</ol></nav> : null}
      <h1 className="min-w-0 truncate text-lg font-bold sm:text-2xl" title={title}>{titleSlot ?? title}</h1>
      {badge}
      {center ? <div className="mx-auto hidden w-full max-w-xl min-w-0 flex-1 sm:block">{center}</div> : null}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {status}
        {actions.map(({ label, icon: Icon, onSelect, primary, iconOnly }) => (
          iconOnly && Icon
            ? <Button key={label} variant={primary ? "primary" : "secondary"} size="icon" aria-label={label} title={label} className="hidden sm:inline-flex" onClick={onSelect}><Icon className="size-4" aria-hidden="true" /></Button>
            : <Button key={label} variant={primary ? "primary" : "secondary"} className="hidden sm:inline-flex" onClick={onSelect}>
              {Icon ? <Icon className="size-4" aria-hidden="true" /> : null}{label}
            </Button>
        ))}
        {menu.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={menuLabel} className="hidden sm:inline-flex"><MoreVertical className="size-5" aria-hidden="true" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>{menu.map(m => <DropdownMenuItem key={m.label} className={m.danger ? "text-danger" : undefined} onSelect={m.onSelect}>{m.label}</DropdownMenuItem>)}</DropdownMenuContent>
          </DropdownMenu>
        )}
        {all.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={menuLabel} className="sm:hidden"><MoreVertical className="size-5" aria-hidden="true" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>{all.map(m => <DropdownMenuItem key={m.label} onSelect={m.onSelect}>{m.label}</DropdownMenuItem>)}</DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </>
  )
  if (!slot) return <div className="flex items-center gap-3">{body}</div>
  return slot.target ? createPortal(body, slot.target) : null
}
