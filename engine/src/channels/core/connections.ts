import { HTTPException } from 'hono/http-exception'
import { NO_CREDENTIALS, ProviderRefusal } from './meta-error'
import type { BusinessProfile } from '../contract'
import type { IntegrationEnv } from '../../integrations'
import type { ChannelProfile, CommentPostsPage, ConnectContext, ConnectStep, Credentials, PermissionItem, ProfilePatch, StoredProvider } from '../contract'
import { effectiveProfile } from './profile-merge'
import { capabilities } from '../capabilities'
import { hasDefaultProvider, providerFor, providerIds, providers, type ConnectSpec, type OptionField, type ProviderMeta } from '../providers'
import { providerAdapterById, resolveProviderAdapter } from '../registry'
import type { ChannelType } from '../types'
import { connectionFromRow, liteRow } from './connection'
import { openRow } from './credentials'
import { encryptCredentials } from './crypto'
import { digest } from './webhook-http'
import { upsertGroupThread } from './groups'
import { effectiveConnectionState, INITIAL_STATE, moveConnection, moveConnectionStatement } from './connection-state'

/** Connection as the panel sees it: state and webhook facts, never a credential. */
export type ConnectionView = {
  id: string; kind: ChannelType; provider: string; label: string; displayName: string | null; externalId: string
  status: string; active: boolean; pairing: string | null; statusDetail: string | null; hasCredentials: boolean; createdAt: number; credentialsRotatedAt: number | null
  /** The provider's options with their current values (never a credential). */
  settings: Record<string, unknown>
  profile: ChannelProfile
  /** What the provider announced about the account behind the connection (quality, limits, alerts, restrictions, review), each part with the time of the notice. */
  health: Record<string, unknown>
  /** The provider has an account above the number (WhatsApp: the business account) and this connection does not know it yet: account notices cannot reach it. */
  accountIdMissing: boolean
  webhook: { mode: 'auto' | 'manual'; registered: boolean; url: string | null
    /** When this server subscribed the account's webhooks on the provider (null: nobody did). Only the first real delivery makes the connection `connected`. */
    subscribedAt: number | null
    /** Where the provider registered the webhook on its own (pt-BR), when it says so. */
    note: string | null }
  /** Só na lista: contatos não excluídos ligados a esta conexão (a mesma conta do `total` de `GET /contacts?connection_id=`). */
  contactTotal?: number
}
export type CatalogProvider = { id: string; label: string; fields: ConnectSpec['fields']; webhook: ConnectSpec['webhook']; webhookNote?: string; notice?: string; pairing?: 'qr'; options?: OptionField[] }
export type CatalogEntry = { kind: ChannelType; label: string; providers: CatalogProvider[] }

export const fail = (status: 400 | 404 | 409 | 422, message: string) => new HTTPException(status, { message })
export const random = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

/** Channels the panel can connect, each with its providers (a single provider means the panel skips that step). */
export function catalog(): CatalogEntry[] {
  const byKind = new Map<ChannelType, ProviderMeta[]>()
  for (const id of providerIds) {
    const meta = providers[id]
    if (!meta.connect || !meta.live || meta.frozen) continue
    for (const kind of meta.kinds) byKind.set(kind, [...byKind.get(kind) ?? [], meta])
  }
  return [...byKind].map(([kind, list]) => ({ kind, label: list[0].label,
    providers: list.map(meta => ({ id: meta.id, label: meta.label, fields: meta.connect!.fields, webhook: meta.connect!.webhook, ...(meta.connect!.autoWebhook ? { webhookNote: meta.connect!.autoWebhook.form } : {}), ...(meta.connect!.notice ? { notice: meta.connect!.notice } : {}), ...(meta.connect!.pairing ? { pairing: meta.connect!.pairing } : {}), ...(meta.options ? { options: meta.options } : {}) })) }))
}

type Row = { id: string; workspace_id: string; type: ChannelType; provider: StoredProvider; external_id: string; display_name: string | null; settings: string; capabilities_override?: string | null
  status: string; connection_state: string; status_detail: string | null; webhook_mode: 'auto' | 'manual'; webhook_registered_at: number | null
  has_credentials: number; provider_health: string; created_at: number; credentials_rotated_at: number | null; webhook_secret_hash: string | null }
const columns = `id, workspace_id, type, provider, external_id, display_name, settings, capabilities_override, status, connection_state, status_detail, webhook_mode,
  webhook_registered_at, credentials_ciphertext IS NOT NULL AS has_credentials, provider_health, created_at, credentials_rotated_at, webhook_secret_hash`

const hookUrl = (base: string, spec: ConnectSpec, id: string) => spec.hook === 'connection' ? `${base}/api/hooks/${id}` : `${base}/api/webhooks/meta`

/** Provider metadata of a row; a stored provider missing from the catalog falls back to the channel's default instead of crashing. */
const metaOf = (row: Pick<Row, 'type' | 'provider'>): ProviderMeta =>
  providers[row.provider as keyof typeof providers] ?? providers[defaultProviderOf(row.type)]

