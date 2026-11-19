import { Link, useLocation, useParams } from "react-router"
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { apiRequest, getWorkspace, isFakeMode } from "@/data/api"
import { toast } from "sonner"
import { Bell, ChevronRight, LogOut } from "lucide-react"
import { cn } from "@/lib/utils"
import { automationAreas, mainNav, segmentLabels } from "@/lib/nav"
import { useCan, useRole } from "@/hooks/use-role"
import { roleCan, type Action } from "../../../../shared/permissions"
import { PageHeaderContext } from "./page-header"
import { authRequest, resetWorkspaceContext } from "@/data/auth"
import { useAsync } from "@/hooks/use-async"
import { AvatarInitials } from "@/components/ui/avatar-initials"
import { prefetchPages } from "@/lib/prefetch"
import { primeFrequentScreens, primeScreen } from "@/lib/prefetch-data"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

function Sidebar({ workspace }: { workspace: string }) {
  const { pathname } = useLocation()
  const seesAutomations = useCan("automation:read")
  const items = seesAutomations ? mainNav : mainNav.filter(item => !automationAreas.includes(item.href))
  const role = useRole()
  const current = pathname.split("/")[2]
  const can = useCallback((action: Action) => roleCan(role, action), [role])
  // Uma vez por carga (o caminho de agora só decide qual tela não precisa).
  const firstScreen = useRef(current)
  useEffect(() => { primeFrequentScreens(workspace, can, firstScreen.current) }, [workspace, can])
  // Mouse em cima, foco do teclado ou toque no celular: o dado da tela começa a vir antes do clique.
  const prime = (href: string) => { if (href !== current) primeScreen(href, workspace, can) }
  return (
    <nav
      aria-label="Principal"
      className="fixed inset-y-0 left-0 z-30 flex w-(--sidebar) flex-col items-center gap-2 border-r border-border bg-surface py-4"
    >
      <Link
        to={`/${workspace}/${seesAutomations ? "dashboard" : "inbox"}`}
        aria-label="Página inicial"
        className="mb-2 grid size-9 place-items-center rounded-md"
      >
        <img src="/logo.svg" alt="" className="size-9" />
      </Link>
      {items.map(({ href, label, icon: Icon }) => {
        const full = `/${workspace}/${href}`
        const active = pathname === full || pathname.startsWith(`${full}/`)
        return (
          <Link
            key={href}
            to={full}
            aria-current={active ? "page" : undefined}
            aria-label={label}
            title={label}
            onMouseEnter={() => prime(href)}
            onFocus={() => prime(href)}
            onPointerDown={() => prime(href)}
            className={cn(
              "group relative grid size-10 place-items-center rounded-md transition-colors duration-(--duration-fast)",
              active ? "bg-border/40 text-text" : "text-text-muted hover:bg-border/30 hover:text-text"
            )}
          >
            <Icon className="size-5" aria-hidden="true" />
            <span
              role="presentation"
              className="pointer-events-none absolute left-full ml-2 hidden whitespace-nowrap rounded-sm bg-text px-2 py-1 text-xs text-surface shadow-pop group-hover:block group-focus-visible:block"
            >
              {label}
            </span>
          </Link>
        )
      })}
    </nav>
  )
}

function Breadcrumb({ workspace }: { workspace: string }) {
  const { pathname } = useLocation()
  const parts = pathname.split("/").filter(Boolean).slice(1)
  const crumbs = parts.map((seg, i) => ({
    label: parts[0] === "contacts" && seg === "segments" ? "Segmentos" : parts[i - 1] === "segments" ? "Segmento" : segmentLabels[seg] ?? (parts[i - 1] === "automations" ? "Editor" : parts[i - 1] === "inbox" ? "Conversa" : `#${seg.slice(0, 8)}`),
    href: `/${workspace}/${parts.slice(0, i + 1).join("/")}`,
  }))
  // Insights fica sob o Início ("Início › Insights"), como no original.
  if (parts[0] === "insights") crumbs.unshift({ label: "Início", href: `/${workspace}/dashboard` })
  return (
    <nav aria-label="Você está em" className="min-w-0">
      <ol className="flex items-center gap-1 text-sm">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1
          return (
            <Fragment key={c.href}>
              <li className="min-w-0 truncate">
                {last ? (
                  <span aria-current="page" className="font-semibold text-text">
                    {c.label}
                  </span>
                ) : (
                  <Link to={c.href} className="text-text-muted hover:text-text">
                    {c.label}
                  </Link>
                )}
              </li>
              {last ? null : <ChevronRight className="size-4 shrink-0 text-text-muted" aria-hidden="true" />}
            </Fragment>
          )
        })}
      </ol>
    </nav>
  )
}

