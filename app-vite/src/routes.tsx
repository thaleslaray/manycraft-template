import type * as React from "react"
import { createBrowserRouter, Link, Navigate, Outlet, isRouteErrorResponse, redirect, useLoaderData, useParams, useRouteError } from "react-router"
import { AppShell } from "@/components/shell/app-shell"
import { AutomationSection } from "@/components/shell/section-tabs"
import { Button } from "@/components/ui/button"
import { ApiError, getWorkspace, type DevWorkspace } from "@/data/api"
import { RoleContext, useCan } from "@/hooks/use-role"
import { authRequest, type Session } from "@/data/auth"
import { destinoDepoisDoLogin } from "@/data/conector"

// Substitui app/[workspace]/layout.tsx (Suspense + generateStaticParams não existem aqui).
function WorkspaceLayout() {
  const workspace = useLoaderData() as DevWorkspace
  return (
    <RoleContext.Provider value={workspace.role ?? "owner"}>
      <AppShell>
        <Outlet />
      </AppShell>
    </RoleContext.Provider>
  )
}

/** Leitor vê a tela inteira com os controles desligados: o motor recusaria qualquer alteração dele. Links seguem funcionando. */
function ReadOnlyForViewer({ children }: { children: React.ReactNode }) {
  const canEdit = useCan("edit")
  if (canEdit) return <>{children}</>
  return (
    <fieldset disabled className="min-w-0 space-y-4">
      <p role="note" className="text-sm text-text-muted">Seu papel permite ver esta tela, não alterar.</p>
      {children}
    </fieldset>
  )
}
function readOnlyForViewer<P extends object>(Component: React.ComponentType<P>) {
  return function ReadOnlyPage(props: P) { return <ReadOnlyForViewer><Component {...props} /></ReadOnlyForViewer> }
}

/** Atendente começa na caixa de entrada: o início resume automações, que o motor não mostra a ele. */
function WorkspaceHome() {
  return <Navigate to={useCan("automation:read") ? "dashboard" : "inbox"} replace />
}

/** Atendente não vê automações nem o que depende delas (início, transmissões, insights): o motor recusa a leitura, então a tela nem tenta. */
function RequireAutomationAccess() {
  const allowed = useCan("automation:read")
  const { workspace } = useParams()
  if (allowed) return <Outlet />
  return (
    <main className="mx-auto max-w-md space-y-3 py-10">
      <h1 className="text-xl font-bold">Sem acesso a esta área</h1>
      <p className="text-text-muted">Seu papel neste espaço é de atendimento: você trabalha pela caixa de entrada. Peça a um administrador se precisar ver esta parte.</p>
      <Link to={`/${workspace}/inbox`} className="font-semibold underline underline-offset-2">Ir para a caixa de entrada</Link>
    </main>
  )
}

/** Depois de uma publicação, uma aba aberta pede telas pelo nome antigo do arquivo: recarrega uma vez e pega a versão nova. */
const staleChunk = /dynamically imported module|Importing a module script failed|error loading dynamically imported/i
function WorkspaceError() {
  const error = useRouteError()
  if (error instanceof Error && staleChunk.test(error.message)) {
    let reloaded = false
    try { reloaded = Date.now() - Number(sessionStorage.getItem("chunk-reload") ?? 0) < 10_000; sessionStorage.setItem("chunk-reload", String(Date.now())) } catch { /* sem armazenamento: recarrega uma vez mesmo assim */ }
    if (!reloaded) { window.location.reload(); return null }
  }
  // Endereço que não existe no painel: dizer isso e oferecer o caminho de volta, em vez do erro genérico.
  if (isRouteErrorResponse(error) && error.status === 404)
    return <main className="mx-auto max-w-md space-y-4 p-6"><h1 className="text-xl font-bold">Página não encontrada</h1><p>Este endereço não existe no painel. Confira o link ou volte para o início.</p><Button asChild><Link to="/">Ir para o início</Link></Button></main>
  return <main className="mx-auto max-w-md space-y-4 p-6"><h1 className="text-xl font-bold">Não foi possível abrir o espaço</h1><p>Algo deu errado ao carregar esta página. Tente de novo em instantes; se continuar, peça ajuda a quem administra o espaço.</p><Button onClick={() => window.location.reload()}>Tentar de novo</Button></main>
}