function view(row: Row, base: string): ConnectionView {
  const meta = metaOf(row)
  return { id: row.id, kind: row.type, provider: meta.id, label: meta.label, displayName: row.display_name, externalId: row.external_id,
    // A desativada pela equipe vence a saúde do provedor: o painel inteiro mostra um estado só (Início lê a mesma regra).
    status: effectiveConnectionState(row), active: row.status !== 'disconnected', pairing: meta.connect?.pairing ?? null, statusDetail: row.status_detail, hasCredentials: row.has_credentials === 1, createdAt: row.created_at,
    credentialsRotatedAt: row.credentials_rotated_at, settings: optionValues(meta, row.settings),
    profile: effectiveProfile(row.type, meta.id, row.capabilities_override ? JSON.parse(row.capabilities_override) as ProfilePatch : undefined),
    health: healthOf(row.provider_health),
    accountIdMissing: !!meta.connect?.accountIdField && typeof settingsOf(row.settings).accountId !== 'string',
    webhook: { mode: row.webhook_mode, registered: row.webhook_registered_at !== null, url: meta.connect ? hookUrl(base, meta.connect, row.id) : null, subscribedAt: subscribedAtOf(row.settings),
      note: meta.connect?.autoWebhook && row.webhook_mode === 'auto' && row.webhook_registered_at !== null ? meta.connect.autoWebhook.done : null } }
}
/** Only the settings the provider declares as options go to the panel; the rest of the column (development overrides) stays server side. */
function optionValues(meta: ProviderMeta, stored: string): Record<string, unknown> {
  let all: Record<string, unknown> = {}
  try { all = JSON.parse(stored) as Record<string, unknown> } catch { /* an unreadable column shows no options */ }
  return Object.fromEntries((meta.options ?? []).filter(option => option.key in all).map(option => [option.key, all[option.key]]))
}
/** What the panel sees of the health: a part the provider cleared (kept as a mark with its time, so a late older notice cannot bring it back) is not shown. */
function healthOf(stored: string): Record<string, unknown> {
  const cleared = (part: unknown) => !!part && typeof part === 'object' && (part as { cleared?: unknown }).cleared === true
  try {
    const all = JSON.parse(stored) as unknown
    if (!all || typeof all !== 'object') return {}
    return Object.fromEntries(Object.entries(all as Record<string, unknown>).filter(([, part]) => !cleared(part)).map(([key, part]) => key === 'alerts' && part && typeof part === 'object'
      ? [key, Object.fromEntries(Object.entries(part as Record<string, unknown>).filter(([, alert]) => !cleared(alert)))] : [key, part]))
  } catch { return {} }
}
const settingsOf = (stored: string): Record<string, unknown> => { try { return JSON.parse(stored) as Record<string, unknown> } catch { return {} } }
/** Server side bookkeeping kept in the settings column (never shown as an option). */
function subscribedAtOf(stored: string): number | null {
  try { const at = (JSON.parse(stored) as Record<string, unknown>).subscribedAt; return typeof at === 'number' ? at : null } catch { return null }
}
/** O padrão do canal (providers.ts, `defaults`), não o primeiro da lista: o primeiro é só o que o painel oferece antes. */
const defaultProviderOf = (kind: ChannelType) => hasDefaultProvider(kind) ? providerFor(kind) : providerIds.find(id => providers[id].kinds.includes(kind))!

async function find(env: IntegrationEnv, workspaceId: string, id: string): Promise<Row> {
  const row = await env.DB.prepare(`SELECT ${columns} FROM channels WHERE workspace_id=? AND id=? AND archived_at IS NULL`).bind(workspaceId, id).first<Row>()
  if (!row) throw fail(404, 'Conexão não encontrada.')
  return row
}

/** What the provider read while connecting and the core keeps: health parts (a value sets, `null` clears with the time of the clearing, like a
 * cleared notice) and, when the provider proved it, the account above the connection. A part older than the one kept is not replaced. */
async function keepConnectFacts(env: IntegrationEnv, workspaceId: string, id: string, step: ConnectStep, spec: ConnectSpec | undefined, current?: unknown): Promise<void> {
  if (step.kind !== 'done') return
  const at = Date.now()
  const writes = Object.entries(step.health ?? {}).filter(([key]) => /^[A-Za-z]{1,40}$/.test(key)).map(([key, value]) =>
    env.DB.prepare(`UPDATE channels SET provider_health = json_set(provider_health, '$.' || ?, json(?)) WHERE workspace_id = ? AND id = ?
      AND coalesce(json_extract(provider_health, '$.' || ? || '.at'), 0) <= ?`).bind(key, JSON.stringify(value === null ? { cleared: true, at } : { ...value, at }), workspaceId, id, key, at))
  if (spec?.accountIdField && step.accountId && step.accountId !== current)
    writes.push(env.DB.prepare("UPDATE channels SET settings=json_set(settings,'$.accountId',?) WHERE workspace_id=? AND id=?").bind(step.accountId, workspaceId, id))
  if (writes.length) await env.DB.batch(writes)
}
const warningOf = (step: ConnectStep) => step.kind === 'done' && step.warning ? { warning: step.warning } : {}

/** A connection made before the account id was proved has none stored: ask the provider once with the connection's own credentials, and again
 * only after a while when it did not say. What the panel shows is `accountIdMissing` until the provider names the account. */
const ACCOUNT_RETRY_MS = 3600_000
async function learnAccountId(env: IntegrationEnv, row: Row, base: string): Promise<Row> {
  const meta = metaOf(row), spec = meta.connect
  if (!spec?.accountIdField || row.has_credentials !== 1 || ['error', 'disconnected'].includes(effectiveConnectionState(row))) return row
  const settings = settingsOf(row.settings)
  if (typeof settings.accountId === 'string' || (typeof settings.accountCheckedAt === 'number' && Date.now() - settings.accountCheckedAt < ACCOUNT_RETRY_MS)) return row
  const provider = resolveProviderAdapter(row.type, meta.id)
  if (!provider) return row
  let accountId: string | undefined
  try {
    const credentials = await openRow(env, row.workspace_id, row.id, await env.DB.prepare(`SELECT ${sealedColumns} FROM channels WHERE workspace_id=? AND id=?`).bind(row.workspace_id, row.id).first())
    const step = await provider.connect(contextFor(env, row, credentials, settings, base, spec, credentials.webhookSecret ?? ''))
    if (step.kind === 'done' && step.externalId === row.external_id) { accountId = step.accountId; await keepConnectFacts(env, row.workspace_id, row.id, { ...step, accountId: undefined }, spec) }
  } catch { /* the next look tries again after the wait */ }
  const next = { ...settings, accountCheckedAt: Date.now(), ...(accountId ? { accountId } : {}) }
  await env.DB.prepare(accountId ? "UPDATE channels SET settings=json_set(settings,'$.accountCheckedAt',?,'$.accountId',?) WHERE workspace_id=? AND id=?"
    : "UPDATE channels SET settings=json_set(settings,'$.accountCheckedAt',?) WHERE workspace_id=? AND id=?")
    .bind(...[next.accountCheckedAt, ...(accountId ? [accountId] : []), row.workspace_id, row.id]).run()
  return { ...row, settings: JSON.stringify(next) }
}

