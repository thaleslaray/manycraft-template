import { HTTPException } from 'hono/http-exception'
import type { IntegrationEnv } from '../../integrations'
import { failureNotice, noteConnectionFailure } from './failure'
import { runtimeFromRow } from './runtime'
import { connectionColumns, type ConnectionRow } from './connection'

/** Is the account enabled for the provider's dedicated marketing API? The last check lives in the connection's settings (`marketingMessages`). */
export type MarketingView = { supported: boolean; enabled: boolean; status: string | null; checkedAt: number | null; cloudMarketingDisabled: boolean | null
  /** What the person should know and do while the account is not enabled. */
  notice: string | null
  /** Set when the last attempt to ask the provider failed; the other fields keep the last good answer. */
  error?: string }
type Stored = { enabled?: boolean; status?: string; cloudMarketingDisabled?: boolean | null; checkedAt?: number; failedAt?: number }

const FRESH_MS = 24 * 3600_000   // a stored answer is reused for a day
const RETRY_MS = 10 * 60_000     // after a failed check, wait before asking again
const tokenRefused = { ok: false as const, reason: 'rejected' as const, code: '190', detail: 'token' }

/** Cutoffs of marketing on the Cloud API (P/marketing-messages/overview.md [upd. 2026-10-13]) and where the terms are accepted (onboarding.md). */
function noticeFor(status: string, cloudMarketingDisabled: boolean | null): string {
  // The account answers ONBOARDED yet is not enabled: only a refused send (134102) leaves it so.
  if (status === 'ONBOARDED') return 'A Meta recusou o último envio de marketing por esta conta (erro 134102: conta não elegível para a API de Mensagens de Marketing), embora ela conste como habilitada. '
    + 'Os modelos de marketing seguem pela API de nuvem até a próxima verificação. Use Verificar de novo; se o erro continuar, confira os termos e as restrições da conta no Gerenciador do WhatsApp.'
  return `${cloudMarketingDisabled ? 'O envio de marketing pela API de nuvem está bloqueado nesta conta: os modelos de marketing serão recusados (erro 131063) até aceitar os termos da API de Mensagens de Marketing. ' : ''}`
    + 'Esta conta ainda não usa a API de Mensagens de Marketing da Meta; os modelos de marketing seguem pela API de nuvem. '
    + 'A Meta encerra o marketing na API de nuvem em 13/10/2027 (contas criadas a partir de 13/04/2027 já não enviam marketing por ela). '
    + 'Para continuar enviando, aceite os termos: no Gerenciador do WhatsApp, abra Visão geral e, em Alertas, clique em Aceitar termos (sem parceiro: painel do app, WhatsApp, Início rápido, Começar). '
    + `Depois use Verificar de novo.${status === 'ELIGIBLE' ? '' : ` A Meta informou o estado ${status}; se a conta não aparecer como elegível, confira as restrições dela no Gerenciador do WhatsApp.`}`
}

const read = (stored: string): Stored => { try { return (JSON.parse(stored).marketingMessages ?? {}) as Stored } catch { return {} } }
function view(supported: boolean, saved: Stored, error?: string): MarketingView {
  const checked = typeof saved.checkedAt === 'number' && typeof saved.status === 'string'
  // A zero (the stored answer was disowned by a refused send) means "ask again", not "checked at the epoch".
  return { supported, enabled: supported && saved.enabled === true, status: checked ? saved.status! : null, checkedAt: checked ? saved.checkedAt! || null : null,
    cloudMarketingDisabled: saved.cloudMarketingDisabled ?? null,
    notice: supported && checked && !saved.enabled ? noticeFor(saved.status!, saved.cloudMarketingDisabled ?? null) : null, ...(error ? { error } : {}) }
}
async function open(env: IntegrationEnv, workspaceId: string, id: string) {
  // Uma ida só: a linha da conexão (não arquivada) já traz as configurações e tudo que o runtime precisa.
  const row = await env.DB.prepare(`SELECT ${connectionColumns} FROM channels WHERE workspace_id=? AND id=? AND archived_at IS NULL`).bind(workspaceId, id).first<ConnectionRow>()
  if (!row) throw new HTTPException(404, { message: 'Conexão não encontrada.' })
  return { rt: await runtimeFromRow(env, row), saved: read(row.settings) }
}
const save = (env: IntegrationEnv, workspaceId: string, id: string, saved: Stored) =>
  env.DB.prepare("UPDATE channels SET settings=json_set(settings,'$.marketingMessages',json(?)) WHERE workspace_id=? AND id=?").bind(JSON.stringify(saved), workspaceId, id).run()

/** Asks the provider and stores the answer with the time of the check. A failed ask keeps the last answer and says so. */
export async function refreshMarketing(env: IntegrationEnv, workspaceId: string, id: string, opened?: Awaited<ReturnType<typeof open>>): Promise<MarketingView> {
  const { rt, saved } = opened ?? await open(env, workspaceId, id)
  if (!rt.provider?.marketing) return view(false, {})
  const result = await rt.provider.marketing.status({ connection: rt.connection, credentials: await rt.credentials(), fetch: rt.fetch, env })
  if (result.ok) {
    const fresh: Stored = { enabled: result.enabled, status: result.status, cloudMarketingDisabled: result.cloudMarketingDisabled, checkedAt: Date.now() }
    await save(env, workspaceId, id, fresh)
    return view(true, fresh)
  }
  if (result.code === 190) {
    await noteConnectionFailure(env, workspaceId, id, tokenRefused)
    throw new HTTPException(409, { message: failureNotice(tokenRefused) })
  }
  if (result.missing === 'account_id') return view(true, saved, 'Informe o ID da conta do WhatsApp Business (WABA) nesta conexão para a Meta dizer se ela usa a API de Mensagens de Marketing.')
  await save(env, workspaceId, id, { ...saved, failedAt: Date.now() })
  return view(true, saved, 'Não foi possível consultar a Meta agora. Tente de novo em alguns minutos.')
}

/** What the panel shows: the stored answer, asked again when there is none or it is old. */
export async function connectionMarketing(env: IntegrationEnv, workspaceId: string, id: string): Promise<MarketingView> {
  const opened = await open(env, workspaceId, id), { rt, saved } = opened
  if (!rt.provider?.marketing) return view(false, {})
  return stale(saved) ? refreshMarketing(env, workspaceId, id, opened) : view(true, saved)
}
const stale = (saved: Stored, now = Date.now()) => !(typeof saved.checkedAt === 'number' && now - saved.checkedAt < FRESH_MS)
  && !(typeof saved.failedAt === 'number' && now - saved.failedAt < RETRY_MS)

/** Before a marketing template goes out: bring the stored answer up to date when it is old. Never blocks the send and never throws.
 * The send in flight uses the connection as it was loaded; the refreshed answer applies from the next send on. */
export async function ensureMarketing(env: IntegrationEnv, workspaceId: string, id: string): Promise<void> {
  try {
    const opened = await open(env, workspaceId, id), { rt, saved } = opened
    if (rt.provider?.marketing && stale(saved)) await refreshMarketing(env, workspaceId, id, opened)
  } catch { /* the send goes on with what the connection already knows */ }
}
