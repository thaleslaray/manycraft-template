import { SurfaceEditor, surfaceCap } from "./surface-editor"
import { BasicIllustration } from "./basic-illustration"
import * as React from "react"
import { Link, useNavigate, useParams } from "react-router"
import { ArrowRight, AtSign, BellOff, BellPlus, ChevronDown, ChevronUp, GitBranch, Hand, List, Mail, MessageCircle, MessageCircleQuestion, MessagesSquare, Pause, Play, Plus, Reply, Send, type LucideIcon } from "lucide-react"
import { toast } from "sonner"
import { createAutomation, getAutomation, listAutomations } from "@/data"
import { getBasicSettings, getSurface, saveBasicEntry, type BasicConnection, type BasicEntry, type BasicKind, type SurfaceKind } from "@/data/basic"
import { listConnections } from "@/data/connections"
import { cn } from "@/lib/utils"
import { useAsync } from "@/hooks/use-async"
import { apiRequest } from "@/data/api"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ChooseExisting } from "@/components/ui/choose-existing"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { RowMenu, RowMenuItem } from "@/components/ui/row-menu"
import { PanelFooterBar } from "@/components/ui/panel-footer-bar"
import { AutomationPicker, AutomationPreview, publishedTexts } from "./automation-picker"

export function StateBadge({ children }: { children: React.ReactNode }) {
  return <span className="w-fit rounded-pill bg-surface-muted px-2 py-0.5 text-xs font-normal text-text-muted">{children}</span>
}
const definitions = [
  { kind: "default_reply" as const, title: "Resposta padrão", action: "Configurar resposta padrão", description: "Responda quando a mensagem não encontrar uma automação ou palavra-chave." },
  { kind: "welcome_message" as const, title: "Mensagem de boas-vindas", action: "Configurar boas-vindas", description: "Receba o contato na primeira mensagem que ele enviar nesta conexão." },
  { kind: "system_opt_in" as const, title: "Confirmação de inscrição", action: "Configurar inscrição", description: "Confirme a inscrição nesta conexão quando o contato enviar voltar, começar, start ou subscribe. Essas palavras são fixas e não contam no limite de palavras-chave." },
  { kind: "system_opt_out" as const, title: "Confirmação de descadastro", action: "Configurar descadastro", description: "Confirme o descadastro desta conexão quando o contato enviar parar, sair, stop ou unsubscribe. Essas palavras são fixas e não contam no limite de palavras-chave." },
]