export async function listConnections(env: IntegrationEnv, workspaceId: string, base: string, kind?: ChannelType): Promise<ConnectionView[]> {
  // A contagem por conexão sai na mesma onda da lista (o Insights mostrava o total com um GET /contacts por conexão).
  const [rows, totals] = await Promise.all([
    env.DB.prepare(`SELECT ${columns} FROM channels WHERE workspace_id=? AND archived_at IS NULL${kind ? ' AND type=?' : ''} ORDER BY created_at, id`)
      .bind(...[workspaceId, ...kind ? [kind] : []]).all<Row>(),
    env.DB.prepare(`SELECT cc.channel_id, count(DISTINCT c.id) AS total FROM contact_channels cc JOIN contacts c ON c.id = cc.contact_id
      WHERE cc.workspace_id = ? AND c.workspace_id = ? AND c.status <> 'deleted' GROUP BY cc.channel_id`).bind(workspaceId, workspaceId).all<{ channel_id: string; total: number }>(),
  ])
  const totalOf = new Map(totals.results.map(row => [row.channel_id, row.total]))
  return (await Promise.all(rows.results.map(row => learnAccountId(env, row, base)))).map(row => ({ ...view(row, base), contactTotal: totalOf.get(row.id) ?? 0 }))
}
export async function getConnection(env: IntegrationEnv, workspaceId: string, id: string, base: string) {
  return view(await learnAccountId(env, await find(env, workspaceId, id), base), base)
}

/** Unknown fields, blank required fields and malformed values are refused; messages name fields, never echo values. */
function checkCredentials(spec: ConnectSpec, input: Credentials, partial = false): Credentials {
  const known = new Map(spec.fields.map(field => [field.key, field]))
  const out: Credentials = {}
  for (const [key, value] of Object.entries(input)) {
    const field = known.get(key)
    if (!field) throw fail(400, `Campo desconhecido: ${key}.`)
    const text = value.trim()
    if (!text) { if (!partial) continue; throw fail(400, `${field.label}: preencha o campo.`) }
    if (field.pattern && !new RegExp(field.pattern).test(text)) throw fail(400, `${field.label}: formato inválido.`)
    out[key] = text
  }
  if (!partial) for (const field of spec.fields) if (!field.optional && !out[field.key]) throw fail(400, `${field.label}: preencha o campo.`)
  return out
}

function contextFor(env: IntegrationEnv, row: Row, credentials: Credentials, settings: Record<string, unknown>, base: string, spec: ConnectSpec, secret: string): ConnectContext {
  const connection = connectionFromRow({ ...liteRow(row.type, row.id, row.workspace_id), provider: row.provider, settings: JSON.stringify(settings) })
  return { env, connection, credentials, hookUrl: hookUrl(base, spec, row.id), webhookSecret: secret, fetch: ((input, init) => fetch(input, init)) as typeof fetch }
}
const GENERIC_WEBHOOK_STEPS = ['Abra o painel do provedor e vá na configuração de webhooks.', 'Cole a URL de retorno e o token de verificação acima.']
/** Passos do webhook manual por provider: quem tem `webhookChecklist` no próprio provider usa o dele (fonte única); os outros, os passos genéricos. */
export function manualChecklist(provider: string): string[] {
  const own = providerAdapterById(provider)?.webhookChecklist
  return own ? [...own] : GENERIC_WEBHOOK_STEPS
}
const manualStep = (spec: ConnectSpec, url: string, credentials: Credentials, provider: string): Extract<ConnectStep, { kind: 'manual_webhook' }> => ({
  kind: 'manual_webhook', callbackUrl: url, verifyToken: credentials[spec.verifyTokenField ?? ''] ?? credentials.webhookSecret ?? '', checklist: manualChecklist(provider) })

/** Registers the webhook where the provider allows it; otherwise returns the guided step. Never throws on a provider refusal. */
const sealedColumns = 'credentials_ciphertext,credentials_iv,credentials_key_version'

async function wireWebhook(env: IntegrationEnv, row: Row, credentials: Credentials, settings: Record<string, unknown>, base: string, spec: ConnectSpec): Promise<ConnectStep> {
  const provider = resolveProviderAdapter(row.type, row.provider)
  const ctx = contextFor(env, row, credentials, settings, base, spec, credentials.webhookSecret ?? '')
  const result = provider && (spec.webhook === 'auto' || spec.hook === 'connection' || provider.registersSharedWebhook) ? await provider.registerWebhook(ctx) : undefined
  if (result?.registered && result.awaitFirstEvent) {
    // Aceito pelo provedor, mas só a primeira entrega real prova que os eventos chegam: fica pendente ("aguardando o primeiro evento", subscribedAt)
    // até lá (first_delivery). Conectada ou restrita não cai (mesma regra de webhook_manual: esperar a primeira entrega).
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare("UPDATE channels SET webhook_mode='auto', webhook_registered_at=?, settings=json_set(settings,'$.subscribedAt',?), sync_cursor=coalesce(sync_cursor,?) WHERE workspace_id=? AND id=?")
        .bind(now, now, now, row.workspace_id, row.id),
      moveConnectionStatement(env.DB, { id: row.id, workspaceId: row.workspace_id, event: 'webhook_manual', to: 'pending', detail: null }),
    ])
    return { kind: 'done', externalId: row.external_id, ...(spec.autoWebhook ? { notice: spec.autoWebhook.done } : {}) }
  }
  if (result?.registered) {
    // sync_cursor: a provider that never redelivers is reconciled from the moment it is wired, not from its whole history.
    // O webhook fica registrado de qualquer jeito; o estado só muda numa conexão ligada (a desativada pela equipe segue desligada até reativar).
    await env.DB.batch([
      env.DB.prepare("UPDATE channels SET webhook_mode='auto', webhook_registered_at=?, settings=json_remove(settings,'$.subscribedAt'), sync_cursor=coalesce(sync_cursor,?) WHERE workspace_id=? AND id=?")
        .bind(Date.now(), Date.now(), row.workspace_id, row.id),
      moveConnectionStatement(env.DB, { id: row.id, workspaceId: row.workspace_id, event: 'webhook_auto', to: 'connected', detail: null }),
    ])
    return { kind: 'done', externalId: row.external_id }
  }
  const detail = result && !result.registered && result.manual.reason ? `O webhook não foi registrado automaticamente: ${result.manual.reason}`
    : result ? 'O webhook não foi registrado automaticamente.' : 'Aguardando a configuração do webhook.'
  await env.DB.batch([
    // Conexão que já recebe mantém modo e assinatura: a tentativa falha não apaga o webhook que o provedor tem (mesma guarda de webhook_manual).
    env.DB.prepare("UPDATE channels SET webhook_mode='manual', settings=json_remove(settings,'$.subscribedAt') WHERE workspace_id=? AND id=? AND connection_state NOT IN ('connected','restricted')").bind(row.workspace_id, row.id),
    moveConnectionStatement(env.DB, { id: row.id, workspaceId: row.workspace_id, event: 'webhook_manual', to: 'pending', detail }),
  ])
  return result && !result.registered ? result.manual : manualStep(spec, ctx.hookUrl, credentials, row.provider)
}

