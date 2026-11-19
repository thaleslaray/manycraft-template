import * as React from "react"
import { Link, useParams } from "react-router"
import { Copy } from "lucide-react"
import { ChannelIcon, channelNames, type ChannelId } from "./settings-nav"
import { ChannelArt } from "./channel-art"
import { SettingsProfileCard, SettingsRow, SettingsRows } from "./settings-rows"
import { dailyLimitLabel } from "@/data/account-health"
import { offersConversationStarters, webhookState, type WebhookState } from "@/data/connection-rows"
import { toast } from "sonner"
import { apiRequest } from "@/data/api"
import {
  archiveConnection, createConnection, getConnectionCatalog, getConnectionMarketing, describeAccountHealth, getConnectionRouting, getConnectionWebhookStep, listConnections, pollConnectionPairing, rotateConnectionCredentials, updateConnection, refreshConnection, setConnectionEnabled, hasMetaReview,
  type CatalogChannel, type HealthTone, type CatalogProvider, type Connection, type ConnectionState, type ConnectStep, type OptionField, type PermissionItem,
} from "@/data"
import { useAsync } from "@/hooks/use-async"
import { Banner } from "@/components/ui/banner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NumberedStep } from "@/components/ui/numbered-step"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

const REFRESH_MS = 8000
const stateLabel: Record<ConnectionState, { label: string; cls: string }> = {
  connected: { label: "Conectada", cls: "bg-success-soft text-success" },
  pending: { label: "Aguardando webhook", cls: "bg-warning-soft text-warning" },
  connecting: { label: "Conectando", cls: "bg-warning-soft text-warning" },
  disconnected: { label: "Desconectada", cls: "border border-border bg-bg text-text-muted" },
  error: { label: "Com erro", cls: "bg-danger text-on-danger" },
  restricted: { label: "Restrita", cls: "bg-warning-soft text-warning" },
}
const dateFormat = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" })

