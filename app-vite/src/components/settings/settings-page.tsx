import { TeamSettingsPanel } from "./team-settings"
import { LogsSettings } from "./logs-settings"
import { InstalledTemplates } from "./installed-templates"
import { ComplianceSettings } from "./compliance-settings"
import { NotificationTopics } from "./notification-topics"
import { AppsSettings } from "./apps-settings"
import { NotificationsSettings } from "./member-alerts"
import { IntegrationsSettings } from "./integrations-settings"
import { InboxSettingsPanel } from "./inbox-settings"
import { InboxAssignmentSettings } from "./inbox-assignment"
import * as React from "react"
import { Navigate, useLocation, useParams } from "react-router"
import { toast } from "sonner"
import { getSettings, type SettingsSection } from "@/data"
import { useAsync } from "@/hooks/use-async"
import { Button } from "@/components/ui/button"
import { PageHeader } from "@/components/shell/page-header"
import { SettingsTabs } from "./settings-rows"
import { GeneralSettings } from "./general-settings"
import { useCan, useRole } from "@/hooks/use-role"
import { SettingsNav, ChannelIcon, activeSettings, unknownChannelRedirect, type SettingsId } from "./settings-nav"
import { settingsVisibleTo } from "./settings-sections"
import { settingsKeys, settingsParts } from "@/data/screen-keys"
import { Banner } from "@/components/ui/banner"
import { Skeleton } from "@/components/ui/skeleton"
import { MessageTemplatesPanel } from "./message-templates-panel"
import { EmailSettingsPanel } from "@/components/email/email-settings"
import { ConnectionsPanel } from "./connections-panel"
import { ItemsPanel, type Action } from "./items-panel"
import { ApiPanel } from "./api-panel"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

/** Configurações: menu em grupos à esquerda e a seção aberta à direita; cada seção é uma rota. */
export function SettingsPage({ section }: { section?: SettingsSection }) {
  const { workspace = "demo" } = useParams()
  const { pathname } = useLocation()
  const active = section ? (section as SettingsId) : activeSettings(pathname)
  // Equipe e convites são do dono e do administrador; o motor recusa os demais.
  const seesTeam = useCan("team")
  const seesAutomations = useCan("automation:read")
  const role = useRole()
  // O menu só mostra o que o papel pode abrir; quem digita o endereço de uma seção bloqueada vê o aviso, não uma tela com erro 403.
  const visible = (id: SettingsId) => settingsVisibleTo(role, id)
  const canEdit = useCan("edit")
  const base = `/${workspace}/settings`
  const channelTabs = (items: { to: string; label: string }[]) => <SettingsTabs label="Seções do canal" tabs={items} />
  const whatsappTabs = channelTabs([{ to: `${base}/channels/whatsapp`, label: "Conta" }, { to: `${base}/message-templates`, label: "Modelos de mensagem" }])
  const emailTabs = <SettingsTabs inline label="Seções do canal" tabs={[{ to: `${base}/email`, label: "Canal" }, ...(seesAutomations ? [{ to: `${base}/topics`, label: "Tópicos de notificação" }] : [])]} />
  const frame = (channel: "whatsapp" | "email", name: string, tabs: React.ReactNode, body: React.ReactNode) => <div className="space-y-4">
    {channel === "email" ? <div className="flex flex-wrap items-end justify-between gap-3"><h2 className="flex items-center gap-3 text-2xl font-semibold"><ChannelIcon channel={channel} className="size-8" />{name}</h2>{tabs}</div>
      : <><h2 className="flex items-center gap-3 text-2xl font-semibold"><ChannelIcon channel={channel} className="size-8" />{name}</h2>{tabs}</>}
    {body}
  </div>
  let body: React.ReactNode
  if (active !== "channels" && !visible(active as SettingsId)) body = <p role="note" className="text-text-muted">Seu papel não dá acesso a esta seção. Peça ao dono ou a um administrador do espaço.</p>
  else if (active === "notices") body = <NotificationsSettings />
  else if (active === "team") body = seesTeam ? <TeamSettingsPanel tab={pathname.endsWith("/groups") ? "groups" : "members"} /> : <p role="note" className="text-text-muted">Só o dono e os administradores do espaço veem e convidam a equipe.</p>
  else {
    const editable = (node: React.ReactNode) => <fieldset disabled={!canEdit} className="min-w-0">{!canEdit && <p role="note" className="mb-4 text-sm text-text-muted">Seu papel permite ver as configurações, não alterar.</p>}{node}</fieldset>
    if (active === "integrations") body = editable(<IntegrationsSettings />)
    else if (active === "logs") body = editable(<LogsSettings tab={pathname.endsWith("/activity") ? "activity" : "general"} />)
    else if (active === "installed") body = editable(<InstalledTemplates />)
    else if (active === "compliance") body = editable(<ComplianceSettings />)
    else if (active === "apps") body = editable(<AppsSettings />)
    else if (active === "inbox") body = editable(<InboxSettingsPanel />)
    else if (active === "assignment") body = editable(<InboxAssignmentSettings />)
    else if (active === "email" && pathname.endsWith("/topics") && seesAutomations) body = editable(frame("email", "E-mail", emailTabs, <NotificationTopics />))
    else if (active === "email") body = editable(frame("email", "E-mail", emailTabs, <EmailSettingsPanel />))
    else if (active === "whatsapp" && pathname.endsWith("/message-templates")) body = editable(frame("whatsapp", "WhatsApp", whatsappTabs, <><h2 className="sr-only">Modelos de mensagem</h2><MessageTemplatesPanel /></>))
    else if (active === "whatsapp") body = editable(<ConnectionsPanel workspace={workspace} kind="whatsapp" tabs={whatsappTabs} />)
    else if (active === "instagram" || active === "telegram") body = editable(<ConnectionsPanel workspace={workspace} kind={active} />)
    else if (active === "channels") body = editable(<ConnectionsPanel workspace={workspace} />)
    else body = editable(<SettingsContent key={`${workspace}|${active}|${pathname.endsWith("/bot")}`} workspace={workspace} section={active as SettingsSection} bot={pathname.endsWith("/bot")} />)
  }
  const unknownChannel = unknownChannelRedirect(pathname)
  if (unknownChannel) return <Navigate to={unknownChannel} replace />
  return (
    <div className="space-y-6">
      <title>Configurações</title>
      <PageHeader title="Configurações" />
      <div className="flex min-w-0 flex-col gap-6 md:flex-row md:gap-10">
        <SettingsNav visible={visible} />
        <div className="min-w-0 flex-1 space-y-6">{body}</div>
      </div>
    </div>
  )
}