/** Token recusado e provedor fora do ar pedem ações diferentes (colar outro token x esperar): cada um tem a sua frase. */
export const failureMessage = (code: string) => code === 'invalid_credentials'
  ? 'O provedor não aceitou este token. Confira se copiou inteiro e se ainda vale, ou gere um novo.'
  : 'Não consegui falar com o provedor agora: ele pode estar fora do ar. O token não foi testado; tente de novo em instantes.'

export type CreateInput = { kind: ChannelType; provider?: string; displayName?: string; credentials: Credentials }

/** `trusted` are credentials the server itself made (not typed in the form), stored sealed next to the checked ones. */
export async function createConnection(env: IntegrationEnv, workspaceId: string, input: CreateInput, base: string, trusted: Credentials = {}): Promise<{ connection: ConnectionView; step: ConnectStep; warning?: string }> {
  const meta = input.provider ? providers[input.provider as keyof typeof providers] : providers[defaultProviderOf(input.kind)]
  if (!meta?.connect || !meta.live || !meta.kinds.includes(input.kind)) throw fail(400, 'Este canal ainda não pode ser conectado pelo painel.')
  const spec = meta.connect
  const id = crypto.randomUUID()
  const credentials: Credentials = { ...checkCredentials(spec, input.credentials), ...trusted, webhookSecret: random() }
  if (spec.verifyTokenField) {
    if (!credentials[spec.verifyTokenField]) credentials[spec.verifyTokenField] = random()
    // Meta's handshake compares against the webhook secret of the connection: it is the verify token.
    credentials.webhookSecret = credentials[spec.verifyTokenField]
  }
  const settings: Record<string, unknown> = env.APP_ENV === 'development' && env.DEV_PROVIDER_API_BASE ? { apiBase: env.DEV_PROVIDER_API_BASE } : {}
  const draft = { ...liteRow(input.kind, id, workspaceId), provider: meta.id } as never as Row
  // Validate against the provider before anything is stored.
  const provider = resolveProviderAdapter(input.kind, meta.id)
  let externalId = spec.externalIdField ? credentials[spec.externalIdField] : undefined
  let name = input.displayName?.trim() || null
  let pairing: Extract<ConnectStep, { kind: 'qr' | 'pairing_code' }> | undefined
  let connected: ConnectStep | undefined
  if (provider) {
    const step = connected = await provider.connect(contextFor(env, draft, credentials, settings, base, spec, credentials.webhookSecret))
    if (step.kind === 'failed') throw fail(422, step.message ?? failureMessage(step.code))
    if (step.kind === 'done') { externalId = step.externalId; name ??= step.displayName ?? null; if (spec.accountIdField && step.accountId) settings.accountId = step.accountId }
    // A provider that pairs by QR names the account before the pairing is done; the panel then shows the QR.
    if (step.kind === 'qr' || step.kind === 'pairing_code') { pairing = step; if (step.kind === 'qr') { externalId = step.externalId ?? externalId; name ??= step.displayName ?? null } }
  }
  if (!externalId) throw fail(400, 'Não foi possível identificar a conta.')
  const sealed = await encryptCredentials(env, { workspaceId, connectionId: id }, credentials)
  try {
    await env.DB.prepare(`INSERT INTO channels (id, workspace_id, type, provider, external_id, display_name, status, connection_state, settings,
      credentials_ciphertext, credentials_iv, credentials_key_version, credentials_rotated_at, webhook_secret_hash, webhook_mode)
      VALUES (?,?,?,?,?,?,'connected',?,?,?,?,?,?,?,?)`)
      .bind(id, workspaceId, input.kind, meta.id, externalId, name, INITIAL_STATE, JSON.stringify(settings), sealed.ciphertext, sealed.iv, sealed.keyVersion,
        Date.now(), await digest(credentials.webhookSecret), spec.webhook).run()
  } catch (error) {
    if (/UNIQUE/i.test(String(error))) throw fail(409, input.kind === 'instagram'
      ? 'Esta conta já está conectada. Se for a conexão antiga, arquive-a em Configurações > Canais e conecte de novo.' : 'Esta conta já está conectada.')
    throw error
  }
  if (connected) await keepConnectFacts(env, workspaceId, id, { ...connected, ...(connected.kind === 'done' ? { accountId: undefined } : {}) } as ConnectStep, spec)
  const row = await find(env, workspaceId, id)
  const wired = await wireWebhook(env, row, credentials, settings, base, spec)
  if (pairing) await moveConnection(env.DB, { id, workspaceId, event: 'pairing', to: 'connecting', detail: 'Aguardando a leitura do QR code.' })
  return { connection: view(await find(env, workspaceId, id), base), step: pairing ?? wired, ...(connected ? warningOf(connected) : {}) }
}

async function loadSettings(env: IntegrationEnv, workspaceId: string, id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await env.DB.prepare('SELECT settings FROM channels WHERE workspace_id=? AND id=?').bind(workspaceId, id).first<string>('settings') ?? '{}') as Record<string, unknown>
}