function StateBadge({ status, awaitingFirstEvent }: { status: ConnectionState; awaitingFirstEvent?: boolean }) {
  const { label, cls } = awaitingFirstEvent ? { label: "Aguardando primeiro evento", cls: stateLabel.pending.cls } : stateLabel[status] ?? stateLabel.disconnected
  return <span className={cn("inline-flex items-center rounded-sm px-2 py-0.5 text-2xs font-bold uppercase", cls)}>{label}</span>
}
function Card({ children }: { children: React.ReactNode }) {
  return <div className="space-y-4 rounded-lg border border-border bg-surface p-4 sm:p-6">{children}</div>
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : "Não foi possível concluir a operação."

type Dialogs =
  | { kind: "connect"; channel?: string }
  | { kind: "rotate"; connection: Connection }
  | { kind: "archive"; connection: Connection }
  | { kind: "qr"; connection: Connection; qr: string }
  | { kind: "options"; connection: Connection; options: OptionField[] }
  | { kind: "guide"; connection: Connection | null; step: Extract<ConnectStep, { kind: "manual_webhook" }> }

/** `kind` abre a página de um canal (Instagram, WhatsApp, Telegram); sem ele, a lista com todas as conexões. */
export function ConnectionsPanel({ workspace, kind, tabs }: { workspace: string; kind?: "instagram" | "whatsapp" | "telegram"; tabs?: React.ReactNode }) {
  const connections = useAsync(() => listConnections(workspace), workspace)
  const [dialog, setDialog] = React.useState<Dialogs | null>(null)
  const reload = connections.reload
  // The state of each connection is live: pick up the first event, a revoked token or a restored webhook.
  React.useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") reload() }, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [reload])
  const everything = connections.data ?? connections.stale
  const list = everything && kind ? everything.filter(row => row.kind === kind) : everything
  const catalog = useAsync(getConnectionCatalog, "catalog")
  // Options belong to the provider: a connection shows them only when its provider declares some.
  const optionsOf = (connection: Connection) => catalog.data?.channels.flatMap((row) => row.providers).find((row) => row.id === connection.provider)?.options ?? []
  const openGuide = async (connection: Connection) => {
    try {
      const step = await getConnectionWebhookStep(connection.id, workspace)
      if (step.kind === "manual_webhook") setDialog({ kind: "guide", connection, step })
      else { toast.success(step.kind === "done" && step.notice ? step.notice : "Webhook registrado."); reload() }
    } catch (error) { toast.error(messageOf(error)) }
  }
  const label = kind ? channelNames[kind as ChannelId] : ""
  const loading = <div role="status" aria-label="Carregando conexões" className="space-y-4"><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
  const failed = <Banner variant="danger"><div className="flex flex-wrap items-center gap-3">Não foi possível carregar as conexões.<Button size="sm" variant="secondary" onClick={reload}>Tentar de novo</Button></div></Banner>
  const cards = (list ?? []).map((connection) => <li key={connection.id} className="min-w-0"><ConnectionCard connection={connection} single={!!kind}
          options={optionsOf(connection).length > 0} onOptions={() => setDialog({ kind: "options", connection, options: optionsOf(connection) })}
          onQr={() => setDialog({ kind: "qr", connection, qr: "" })}
          onRotate={() => setDialog({ kind: "rotate", connection })} onArchive={() => setDialog({ kind: "archive", connection })} onGuide={() => void openGuide(connection)} onChanged={reload} /></li>)
  return <div className="space-y-4">
    {kind ? <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="flex items-center gap-3 text-2xl font-semibold"><ChannelIcon channel={kind as ChannelId} className="size-8" />{label}</h2>
      {list && list.length > 0 ? <Button variant="secondary" onClick={() => setDialog({ kind: "connect", channel: kind })}>Conectar outra conta</Button> : null}
    </div> : <div className="flex flex-wrap items-center justify-between gap-3">
      <Banner className="w-full sm:w-auto sm:min-w-0 sm:flex-1">As credenciais ficam cifradas no banco e nunca voltam para o navegador.</Banner>
      <Button onClick={() => setDialog({ kind: "connect" })}>Conectar canal</Button>
    </div>}
    {kind ? tabs : null}
    {connections.error && !list ? failed
      : !list ? loading
      : list.length === 0 && kind ? <section aria-label={`${label} sem conexão`} className="flex min-h-[36rem] flex-col items-center justify-center gap-3 rounded-lg border border-border bg-surface px-6 py-16 text-center">
          <ChannelArt className="mb-8 w-96 max-w-full" />
          <h3 className="text-xl font-semibold">Crie relações com seus clientes no {label}</h3>
          <p className="max-w-lg text-sm text-text-muted">{pitch[kind] ?? "Receba e responda mensagens por este canal."}</p>
          <Button className="mt-2" onClick={() => setDialog({ kind: "connect", channel: kind })}>Conectar</Button>
        </section>
      : list.length === 0 ? <EmptyState title="Nenhum canal conectado" description="Conecte um bot de Telegram, um número de WhatsApp ou uma conta do Instagram para receber e responder mensagens." action={<Button onClick={() => setDialog({ kind: "connect" })}>Conectar canal</Button>} />
      : <ul aria-label="Conexões" className={kind ? "space-y-6" : "grid grid-cols-1 gap-4 xl:grid-cols-2"}>{cards}</ul>}
    {!kind && list && catalog.data ? <AvailableChannels channels={catalog.data.channels.filter(c => !list.some(x => x.kind === c.kind))} onConnect={channel => setDialog({ kind: "connect", channel })} /> : null}
    {dialog?.kind === "connect" && <ConnectDialog initialKind={dialog.channel} workspace={workspace} onClose={() => setDialog(null)} onConnected={reload} onGuide={(connection, step) => setDialog({ kind: "guide", connection, step })}
      onQr={(connection, qr) => setDialog({ kind: "qr", connection, qr })} />}
    {dialog?.kind === "qr" && <QrDialog workspace={workspace} connection={dialog.connection} first={dialog.qr} onClose={() => { setDialog(null); reload() }} />}
    {dialog?.kind === "options" && <OptionsDialog workspace={workspace} connection={dialog.connection} options={dialog.options} onClose={() => setDialog(null)} onDone={reload} />}
    {dialog?.kind === "rotate" && <RotateDialog workspace={workspace} connection={dialog.connection} onClose={() => setDialog(null)} onDone={reload} />}
    {dialog?.kind === "archive" && <ArchiveDialog workspace={workspace} connection={dialog.connection} onClose={() => setDialog(null)} onDone={reload} />}
    {dialog?.kind === "guide" && <GuideDialog connection={dialog.connection} step={dialog.step} onClose={() => { setDialog(null); reload() }} />}
  </div>
}

const routingRoleLabels: Record<string, string> = {
  customer_service: "Atendimento (conversas iniciadas pelo cliente)", marketing: "Resposta a mensagens de marketing", utility: "Resposta a mensagens de utilidade",
  ctwa: "Anúncios que abrem o WhatsApp", escalation: "Parceiro de escalonamento (pode assumir qualquer conversa)", calls: "Chamadas", ai_agent: "Agente de IA da Meta",
}
/** Several partners can share one WhatsApp number: only the owner of a conversation receives its messages and can answer (Meta error 131070 otherwise). */
function RoutingInfo({ connection, bare }: { connection: Connection; bare?: boolean }) {
  const routing = useAsync(() => getConnectionRouting(connection.id), connection.id)
  // Nome único por conexão: com dois números na tela, duas regiões com o mesmo nome não se distinguem no leitor de tela.
  const region = `Roteamento de conversas de ${connection.displayName || connection.label}`
  const body = <>
    {bare ? null : <h4 className="font-semibold">Roteamento de conversas</h4>}
    {routing.error ? <p className="text-text-muted">Não foi possível consultar os papéis na Meta agora. {routing.error instanceof Error ? routing.error.message : ""}</p>
      : !routing.data ? <p role="status" className="text-text-muted">Consultando os papéis na Meta…</p>
      : !routing.data.active ? <p className="text-text-muted">Este número não divide conversas com outros parceiros: este app responde tudo.</p>
      : <div className="space-y-1"><p className="text-text-muted">Este app divide o número com outros parceiros. Papéis dele neste número:</p>
          {routing.data.roles.length ? <ul className="list-disc pl-5">{routing.data.roles.map(role => <li key={role}>{routingRoleLabels[role] ?? role}</li>)}</ul>
            : <p className="font-medium">Nenhum papel: este app não recebe conversas novas neste número.</p>}
          {routing.data.standby && <p className="text-text-muted">Também recebe uma cópia das conversas dos outros (modo espera), sem poder responder.</p>}</div>}
    <details className="text-text-muted"><summary className="cursor-pointer font-medium text-text">Erro 131070: “outro app controla esta conversa”</summary>
      <p className="mt-1">Com mais de um parceiro no número, só o dono da conversa recebe as mensagens e consegue responder. Os outros apps levam o erro 131070 ao tentar enviar. Para escolher quem recebe cada tipo de conversa, abra o Gerenciador de Negócios, vá em Contas do WhatsApp, escolha o número e abra Roteamento de conversas (na Meta em inglês, Conversation routing).</p></details>
  </>
  return bare ? <SettingsRow label="Roteamento" help="Vários parceiros podem dividir o mesmo número: só o dono de cada conversa recebe as mensagens e responde."><section aria-label={region} className="space-y-2 text-sm">{body}</section></SettingsRow>
    : <section aria-label={region} className="space-y-2 rounded-md border border-border bg-surface-muted p-3 text-sm">{body}</section>
}

const healthTone: Record<HealthTone, { label: string; cls: string }> = {
  ok: { label: "Tudo certo", cls: "bg-success-soft text-success" }, info: { label: "Informação", cls: "border border-border bg-bg text-text-muted" },
  attention: { label: "Atenção", cls: "bg-warning-soft text-warning" }, critical: { label: "Ação necessária", cls: "bg-danger text-on-danger" },
}
/** What the provider announced about the account behind the number (quality, limits, alerts, restrictions, review), with what to do. */
function AccountHealth({ connection, bare }: { connection: Connection; bare?: boolean }) {
  const { tone, items } = describeAccountHealth(connection.health)
  const badge = <span className={cn("inline-flex items-center rounded-sm px-2 py-0.5 text-2xs font-bold uppercase", healthTone[tone].cls)}>{healthTone[tone].label}</span>
  const list = items.length === 0 ? <p className="text-text-muted">A Meta ainda não enviou nenhum aviso sobre a qualidade, o limite ou a situação desta conta.</p>
    : <ul className="space-y-2">{items.map(item => <li key={item.id} className="space-y-0.5">
        <p className="flex flex-wrap items-center gap-2 font-medium">{item.title}<span className={cn("inline-flex items-center rounded-sm px-1.5 py-0.5 text-2xs font-bold uppercase", healthTone[item.tone].cls)}>{healthTone[item.tone].label}</span></p>
        <p className="text-text-muted">{item.text}</p>
        {item.action && <p><span className="font-medium">O que fazer:</span> <span className="text-text-muted">{item.action}</span></p>}
      </li>)}</ul>
  return bare ? <SettingsRow label="Saúde da conta" help="O que a Meta avisou sobre a qualidade do número, os limites e a situação da conta, com o que fazer."><section aria-label="Saúde da conta" className="space-y-2 text-sm">{badge}{list}</section></SettingsRow>
    : <section aria-label="Saúde da conta" className="space-y-2 rounded-md border border-border bg-surface-muted p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold">Saúde da conta</h4>{badge}</div>{list}
      </section>
}

/** Marketing templates go through the Marketing Messages API once the account accepted its terms; until then they still use the Cloud API, which Meta retires on 13/10/2027. */
function MarketingInfo({ connection, bare }: { connection: Connection; bare?: boolean }) {
  const [version, setVersion] = React.useState(0)
  const marketing = useAsync(() => getConnectionMarketing(connection.id, version > 0), `${connection.id}:${version}`)
  const data = marketing.data ?? marketing.stale
  // "Verificar de novo" precisa dizer que conferiu: sem isto o botão volta ao normal e nada muda na tela.
  const asked = React.useRef(0)
  React.useEffect(() => {
    if (marketing.loading || asked.current === version) return
    asked.current = version
    if (marketing.error) toast.error("Não foi possível consultar a Meta agora.")
    else toast.success("Conferido agora na Meta.")
  }, [marketing.loading, marketing.error, version])
  if (data && !data.supported) return null
  const body = <>
    {bare ? null : <h4 className="font-semibold">Mensagens de marketing</h4>}
    {marketing.error ? <p className="text-text-muted">Não foi possível consultar a Meta agora. {marketing.error instanceof Error ? marketing.error.message : ""}</p>
      : !data ? <p role="status" className="text-text-muted">Consultando a Meta…</p>
      : data.enabled ? <p className="text-text-muted">Habilitada: os modelos de marketing saem pela API de Mensagens de Marketing. Utilidade e autenticação continuam na API de nuvem.
          {data.checkedAt ? ` Conferido em ${dateFormat.format(data.checkedAt)}.` : ""}</p>
      : <div className="space-y-1"><p className="font-medium">Ainda não habilitada.</p>{data.notice && <p className="text-text-muted">{data.notice}</p>}
          {data.checkedAt && <p className="text-text-muted">Conferido em {dateFormat.format(data.checkedAt)}.</p>}</div>}
    {data?.error && <p role="alert" className="text-text-muted">{data.error}</p>}
    <Button size="sm" variant="secondary" disabled={marketing.loading} onClick={() => setVersion(v => v + 1)}>{marketing.loading && version > 0 ? "Verificando…" : "Verificar de novo"}</Button>
  </>
  return bare ? <SettingsRow label="Marketing" help="As Mensagens de Marketing do WhatsApp enviam conteúdo promocional com entrega otimizada, por uma API própria da Meta."><section aria-label="Mensagens de marketing" className="space-y-2 text-sm">{body}</section></SettingsRow>
    : <section aria-label="Mensagens de marketing" className="space-y-2 rounded-md border border-border bg-surface-muted p-3 text-sm">{body}</section>
}

const webhookTone: Record<WebhookState["tone"], string> = { ok: "bg-success-soft text-success", waiting: "bg-warning-soft text-warning", off: "border border-border bg-bg text-text-muted" }
/** O estado do webhook no meio da linha: selo, o que significa, o endereço e, quando falta o passo manual, o botão que o abre. */
function WebhookStatus({ connection, onGuide }: { connection: Connection; onGuide: () => void }) {
  const state = webhookState(connection)
  return <section aria-label="Estado do webhook" className="space-y-2 text-sm">
    <span className={cn("inline-flex items-center rounded-sm px-2 py-0.5 text-2xs font-bold uppercase", webhookTone[state.tone])}>{state.label}</span>
    <p className="text-text-muted">{state.text}</p>
    {state.url && <p className="font-mono text-xs text-text-muted [overflow-wrap:anywhere]">{state.url}</p>}
    {state.guide && <Button size="sm" variant="secondary" onClick={onGuide}>Ver passo do webhook</Button>}
  </section>
}

/** Why the connection is not "connected" yet and what to check, in the order that usually finds the cause. */
function FirstEventHelp({ connection }: { connection: Connection }) {
  return <section aria-label="O que falta para conectar" className="space-y-2 rounded-md border border-border bg-surface-muted p-3 text-sm">
    <h4 className="font-semibold">O que falta</h4>
    <p className="text-text-muted">A conexão só vira “Conectada” quando a Meta entrega aqui o primeiro evento real deste número. Isso ainda não aconteceu. Envie uma mensagem de outro WhatsApp para o número conectado e espere alguns segundos: esta tela atualiza sozinha.</p>
    <details className="text-text-muted"><summary className="cursor-pointer font-medium text-text">A mensagem não chega</summary>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        <li>O endereço <span className="font-mono [overflow-wrap:anywhere]">{connection.webhook.url}</span> precisa abrir pela internet. Painel rodando só no seu computador não recebe nada da Meta.</li>
        <li>O app da Meta precisa estar em modo Live para entregar mensagens de pessoas reais; em modo de desenvolvimento só chegam as de contas de teste.</li>
        <li>No app da Meta, em WhatsApp, confira que o campo “messages” está assinado.</li>
        <li>A chave secreta do app que o servidor usa precisa ser a do mesmo app da Meta: entregas com assinatura diferente são recusadas.</li>
      </ul></details>
  </section>
}

function ConnectionCard({ connection, single, options, onOptions, onQr, onRotate, onArchive, onGuide, onChanged }: { connection: Connection; single?: boolean; options: boolean; onOptions: () => void; onQr: () => void; onRotate: () => void; onArchive: () => void; onGuide: () => void; onChanged: () => void }) {
  const { workspace } = useParams()
  const name = connection.displayName || connection.label
  // Subscribed on the provider by this server, but no real delivery has arrived: only that delivery turns the connection green.
  const awaiting = connection.status === "pending" && connection.webhook.subscribedAt !== null
  const webhook = awaiting ? `${connection.webhook.note ?? `Conta assinada na Meta em ${dateFormat.format(connection.webhook.subscribedAt!)}.`} Nenhum evento chegou ainda.`
    : connection.webhook.registered ? (connection.webhook.mode === "auto" ? connection.webhook.note ?? "Webhook registrado automaticamente." : "Webhook confirmado.")
    : connection.webhook.mode === "auto" ? "O webhook não foi registrado. Tente trocar a credencial." : "Webhook ainda não configurado."
  const actions = (
    <div className="flex flex-wrap gap-2">
      {connection.webhook.mode === "manual" && connection.status === "pending" && <Button size="sm" variant="secondary" onClick={onGuide}>Ver passo do webhook</Button>}
      {(connection.status === "connecting" || connection.active !== false && connection.status === "disconnected" && connection.pairing === "qr") && <Button size="sm" onClick={onQr}>Ler QR code</Button>}
      {connection.profile?.email && <Button size="sm" variant="secondary" asChild><Link to={`/${workspace}/settings/email`}>Configurar e-mail</Link></Button>}
      {options && <Button size="sm" variant="secondary" onClick={onOptions}>Opções</Button>}
      <RefreshButton id={connection.id} onChanged={onChanged} />
      {connection.provider === "meta_whatsapp_cloud" && connection.status === "connected" ? <><BusinessProfileButton id={connection.id} /><CatalogButton id={connection.id} />{single ? null : <UsernameButton id={connection.id} />}</> : null}
      {hasMetaReview(connection) ? <MetaReviewButton id={connection.id} /> : null}
      <Button size="sm" variant="secondary" onClick={onRotate}>Trocar credencial</Button>
      <Button size="sm" variant="ghost" onClick={async () => {
        const enable = connection.active === false
        try { const r = await setConnectionEnabled(connection.id, enable); if (r.ok) { toast.success(enable ? "Conexão reativada." : "Conexão desativada. Contatos, conversas e credenciais continuam salvos."); window.setTimeout(() => window.location.reload(), 600) } else toast.error(r.detail ?? "Não foi possível reativar.") }
        catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível alterar a conexão.") }
      }}>{connection.active === false ? "Reativar" : "Desativar"}</Button>
      <Button size="sm" variant="ghost" onClick={onArchive}>Arquivar</Button>
    </div>
  )
  if (single) {
    const whatsapp = connection.provider === "meta_whatsapp_cloud"
    const basic = `/${workspace}/automations/basic`
    const toBasic = (label: string, hidden: string) => <Button variant="secondary" className="w-full" asChild><Link to={basic}>{label}<span className="sr-only"> {hidden}</span></Link></Button>
    const channelRows = connection.kind === "instagram" ? <>
      <SettingsRow label="Resposta padrão" help="Acionada quando o contato escreve algo que o bot não reconhece e nenhuma palavra-chave casa. Vale configurar para dar mais informações e um caminho pela conversa.">{toBasic("Configurar", "resposta padrão")}</SettingsRow>
      <SettingsRow label="Menu principal" help="O menu do ícone de hambúrguer no alto do Instagram, sempre à mão dos contatos. Personalize para facilitar a navegação pelo bot.">{toBasic("Editar", "menu principal")}</SettingsRow>
      {offersConversationStarters(connection) ? <SettingsRow label="Iniciadores de conversa" help="Perguntas frequentes que o contato toca para começar uma conversa com a empresa.">{toBasic("Editar", "iniciadores de conversa")}</SettingsRow> : null}
      <SettingsRow label="Cumprimento de novos seguidores" help="Quando alguém começa a te seguir, uma mensagem automática pode ser enviada, só na primeira vez.">{toBasic("Configurar", "cumprimento de novos seguidores")}</SettingsRow>
    </> : whatsapp ? <>
      <SettingsRow label="Nome de usuário do WhatsApp" help="Os contatos encontram o número por este nome em vez do telefone. O pedido fica reservado até a Meta aprovar."><UsernameButton id={connection.id} row /></SettingsRow>
      {connection.status === "connected" ? <MarketingInfo connection={connection} bare /> : null}
      {offersConversationStarters(connection) ? <SettingsRow label="Iniciadores de conversa" help="Perguntas frequentes que o contato toca para começar uma conversa com a empresa.">{toBasic("Configurar", "iniciadores de conversa")}</SettingsRow> : null}
      <SettingsRow label="Resposta padrão" help="Ajuste a resposta padrão do WhatsApp, enviada quando nenhuma palavra-chave ou automação casa.">{toBasic("Configurar", "resposta padrão")}</SettingsRow>
      <SettingsRow label="Automação de opt-out" help="Aciona a automação quando o contato digita “Parar” ou “Cancelar inscrição”. As palavras do sistema são fixas; só a automação muda.">{toBasic("Editar", "automação de opt-out")}</SettingsRow>
      {connection.status === "connected" ? <AccountHealth connection={connection} bare /> : null}
      {connection.status === "connected" ? <RoutingInfo connection={connection} bare /> : null}
    </> : <SettingsRow label="Resposta padrão" help="Acionada quando o contato escreve algo que o bot não reconhece e nenhuma palavra-chave casa.">{toBasic("Configurar", "resposta padrão")}</SettingsRow>
    const limit = dailyLimitLabel(connection.health)
    const avatar = <span aria-hidden="true" className="grid size-14 place-items-center rounded-full bg-accent-soft text-xl font-semibold text-accent">{name.slice(0, 1).toLocaleUpperCase("pt-BR")}</span>
    const status = <StateBadge status={connection.status} awaitingFirstEvent={awaiting} />
    return <div className="space-y-4">
      {whatsapp ? <SettingsProfileCard label={`Conta ${name}`} avatar={avatar} title={name} fields={[
        { label: "Exibir nome", value: name }, { label: "ID da conta", value: connection.externalId },
        { label: "Limite de mensagens", value: limit ?? "Ainda sem informação da Meta" }, { label: "Situação", value: status },
      ]} /> : <SettingsProfileCard label={`Conta ${name}`} avatar={avatar} title={name} subtitle={<>{connection.label} · conta {connection.externalId}{connection.credentialsRotatedAt ? <> · credencial salva em {dateFormat.format(connection.credentialsRotatedAt)}</> : null}</>} aside={status} />}
      {awaiting && <FirstEventHelp connection={connection} />}
      {whatsapp && connection.accountIdMissing && <Banner variant="warning">Não foi possível confirmar a conta do WhatsApp Business (WABA) desta conexão na Meta. Sem ela, os avisos da conta (qualidade do número, limites, alertas e restrições) não aparecem aqui. Use “Trocar credencial” com um token que enxergue a conta do WhatsApp Business (WABA) do número.</Banner>}
      <SettingsRows label={`Conexão ${name}`}>
        {channelRows}
        <SettingsRow label="Webhook" help={<div className="space-y-1 text-sm text-text-muted"><p>Endereço onde o provedor entrega as mensagens e os eventos deste canal.</p>
          {connection.statusDetail && ["error", "restricted", "disconnected"].includes(connection.status) && <p>{connection.statusDetail}</p>}</div>}>
          <WebhookStatus connection={connection} onGuide={onGuide} />
        </SettingsRow>
        <SettingsRow label="Gerenciar conexão" help="Atualize, troque a credencial, desative ou arquive. Contatos, conversas e credenciais continuam salvos.">
          {actions}
        </SettingsRow>
        <SettingsRow label="Opções" help="O que acontece quando a conexão cai e o encurtador de links.">
          <DisconnectionConditions id={connection.id} />
        </SettingsRow>
      </SettingsRows>
    </div>
  }
  return <Card>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <h3 className="break-words font-semibold">{name}</h3>
        <p className="min-w-0 [overflow-wrap:anywhere] text-sm text-text-muted">{connection.label} · conta {connection.externalId}</p>
      </div>
      <StateBadge status={connection.status} awaitingFirstEvent={awaiting} />
    </div>
    <div className="space-y-1 text-sm text-text-muted">
      <p>{webhook}</p>
      {connection.statusDetail && ["error", "restricted", "disconnected"].includes(connection.status) && <p>{connection.statusDetail}</p>}
      {connection.credentialsRotatedAt && <p>Credencial salva em {dateFormat.format(connection.credentialsRotatedAt)}.</p>}
    </div>
    {awaiting && <FirstEventHelp connection={connection} />}
    {connection.provider === "meta_whatsapp_cloud" && connection.accountIdMissing && <Banner variant="warning">Não foi possível confirmar a conta do WhatsApp Business (WABA) desta conexão na Meta. Sem ela, os avisos da conta (qualidade do número, limites, alertas e restrições) não aparecem aqui. Use “Trocar credencial” com um token que enxergue a conta do WhatsApp Business (WABA) do número.</Banner>}
    {connection.provider === "meta_whatsapp_cloud" && connection.status === "connected" && <AccountHealth connection={connection} />}
    {connection.provider === "meta_whatsapp_cloud" && connection.status === "connected" && <MarketingInfo connection={connection} />}
    {connection.provider === "meta_whatsapp_cloud" && connection.status === "connected" && <RoutingInfo connection={connection} />}
    <div className="flex flex-wrap gap-2">
      {connection.webhook.mode === "manual" && connection.status === "pending" && <Button size="sm" variant="secondary" onClick={onGuide}>Ver passo do webhook</Button>}
      {(connection.status === "connecting" || connection.active !== false && connection.status === "disconnected" && connection.pairing === "qr") && <Button size="sm" onClick={onQr}>Ler QR code</Button>}
      {connection.profile?.email && <Button size="sm" variant="secondary" asChild><Link to={`/${workspace}/settings/email`}>Configurar e-mail</Link></Button>}
      {options && <Button size="sm" variant="secondary" onClick={onOptions}>Opções</Button>}
      <RefreshButton id={connection.id} onChanged={onChanged} />
      {connection.provider === "meta_whatsapp_cloud" && connection.status === "connected" ? <><BusinessProfileButton id={connection.id} /><CatalogButton id={connection.id} />{single ? null : <UsernameButton id={connection.id} />}</> : null}
      {hasMetaReview(connection) ? <MetaReviewButton id={connection.id} /> : null}
      <Button size="sm" variant="secondary" onClick={onRotate}>Trocar credencial</Button>
      <Button size="sm" variant="ghost" onClick={async () => {
        const enable = connection.active === false
        try { const r = await setConnectionEnabled(connection.id, enable); if (r.ok) { toast.success(enable ? "Conexão reativada." : "Conexão desativada. Contatos, conversas e credenciais continuam salvos."); window.setTimeout(() => window.location.reload(), 600) } else toast.error(r.detail ?? "Não foi possível reativar.") }
        catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível alterar a conexão.") }
      }}>{connection.active === false ? "Reativar" : "Desativar"}</Button>
      <Button size="sm" variant="ghost" onClick={onArchive}>Arquivar</Button>
    </div>
    <DisconnectionConditions id={connection.id} />
  </Card>
}

const checkTone = { ok: "text-success", missing: "text-danger", unknown: "text-text-muted", unavailable: "text-text-muted" } as const
const checkLabel = { ok: "Ok", missing: "Falta", unknown: "Não conferido", unavailable: "Indisponível" } as const
/** Atualizar conexão: revalida no provedor e, quando o provedor confere permissões (Instagram), mostra o que está ok e o que falta com o passo para resolver. */
function RefreshButton({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [busy, setBusy] = React.useState(false)
  const [checked, setChecked] = React.useState<PermissionItem[] | null>(null)
  return <>
    <Button size="sm" variant="secondary" disabled={busy} onClick={async () => {
      setBusy(true)
      try {
        const r = await refreshConnection(id)
        if (r.permissions) setChecked(r.permissions)
        if (r.ok) toast.success("Conexão atualizada."); else toast.error(r.detail ?? "A conexão não respondeu.")
        if (r.warning) toast.warning(r.warning, { duration: 15_000 })
        onChanged()
      } catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível atualizar a conexão.") }
      finally { setBusy(false) }
    }}>{busy ? "Atualizando…" : "Atualizar conexão"}</Button>
    {checked ? <Dialog open onOpenChange={open => { if (!open) setChecked(null) }}><DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader><DialogTitle>Conferência da conexão</DialogTitle><DialogDescription>O que a conexão consegue fazer na conta agora. O que faltar deixa a conexão com erro até você resolver e atualizar de novo.</DialogDescription></DialogHeader>
      <ul aria-label="Resultado da conferência" className="divide-y divide-border">{checked.map(item => <li key={item.key} className="space-y-1 py-2 text-sm">
        <div className="flex items-start justify-between gap-3"><span className="min-w-0 [overflow-wrap:anywhere] font-medium">{item.label}</span><span className={cn("shrink-0 font-semibold", checkTone[item.status])}>{checkLabel[item.status]}</span></div>
        {item.status !== "ok" && item.fix ? <p className="min-w-0 [overflow-wrap:anywhere] text-text-muted">{item.fix}</p> : null}
      </li>)}</ul>
      <DialogFooter><Button variant="secondary" onClick={() => setChecked(null)}>Fechar</Button></DialogFooter>
    </DialogContent></Dialog> : null}
  </>
}

/** Condições de desconexão: o que acontece se esta conexão cair (aviso no sininho e por e-mail; pausar transmissões dela). */
function DisconnectionConditions({ id }: { id: string }) {
  const [state, setState] = React.useState({ notify: true, pause_broadcasts: false })
  const save = (next: typeof state) => { setState(next); void apiRequest(`/connections/${encodeURIComponent(id)}/disconnection`, { method: "PUT", body: JSON.stringify(next) }).then(() => toast.success("Condições de desconexão salvas.")).catch((e: Error) => toast.error(e.message)) }
  return <details className="mt-3 text-sm"><summary className="cursor-pointer text-text-muted">Opções: queda da conexão e links</summary>
    <label className="mt-2 flex items-center gap-2"><input type="checkbox" className="accent-accent" checked={state.notify} onChange={e => save({ ...state, notify: e.target.checked })} />Avisar a equipe</label>
    <label className="mt-1 flex items-center gap-2"><input type="checkbox" className="accent-accent" checked={state.pause_broadcasts} onChange={e => save({ ...state, pause_broadcasts: e.target.checked })} />Pausar as transmissões agendadas desta conexão</label>
    <ShortenLinks id={id} />
  </details>
}

function SecretField({ field, value, onChange, required, autoFocus }: { field: CatalogProvider["fields"][number]; value: string; onChange: (value: string) => void; required: boolean; autoFocus?: boolean }) {
  const id = `credential-${field.key}`
  return <div className="space-y-2">
    <Label htmlFor={id}>{field.label}{!required && <span className="font-normal text-text-muted"> (opcional)</span>}</Label>
    <Input id={id} name={field.key} type={field.secret ? "password" : "text"} autoComplete="off" spellCheck={false} required={required} autoFocus={autoFocus} value={value} onChange={(event) => onChange(event.target.value)} />
    {field.help && <p className="text-xs text-text-muted">{field.help}</p>}
  </div>
}

function ConnectDialog({ initialKind, workspace, onClose, onConnected, onGuide, onQr }: { initialKind?: string; workspace: string; onClose: () => void; onConnected: () => void; onGuide: (connection: Connection, step: Extract<ConnectStep, { kind: "manual_webhook" }>) => void; onQr: (connection: Connection, qr: string) => void }) {
  const catalog = useAsync(getConnectionCatalog, "catalog")
  const [kind, setKind] = React.useState<string | null>(initialKind ?? null)
  const [providerId, setProviderId] = React.useState<string | null>(null)
  const [values, setValues] = React.useState<Record<string, string>>({})
  const [name, setName] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const channels: CatalogChannel[] = catalog.data?.channels ?? []
  const channel = channels.find((row) => row.kind === kind)
  // One provider means there is nothing to choose: that step is skipped.
  const provider = channel?.providers.length === 1 ? channel.providers[0] : channel?.providers.find((row) => row.id === providerId)
  const chooseProvider = !!channel && channel.providers.length > 1
  const credentialsStep = 1 + 1 + (chooseProvider ? 1 : 0)
  const pick = (next: string) => { setKind(next); setProviderId(null); setValues({}); setName(""); setError(null) }
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!channel || !provider) return
    setBusy(true); setError(null)
    try {
      const result = await createConnection({ kind: channel.kind, provider: provider.id, displayName: name.trim() || undefined,
        credentials: values }, workspace)
      onConnected()
      if (result.warning) toast.warning(result.warning, { duration: 15_000 })
      if (result.step.kind === "manual_webhook") onGuide(result.connection, result.step)
      else if (result.step.kind === "qr") onQr(result.connection, result.step.qr)
      else { toast.success(result.step.kind === "done" && result.step.notice ? `Canal conectado. ${result.step.notice}` : "Canal conectado."); onClose() }
    } catch (failure) { setError(messageOf(failure)) }
    finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader><DialogTitle>Conectar canal</DialogTitle><DialogDescription>Escolha o canal e informe as credenciais da conta que vai receber e responder mensagens.</DialogDescription></DialogHeader>
      <form className="space-y-5" onSubmit={(event) => void submit(event)}>
        <NumberedStep n={1} title="Canal">
          {catalog.error ? <Banner variant="danger">Não foi possível carregar os canais.</Banner> : !catalog.data ? <Skeleton className="h-12" /> :
            <fieldset className="grid gap-2 sm:grid-cols-3"><legend className="sr-only">Canal</legend>{channels.map((row) => <label key={row.kind} className={cn("flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 font-medium", kind === row.kind ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface hover:bg-surface-muted")}>
              <input type="radio" name="channel" className="accent-(--color-accent)" checked={kind === row.kind} onChange={() => pick(row.kind)} />{row.label}</label>)}</fieldset>}
        </NumberedStep>
        {chooseProvider && channel && <NumberedStep n={2} title="Provedor">
          <fieldset className="grid gap-2 sm:grid-cols-2"><legend className="sr-only">Provedor</legend>{channel.providers.map((row) => <label key={row.id} className={cn("flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 font-medium", providerId === row.id ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface hover:bg-surface-muted")}>
            <input type="radio" name="provider" className="accent-(--color-accent)" checked={providerId === row.id} onChange={() => { setProviderId(row.id); setValues({}) }} />{row.label}</label>)}</fieldset>
        </NumberedStep>}
        {provider && <NumberedStep n={credentialsStep} title="Credenciais">
          {provider.notice && <Banner variant="warning">{provider.notice}</Banner>}
          <div className="space-y-4">
            {provider.fields.map((field) => <SecretField key={field.key} field={field} required={!field.optional} value={values[field.key] ?? ""} onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))} />)}
            <div className="space-y-2"><Label htmlFor="connection-name">Nome na lista <span className="font-normal text-text-muted">(opcional)</span></Label><Input id="connection-name" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></div>
          </div>
          {provider.webhook === "auto" ? <p className="text-xs text-text-muted">O webhook é registrado sozinho no provedor.{provider.pairing === "qr" ? " Depois de salvar, você lê o QR code com o celular." : ""}</p> : <p className="text-xs text-text-muted">{provider.webhookNote ?? "Depois de salvar, mostramos a URL e o token para colar no app da Meta."}</p>}
        </NumberedStep>}
        {error && <Banner variant="danger">{error}</Banner>}
        <DialogFooter><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancelar</Button><Button type="submit" loading={busy} disabled={!provider}>Conectar</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

const QR_POLL_MS = 3000
/** A QR code arrives as a data URL or as bare base64 (png). */
const qrSource = (qr: string) => qr.startsWith("data:") ? qr : `data:image/png;base64,${qr}`

function QrDialog({ workspace, connection, first, onClose }: { workspace: string; connection: Connection; first: string; onClose: () => void }) {
  const [qr, setQr] = React.useState(first)
  const [error, setError] = React.useState<string | null>(null)
  const [paired, setPaired] = React.useState(false)
  // The QR expires and the provider refreshes it: ask again until the number is paired.
  React.useEffect(() => {
    let stopped = false
    const ask = async () => {
      try {
        const { step } = await pollConnectionPairing(connection.id, workspace)
        if (stopped) return
        if (step.kind === "done") { setPaired(true); toast.success("Número conectado."); return }
        if (step.kind === "qr") { setQr(step.qr); setError(null) }
      } catch (failure) { if (!stopped) setError(messageOf(failure)) }
      if (!stopped) timer = window.setTimeout(() => void ask(), QR_POLL_MS)
    }
    let timer = window.setTimeout(() => void ask(), first ? QR_POLL_MS : 0)
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [connection.id, first, workspace])
  return <Dialog open onOpenChange={(open) => !open && onClose()}>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader><DialogTitle>Conectar o WhatsApp</DialogTitle><DialogDescription>{connection.displayName || connection.label}: leia o QR code com o celular do número que vai atender.</DialogDescription></DialogHeader>
      <div className="space-y-4">
        {paired ? <Banner>Número conectado. As mensagens que chegarem nele passam a entrar aqui.</Banner> : <>
          <div className="mx-auto flex size-56 items-center justify-center rounded-lg border border-border bg-surface p-2">
            {qr ? <img src={qrSource(qr)} alt="QR code para parear o WhatsApp" className="size-full object-contain" /> : <Skeleton className="size-full" role="status" aria-label="Gerando o QR code" />}
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-text-muted">
            <li>No celular, abra o WhatsApp e vá em Aparelhos conectados.</li><li>Toque em Conectar um aparelho e aponte a câmera para o QR code.</li>
            <li>Esta janela fecha sozinha quando o número estiver conectado.</li>
          </ol>
          <Banner variant="warning">Conexão não oficial: o WhatsApp pode bloquear o número. Não use um número que você não pode perder.</Banner>
          {error && <Banner variant="danger">{error}</Banner>}
        </>}
      </div>
      <DialogFooter><Button onClick={onClose}>{paired ? "Concluir" : "Fechar"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}

function OptionsDialog({ workspace, connection, options, onClose, onDone }: { workspace: string; connection: Connection; options: OptionField[]; onClose: () => void; onDone: () => void }) {
  const [values, setValues] = React.useState<Record<string, unknown>>({ ...connection.settings })
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true); setError(null)
    try {
      // Every option is sent, so what was switched off or cleared is switched off or cleared on the server too.
      const settings = Object.fromEntries(options.map((option) => [option.key, option.type === "boolean" ? values[option.key] === true : String(values[option.key] ?? "")]))
      await updateConnection(connection.id, { settings }, workspace)
      toast.success("Opções salvas."); onDone(); onClose()
    } catch (failure) { setError(messageOf(failure)) } finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader><DialogTitle>Opções da conexão</DialogTitle><DialogDescription>{connection.displayName || connection.label}. Tudo começa desligado.</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        {options.filter((option) => !option.dependsOn || values[option.dependsOn] === true).map((option) => option.type === "boolean"
          ? <div key={option.key} className="flex items-start justify-between gap-4">
              <div className="space-y-1"><Label htmlFor={`option-${option.key}`}>{option.label}</Label>{option.help && <p className="text-xs text-text-muted">{option.help}</p>}</div>
              <Switch id={`option-${option.key}`} checked={values[option.key] === true} onCheckedChange={(checked) => setValues((current) => ({ ...current, [option.key]: checked }))} />
            </div>
          : <div key={option.key} className="space-y-2"><Label htmlFor={`option-${option.key}`}>{option.label}</Label>
              <Textarea id={`option-${option.key}`} rows={3} maxLength={option.max ?? 500} value={String(values[option.key] ?? "")} onChange={(event) => setValues((current) => ({ ...current, [option.key]: event.target.value }))} />
              {option.help && <p className="text-xs text-text-muted">{option.help}</p>}</div>)}
        {error && <Banner variant="danger">{error}</Banner>}
        <DialogFooter><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancelar</Button><Button type="submit" loading={busy}>Salvar</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

function CopyField({ id, label, value }: { id: string; label: string; value: string }) {
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); toast.success("Copiado.") } catch { toast.error("Não foi possível copiar. Selecione o texto e copie à mão.") }
  }
  return <div className="space-y-2"><Label htmlFor={id}>{label}</Label>
    <div className="flex gap-2"><Input id={id} readOnly value={value} onFocus={(event) => event.currentTarget.select()} className="min-w-0 flex-1 font-mono" />
      <Button type="button" variant="secondary" size="icon" aria-label={`Copiar ${label.toLowerCase()}`} onClick={() => void copy()}><Copy className="size-4" aria-hidden="true" /></Button></div></div>
}

function GuideDialog({ connection, step, onClose }: { connection: Connection | null; step: Extract<ConnectStep, { kind: "manual_webhook" }>; onClose: () => void }) {
  return <Dialog open onOpenChange={(open) => !open && onClose()}>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader><DialogTitle>Falta um passo no app da Meta</DialogTitle><DialogDescription>{connection ? `A conexão ${connection.displayName || connection.label} foi salva.` : "A conexão foi salva."} A Meta configura o webhook por app, então ele precisa ser colado lá.</DialogDescription></DialogHeader>
      <div className="space-y-5">
        {step.reason ? <Banner>Não deu para assinar o webhook sozinho: {step.reason}</Banner> : null}
        <NumberedStep n={1} title="Copie a URL"><CopyField id="guide-url" label="URL de retorno" value={step.callbackUrl} /></NumberedStep>
        <NumberedStep n={2} title="Copie o token"><CopyField id="guide-token" label="Token de verificação" value={step.verifyToken} /></NumberedStep>
        <NumberedStep n={3} title="Cole no painel da Meta"><ol className="list-decimal space-y-1 pl-5 text-text-muted">{step.checklist.map((item) => <li key={item}>{item}</li>)}</ol></NumberedStep>
        <Banner>A conexão aparece como “Aguardando webhook” até a Meta enviar o primeiro evento.</Banner>
      </div>
      <DialogFooter><Button onClick={onClose}>Concluir</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}

function RotateDialog({ workspace, connection, onClose, onDone }: { workspace: string; connection: Connection; onClose: () => void; onDone: () => void }) {
  const catalog = useAsync(getConnectionCatalog, "catalog")
  const [values, setValues] = React.useState<Record<string, string>>({})
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const provider = catalog.data?.channels.flatMap((row) => row.providers).find((row) => row.id === connection.provider)
  // The account itself cannot change here, only what proves access to it.
  const fields = provider?.fields.filter((field) => field.secret) ?? []
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const credentials = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim()))
    if (!Object.keys(credentials).length) { setError("Preencha ao menos uma credencial."); return }
    setBusy(true); setError(null)
    try { const result = await rotateConnectionCredentials(connection.id, credentials, workspace); toast.success("Credencial trocada."); if (result.warning) toast.warning(result.warning, { duration: 15_000 }); onDone(); onClose() }
    catch (failure) { setError(messageOf(failure)) }
    finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader><DialogTitle>Trocar credencial</DialogTitle><DialogDescription>{connection.displayName || connection.label}. Contatos e conversas continuam. Deixe em branco o que não quer trocar.</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        {!provider ? <Skeleton className="h-24" /> : fields.map((field, index) => <SecretField key={field.key} field={field} required={false} autoFocus={index === 0} value={values[field.key] ?? ""} onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))} />)}
        {error && <Banner variant="danger">{error}</Banner>}
        <DialogFooter><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancelar</Button><Button type="submit" loading={busy} disabled={!provider}>Trocar credencial</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

