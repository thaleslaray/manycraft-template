import { apiRequest, isFakeMode } from "./api"

/** Conexões de canal. No modo real tudo vem do engine; credenciais só vão do formulário para o engine e nunca voltam. */
/** Conexões da Meta que têm o botão "Revisão de recursos" (precisa bater com `metaProviders` do motor, em meta-review.ts). */
export const metaReviewProviders = ["meta_whatsapp_cloud", "instagram_unified", "messenger_page"]
export const hasMetaReview = (connection: { provider: string; status: string }) => metaReviewProviders.includes(connection.provider) && connection.status === "connected"

export type CredentialField = { key: string; label: string; secret: boolean; optional?: boolean; help?: string; pattern?: string }
/** A setting the provider adds to its connections (off or empty by default). The official WhatsApp has none, so the panel shows none for it. */
export type OptionField = { key: string; label: string; type: "boolean" | "text"; help?: string; max?: number; dependsOn?: string }
export type CatalogProvider = { profile?: Connection["profile"]; id: string; label: string; fields: CredentialField[]; webhook: "auto" | "manual"; /** Provedor de passo manual que tenta registrar o webhook sozinho antes: o que dizer embaixo do formulário. */ webhookNote?: string; notice?: string; pairing?: "qr"; options?: OptionField[] }
export type CatalogChannel = { kind: string; label: string; providers: CatalogProvider[] }
export type ConnectionState = "pending" | "connecting" | "connected" | "disconnected" | "error" | "restricted"
export type Connection = {
  id: string; kind: string; provider: string; label: string; displayName: string | null; externalId: string
  status: ConnectionState; active?: boolean; pairing?: string | null; statusDetail: string | null; hasCredentials: boolean; createdAt: number; credentialsRotatedAt: number | null
  /** note: onde o provedor registrou o webhook sozinho (WhatsApp oficial: no número), quando ele diz. */
  webhook: { mode: "auto" | "manual"; registered: boolean; url: string | null; subscribedAt: number | null; note?: string | null }
  /** Current values of the provider's options (never a credential). */
  profile?: { conversationStarters?: { maxItems: number; titleMax: number } | null; initiator?: "user" | "business_with_template" | "business_with_optin"; identity?: { key: string }; unstable?: ("buttons" | "list" | "cards")[]; text?: { maxLength: number; unit: "chars" | "bytes" }; list?: { maxRows: number; maxSections: number; rowTitleMax: number; rowDescMax: number } | null; groups?: { inbound: boolean; reply: boolean; mentionDetect: boolean } | null; inbound?: { message: boolean; comment?: boolean; storyReply?: boolean }; comments?: { posts: boolean; publicReply: boolean; like: boolean; privateReply?: { textMaxLength: number; urlButtonsMax: number } }; stories?: { reply: boolean; mention: boolean; heart: boolean; list: boolean } | null; cards?: import("../../../engine/src/schemas/message-cards").CardsProfile["cards"]; buttons?: import("../../../engine/src/schemas/message-cards").CardsProfile["buttons"]; quickReplies?: { max: number; titleMax: number } | null; typing?: { maxSeconds: number } | null; window?: { standardHours: number } | null; media?: import("../../../engine/src/schemas/message-media").MediaProfile["media"]; email?: { subjectMaxLength: number; preheader: boolean; html: boolean; unsubscribe: "marketing" } }
  settings: Record<string, unknown>
  /** O que a Meta avisou sobre a conta (qualidade, limites, alertas, restrições, revisão). Vazio até o primeiro aviso. */
  health?: import("./account-health").AccountHealth
  /** O WhatsApp oficial ainda não sabe qual é a conta do WhatsApp Business (WABA) desta conexão: os avisos da conta (qualidade, limites, alertas) não chegam. */
  accountIdMissing?: boolean
  /** Só na lista (`listConnections`): contatos não excluídos ligados a esta conexão, o mesmo `total` de `listContacts` com `connection_id`. */
  contactTotal?: number
}
export type ConnectStep =
  | { kind: "done"; externalId: string; /** Onde o webhook foi registrado, para o aviso depois de conectar. */ notice?: string }
  | { kind: "manual_webhook"; callbackUrl: string; verifyToken: string; checklist: string[]; reason?: string }
  | { kind: "failed"; code: string; detail: string }
  | { kind: "qr"; qr: string; expiresAt: number; externalId?: string }
  | { kind: "pairing_code"; [key: string]: unknown }
export type CreateConnectionInput = { kind: string; provider?: string; displayName?: string; credentials: Record<string, string> }