/** Leitor e atendente não editam: o aviso fica no topo para não descobrirem só no erro ao salvar. */
function RoleBadge() {
  const role = useRole()
  if (role !== "viewer" && role !== "livechat_agent") return null
  return (
    <span role="note" className="ml-auto shrink-0 rounded-pill border border-border px-3 py-1 text-xs text-text-muted">
      {role === "viewer" ? "Acesso só de leitura" : "Acesso de atendimento"}
    </span>
  )
}

export function AppShell({ children }: { children: React.ReactNode }) {
  useEffect(() => { prefetchPages() }, [])
  // Volta do login do Instagram: avisa o resultado uma vez e limpa o endereço.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search), result = params.get("conexao")
    if (!result) return
    if (result === "conectada") toast.success("Conta conectada.")
    else toast.error(params.get("motivo") || "Não foi possível conectar a conta.")
    window.history.replaceState(null, "", window.location.pathname)
  }, [])
  const { workspace } = useParams() as { workspace: string }
  const { pathname } = useLocation()
  // Editor de fluxo e caixa de entrada usam a largura toda; as outras telas mantêm a coluna de leitura.
  const inSettings = /\/settings(?:\/|$)/.test(pathname)
  const fullWidth = /\/broadcasts(?:\/|$)|\/automations\/(?!keywords$|sequences$|rules$|email-rules$|basic$|triggers$)[^/]+$|\/inbox(?:\/[^/]+)?$/.test(pathname) && !inSettings
  // O editor de fluxo tem a própria barra no topo (caminho, nome, situação e ações) e ocupa a tela de ponta a ponta (no celular continua a lista de passos, com o cabeçalho comum).
  const inbox = /\/inbox(?:\/[^/]+)?$/.test(pathname) && !inSettings
  const editor = /\/automations\/(?!keywords$|sequences$|rules$|email-rules$|basic$|triggers$)[^/]+$/.test(pathname)
  // Configurações: menu à esquerda e conteúdo até a borda direita, como no original (o editor de e-mail mantém a coluna de leitura).
  const settings = inSettings && !/\/settings\/email\/design$/.test(pathname)
  // Seções de Automação (Minhas automações, Básico, Sequências, Palavras-chave, Regras): submenu logo ao lado do menu principal, como no original.
  const secaoAutomacao = /\/automations\/?$|\/automations\/(basic|sequences|keywords|rules)(\/[^/]+)?$/.test(pathname)
  // Contatos: lateral e tabela até as bordas, como no original.
  const contacts = /\/contacts(?:\/segments\/[^/]+)?$/.test(pathname) && !inSettings
  const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null)
  const [claims, setClaims] = useState(0)
  const slot = useMemo(() => ({ target: headerTarget, claim: () => { setClaims(n => n + 1); return () => setClaims(n => n - 1) } }), [headerTarget])
  return (
    <PageHeaderContext.Provider value={slot}>
    <div className="min-h-screen bg-bg">
      <a
        href="#conteudo"
        className="sr-only z-50 rounded-md bg-surface px-4 py-2 font-semibold text-text shadow-pop focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Ir para o conteúdo
      </a>
      <Sidebar workspace={workspace} />
      <div className="pl-(--sidebar)">
        <header className={cn("sticky top-0 z-20 flex h-(--header) items-center gap-3 border-b border-border bg-surface px-6", editor && "md:hidden")}>
          {claims === 0 && <Breadcrumb workspace={workspace} />}
          <div ref={setHeaderTarget} className="flex min-w-0 flex-1 items-center gap-3" />
          <RoleBadge />
          <WorkspaceSwitcher current={workspace} />
          <NoticeBell workspace={workspace} />
          <AccountMenu />
        </header>
        <RestrictionBanner />
        <main id="conteudo" tabIndex={-1} className={cn("w-full outline-none", editor ? "p-3 md:p-0" : inbox ? "p-0" : fullWidth ? "p-3" : contacts ? "px-4 py-6 md:px-10 md:pt-10" : settings || secaoAutomacao ? "px-4 py-6 md:px-10 md:pt-8" : "mx-auto max-w-(--content-max) p-6")}>
          {children}
        </main>
      </div>
    </div>
    </PageHeaderContext.Provider>
  )
}