async function workspaceLoader({ request, params }: { request: Request; params: { workspace?: string } }) {
  let workspace
  try { workspace = await getWorkspace() }
  catch (error) { if (error instanceof ApiError && error.status === 401) return redirect('/login'); throw error }
  if (params.workspace !== workspace.workspace_id) {
    const url = new URL(request.url)
    // Sem caminho, cai no índice do espaço: WorkspaceHome escolhe Início ou caixa de entrada pelo papel.
    const suffix = params.workspace ? url.pathname.split("/").slice(2).join("/") : ""
    return redirect(`/${encodeURIComponent(workspace.workspace_id)}/${suffix}${url.search}`)
  }
  return workspace
}

/** Telas fora da primeira pintura viram chunks próprios: o `lazy` do roteador baixa o arquivo antes de trocar de tela. */
const page = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  async () => ({ Component: (await load())[name] })
const settingsPage = page(() => import("@/components/settings/settings-page"), "SettingsPage")

const antigasTelasDeEntrada = ["/signup", "/verify-email", "/forgot-password", "/reset-password", "/magic-link"]

export const router = createBrowserRouter([
  { path: "/invite", lazy: page(() => import("@/components/auth/invite-page"), "InvitePage"), errorElement: <WorkspaceError /> },
  { path: "/", loader: workspaceLoader, errorElement: <WorkspaceError /> },
  // Conectar um aplicativo (Claude) pelo login: a tela de consentimento confere o login por conta própria e guarda o pedido.
  { path: "/conectar", lazy: page(() => import("@/components/auth/connect-page"), "ConnectPage"), errorElement: <WorkspaceError /> },
  { path: "/pedir-acesso/:workspaceId", lazy: async () => ({ Component: (await import("@/components/auth/request-access-page")).RequestAccessPage }) },
  { path: "/automacao-compartilhada/:token", lazy: async () => ({ Component: (await import("@/components/automations/shared-automation-page")).SharedAutomationPage }) },
  { path: "/login", lazy: page(() => import("@/components/auth/auth-page"), "AuthPage"), loader: async () => {
    const session = await authRequest<Session>('get-session').catch(() => null)
    return session?.user.emailVerified ? redirect(destinoDepoisDoLogin()) : null
  }, errorElement: <WorkspaceError /> },
  // Telas antigas de senha, confirmação por link e link mágico: a entrada agora é só por código. O destino de volta
  // (convite, /conectar) fica guardado na sessão do navegador, então o /login leva a pessoa ao mesmo lugar.
  ...antigasTelasDeEntrada.map(path => ({ path, loader: () => redirect("/login") })),
  // Galeria de primitivos é ferramenta de desenvolvimento (jornada pecas-comuns roda no `vite`): fora do build de produção, nem o chunk vai junto.
  ...(import.meta.env.DEV ? [{ path: "/design", lazy: async () => {
    const { DesignGallery } = await import("./routes/design-gallery")
    return { Component: () => <><title>Primitivos</title><DesignGallery /></> }
  } }] : []),
  {
    path: "/:workspace",
    loader: workspaceLoader,
    errorElement: <WorkspaceError />,
    element: <WorkspaceLayout />,
    children: [
      { index: true, element: <WorkspaceHome /> },
      { path: "contacts/segments", lazy: async () => ({ Component: readOnlyForViewer((await import("@/components/contacts/segments-page")).SegmentsPage) }) },
      { path: "contacts/segments/:segmentId", lazy: async () => ({ Component: readOnlyForViewer((await import("@/components/contacts/segments-page")).SegmentContactsPage) }) },
      { path: "contacts", lazy: async () => {
        const { ContactsView } = await import("@/components/contacts/contacts-view")
        return { Component: () => <div className="space-y-6"><ContactsView /></div> }
      } },
      { path: "contacts/:contactId/email", lazy: async () => ({ Component: (await import("@/components/email/email-contact-page")).EmailContactPage }) },
      { element: <RequireAutomationAccess />, children: [
        { path: "dashboard", lazy: async () => ({ Component: (await import("@/components/dashboard/dashboard-page")).DashboardPage }) },
        { element: <AutomationSection />, children: [
        { path: "automations", lazy: async () => {
          const { AutomationsList } = await import("@/components/automations/automations-list")
          return { Component: () => <div className="space-y-6"><AutomationsList /></div> }
        } },
        { path: "automations/basic", lazy: async () => ({ Component: readOnlyForViewer((await import("@/components/automations/basic-page")).BasicPage) }) },
        { path: "automations/triggers/:triggerId", lazy: async () => ({ Component: (await import("@/components/triggers/trigger-page")).TriggerPage }) },
        { path: "automations/triggers", lazy: async () => ({ Component: (await import("@/components/triggers/triggers-page")).TriggersPage }) },
        { path: "automations/keywords", lazy: async () => ({ Component: readOnlyForViewer((await import("@/components/keywords/keywords-page")).KeywordsPage) }) },
        { path: "automations/sequences", lazy: async () => ({ Component: readOnlyForViewer((await import("@/components/sequences/sequences-page")).SequencesPage) }) },
        { path: "automations/rules", lazy: async () => ({ Component: readOnlyForViewer((await import("@/components/rules/rules-page")).RulesPage) }) },
        { path: "automations/email-rules", lazy: async () => ({ Component: readOnlyForViewer((await import("@/components/email/email-rules-page")).EmailRulesPage) }) },
        ] },
        { path: "automations/sequences/:sequenceId", lazy: async () => ({ Component: readOnlyForViewer((await import("@/components/sequences/sequence-edit-page")).SequenceEditPage) }) },
        { path: "automations/:id", lazy: page(() => import("@/components/editor/flow-editor"), "AutomationEditor") },
        { path: "broadcasts", lazy: async () => ({ Component: readOnlyForViewer((await import("@/components/broadcasts/broadcasts-page")).BroadcastsPage) }) },
        { path: "broadcasts/new", lazy: async () => ({ Component: readOnlyForViewer((await import("@/components/broadcasts/broadcast-editor-page")).BroadcastEditorPage) }) },
        { path: "broadcasts/:id/report", lazy: async () => ({ Component: readOnlyForViewer((await import("@/components/broadcasts/broadcast-report-page")).BroadcastReportPage) }) },
        { path: "broadcasts/:id", lazy: async () => ({ Component: readOnlyForViewer((await import("@/components/broadcasts/broadcast-editor-page")).BroadcastEditorPage) }) },
        { path: "insights", lazy: page(() => import("@/components/insights/insights-page"), "InsightsPage") },
      ] },
      { path: "inbox/:conversationId?", lazy: page(() => import("@/components/inbox/inbox-page"), "InboxPage") },
      { path: "agency", lazy: async () => ({ Component: (await import("@/components/settings/agency-page")).AgencyPage }) },
      { path: "settings", lazy: settingsPage },
      { path: "settings/message-templates", lazy: settingsPage },
      { path: "settings/channels", lazy: settingsPage },
      { path: "settings/channels/:kind", lazy: settingsPage },
      { path: "settings/assignment", lazy: settingsPage },
      { path: "settings/fields/bot", lazy: settingsPage },
      { path: "settings/team/groups", lazy: settingsPage },
      { path: "settings/logs/activity", lazy: settingsPage },
      { path: "settings/email", lazy: settingsPage },
      { path: "settings/email/design", lazy: async () => ({ Component: readOnlyForViewer((await import("@/components/email/email-design-page")).EmailDesignPage) }) },
      { path: "settings/fields", lazy: settingsPage },
      { path: "settings/tags", lazy: settingsPage },
      { path: "settings/inbox", lazy: settingsPage },
      { path: "settings/team", lazy: settingsPage },
      { path: "settings/logs", lazy: settingsPage },
      { path: "settings/integrations", lazy: settingsPage },
      { path: "settings/api", lazy: settingsPage },
      { path: "settings/installed", lazy: settingsPage },
      { path: "settings/compliance", lazy: settingsPage },
      { path: "settings/topics", lazy: settingsPage },
      { path: "settings/apps", lazy: settingsPage },
      { path: "settings/notices", lazy: settingsPage },
    ],
  },
])