const fakeCatalog: CatalogChannel[] = [
  { kind: "telegram", label: "Telegram", providers: [{ id: "telegram_bot", label: "Telegram", webhook: "auto",
    fields: [{ key: "botToken", label: "Token do bot", secret: true, pattern: "^\\d+:[A-Za-z0-9_-]+$", help: "Criado no @BotFather." }] }] },
  { kind: "whatsapp", label: "WhatsApp", providers: [{ id: "meta_whatsapp_cloud", label: "WhatsApp", webhook: "manual", fields: [
    { key: "accessToken", label: "Token de acesso", secret: true }, { key: "phoneNumberId", label: "ID do número de telefone", secret: false, pattern: "^\\d+$" },
    { key: "appSecret", label: "Chave secreta do app", secret: true }, { key: "verifyToken", label: "Token de verificação", secret: true, optional: true, help: "Em branco: geramos um." }] }] },
  { kind: "instagram", label: "Instagram", providers: [
    { id: "instagram_unified", label: "Instagram", webhook: "manual", notice: "Para apps da Meta criados com 'API setup with Unified login'. Ao criar a configuração, escolha a expiração 'O token nunca expira': o painel não renova o token e só avisa quando ele já venceu. Cole o token gerado no card 'Gerar tokens de acesso' e o ID que aparece embaixo do @.", fields: [
      { key: "accessToken", label: "Token de acesso", secret: true }, { key: "accountId", label: "ID da conta do Instagram", secret: false, pattern: "^\\d+$", help: "O número que aparece embaixo do @ no painel da Meta." },
      { key: "appSecret", label: "Chave secreta do app da Meta", secret: true, help: "Painel da Meta: Configurações do app > Básico > Chave secreta do app." }] }] },
]
const fakeOptions: OptionField[] = [
  { key: "typing", type: "boolean", label: "Mostrar “digitando…” antes de enviar" },
  { key: "markRead", type: "boolean", label: "Marcar como lida ao receber" },
  { key: "rejectCalls", type: "boolean", label: "Recusar ligações" },
  { key: "rejectCallMessage", type: "text", max: 500, dependsOn: "rejectCalls", label: "Mensagem ao recusar a ligação" },
  { key: "unopenedMessageText", type: "text", max: 500, label: "Texto para mensagem que não pôde ser aberta" },
]
fakeCatalog.find((row) => row.kind === "whatsapp")!.providers.push({ id: "uazapi", label: "WhatsApp não oficial (UAZAPI)", profile: { inbound: { message: true }, groups: { inbound: true, reply: true, mentionDetect: true } }, webhook: "auto", pairing: "qr", options: fakeOptions,
  notice: "Esta conexão não é oficial. O WhatsApp pode bloquear o número, principalmente se você mandar mensagem para quem não escreveu primeiro ou enviar em volume.",
  fields: [{ key: "serverUrl", label: "Endereço do servidor", secret: false, pattern: "^https://[^\\s/]+/?$" }, { key: "token", label: "Token da instância", secret: true }] })
const fakeStore = new Map<string, Connection[]>()
const fakeList = (workspace: string) => { let list = fakeStore.get(workspace); if (!list) fakeStore.set(workspace, list = []); return list }
const fakeWorkspace = "demo"
/** Espaço nas pontas (colar com quebra de linha) nunca faz parte da credencial; campo vazio nem é enviado. */
const cleanCredentials = (credentials: Record<string, string>) =>
  Object.fromEntries(Object.entries(credentials).map(([key, value]) => [key, value.trim()] as const).filter(([, value]) => value))