/** Registers again (auto) or hands back the guided step (manual). */
export async function webhookStep(env: IntegrationEnv, workspaceId: string, id: string, base: string): Promise<ConnectStep> {
  const row = await find(env, workspaceId, id)
  const spec = metaOf(row).connect!
  const credentials = await openRow(env, workspaceId, id, await env.DB.prepare(`SELECT ${sealedColumns} FROM channels WHERE workspace_id=? AND id=?`).bind(workspaceId, id).first())
  return wireWebhook(env, row, credentials, await loadSettings(env, workspaceId, id), base, spec)
}

/** New credentials replace the stored ones under the active key. Secrets that are not resent keep their value. */
export async function rotateCredentials(env: IntegrationEnv, workspaceId: string, id: string, supplied: Credentials, base: string): Promise<{ rotatedAt: number; step: ConnectStep; warning?: string }> {
  const row = await find(env, workspaceId, id)
  const meta = metaOf(row)
  const spec = meta.connect
  if (!spec) throw fail(400, 'Esta conexão não aceita troca de credencial pelo painel.')
  const changes = checkCredentials(spec, supplied, true)
  if (spec.externalIdField && changes[spec.externalIdField] && changes[spec.externalIdField] !== row.external_id) throw fail(400, 'Para trocar a conta, crie outra conexão.')
  const current = await openRow(env, workspaceId, id, await env.DB.prepare(`SELECT ${sealedColumns} FROM channels WHERE workspace_id=? AND id=?`).bind(workspaceId, id).first())
  const credentials = { ...current, ...changes }
  // Credencial guardada sem o id da conta (ou vazia): a tela de troca não pede o id, então vale o da própria conexão.
  if (spec.externalIdField && !credentials[spec.externalIdField] && row.external_id) credentials[spec.externalIdField] = row.external_id
  // The handshake compares against the webhook secret, so a new verify token has to become the secret too.
  if (spec.verifyTokenField && changes[spec.verifyTokenField]) credentials.webhookSecret = changes[spec.verifyTokenField]
  const settings = await loadSettings(env, workspaceId, id)
  let provedAccountId: string | undefined
  let connected: ConnectStep | undefined
  const provider = resolveProviderAdapter(row.type, meta.id)
  if (provider) {
    const step = connected = await provider.connect(contextFor(env, row, credentials, settings, base, spec, credentials.webhookSecret ?? ''))
    if (step.kind === 'failed') throw fail(422, step.message ?? 'O provedor não aceitou estas credenciais.')
    if (step.kind === 'done' && step.externalId !== row.external_id) throw fail(409, 'Estas credenciais são de outra conta. Crie uma nova conexão.')
    if (step.kind === 'done' && spec.accountIdField) provedAccountId = step.accountId
  }
  const sealed = await encryptCredentials(env, { workspaceId, connectionId: id }, credentials)
  const rotatedAt = Date.now()
  const hash = credentials.webhookSecret ? await digest(credentials.webhookSecret) : null
  // Archived meanwhile (the provider call above can be slow): do not bring the credentials back.
  const written = await env.DB.prepare(`UPDATE channels SET credentials_ciphertext=?, credentials_iv=?, credentials_key_version=?, credentials_rotated_at=?,
    webhook_secret_hash=coalesce(?, webhook_secret_hash) WHERE workspace_id=? AND id=? AND archived_at IS NULL`)
    .bind(sealed.ciphertext, sealed.iv, sealed.keyVersion, rotatedAt, hash, workspaceId, id).run()
  if (!written.meta.changes) throw fail(404, 'Conexão não encontrada.')
  if (connected) await keepConnectFacts(env, workspaceId, id, connected, spec)
  if (provedAccountId) settings.accountId = provedAccountId
  // A new token has to be registered with the provider again.
  return { rotatedAt, step: await wireWebhook(env, row, credentials, settings, base, spec), ...(connected ? warningOf(connected) : {}) }
}

/** Archiving stops the connection and drops its credentials; contacts, conversations and history stay. The account id is
 * released so the same account can be connected again later. */
export async function archiveConnection(env: IntegrationEnv, workspaceId: string, id: string, base: string): Promise<void> {
  const row = await find(env, workspaceId, id)
  const meta = metaOf(row)
  // O e-mail da plataforma é um só por conta, com id fixo: arquivado, nada o recriaria (a gravação de e-mail acharia a linha arquivada).
  if (meta.id === 'cloudflare_email') throw fail(409, 'O e-mail da plataforma não pode ser arquivado. Para parar os envios, desative a conexão.')
  const provider = resolveProviderAdapter(row.type, meta.id)
  if (provider?.disconnect && meta.connect) {
    const credentials = await openRow(env, workspaceId, id, await env.DB.prepare(`SELECT ${sealedColumns} FROM channels WHERE workspace_id=? AND id=?`).bind(workspaceId, id).first())
    await provider.disconnect(contextFor(env, row, credentials, await loadSettings(env, workspaceId, id), base, meta.connect, credentials.webhookSecret ?? '')).catch(() => {})
  }
  await moveConnection(env.DB, { id, workspaceId, event: 'archive', to: 'disconnected', detail: 'Arquivada',
    also: { sql: `archived_at=?, external_id=?, credentials_ciphertext=NULL, credentials_iv=NULL, credentials_key_version=NULL, webhook_secret_hash=NULL,
    webhook_registered_at=NULL`, binds: [Date.now(), `archived:${id}:${row.external_id}`] } })
}

export const profileOf = (kind: ChannelType) => capabilities(kind)

/** Asks the provider where the connection stands: a fresh QR code while it waits to be read, `done` once the number is paired.
 * The panel calls this while the QR dialog is open. Only the provider's own proof moves the connection to `connected`. */