/** Menu da conta (avatar e nome): sair da sessão, para todo papel. "Encerrar todas as sessões" continua em Membros da equipe. */
function AccountMenu() {
  const name = useAsync(() => getWorkspace(), "shell-conta").data?.user_name?.trim() || "Minha conta"
  const [leaving, setLeaving] = useState(false)
  async function signOut() {
    setLeaving(true)
    try { await authRequest("sign-out", {}); resetWorkspaceContext(); noticeCache = null; window.location.assign("/login") }
    catch { toast.error("Não foi possível sair. Tente de novo."); setLeaving(false) }
  }
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button type="button" aria-label={`Menu da conta: ${name}`} className="flex h-9 shrink-0 items-center gap-2 rounded-md px-1 hover:bg-surface-muted md:pr-2">
        <AvatarInitials name={name} className="size-7 text-2xs" />
        <span className="hidden max-w-32 truncate text-sm md:inline">{name}</span>
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent>
      <DropdownMenuLabel>{name}</DropdownMenuLabel>
      <DropdownMenuItem disabled={leaving} onSelect={event => { event.preventDefault(); void signOut() }}><LogOut className="size-4" aria-hidden="true" />Sair</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
}

/** Seletor de conta: aparece quando o usuário participa de mais de um espaço; trocar recarrega o painel no espaço escolhido. */
function WorkspaceSwitcher({ current }: { current: string }) {
  const [items, setItems] = useState<{ id: string; name: string }[]>([])
  useEffect(() => { if (!isFakeMode()) apiRequest<{ items: { id: string; name: string }[] }>("/workspaces/mine").then(r => setItems(r.items)).catch(() => {}) }, [])
  if (items.length < 2) return null
  return <select aria-label="Trocar de conta" className="ml-auto h-9 max-w-48 truncate rounded-md border border-border-input bg-surface px-2 text-sm" value={current}
    onChange={async e => { const id = e.target.value; try { await apiRequest("/workspaces/switch", { method: "POST", body: JSON.stringify({ workspace_id: id }) }); window.location.assign(`/${id}`) } catch { toast.error("Não foi possível trocar de conta.") } }}>
    {items.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
  </select>
}

type Notices = { items: { id: number; kind: string; message: string; created_at: number; read_at: number | null }[]; unread: number; restriction: string | null }
let noticeCache: Promise<Notices> | null = null
const loadNotices = () => (noticeCache ??= isFakeMode() ? Promise.resolve({ items: [], unread: 0, restriction: null }) : apiRequest<Notices>("/notices").catch(() => ({ items: [], unread: 0, restriction: null })))

/** Sininho de avisos da conta: conexão que caiu, restrição. Abrir marca como lidos. */
function NoticeBell({ workspace }: { workspace: string }) {
  const [data, setData] = useState<Notices | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => { noticeCache = null; loadNotices().then(setData) }, [workspace])
  return <div className="relative">
    <button type="button" aria-label={`Avisos${data?.unread ? `: ${data.unread} novos` : ""}`} className="relative grid size-9 place-items-center rounded-md hover:bg-surface-muted"
      onClick={() => { setOpen(o => !o); if (data?.unread) { void apiRequest("/notices/read", { method: "POST", body: "{}" }).catch(() => {}); setData({ ...data, unread: 0 }) } }}>
      <Bell className="size-5" aria-hidden="true" />{data?.unread ? <span className="absolute top-1 right-1 size-2 rounded-full bg-danger" /> : null}
    </button>
    {open ? <div role="dialog" aria-label="Avisos" className="absolute right-0 z-30 mt-2 w-80 rounded-lg border border-border bg-surface p-3 shadow-pop">
      {data?.items.length ? <ul className="max-h-80 space-y-2 overflow-y-auto text-sm">{data.items.map(n => <li key={n.id} className="border-b border-border pb-2 last:border-0"><p>{n.message}</p><p className="text-xs text-text-muted">{new Date(n.created_at).toLocaleString("pt-BR")}</p></li>)}</ul>
        : <p className="text-sm text-text-muted">Nenhum aviso.</p>}
      <Link to={`/${workspace}/settings/notices`} className="mt-2 block text-xs text-accent hover:underline" onClick={() => setOpen(false)}>Preferências de aviso</Link>
    </div> : null}
  </div>
}
/** Conta restrita pela operação da plataforma: aviso fixo no topo com o motivo. */
function RestrictionBanner() {
  const [reason, setReason] = useState<string | null>(null)
  useEffect(() => { loadNotices().then(n => setReason(n.restriction)) }, [])
  return reason ? <div role="alert" className="border-b border-border bg-danger-soft px-6 py-2 text-sm text-danger">Sua conta está restrita: {reason}. Envios podem estar bloqueados.</div> : null
}