export async function getConnectionCatalog(): Promise<{ channels: CatalogChannel[] }> {
  if (isFakeMode()) return { channels: structuredClone(fakeCatalog) }
  return apiRequest("/connections/catalog")
}
export async function listConnections(workspace: string = fakeWorkspace): Promise<Connection[]> {
  if (isFakeMode()) return structuredClone(fakeList(workspace))
  return apiRequest("/connections")
}
/** `warning`: o que o provedor corrigiu sozinho ao conectar (ex.: a conta informada não era a dona do número), para avisar a pessoa. */
export async function createConnection(raw: CreateConnectionInput, workspace: string = fakeWorkspace): Promise<{ connection: Connection; step: ConnectStep; warning?: string }> {
  const input = { ...raw, credentials: cleanCredentials(raw.credentials) }
  if (!isFakeMode()) return apiRequest("/connections", { method: "POST", body: JSON.stringify(input) })
  const channel = fakeCatalog.find((row) => row.kind === input.kind)
  const provider = channel?.providers.find((row) => !input.provider || row.id === input.provider)
  if (!provider) throw new Error("Este canal ainda não pode ser conectado pelo painel.")
  for (const field of provider.fields) {
    const value = input.credentials[field.key]
    if (!value && !field.optional) throw new Error(`${field.label}: preencha o campo.`)
    if (value && field.pattern && !new RegExp(field.pattern).test(value)) throw new Error(`${field.label}: formato inválido.`)
  }
  // The bot id is the number before the colon in the token, like the engine's getMe would return.
  const externalId = provider.pairing ? `${provider.id}:${input.credentials.token?.slice(0, 6)}`
    : input.credentials.phoneNumberId ?? input.credentials.accountId ?? input.credentials.botToken?.split(":")[0] ?? "1000"
  if (fakeList(workspace).some((row) => row.kind === input.kind && row.externalId === externalId)) throw new Error(input.kind === "instagram" ? "Esta conta já está conectada. Se for a conexão antiga, arquive-a em Configurações > Canais e conecte de novo." : "Esta conta já está conectada.")
  const manual = provider.webhook === "manual"
  const pairing = provider.pairing === "qr"
  const connection: Connection = { id: crypto.randomUUID(), kind: input.kind, provider: provider.id, label: provider.label, displayName: input.displayName || null,
    externalId, status: manual ? "pending" : pairing ? "connecting" : "connected", statusDetail: manual ? "Aguardando a configuração do webhook." : pairing ? "Aguardando a leitura do QR code." : null, hasCredentials: true, settings: {},
    createdAt: Date.now(), credentialsRotatedAt: Date.now(), profile: provider.profile ?? { inbound: { message: true } }, webhook: { mode: provider.webhook, subscribedAt: null, registered: !manual, url: manual ? "https://exemplo.test/api/webhooks/meta" : "https://exemplo.test/api/hooks/demo" } }
  fakeList(workspace).push(connection)
  if (pairing) return { connection: structuredClone(connection), step: { kind: "qr", qr: "", expiresAt: Date.now() + 60_000, externalId } }
  return { connection: structuredClone(connection), step: manual
    ? { kind: "manual_webhook", callbackUrl: connection.webhook.url!, verifyToken: input.credentials.verifyToken || "token-de-demonstracao", checklist: ["Cole a URL e o token no app da Meta."] }
    : { kind: "done", externalId } }
}
export async function rotateConnectionCredentials(id: string, raw: Record<string, string>, workspace: string = fakeWorkspace): Promise<{ rotatedAt: number; step: ConnectStep; warning?: string }> {
  const credentials = cleanCredentials(raw)
  if (!isFakeMode()) return apiRequest(`/connections/${encodeURIComponent(id)}/rotate`, { method: "POST", body: JSON.stringify({ credentials }) })
  const row = fakeList(workspace).find((item) => item.id === id)
  if (!row) throw new Error("Conexão não encontrada.")
  if (!Object.keys(credentials).length) throw new Error("Informe a nova credencial.")
  row.credentialsRotatedAt = Date.now()
  return { rotatedAt: row.credentialsRotatedAt, step: { kind: "done", externalId: row.externalId } }
}
export async function getConnectionWebhookStep(id: string, workspace: string = fakeWorkspace): Promise<ConnectStep> {
  if (!isFakeMode()) return (await apiRequest<{ step: ConnectStep }>(`/connections/${encodeURIComponent(id)}/webhook`, { method: "POST" })).step
  const row = fakeList(workspace).find((item) => item.id === id)
  if (!row) throw new Error("Conexão não encontrada.")
  return { kind: "manual_webhook", callbackUrl: row.webhook.url ?? "", verifyToken: "token-de-demonstracao", checklist: ["Cole a URL e o token no app da Meta."] }
}
/** Our roles under WhatsApp Conversation Routing (several partners sharing one number). Not active: this app is the only responder. */
export type ConnectionRouting = { active: boolean; roles: string[]; standby: boolean }
export async function getConnectionRouting(id: string): Promise<ConnectionRouting> {
  if (!isFakeMode()) return apiRequest(`/connections/${encodeURIComponent(id)}/routing`)
  return { active: true, roles: ["customer_service", "escalation"], standby: false }
}
/** Is the account enabled for the WhatsApp Marketing Messages API? `notice` says what to do while it is not; `error` says the last check failed (the rest keeps the last answer). */
export type ConnectionMarketing = { supported: boolean; enabled: boolean; status: string | null; checkedAt: number | null; cloudMarketingDisabled: boolean | null; notice: string | null; error?: string }
export async function getConnectionMarketing(id: string, check = false): Promise<ConnectionMarketing> {
  if (!isFakeMode()) return apiRequest(`/connections/${encodeURIComponent(id)}/marketing`, check ? { method: "POST" } : undefined)
  return { supported: true, enabled: false, status: "ELIGIBLE", checkedAt: Date.now(), cloudMarketingDisabled: false,
    notice: "Esta conta ainda não usa a API de Mensagens de Marketing da Meta; os modelos de marketing seguem pela API de nuvem. A Meta encerra o marketing na API de nuvem em 13/10/2027 (contas criadas a partir de 13/04/2027 já não enviam marketing por ela). Para continuar enviando, aceite os termos no Gerenciador do WhatsApp (Visão geral, Alertas, Aceitar termos). Depois use Verificar de novo." }
}
export async function archiveConnection(id: string, workspace: string = fakeWorkspace, deleteContacts = false): Promise<void> {
  if (!isFakeMode()) { await apiRequest<null>(`/connections/${encodeURIComponent(id)}${deleteContacts ? "?delete_contacts=1" : ""}`, { method: "DELETE" }); return }
  const list = fakeList(workspace), index = list.findIndex((item) => item.id === id)
  if (index < 0) throw new Error("Conexão não encontrada.")
  list.splice(index, 1)
}
/** Where the pairing stands: a fresh QR code while it waits to be read, `done` once the number is paired. The QR dialog asks every few seconds. */
export async function pollConnectionPairing(id: string, workspace: string = fakeWorkspace): Promise<{ connection: Connection; step: ConnectStep }> {
  if (!isFakeMode()) return apiRequest(`/connections/${encodeURIComponent(id)}/connect`, { method: "POST" })
  const row = fakeList(workspace).find((item) => item.id === id)
  if (!row) throw new Error("Conexão não encontrada.")
  row.status = "connected"; row.statusDetail = null
  return { connection: structuredClone(row), step: { kind: "done", externalId: row.externalId } }
}
/** Name and the provider's options. */
export async function updateConnection(id: string, patch: { displayName?: string; settings?: Record<string, unknown> }, workspace: string = fakeWorkspace): Promise<Connection> {
  if (!isFakeMode()) return apiRequest(`/connections/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) })
  const row = fakeList(workspace).find((item) => item.id === id)
  if (!row) throw new Error("Conexão não encontrada.")
  if (patch.displayName !== undefined) row.displayName = patch.displayName.trim() || null
  for (const [key, value] of Object.entries(patch.settings ?? {})) {
    const option = fakeCatalog.flatMap((c) => c.providers).find((p) => p.id === row.provider)?.options?.find((o) => o.key === key)
    if (!option) throw new Error(`Opção desconhecida: ${key}.`)
    if (typeof value === "string" && !value.trim()) delete row.settings[key]; else row.settings[key] = value
  }
  return structuredClone(row)
}

export type ConnectionGroup = { id: string; externalGroupId: string; subject: string | null }
/** Grupos do número conectado (uma página de resumos). Cada grupo listado já ganha seu registro no engine, então o gatilho pode apontar para ele. */
export async function listConnectionGroups(id: string, query: { search?: string; offset?: number } = {}): Promise<{ groups: ConnectionGroup[]; nextOffset: number | null }> {
  if (isFakeMode()) {
    const all: ConnectionGroup[] = [{ id: "grp-fake-1", externalGroupId: "120363153742561022@g.us", subject: "Clube da Loja" }, { id: "grp-fake-2", externalGroupId: "120363000000000002@g.us", subject: "Suporte" }]
    const term = query.search?.trim().toLocaleLowerCase("pt-BR")
    return { groups: all.filter((g) => !term || g.subject?.toLocaleLowerCase("pt-BR").includes(term)), nextOffset: null }
  }
  const params = new URLSearchParams({ limit: "50", offset: String(query.offset ?? 0), ...(query.search?.trim() ? { search: query.search.trim() } : {}) })
  return apiRequest(`/connections/${encodeURIComponent(id)}/groups?${params}`)
}

/** Um item da conferência da conexão: ok, falta (a conexão não funciona sem) ou não conferido, com o passo para resolver. */
export type PermissionItem = { key: string; label: string; status: "ok" | "missing" | "unknown" | "unavailable"; fix?: string }

/** Atualizar conexão: o motor revalida credenciais e permissões no provedor e reassina o webhook automático. */
export async function refreshConnection(id: string): Promise<{ ok: boolean; detail: string | null; permissions: PermissionItem[] | null; warning?: string }> {
  if (isFakeMode()) return { ok: true, detail: null, permissions: null }
  return apiRequest(`/connections/${encodeURIComponent(id)}/refresh`, { method: "POST" })
}

/** Desativar sem apagar (reversível) ou reativar: reativar revalida a conexão no provedor. */
export async function setConnectionEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; detail: string | null }> {
  if (isFakeMode()) return { ok: true, detail: null }
  return apiRequest(`/connections/${encodeURIComponent(id)}/enabled`, { method: "POST", body: JSON.stringify({ enabled }) })
}