export async function refreshConnect(env: IntegrationEnv, workspaceId: string, id: string, base: string): Promise<{ connection: ConnectionView; step: ConnectStep }> {
  const row = await find(env, workspaceId, id)
  const meta = providers[row.provider === 'legacy' ? defaultProviderOf(row.type) : row.provider as keyof typeof providers]
  const provider = resolveProviderAdapter(row.type, meta.id)
  if (!provider || !meta.connect) throw fail(400, 'Esta conexão não é conectada por QR code.')
  const credentials = await openRow(env, workspaceId, id, await env.DB.prepare(`SELECT ${sealedColumns} FROM channels WHERE workspace_id=? AND id=?`).bind(workspaceId, id).first())
  const step = await provider.connect(contextFor(env, row, credentials, await loadSettings(env, workspaceId, id), base, meta.connect, credentials.webhookSecret ?? ''))
  if (step.kind === 'failed') throw fail(422, step.message ?? failureMessage(step.code))
  if (step.kind === 'done') {
    await moveConnection(env.DB, { id, workspaceId, event: 'paired', to: 'connected', detail: null,
      also: { sql: 'display_name=coalesce(display_name,?), sync_cursor=coalesce(sync_cursor,?)', binds: [step.displayName ?? null, Date.now()] } })
  } else if (step.kind === 'qr' || step.kind === 'pairing_code') {
    await moveConnection(env.DB, { id, workspaceId, event: 'pairing', to: 'connecting', detail: 'Aguardando a leitura do QR code.' })
  }
  return { connection: view(await find(env, workspaceId, id), base), step }
}

export type UpdateInput = { displayName?: string; settings?: Record<string, unknown> }
/** Name and the provider's options. An option the provider does not declare, or of the wrong type, is refused; an empty text clears the option. */
export async function updateConnection(env: IntegrationEnv, workspaceId: string, id: string, input: UpdateInput, base: string): Promise<ConnectionView> {
  const row = await find(env, workspaceId, id)
  const meta = providers[row.provider === 'legacy' ? defaultProviderOf(row.type) : row.provider as keyof typeof providers]
  const current = JSON.parse(row.settings) as Record<string, unknown>
  for (const [key, value] of Object.entries(input.settings ?? {})) {
    const option = meta.options?.find(o => o.key === key)
    if (!option) throw fail(400, `Opção desconhecida: ${key}.`)
    if (option.type === 'boolean') {
      if (typeof value !== 'boolean') throw fail(400, `${option.label}: use ligado ou desligado.`)
      current[key] = value
    } else {
      if (typeof value !== 'string' || [...value].length > (option.max ?? 500)) throw fail(400, `${option.label}: texto longo demais.`)
      if (value.trim()) current[key] = value.trim(); else delete current[key]
    }
  }
  const name = input.displayName === undefined ? undefined : input.displayName.trim().slice(0, 120) || null
  const provider = resolveProviderAdapter(row.type, meta.id)
  if (provider?.applySettings && input.settings && Object.keys(input.settings).some(key => key === 'greeting')) {
    const credentials = await openRow(env, workspaceId, id, await env.DB.prepare(`SELECT ${sealedColumns} FROM channels WHERE workspace_id=? AND id=?`).bind(workspaceId, id).first())
    const connection = connectionFromRow({ ...liteRow(row.type, row.id, row.workspace_id), provider: row.provider, external_id: row.external_id, capabilities_override: row.capabilities_override ?? null, settings: JSON.stringify(current) })
    try { await provider.applySettings({ connection, credentials, fetch: ((i, init) => fetch(i, init)) as typeof fetch }, current) }
    catch (error) { throw fail(422, error instanceof Error ? error.message : 'O provedor não aceitou a opção.') }
  }
  await env.DB.prepare('UPDATE channels SET settings=?, display_name=? WHERE workspace_id=? AND id=?')
    .bind(JSON.stringify(current), name === undefined ? row.display_name : name, workspaceId, id).run()
  return view(await find(env, workspaceId, id), base)
}

/** Conexão marcada como ligada mas sem token cifrado guardado: diz isso em vez de um erro genérico do provedor. */
function requireSealed(sealed: { credentials_ciphertext?: unknown } | null | undefined): void {
  if (!sealed?.credentials_ciphertext) throw fail(409, NO_CREDENTIALS)
}
/** Erro de listagem: repassa a recusa já traduzida do provedor; o resto fica com a frase genérica. */
const listFailure = (error: unknown, generic: string) => error instanceof ProviderRefusal ? new HTTPException(error.status, { message: error.message }) : fail(422, generic)

export type GroupView = { id: string; externalGroupId: string; subject: string | null }
/** Resolve the workspace-scoped connection and its effective capability before opening credentials or calling the provider. */
export async function listConnectionPosts(env: IntegrationEnv, workspaceId: string, id: string, query: { limit: number; after?: string }): Promise<CommentPostsPage> {
  // A conexão e as credenciais cifradas saem na mesma ida; as configurações já vêm na linha da conexão.
  const [row, sealed] = await Promise.all([find(env, workspaceId, id), env.DB.prepare(`SELECT ${sealedColumns} FROM channels WHERE workspace_id=? AND id=?`).bind(workspaceId, id).first<Parameters<typeof openRow>[3] & object>()])
  const provider = resolveProviderAdapter(row.type, metaOf(row).id)
  const profile = effectiveProfile(row.type, metaOf(row).id, row.capabilities_override ? JSON.parse(row.capabilities_override) as ProfilePatch : undefined)
  if (!profile.comments?.posts || !provider?.comments) throw fail(400, 'Esta conexão não oferece publicações para comentários.')
  if (effectiveConnectionState(row) !== 'connected') throw fail(409, 'Conecte a conta antes de listar as publicações.')
  requireSealed(sealed)
  const credentials = await openRow(env, workspaceId, id, sealed)
  const connection = connectionFromRow({ ...liteRow(row.type, row.id, row.workspace_id), provider: row.provider, external_id: row.external_id,
    capabilities_override: row.capabilities_override ?? null, settings: JSON.stringify(settingsOf(row.settings as string)) })
  try { return await provider.comments.listPosts({ connection, credentials, fetch: ((input, init) => fetch(input, init)) as typeof fetch }, query) }
  catch (error) { throw listFailure(error, 'Não foi possível listar as publicações agora. Confira a conexão e tente novamente.') }
}