function SettingsContent({ workspace, section, bot }: { workspace: string; section: SettingsSection; bot: boolean }) {
  const tab = section === "general" || section === "fields" || section === "tags" ? section : "api"
  // API: o cache guarda só o final e a data da chave; o valor completo vive no estado do painel, uma vez.
  const data = useAsync(() => getSettings(workspace, settingsParts(tab)), `${workspace}|${section}`, { cache: settingsKeys[tab](workspace) })
  const [busy, setBusy] = React.useState(false)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [confirmation, setConfirmation] = React.useState<{ title: string; description: string; action: () => Promise<unknown> } | null>(null)
  const run: Action = async (task, success) => {
    setBusy(true)
    setActionError(null)
    try { await task(); if (success) toast.success(success); data.reload(); return true }
    catch (error) { const message = error instanceof Error ? error.message : "Não foi possível salvar a alteração."; setActionError(message); toast.error(message); return false }
    finally { setBusy(false) }
  }
  const snapshot = data.data ?? data.stale
  const confirm = (title: string, description: string, action: () => Promise<unknown>) => setConfirmation({ title, description, action })
  const label = { general: "Geral", fields: "Campos", tags: "Tags", api: "API" }[section as "general" | "fields" | "tags" | "api"] ?? "Configurações"
  const fieldTabs = [{ to: `/${workspace}/settings/fields`, label: "Campos do usuário" }, { to: `/${workspace}/settings/fields/bot`, label: "Campos do bot" }]
  return <section aria-label={label} className="space-y-4">
    <h2 className="sr-only">{label}</h2>
    {actionError && <Banner variant="danger">{actionError}</Banner>}
    {data.error ? <Banner variant="danger"><div className="flex flex-wrap items-center gap-3">Não foi possível carregar as configurações.<Button size="sm" variant="secondary" onClick={data.reload}>Tentar de novo</Button></div></Banner> : !snapshot ? <div role="status" aria-label="Carregando configurações" className="space-y-4"><Skeleton className="h-12" /><Skeleton className="h-48" /><Skeleton className="h-24" /></div> : <div aria-busy={busy}>
      {section === "general" && <GeneralSettings snapshot={snapshot} workspace={workspace} run={run} busy={busy} />}
      {section === "fields" && <ItemsPanel snapshot={snapshot} kind="fields" workspace={workspace} run={run} busy={busy} confirm={confirm} scope={bot ? "bot" : "contact"} scopeTabs={fieldTabs} />}
      {section === "tags" && <ItemsPanel snapshot={snapshot} kind="tags" workspace={workspace} run={run} busy={busy} confirm={confirm} />}
      {section === "api" && <ApiPanel snapshot={snapshot} workspace={workspace} run={run} busy={busy} confirm={confirm} />}
    </div>}
    {confirmation && <Dialog open onOpenChange={(open) => !open && setConfirmation(null)}><DialogContent><DialogHeader><DialogTitle>{confirmation.title}</DialogTitle><DialogDescription>{confirmation.description}</DialogDescription></DialogHeader><DialogFooter><Button variant="secondary" disabled={busy} onClick={() => setConfirmation(null)}>Voltar</Button><Button variant="danger" loading={busy} onClick={async () => { if (await run(confirmation.action, "Alteração concluída.")) setConfirmation(null) }}>Confirmar</Button></DialogFooter></DialogContent></Dialog>}
  </section>
}
