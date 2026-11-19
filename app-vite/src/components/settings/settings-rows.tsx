import * as React from "react"
import { NavLink } from "react-router"
import { cn } from "@/lib/utils"

/** Cartão único dividido em linhas: rótulo | controle | ajuda em cinza (empilha no celular). */
export function SettingsRows({ children, className = "", label }: { children: React.ReactNode; className?: string; label?: string }) {
  return <div role={label ? "group" : undefined} aria-label={label} className={`overflow-hidden rounded-lg border border-border bg-surface ${className}`}><div className="-mb-px">{children}</div></div>
}

/** Linha de configuração (padrão do original): rótulo em negrito, controle à esquerda logo abaixo e ajuda em cinza à direita; no celular empilha. Reuse em toda seção de Configurações. */
export function SettingsRow({ label, htmlFor, help, danger, children, className }: { danger?: boolean; label: React.ReactNode; htmlFor?: string; help?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  const title = `font-semibold ${danger ? "text-danger" : ""}`
  return (
    <div className={cn("grid gap-2 border-b border-border px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,0.73fr)_minmax(0,1fr)_minmax(0,1.27fr)] lg:gap-8", className)}>
      {htmlFor ? <label htmlFor={htmlFor} className={title}>{label}</label> : <div className={title}>{label}</div>}
      <div className="min-w-0">{children}</div>
      {help ? <div className="min-w-0 text-sm text-text-muted">{help}</div> : <span />}
    </div>
  )
}

/** Cartão com título e ação à direita, usado nas listas (Equipe, Campos, Tags). */
export function SettingsCard({ title, action, children, className }: { title?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <section className={cn("rounded-lg border border-border bg-surface", className)}>
    {title || action ? <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-6"><h2 className="text-lg font-semibold">{title}</h2>{action}</header> : null}
    {children}
  </section>
}

/** Abas por link (rotas reais) no alto da seção, com linha fina embaixo. */
export function SettingsTabs({ label, tabs, trailing, inline }: { label: string; tabs: { to: string; label: string; end?: boolean }[]; trailing?: React.ReactNode; inline?: boolean }) {
  return <div className={cn("flex flex-wrap items-end justify-between gap-3", inline ? "" : "mb-4 border-b border-border")}>
    <nav aria-label={label} className="flex gap-6">
      {tabs.map(tab => <NavLink key={tab.to} to={tab.to} end={tab.end ?? true}
        className={({ isActive }) => cn("-mb-px inline-flex h-10 items-center border-b-2 text-sm font-semibold transition-colors focus-visible:-outline-offset-2", isActive ? "border-accent text-text" : "border-transparent text-text-muted hover:text-text")}>{tab.label}</NavLink>)}
    </nav>
    {trailing ? <div className="pb-2">{trailing}</div> : null}
  </div>
}

/** Cartão de perfil no topo de uma seção de canal: foto ou inicial, nome em destaque e, opcionalmente, dados em colunas (rótulo pequeno sobre valor). */
export function SettingsProfileCard({ avatar, title, subtitle, fields, aside, label }: { avatar: React.ReactNode; title: React.ReactNode; subtitle?: React.ReactNode; fields?: { label: string; value: React.ReactNode }[]; aside?: React.ReactNode; label: string }) {
  return <section aria-label={label} className="rounded-lg border border-border bg-surface px-4 py-5 sm:px-6">
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <div className="shrink-0">{avatar}</div>
      <div className="min-w-0 flex-1"><h3 className="break-words text-xl font-semibold">{title}</h3>{subtitle ? <p className="mt-1 min-w-0 [overflow-wrap:anywhere] text-sm text-text-muted">{subtitle}</p> : null}</div>
      {aside ? <div className="shrink-0">{aside}</div> : null}
    </div>
    {fields?.length ? <dl className="mt-4 grid gap-x-6 gap-y-4 border-t border-border pt-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
      {fields.map(field => <div key={field.label} className="min-w-0"><dt className="text-xs text-text-muted">{field.label}</dt><dd className="mt-1 min-w-0 [overflow-wrap:anywhere]">{field.value}</dd></div>)}
    </dl> : null}
  </section>
}