/** Active stories of the account, to pick the one a story-reply trigger watches (same guards as the posts). */
export async function listConnectionStories(env: IntegrationEnv, workspaceId: string, id: string, query: { limit: number; after?: string }): Promise<CommentPostsPage> {
  // A conexão e as credenciais cifradas saem na mesma ida; as configurações já vêm na linha da conexão.
  const [row, sealed] = await Promise.all([find(env, workspaceId, id), env.DB.prepare(`SELECT ${sealedColumns} FROM channels WHERE workspace_id=? AND id=?`).bind(workspaceId, id).first<Parameters<typeof openRow>[3] & object>()])
  const provider = resolveProviderAdapter(row.type, metaOf(row).id)
  const profile = effectiveProfile(row.type, metaOf(row).id, row.capabilities_override ? JSON.parse(row.capabilities_override) as ProfilePatch : undefined)
  if (!profile.stories?.list || !provider?.stories) throw fail(400, 'Esta conexão não lista stories.')
  if (effectiveConnectionState(row) !== 'connected') throw fail(409, 'Conecte a conta antes de listar os stories.')
  requireSealed(sealed)
  const credentials = await openRow(env, workspaceId, id, sealed)
  const connection = connectionFromRow({ ...liteRow(row.type, row.id, row.workspace_id), provider: row.provider, external_id: row.external_id,
    capabilities_override: row.capabilities_override ?? null, settings: JSON.stringify(settingsOf(row.settings as string)) })
  try { return await provider.stories.list({ connection, credentials, fetch: ((input, init) => fetch(input, init)) as typeof fetch }, query) }
  catch (error) { throw listFailure(error, 'Não foi possível listar os stories agora. Confira a conexão e tente novamente.') }
}

/** Groups the connection's account takes part in, for choosing where a group trigger applies. Every group listed gets its thread now, so a
 * trigger can point at it before a single message arrived. The page is the provider's; `nextOffset` is null on the last one. */
export async function listConnectionGroups(env: IntegrationEnv, workspaceId: string, id: string, query: { search?: string; limit: number; offset: number }):
  Promise<{ groups: GroupView[]; nextOffset: number | null }> {
  // A conexão e as credenciais cifradas saem na mesma ida; as configurações já vêm na linha da conexão.
  const [row, sealed] = await Promise.all([find(env, workspaceId, id), env.DB.prepare(`SELECT ${sealedColumns} FROM channels WHERE workspace_id=? AND id=?`).bind(workspaceId, id).first<Parameters<typeof openRow>[3] & object>()])
  const provider = resolveProviderAdapter(row.type, metaOf(row).id)
  if (!provider?.listGroups) throw fail(400, 'Esta conexão não tem grupos.')
  if (effectiveConnectionState(row) !== 'connected') throw fail(409, 'Conecte o número antes de listar os grupos.')
  const credentials = await openRow(env, workspaceId, id, sealed)
  const connection = connectionFromRow({ ...liteRow(row.type, row.id, row.workspace_id), provider: row.provider, settings: JSON.stringify(settingsOf(row.settings as string)) })
  let page: Awaited<ReturnType<NonNullable<typeof provider.listGroups>>>
  try { page = await provider.listGroups({ connection, credentials, fetch: ((input, init) => fetch(input, init)) as typeof fetch }, query) }
  catch { throw fail(422, 'Não foi possível listar os grupos agora. Confira se o número está conectado.') }
  const groups = await Promise.all(page.groups.map(async g => ({ id: await upsertGroupThread(env, workspaceId, id, g.externalGroupId, g.subject), externalGroupId: g.externalGroupId, subject: g.subject })))
  return { groups, nextOffset: page.nextOffset }
}

/** Botão "Atualizar conexão": confere de novo as credenciais e as permissões no provedor e, quando o webhook é automático, reassina.
 * Falha fica registrada na conexão (estado de erro com o motivo) em vez de só voltar ao painel. */
export async function refreshConnection(env: IntegrationEnv, workspaceId: string, id: string, base: string, options: { enabling?: boolean } = {}): Promise<{ connection: ConnectionView; ok: boolean; detail: string | null; permissions: PermissionItem[] | null; warning?: string }> {
  const row = await find(env, workspaceId, id)
  const meta = metaOf(row)
  const provider = resolveProviderAdapter(row.type, meta.id)
  if (!provider || !meta.connect) throw fail(400, 'Esta conexão não pode ser atualizada pelo painel.')
  const sealed = await env.DB.prepare(`SELECT ${sealedColumns} FROM channels WHERE workspace_id=? AND id=?`).bind(workspaceId, id).first<Parameters<typeof openRow>[3] & object>()
  // Sem token guardado não adianta conferir no provedor (ele diria "token vencido", o que engana): a conexão fica em erro com o motivo certo.
  const unsealed = !sealed?.credentials_ciphertext
  const credentials = await openRow(env, workspaceId, id, sealed)
  const ctx = contextFor(env, row, credentials, await loadSettings(env, workspaceId, id), base, meta.connect, credentials.webhookSecret ?? '')
  const step: ConnectStep = unsealed ? { kind: 'failed', code: 'invalid_credentials', detail: 'missing_credentials', message: NO_CREDENTIALS } : await provider.connect(ctx)
  // The account the provider proved now (it may correct the stored one) and the health it read are kept before the webhook is registered again.
  if (step.kind === 'done' && step.externalId === row.external_id) {
    await keepConnectFacts(env, workspaceId, id, step, meta.connect, ctx.connection.settings.accountId)
    if (meta.connect.accountIdField && step.accountId) ctx.connection.settings.accountId = step.accountId
  }
  // Provedores com conferência de permissões dizem item a item o que está ok e o que falta; o que falta vira o motivo do erro.
  const permissions = provider.checkPermissions && !unsealed ? await provider.checkPermissions(ctx, step).catch(() => null) : null
  const missing = permissions?.filter(p => p.status === 'missing') ?? []
  let detail: string | null = null
  if (unsealed) detail = NO_CREDENTIALS
  else if (missing.length) detail = missing.some(p => p.key === 'token') ? 'O token venceu ou foi revogado. Gere um token novo.'
    : `Faltam permissões: ${missing.map(p => p.label.toLocaleLowerCase('pt-BR')).join(', ')}. Veja o passo para resolver na conferência.`
  else if (step.kind === 'failed') detail = step.code === 'invalid_credentials' ? 'O provedor não aceitou as credenciais ou as permissões foram retiradas. Gere um token novo.' : 'Não foi possível falar com o provedor. Tente de novo.'
  else if (step.kind === 'done' && meta.connect.webhook === 'auto') {
    const hook = await provider.registerWebhook(ctx)
    if (!hook.registered) detail = 'A conexão responde, mas o webhook precisa ser configurado à mão.'
  }
  // Reativar um número de QR code despareado: a conferência pede a leitura do QR, que é o que falta para religar.
  if (options.enabling && detail === null && (step.kind === 'qr' || step.kind === 'pairing_code')) detail = 'Leia o QR code antes de reativar.'
  // O provedor sem nada a conferir devolve só o guia do webhook manual (o e-mail da plataforma): vale como conferência certa e o estado não muda
  // (antes a conexão virava "pareando" e só a próxima gravação de e-mail a religava).
  const guideOnly = step.kind === 'manual_webhook' && !missing.length
  const ok = (step.kind === 'done' || guideOnly) && detail === null
  const name = { sql: 'display_name=coalesce(display_name,?)', binds: [step.kind === 'done' ? step.displayName ?? null : null] }
  if (row.status !== 'disconnected' && guideOnly) {
    await env.DB.prepare('UPDATE channels SET status_detail=NULL WHERE workspace_id=? AND id=? AND archived_at IS NULL').bind(workspaceId, id).run()
  } else if (row.status !== 'disconnected') {
    await moveConnection(env.DB, { id, workspaceId, event: 'refresh', to: step.kind === 'failed' || missing.length ? 'error' : step.kind === 'done' ? 'connected' : 'connecting', detail, also: name })
  } else if (options.enabling && ok) {
    await moveConnection(env.DB, { id, workspaceId, event: 'enable', to: 'connected', detail: null, also: name })
  } else {
    // Desativada pela equipe: a conferência diz o que achou, mas só reativar religa (antes, a saúde virava "conectada" com a conexão desligada).
    // Sem nada achado, o motivo gravado ("Desativada pela equipe...") fica.
    const found = detail === null ? { sql: '', binds: [] } : { sql: 'status_detail=?, ', binds: [detail] }
    await env.DB.prepare(`UPDATE channels SET ${found.sql}${name.sql} WHERE workspace_id=? AND id=? AND archived_at IS NULL`).bind(...found.binds, ...name.binds, workspaceId, id).run()
  }
  return { connection: view(await find(env, workspaceId, id), base), ok, detail, permissions, ...warningOf(step) }
}