function BasicDialog({ connection, kind, entry, onClose, onSaved }: {
  connection: BasicConnection; kind: BasicKind; entry?: BasicEntry; onClose: () => void; onSaved: () => void
}) {
  const { workspace } = useParams() as { workspace: string }
  const navigate = useNavigate()
  const title = definitions.find(item => item.kind === kind)!.title
  const isSystemConfirmation = kind === "system_opt_in" || kind === "system_opt_out"
  const [automationId, setAutomationId] = React.useState(entry?.automation_id ?? "")
  const [enabled, setEnabled] = React.useState(entry?.enabled ?? true)
  const [repeatMode, setRepeatMode] = React.useState<BasicEntry["repeat_mode"]>(entry?.repeat_mode ?? "every_time")
  const [dmOnly, setDmOnly] = React.useState(entry?.dm_only ?? false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState("")
  const automations = useAsync(() => listAutomations(workspace), workspace)
  const preview = useAsync(() => automationId ? getAutomation(workspace, automationId) : Promise.resolve(null), automationId)
  const published = preview.data?.published_version
  const automationPaused = preview.data?.automation.status === "stopped"
  const messages = publishedTexts(published?.graph)

  async function save() {
    setError("")
    if (preview.loading) return
    if (!automationId) { setError("Escolha uma automação para continuar."); return }
    if (enabled && !published) { setError("Publique a automação antes de ativar esta configuração."); return }
    if (enabled && automationPaused) { setError("Esta automação está pausada. Retome-a na lista de automações antes de ativar esta configuração."); return }
    setSaving(true)
    try {
      await saveBasicEntry(connection.id, kind, { automation_id: automationId, enabled, repeat_mode: kind === "default_reply" ? repeatMode : "every_time", dm_only: kind === "default_reply" && connection.profile.inbound.storyReply && dmOnly })
      toast.success("Configuração salva")
      onSaved()
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar a configuração.") }
    finally { setSaving(false) }
  }

  async function create() {
    setSaving(true)
    setError("")
    try {
      const automation = await createAutomation(workspace, `${title} · ${connection.displayName}`)
      await saveBasicEntry(connection.id, kind, { automation_id: automation.id, enabled: false, repeat_mode: kind === "default_reply" ? repeatMode : "every_time", dm_only: kind === "default_reply" && connection.profile.inbound.storyReply && dmOnly })
      navigate(`/${workspace}/automations/${automation.id}`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível criar a automação."); setSaving(false) }
  }

  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose() }}>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 sm:max-w-2xl">
      <DialogHeader className="border-b border-border p-6"><DialogTitle>{title}</DialogTitle><DialogDescription>Escolha o conteúdo de {connection.displayName} e defina como ele será enviado.</DialogDescription></DialogHeader>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
        {isSystemConfirmation ? <p className="text-sm leading-6 text-text-muted">As palavras de sistema são fixas. Escolha ou edite a automação de confirmação; o contato muda de inscrição mesmo quando esta confirmação está desligada.</p> : null}
        <div className="space-y-2">
          <p className="text-sm font-semibold">Automação</p>
          <AutomationPicker workspace={workspace} automations={automations.data ?? undefined} value={automationId} valueName={entry?.automation_name} onChange={setAutomationId} clearLabel="Remover automação escolhida" disabled={saving} loadError={!!automations.error} reload={automations.reload} />
          <Button variant="link" onClick={create} disabled={saving}><Plus className="size-4" aria-hidden="true" />Criar nova automação</Button>
          {kind === "system_opt_out" ? <Button variant="link" disabled={saving} onClick={async () => {
            try { await apiRequest(`/basic/${encodeURIComponent(connection.id)}/system_opt_out/default`, { method: "POST", body: "{}" }); toast.success("Fluxo padrão de descadastro criado e ligado."); onSaved() }
            catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível criar o fluxo padrão.") }
          }}>Usar fluxo padrão (confirmação + botão Inscrever)</Button> : null}
          <p className="text-xs text-text-muted">Uma nova automação fica desligada até você publicar o conteúdo e voltar aqui para ativá-la.</p>
        </div>
        <section aria-label="Prévia da automação" className="rounded-lg border border-border bg-bg p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Prévia do conteúdo publicado</h3>
          {!automationId ? <p className="text-sm text-text-muted">Selecione uma automação para conferir a mensagem.</p> : preview.loading ? <Skeleton className="h-16 w-full" /> : preview.error ? <Banner variant="danger">Não foi possível carregar a prévia. <button className="underline" onClick={preview.reload}>Tentar novamente</button></Banner> : !published ? <p className="text-sm text-text-muted">Esta automação ainda não foi publicada. Abra o editor, publique e volte para ativá-la.</p> : messages.length ? <div className="space-y-2">{messages.map((message, index) => <p key={index} className="whitespace-pre-wrap break-words rounded-lg border border-border bg-surface p-3 text-sm">{message}</p>)}</div> : <p className="text-sm text-text-muted">O fluxo publicado não contém uma mensagem de texto para exibir nesta prévia.</p>}
          {automationId ? <Link to={`/${workspace}/automations/${automationId}`} className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-accent">Abrir no editor<ArrowRight className="size-4" aria-hidden="true" /></Link> : null}
        </section>
        {automationPaused ? <Banner variant="warning">Esta automação está pausada. Retome-a na lista de automações para ativar esta configuração.</Banner> : null}
        {kind === "default_reply" ? <div className="space-y-3">
          <div className="space-y-2"><p className="text-sm font-semibold">Frequência da resposta</p>
            <Select value={repeatMode} onValueChange={value => setRepeatMode(value as BasicEntry["repeat_mode"])} disabled={saving}><SelectTrigger aria-label="Frequência da resposta"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="every_time">Toda vez</SelectItem><SelectItem value="once_per_24_hours">Uma vez a cada 24 horas</SelectItem></SelectContent></Select></div>
          {connection.profile.inbound.storyReply ? <div className="flex items-start gap-2 text-sm"><Checkbox id="basic-dm-only" className="mt-0.5" checked={dmOnly} disabled={saving} onCheckedChange={checked => setDmOnly(checked === true)} /><label htmlFor="basic-dm-only">Somente mensagens diretas<span className="block text-xs text-text-muted">Não responder a respostas de story.</span></label></div> : null}
        </div> : null}
        {error ? <Banner variant="danger">{error}</Banner> : null}
      </div>
      <div className="border-t border-border p-4"><PanelFooterBar switchLabel={`Ativar ${title.toLocaleLowerCase("pt-BR")}`} checked={enabled} onCheckedChange={setEnabled} disabled={saving}><Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button><Button onClick={save} loading={saving} disabled={preview.loading || !automationId}>Salvar configuração</Button></PanelFooterBar></div>
    </DialogContent>
  </Dialog>
}

type ItemDef = { key: string; title: string; action: string; description: string; icon: LucideIcon; basic?: BasicKind; surface?: SurfaceKind }
const itemDefs: ItemDef[] = [
  { key: "conversation_starters", title: "Iniciadores de conversa", action: "Configurar iniciadores de conversa", description: "Ofereça perguntas para quem está começando uma conversa.", icon: MessageCircleQuestion, surface: "conversation_starters" },
  { key: "default_reply", title: "Resposta padrão", action: "Configurar resposta padrão", description: definitions[0].description, icon: Reply, basic: "default_reply" },
  { key: "main_menu", title: "Menu principal", action: "Configurar menu principal", description: "Deixe os caminhos mais úteis sempre ao alcance do contato.", icon: List, surface: "main_menu" },
  { key: "welcome_message", title: "Mensagem de boas-vindas", action: "Configurar boas-vindas", description: definitions[1].description, icon: Hand, basic: "welcome_message" },
  { key: "system_opt_in", title: "Confirmação de inscrição", action: "Configurar inscrição", description: definitions[2].description, icon: BellPlus, basic: "system_opt_in" },
  { key: "system_opt_out", title: "Confirmação de descadastro", action: "Configurar descadastro", description: definitions[3].description, icon: BellOff, basic: "system_opt_out" },
]
const kindIcons: Record<string, LucideIcon> = { instagram: AtSign, whatsapp: MessageCircle, telegram: Send, messenger: MessagesSquare, email: Mail }

type Row = { def: ItemDef; configured: boolean; enabled: boolean; entry?: BasicEntry }

/** Um cartão por conta de canal: itens configurados viram linhas; os que faltam viram blocos com ilustração e o botão Configurar. */
function ConnectionCard({ connection, kind, entries, version, onBasic, onSurface, onSwap, onToggle, busy }: {
  connection: BasicConnection; kind?: string; entries: BasicEntry[]; version: number;   onBasic: (connectionId: string, kind: BasicKind) => void; onSurface: (connectionId: string, kind: SurfaceKind) => void
  onSwap: (entry: BasicEntry) => void; onToggle: (entry: BasicEntry) => void; busy: boolean
}) {
  const { workspace } = useParams() as { workspace: string }
  const [open, setOpen] = React.useState(true)
  const surfaceKinds = (["conversation_starters", "main_menu"] as const).filter(item => surfaceCap(connection, item))
  const surfaces = useAsync(async () => Object.fromEntries(await Promise.all(surfaceKinds.map(async item => [item, await getSurface(connection.id, item)] as const))), `${connection.id}:surfaces:${version}:${surfaceKinds.join()}`)
  const Icon = (kind && kindIcons[kind]) || MessageCircle
  const loaded = surfaces.data ?? surfaces.stale
  const rows: Row[] | null = loaded || !surfaceKinds.length ? itemDefs.flatMap<Row>(def => {
    if (def.basic) { const entry = entries.find(item => item.kind === def.basic); return [{ def, entry, configured: !!entry, enabled: !!entry?.enabled }] }
    if (!def.surface || !surfaceKinds.includes(def.surface)) return []
    const draft = loaded?.[def.surface]?.draft
    return [{ def, configured: !!draft?.items.length, enabled: !!draft?.enabled }]
  }) : null
  const configured = rows?.filter(row => row.configured) ?? [], missing = rows?.filter(row => !row.configured) ?? []
  const id = React.useId()
  return <section aria-label={connection.displayName} className="rounded-lg bg-surface px-4 py-4 shadow-card">
    <div className="flex items-center gap-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-pill bg-accent-soft text-accent"><Icon className="size-4" aria-hidden="true" /></span>
      <h3 className="min-w-0 flex-1 truncate text-lg font-bold">{connection.displayName}</h3>
      <Button type="button" variant="ghost" size="icon" aria-expanded={open} aria-controls={id} aria-label={`${open ? "Recolher" : "Expandir"} ${connection.displayName}`} onClick={() => setOpen(value => !value)}>{open ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}</Button>
    </div>
    <div id={id} hidden={!open}>
      <p className="mt-1 max-w-[58rem] text-xs text-text-muted sm:pl-11">Respostas automáticas desta conexão: como a conversa começa, o que acontece quando nenhuma automação responde e as confirmações de inscrição.</p>
      {!connection.profile.inbound.message ? <Banner className="mt-4">Esta conexão não recebe mensagens, então não há respostas para configurar.</Banner>
        : surfaces.error ? <Banner variant="danger" className="mt-4">Não foi possível carregar as configurações. <button className="underline" onClick={surfaces.reload}>Tentar novamente</button></Banner>
        : !rows ? <div className="mt-4 space-y-3" aria-busy="true" aria-label="Carregando configurações"><Skeleton className="h-10 w-full" /><Skeleton className="h-24 w-full" /></div>
        : <div className="mt-4 border-t border-border">
          {configured.map(({ def, entry, enabled }) => {
            const lower = def.title.toLocaleLowerCase("pt-BR")
            return <section key={def.key} aria-label={def.title} className="flex min-w-0 items-center gap-3 border-b border-border py-3">
              <def.icon className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
              <div className="min-w-0 flex-1 text-base"><p>{def.title}</p>
                {entry ? <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-text-muted"><GitBranch className="size-3 shrink-0" aria-hidden="true" /><Link to={`/${workspace}/automations/${entry.automation_id}`} className="min-w-0 truncate hover:underline">{entry.automation_name}</Link>{entry.kind === "default_reply" ? <span className="shrink-0">· <span>{entry.repeat_mode === "every_time" ? "Toda vez" : "Uma vez a cada 24 horas"}</span>{connection.profile.inbound.storyReply && entry.dm_only ? " · Somente mensagens diretas" : ""}</span> : null}</p> : null}</div>
              <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs", enabled ? "border-success/30 bg-success-soft text-success" : "border-border bg-surface-muted text-text-muted")}>{enabled ? <Play className="size-3" aria-hidden="true" /> : <Pause className="size-3" aria-hidden="true" />}{enabled ? "Ativo" : "Suspenso"}</span>
              <RowMenu item={lower}>
                <RowMenuItem onSelect={() => def.basic ? onBasic(connection.id, def.basic) : def.surface && onSurface(connection.id, def.surface)}>Editar configuração</RowMenuItem>
                {entry ? <RowMenuItem disabled={busy} onSelect={() => onSwap(entry)}>Trocar automação</RowMenuItem> : null}
                {entry ? <RowMenuItem disabled={busy} onSelect={() => onToggle(entry)}>{entry.enabled ? "Suspender" : "Ativar"}</RowMenuItem> : null}
              </RowMenu>
            </section>
          })}
          {missing.map(({ def }) => <section key={def.key} aria-label={def.title} className="flex min-w-0 items-start gap-3 border-b border-border py-5 last:border-b-0">
            <def.icon className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden="true" />
            <div className="min-w-0 flex-1"><h4 className="text-base font-medium">{def.title}</h4><p className="mt-2 max-w-lg text-sm text-text-muted">{def.description}</p>
              <Button className="mt-4" aria-label={def.action} onClick={() => def.basic ? onBasic(connection.id, def.basic) : def.surface && onSurface(connection.id, def.surface)}>Configurar</Button></div>
            <BasicIllustration kind={def.key} />
          </section>)}
        </div>}
    </div>
  </section>
}

export function BasicPage() {
  const { workspace } = useParams() as { workspace: string }
  const settings = useAsync(getBasicSettings, workspace, { cache: `basic-settings|${workspace}` })
  const automations = useAsync(() => listAutomations(workspace), workspace, { cache: `basic-automations|${workspace}` })
  const kinds = useAsync(async () => Object.fromEntries((await listConnections(workspace)).map(item => [item.id, item.kind])) as Record<string, string>, workspace, { cache: `basic-kinds|${workspace}` })
  const [surface, setSurface] = React.useState<{ connectionId: string; kind: SurfaceKind } | null>(null)
  const [editing, setEditing] = React.useState<{ connectionId: string; kind: BasicKind } | null>(null)
  const [surfaceVersion, setSurfaceVersion] = React.useState(0)
  const [swapping, setSwapping] = React.useState<BasicEntry | null>(null)
  const [changing, setChanging] = React.useState(false)
  const data = settings.data ?? settings.stale
  const surfaceConnection = surface ? data?.connections.find(item => item.id === surface.connectionId) : undefined
  const editingConnection = editing ? data?.connections.find(item => item.id === editing.connectionId) : undefined

  async function save(entry: BasicEntry, change: Partial<Pick<BasicEntry, "enabled" | "automation_id">>, done: string) {
    setChanging(true)
    const next = { ...entry, ...change }
    const connection = data?.connections.find(item => item.id === entry.connection_id)
    try { await saveBasicEntry(entry.connection_id, entry.kind, { automation_id: next.automation_id, enabled: next.enabled, repeat_mode: entry.kind === "default_reply" ? entry.repeat_mode : "every_time", dm_only: entry.kind === "default_reply" && !!connection?.profile.inbound.storyReply && entry.dm_only }); settings.reload(); toast.success(done) }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : "Não foi possível atualizar a configuração.") }
    finally { setChanging(false) }
  }

  return <div className="min-w-0 space-y-5">
    <title>Automações básicas</title>
    <h2 className="mt-1.5 mb-2 text-xl font-bold">Automações básicas</h2>
    {settings.error ? <Banner variant="danger">Não foi possível carregar as configurações. <button className="underline" onClick={settings.reload}>Tentar novamente</button></Banner>
      : !data ? <div className="space-y-4" aria-busy="true" aria-label="Carregando configurações"><Skeleton className="h-52 w-full" /><Skeleton className="h-52 w-full" /></div>
      : !data.connections.length ? <div className="rounded-lg bg-surface p-8 shadow-card"><MessageCircle className="mb-4 size-7 text-text-muted" aria-hidden="true" /><h3 className="font-semibold">Nenhuma conexão disponível</h3><p className="mt-2 text-sm text-text-muted">Adicione uma conexão para configurar as mensagens automáticas.</p><Button asChild variant="secondary" className="mt-4"><Link to={`/${workspace}/settings/channels`}>Ver conexões</Link></Button></div>
      : data.connections.map(connection => <ConnectionCard key={connection.id} connection={connection} kind={kinds.data?.[connection.id]} entries={data.entries.filter(entry => entry.connection_id === connection.id)} version={surfaceVersion}
        busy={changing || settings.loading} onBasic={(connectionId, kind) => setEditing({ connectionId, kind })} onSurface={(connectionId, kind) => setSurface({ connectionId, kind })} onSwap={setSwapping}
        onToggle={entry => void save(entry, { enabled: !entry.enabled }, entry.enabled ? "Configuração desativada" : "Configuração ativada")} />)}
    {swapping ? <ChooseExisting open onOpenChange={open => { if (!open) setSwapping(null) }} title="Escolher automação existente" searchLabel="Buscar automação" emptyText="Nenhuma automação publicada."
      items={(automations.data ?? []).filter(item => item.published_version_id || item.id === swapping.automation_id).map(item => ({ id: item.id, label: item.name, hint: item.status === "stopped" ? "Pausada" : undefined }))}
      renderPreview={item => <AutomationPreview workspace={workspace} id={item.id} />}
      onChoose={item => { const entry = swapping; setSwapping(null); if (item.id !== entry.automation_id) void save(entry, { automation_id: item.id }, "Automação trocada") }} /> : null}
    {surfaceConnection && surface ? <SurfaceEditor key={`${surfaceConnection.id}:${surface.kind}`} connection={surfaceConnection} kind={surface.kind} onClose={() => { setSurface(null); setSurfaceVersion(v => v + 1) }} /> : null}
    {editing && editingConnection ? <BasicDialog key={`${editingConnection.id}:${editing.kind}`} connection={editingConnection} kind={editing.kind} entry={data?.entries.find(entry => entry.connection_id === editingConnection.id && entry.kind === editing.kind)} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); settings.reload() }} /> : null}
  </div>
}