function ArchiveDialog({ workspace, connection, onClose, onDone }: { workspace: string; connection: Connection; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [purge, setPurge] = React.useState(false)
  const confirm = async () => {
    setBusy(true); setError(null)
    try { await archiveConnection(connection.id, workspace, purge); toast.success(purge ? "Conexão arquivada e contatos dela excluídos." : "Conexão arquivada."); onDone(); onClose() }
    catch (failure) { setError(messageOf(failure)) }
    finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
    <DialogContent>
      <DialogHeader><DialogTitle>Arquivar conexão</DialogTitle><DialogDescription>{connection.displayName || connection.label} para de receber e enviar mensagens e as credenciais são apagadas (para voltar, conecte de novo). Contatos e conversas continuam salvos{connection.kind === "whatsapp" ? ", e os contatos seguem disponíveis para outra conexão do mesmo número" : ""}. Para só pausar, use Desativar.</DialogDescription></DialogHeader>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 accent-accent" checked={purge} onChange={e => setPurge(e.target.checked)} />
        <span>Excluir também os contatos que só existem nesta conexão{connection.kind === "whatsapp" ? " (no WhatsApp o recomendado é manter: o número pode voltar em outra conexão)" : ""}. Quem também fala por outro canal fica. Não dá para desfazer.</span></label>
      {error && <Banner variant="danger">{error}</Banner>}
      <DialogFooter><Button variant="secondary" disabled={busy} onClick={onClose}>Voltar</Button><Button variant="danger" loading={busy} onClick={() => void confirm()}>{purge ? "Arquivar e excluir contatos" : "Arquivar"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}

type BusinessProfile = { about?: string; description?: string; address?: string; email?: string; websites?: string[]; vertical?: string }
/** Perfil comercial do número do WhatsApp (o que aparece para o cliente ao abrir o perfil da empresa). */
function BusinessProfileButton({ id }: { id: string }) {
  const [open, setOpen] = React.useState(false)
  const [data, setData] = React.useState<BusinessProfile | null>(null)
  const [busy, setBusy] = React.useState(false)
  const path = `/connections/${encodeURIComponent(id)}/business-profile`
  const set = (patch: BusinessProfile) => setData({ ...data, ...patch })
  return <>
    <Button size="sm" variant="secondary" onClick={async () => { setOpen(true); try { setData(await apiRequest<BusinessProfile>(path)) } catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível ler o perfil."); setOpen(false) } }}>Perfil comercial</Button>
    {open ? <Dialog open onOpenChange={o => !o && !busy && setOpen(false)}><DialogContent>
      <DialogHeader><DialogTitle>Perfil comercial do WhatsApp</DialogTitle><DialogDescription>O cliente vê estes dados ao tocar no nome da empresa.</DialogDescription></DialogHeader>
      {!data ? <Skeleton className="h-40" /> : <form className="space-y-3" onSubmit={async e => {
        e.preventDefault(); setBusy(true)
        const clean = Object.fromEntries(Object.entries({ ...data, websites: (data.websites ?? []).filter(Boolean) }).filter(([, v]) => v !== undefined && v !== ""))
        try { await apiRequest(path, { method: "PUT", body: JSON.stringify(clean) }); toast.success("Perfil comercial salvo."); setOpen(false) } catch (err) { toast.error(err instanceof Error ? err.message : "Não foi possível salvar.") } finally { setBusy(false) }
      }}>
        {([["about", "Sobre (até 139)", 139], ["description", "Descrição", 512], ["address", "Endereço", 256], ["email", "E-mail", 128], ["vertical", "Setor", 64]] as const).map(([key, label, max]) =>
          <div key={key} className="space-y-1"><Label htmlFor={`bp-${key}`}>{label}</Label><Input id={`bp-${key}`} maxLength={max} value={data[key] ?? ""} onChange={e => set({ [key]: e.target.value })} /></div>)}
        {[0, 1].map(i => <div key={i} className="space-y-1"><Label htmlFor={`bp-site-${i}`}>Site {i + 1}</Label><Input id={`bp-site-${i}`} type="url" placeholder="https://" value={data.websites?.[i] ?? ""} onChange={e => { const sites = [...(data.websites ?? [])]; sites[i] = e.target.value; set({ websites: sites }) }} /></div>)}
        <DialogFooter><Button type="button" variant="secondary" disabled={busy} onClick={() => setOpen(false)}>Cancelar</Button><Button type="submit" loading={busy}>Salvar</Button></DialogFooter>
      </form>}
    </DialogContent></Dialog> : null}
  </>
}

const pitch: Record<string, string> = {
  telegram: "Crie um bot para atender no Telegram com respostas automáticas, botões e transmissões sem janela de 24 horas. Conecte o bot em poucos minutos e comece a conversar.",
  whatsapp: "WhatsApp Business: atendimento, modelos aprovados fora da janela, catálogo e carrinho.",
  instagram: "Instagram: DMs, comentários em posts e lives, respostas a stories e menções.",
  messenger: "Messenger da sua página: DMs, comentários nos posts, menu persistente e iniciadores de conversa.",
  email: "E-mail: transmissões e automações com editor de blocos, remetente e domínio próprios.",
}
/** Canais ainda não conectados: o que cada um faz e o botão para conectar já com o canal escolhido. */
function AvailableChannels({ channels, onConnect }: { channels: CatalogChannel[]; onConnect: (kind: string) => void }) {
  if (!channels.length) return null
  return <section aria-label="Canais disponíveis" className="space-y-2">
    <h3 className="text-sm font-semibold text-text-muted">Conecte também</h3>
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">{channels.map(c => <li key={c.kind} className="flex flex-col justify-between gap-3 rounded-lg border border-border bg-surface p-4">
      <div><p className="font-semibold">{c.label}</p><p className="text-sm text-text-muted">{pitch[c.kind] ?? "Receba e responda mensagens por este canal."}</p></div>
      <Button size="sm" variant="secondary" onClick={() => onConnect(c.kind)}>Conectar {c.label}</Button></li>)}</ul>
  </section>
}

/** Encurtador de links do corpo do texto: cada link vira um endereço curto com clique contado. Desligado, não há taxa de cliques no texto. */
function ShortenLinks({ id }: { id: string }) {
  const [on, setOn] = React.useState(false)
  return <label className="mt-3 flex items-center gap-2 border-t border-border pt-2"><input type="checkbox" className="accent-accent" checked={on} onChange={e => { const v = e.target.checked; setOn(v)
    void apiRequest(`/connections/${encodeURIComponent(id)}/shorten-links`, { method: "PUT", body: JSON.stringify({ enabled: v }) }).then(() => toast.success(v ? "Links do texto serão encurtados." : "Encurtador desligado: cliques no texto deixam de ser contados.")).catch((err: Error) => toast.error(err.message)) }} />
    Encurtar links do texto e contar cliques</label>
}

type Catalog = { catalogId: string | null; products: { id: string; retailerId: string; name: string; price?: string; imageUrl?: string; availability?: string }[] }
/** Aba Catálogo: produtos do catálogo ligado à conta do WhatsApp (o contato pode mandá-los como carrinho). */
function CatalogButton({ id }: { id: string }) {
  const [data, setData] = React.useState<Catalog | null>(null)
  const [open, setOpen] = React.useState(false)
  return <>
    <Button size="sm" variant="secondary" onClick={async () => { setOpen(true); try { setData(await apiRequest<Catalog>(`/connections/${encodeURIComponent(id)}/catalog`)) } catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível ler o catálogo."); setOpen(false) } }}>Catálogo</Button>
    {open ? <Dialog open onOpenChange={setOpen}><DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader><DialogTitle>Catálogo de produtos</DialogTitle><DialogDescription>Produtos do catálogo ligado a esta conta. Edite-os no gerenciador de comércio do provedor.</DialogDescription></DialogHeader>
      {!data ? <p role="status" className="text-sm text-text-muted">Carregando…</p> : !data.catalogId ? <p className="text-sm text-text-muted">Nenhum catálogo ligado a esta conta.</p>
        : <ul className="divide-y divide-border">{data.products.map(p => <li key={p.id} className="flex items-center gap-3 py-2 text-sm">
          {p.imageUrl ? <img src={p.imageUrl} alt="" className="size-12 rounded-md object-cover" /> : null}
          <div className="min-w-0 flex-1"><p className="font-medium">{p.name}</p><p className="text-xs text-text-muted">{p.retailerId}{p.availability ? ` · ${p.availability === "in stock" ? "em estoque" : p.availability}` : ""}</p></div>
          {p.price ? <span>{p.price}</span> : null}</li>)}</ul>}
    </DialogContent></Dialog> : null}
  </>
}

type ReviewItem = { feature: string; source: "permission" | "messaging_feature"; status: string }
const reviewTone = (status: string) => ["granted", "approved"].includes(status) ? "text-success" : ["declined", "rejected", "expired"].includes(status) ? "text-danger" : "text-text-muted"
const reviewLabel: Record<string, string> = { granted: "concedida", declined: "recusada", expired: "expirada", approved: "aprovado", pending: "em análise", rejected: "rejeitado", limited: "limitado" }
/** Revisão de recursos da Meta: permissões do token e recursos de mensagem da página, cada um com seu status. */
function MetaReviewButton({ id }: { id: string }) {
  const [items, setItems] = React.useState<ReviewItem[] | null>(null)
  const [open, setOpen] = React.useState(false)
  const group = (source: ReviewItem["source"], title: string) => {
    const list = items?.filter(i => i.source === source) ?? []
    return list.length ? <div><p className="mt-2 text-xs font-medium text-text-muted">{title}</p><ul className="divide-y divide-border">{list.map(i => <li key={i.feature} className="flex justify-between py-1.5 text-sm"><code>{i.feature}</code><span className={reviewTone(i.status)}>{reviewLabel[i.status] ?? i.status}</span></li>)}</ul></div> : null
  }
  return <>
    <Button size="sm" variant="secondary" onClick={async () => { setOpen(true); try { setItems((await apiRequest<{ items: ReviewItem[] }>(`/connections/${encodeURIComponent(id)}/meta-review`)).items) } catch (e) { toast.error(e instanceof Error ? e.message : "Não foi possível ler a revisão."); setOpen(false) } }}>Revisão de recursos</Button>
    {open ? <Dialog open onOpenChange={setOpen}><DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader><DialogTitle>Revisão de recursos</DialogTitle><DialogDescription>O que esta conexão pode usar na Meta e o status de cada recurso.</DialogDescription></DialogHeader>
      {!items ? <p role="status" className="text-sm text-text-muted">Carregando…</p> : <>{group("messaging_feature", "Recursos de mensagem")}{group("permission", "Permissões")}</>}
    </DialogContent></Dialog> : null}
  </>
}


/** Nome de usuário do número no WhatsApp: pedido pela tela; a Meta reserva e aprova depois. */
function UsernameButton({ id, row }: { id: string; row?: boolean }) {
  const [open, setOpen] = React.useState(false)
  const [current, setCurrent] = React.useState<{ username?: string; status?: string } | null>(null)
  const [value, setValue] = React.useState("")
  const path = `/connections/${encodeURIComponent(id)}/username`
  const load = () => apiRequest<{ username?: string; status?: string }>(path).then(setCurrent).catch(() => setCurrent({}))
  const valid = /^(?![^.]*\.(com|net|org|br|io)$)[a-z0-9._]{3,35}$/i.test(value)
  return <>
    {row ? <Button variant="secondary" className="w-full" onClick={() => { setOpen(true); void load() }}>Solicitar nome de usuário</Button> : <Button size="sm" variant="ghost" onClick={() => { setOpen(true); void load() }}>Nome de usuário</Button>}
    {open ? <Dialog open onOpenChange={setOpen}><DialogContent>
      <DialogHeader><DialogTitle>Nome de usuário</DialogTitle><DialogDescription>Os contatos encontram o número por este nome. O pedido fica reservado até a Meta aprovar.</DialogDescription></DialogHeader>
      <p className="text-sm">{current?.username ? <>Atual: <code>@{current.username}</code> <span className="text-text-muted">({current.status === "approved" ? "aprovado" : current.status === "reserved" ? "reservado" : current.status ?? "—"})</span></> : <span className="text-text-muted">Sem nome de usuário.</span>}</p>
      <input aria-label="Novo nome de usuário" className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" value={value} onChange={e => setValue(e.target.value.trim())} placeholder="minha.loja" />
      <p className="text-xs text-text-muted">3 a 35 letras, números, ponto ou sublinhado; não pode terminar em domínio (.com, .br…).</p>
      <div className="flex justify-end gap-2">
        {current?.username ? <Button size="sm" variant="ghost" onClick={() => void apiRequest(path, { method: "DELETE" }).then(() => { toast.success("Nome de usuário apagado."); void load() }).catch((e: Error) => toast.error(e.message))}>Apagar</Button> : null}
        <Button size="sm" disabled={!valid} onClick={() => void apiRequest(path, { method: "POST", body: JSON.stringify({ username: value }) }).then(() => { toast.success("Pedido enviado à Meta."); void load() }).catch((e: Error) => toast.error(e.message))}>Pedir</Button>
      </div>
    </DialogContent></Dialog> : null}
  </>
}