/** Desativar sem apagar: para de receber e enviar (o webhook passa a responder 404), mas credenciais, contatos e conversas ficam.
 * Reativar revalida no provedor antes de voltar a "conectada". */
export async function setConnectionEnabled(env: IntegrationEnv, workspaceId: string, id: string, enabled: boolean, base: string) {
  const row = await find(env, workspaceId, id)
  if (!enabled) {
    await moveConnection(env.DB, { id, workspaceId, event: 'disable', to: 'disconnected', detail: 'Desativada pela equipe. Reative quando quiser.' })
    return { connection: view(await find(env, workspaceId, id), base), ok: true, detail: null }
  }
  const result = await refreshConnection(env, workspaceId, id, base, { enabling: row.status === 'disconnected' })
  return { ...result, connection: view(await find(env, workspaceId, id), base) }
}

/** Perfil comercial do número (provedores que o expõem). */
export async function connectionBusinessProfile(env: IntegrationEnv, workspaceId: string, id: string, update?: BusinessProfile): Promise<BusinessProfile> {
  // A conexão e as credenciais cifradas saem na mesma ida; as configurações já vêm na linha da conexão.
  const [row, sealed] = await Promise.all([find(env, workspaceId, id), env.DB.prepare(`SELECT ${sealedColumns} FROM channels WHERE workspace_id=? AND id=?`).bind(workspaceId, id).first<Parameters<typeof openRow>[3] & object>()])
  const provider = resolveProviderAdapter(row.type, metaOf(row).id)
  if (!provider?.businessProfile) throw fail(400, 'Esta conexão não tem perfil comercial.')
  requireSealed(sealed)
  const credentials = await openRow(env, workspaceId, id, sealed)
  const connection = connectionFromRow({ ...liteRow(row.type, row.id, row.workspace_id), provider: row.provider, external_id: row.external_id, capabilities_override: row.capabilities_override ?? null, settings: JSON.stringify(settingsOf(row.settings as string)) })
  const ctx = { connection, credentials, fetch: ((i, init) => fetch(i, init)) as typeof fetch }
  try {
    if (update) { await provider.businessProfile.update(ctx, update); return update }
    return await provider.businessProfile.get(ctx)
  } catch (error) {
    if (error instanceof ProviderRefusal) throw new HTTPException(error.status, { message: error.message })
    throw fail(422, error instanceof Error ? error.message : 'Falha no perfil comercial.')
  }
}

/** Catálogo de produtos da conexão, quando o provedor tem (aba Catálogo). */
export async function connectionCatalog(env: IntegrationEnv, workspaceId: string, id: string) {
  // A conexão e as credenciais cifradas saem na mesma ida; as configurações já vêm na linha da conexão.
  const [row, sealed] = await Promise.all([find(env, workspaceId, id), env.DB.prepare(`SELECT ${sealedColumns} FROM channels WHERE workspace_id=? AND id=?`).bind(workspaceId, id).first<Parameters<typeof openRow>[3] & object>()])
  const provider = resolveProviderAdapter(row.type, metaOf(row).id)
  if (!provider?.catalog) throw fail(400, 'Esta conexão não tem catálogo de produtos.')
  requireSealed(sealed)
  const credentials = await openRow(env, workspaceId, id, sealed)
  const connection = connectionFromRow({ ...liteRow(row.type, row.id, row.workspace_id), provider: row.provider, external_id: row.external_id, capabilities_override: row.capabilities_override ?? null, settings: JSON.stringify(settingsOf(row.settings as string)) })
  try { return await provider.catalog({ connection, credentials, fetch: ((i, init) => fetch(i, init)) as typeof fetch }) }
  catch (error) { throw fail(422, error instanceof Error ? error.message : 'Falha ao ler o catálogo.') }
}
