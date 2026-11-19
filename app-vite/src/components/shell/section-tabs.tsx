import * as React from "react"
import { Link, Outlet, useLocation, useParams } from "react-router"
import { ChevronLeft, ChevronRight, KeyRound, ListChecks, ListOrdered, MessageSquare, Workflow, Zap, type LucideIcon } from "lucide-react"
import { PageHeader } from "@/components/shell/page-header"
import { cn } from "@/lib/utils"
import { useWorkspaceSettings } from "@/hooks/use-workspace-settings"

export type SectionTab = { href: string; label: string; icon?: LucideIcon }

/** Sub-abas por link (rotas reais), com aria-current. */
export function SectionTabs({ label, tabs }: { label: string; tabs: SectionTab[] }) {
  const { workspace } = useParams() as { workspace: string }
  const { pathname } = useLocation()
  const settings = useWorkspaceSettings()
  // Abas que o espaço escolheu ocultar (Configurações > Geral) somem; a rota continua abrindo pelo endereço.
  const hidden = new Set([settings?.hide_keywords_tab ? "automations/keywords" : "", settings?.hide_rules_tab ? "automations/rules" : ""])
  return (
    <nav aria-label={label} className="flex min-w-0 max-w-full flex-wrap gap-x-4 gap-y-1 border-b border-border sm:gap-x-6">
      {tabs.filter(t => !hidden.has(t.href) || pathname === `/${workspace}/${t.href}`).map((t) => {
        const full = `/${workspace}/${t.href}`
        const active = pathname === full
        return (
          <Link
            key={t.href}
            to={full}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px inline-flex h-10 shrink-0 items-center whitespace-nowrap border-b-2 text-sm font-semibold transition-colors focus-visible:-outline-offset-2",
              active ? "border-accent text-text" : "border-transparent text-text-muted hover:text-text"
            )}
          >
            {t.label}
          </Link>
        )
      })}
    </nav>
  )
}

export const automationTabs: SectionTab[] = [
  { href: "automations", label: "Minhas automações", icon: Workflow },
  { href: "automations/basic", label: "Básico", icon: MessageSquare },
  { href: "automations/sequences", label: "Sequências", icon: ListOrdered },
  { href: "automations/keywords", label: "Palavras-chave", icon: KeyRound },
  { href: "automations/rules", label: "Regras", icon: ListChecks },
  { href: "automations/triggers", label: "Gatilhos", icon: Zap },
]

/**
 * Submenu de Automação: coluna à esquerda no desktop, faixa de uma linha que rola na horizontal no celular.
 * Mesmas regras das abas: seções que o espaço escondeu somem, exceto a aberta.
 */
export function AutomationNav() {
  const { workspace } = useParams() as { workspace: string }
  const { pathname } = useLocation()
  const settings = useWorkspaceSettings()
  const hidden = new Set([settings?.hide_keywords_tab ? "automations/keywords" : "", settings?.hide_rules_tab ? "automations/rules" : ""])
  const strip = React.useRef<HTMLElement>(null)
  // No celular a faixa rola na horizontal sem barra: uma sombra com seta nas pontas avisa que há mais abas.
  const [more, setMore] = React.useState({ left: false, right: false })
  const measure = React.useCallback(() => {
    const el = strip.current
    if (!el) return
    const left = el.scrollLeft > 4, right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4
    setMore(previous => previous.left === left && previous.right === right ? previous : { left, right })
  }, [])
  React.useEffect(() => {
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [measure, pathname, settings?.hide_keywords_tab, settings?.hide_rules_tab])
  React.useEffect(() => { strip.current?.querySelector("[aria-current=page]")?.scrollIntoView({ block: "nearest", inline: "center" }); measure() }, [pathname, measure])
  return (
    <div className="relative min-w-0 lg:contents">
      <nav
        ref={strip}
        onScroll={measure}
        aria-label="Seções de automação"
        className="flex max-w-full flex-nowrap gap-1 overflow-x-auto overscroll-x-contain border-b border-border [scrollbar-width:none] lg:flex-col lg:overflow-visible lg:border-b-0 [&::-webkit-scrollbar]:hidden"
      >
        {automationTabs.filter(t => !hidden.has(t.href) || pathname === `/${workspace}/${t.href}`).map(t => {
          const full = `/${workspace}/${t.href}`
          const active = pathname === full
          return (
            <Link
              key={t.href}
              to={full}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap px-3 text-sm font-semibold transition-colors focus-visible:-outline-offset-2 lg:rounded-md",
                active ? "bg-border/40 text-text" : "text-text-muted hover:bg-border/20 hover:text-text"
              )}
            >
              {t.icon ? <t.icon className="size-4 shrink-0" aria-hidden="true" /> : null}
              {t.label}
            </Link>
          )
        })}
      </nav>
      {more.left ? <span data-testid="submenu-mais-esquerda" aria-hidden="true" className="pointer-events-none absolute top-0 left-0 grid h-10 w-9 place-items-center bg-gradient-to-r from-bg from-40% to-transparent text-text-muted lg:hidden"><ChevronLeft className="size-4" /></span> : null}
      {more.right ? <span data-testid="submenu-mais-direita" aria-hidden="true" className="pointer-events-none absolute top-0 right-0 grid h-10 w-9 place-items-center bg-gradient-to-l from-bg from-40% to-transparent text-text-muted lg:hidden"><ChevronRight className="size-4" /></span> : null}
    </div>
  )
}

/** Moldura das telas de Automação: título na barra do topo, submenu e a seção aberta ao lado. */
export function AutomationSection() {
  const { pathname } = useLocation()
  // Nestas seções o original deixa uma coluna de ~1070px afastada do submenu; só Gatilhos segue a largura do shell.
  const coluna = /\/automations(\/(basic|sequences|keywords|rules))?$/.test(pathname)
  return (
    <>
      <PageHeader title="Automação" />
      <div className="grid min-w-0 gap-4 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-8">
        <AutomationNav />
        <div className={cn("min-w-0", coluna && "xl:ml-56 xl:max-w-[67rem]")}><Outlet /></div>
      </div>
    </>
  )
}
