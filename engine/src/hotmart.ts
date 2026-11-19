import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize, can } from './permissions'
import { json } from './security'
import { ensureWorkflow, hasFlow } from './flow/dispatch'
import { stableId } from './flow/types'
import { digest, equalSecret } from './channels/core/webhook-http'

/**
 * Gatilho externo Hotmart: o espaço gera a URL do webhook e registra na Hotmart. Compra aprovada, completa, cancelada, boleto
 * impresso e carrinho abandonado disparam as automações com gatilho Hotmart daquele evento (e produto, se escolhido).
 * O comprador vira contato pelo e-mail; produto, status e evento vão para campos de texto de mesmo nome (produto, status, evento).
 * O hottok só confere a origem e o painel nunca o mostra de volta: fica guardado só o SHA-256 (secret_hash), como o segredo de
 * webhook dos canais. A Hotmart reenvia eventos: o "id" de cada um marca a entrega em hotmart_events.
 */
export const hotmartEvents = ['PURCHASE_APPROVED', 'PURCHASE_COMPLETE', 'PURCHASE_CANCELED', 'PURCHASE_BILLET_PRINTED', 'PURCHASE_OUT_OF_SHOPPING_CART'] as const
export const hotmartConfig = z.object({ events: z.array(z.enum(hotmartEvents)).min(1), product_ids: z.array(z.string().max(64)).max(20).default([]) }).strict()

export const hotmartSettingsSchema = z.object({ hottok: z.string().trim().max(200).nullable().optional(), rotate: z.boolean().optional() }).strict()
export const hotmartPanel = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const urlOf = (base: string, token: string) => `${base}/api/hooks/hotmart/${token}`
hotmartPanel.get('/integrations/hotmart', async c => {
  authorize(c.var.principal, 'read')
  const row = await c.env.DB.prepare("SELECT token,coalesce(secret_hash,secret) IS NOT NULL AS has_secret,last_received_at FROM integration_hooks WHERE workspace_id=? AND kind='hotmart'").bind(c.var.principal.workspaceId).first<{ token: string; has_secret: number; last_received_at: number | null }>()
  // A URL carrega o token do webhook: só quem gerencia a equipe a recebe; os outros papéis veem só o estado.
  const canSeeUrl = can(c.var.principal, 'team', { workspace_id: c.var.principal.workspaceId })
  if (!row) return c.json(canSeeUrl ? { url: null, configured: false } : { configured: false })
  const base = c.env.PUBLIC_BASE_URL ?? new URL(c.req.url).origin
  return c.json({ ...(canSeeUrl ? { url: urlOf(base, row.token) } : {}), configured: true, has_secret: !!row.has_secret, last_received_at: row.last_received_at })
})
const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), b => b.toString(16).padStart(2, '0')).join('')
hotmartPanel.put('/integrations/hotmart', async c => {
  authorize(c.var.principal, 'team')
  // hottok omitido ou vazio mantém o segredo; null limpa. rotate troca o token e a URL antiga deixa de valer na hora.
  const { hottok, rotate } = hotmartSettingsSchema.parse(await json(c.req.raw))
  const ws = c.var.principal.workspaceId
  // Só o hash vai para o banco; um hottok novo apaga também o valor em claro das linhas de antes do secret_hash.
  await c.env.DB.prepare(`INSERT INTO integration_hooks (token,workspace_id,kind,secret_hash) VALUES (?,?,'hotmart',?)
    ON CONFLICT(workspace_id,kind) DO UPDATE SET secret_hash=coalesce(excluded.secret_hash,integration_hooks.secret_hash),
      secret=CASE WHEN excluded.secret_hash IS NULL THEN integration_hooks.secret END`).bind(newToken(), ws, hottok ? await digest(hottok) : null).run()
  if (hottok === null) await c.env.DB.prepare("UPDATE integration_hooks SET secret=NULL,secret_hash=NULL WHERE workspace_id=? AND kind='hotmart'").bind(ws).run()
  if (rotate) await c.env.DB.prepare("UPDATE integration_hooks SET token=? WHERE workspace_id=? AND kind='hotmart'").bind(newToken(), ws).run()
  const row = await c.env.DB.prepare("SELECT token FROM integration_hooks WHERE workspace_id=? AND kind='hotmart'").bind(ws).first<string>('token')
  return c.json({ url: urlOf(c.env.PUBLIC_BASE_URL ?? new URL(c.req.url).origin, row!) })
})

/** Linha de antes do secret_hash (hottok em claro em secret): grava o hash e apaga o valor; a condição em secret não desfaz uma gravação feita no meio. */
const hashLegacy = (db: D1Database, token: string, plain: string, hash: string) =>
  db.prepare("UPDATE integration_hooks SET secret_hash=?,secret=NULL WHERE token=? AND kind='hotmart' AND secret=?").bind(hash, token, plain)
/** Cron diário: converte os hottoks em claro que nenhum webhook nem gravação converteu. */
export async function hashLegacyHottoks(db: D1Database): Promise<void> {
  const { results } = await db.prepare("SELECT token,secret FROM integration_hooks WHERE kind='hotmart' AND secret IS NOT NULL LIMIT 500").all<{ token: string; secret: string }>()
  if (results.length) await db.batch(await Promise.all(results.map(async row => hashLegacy(db, row.token, row.secret, await digest(row.secret)))))
}

// "id": código único do evento no contrato 2.0.0, https://developers.hotmart.com/docs/pt-BR/2.0.0/webhook/purchase-webhook
// e .../cart-abandonment-webhook (conferido em 2026-11-13). Id vazio, nulo, longo demais ou de outro tipo conta como ausente (não dá 400).
const eventIdOf = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? String(value)
  : typeof value === 'string' && value.length >= 1 && value.length <= 200 ? value : undefined
const payload = z.object({ id: z.unknown().optional(), event: z.string(), data: z.object({
  buyer: z.object({ email: z.email().optional(), name: z.string().optional(), checkout_phone: z.string().optional(), phone: z.string().optional() }).passthrough().optional(),
  product: z.object({ id: z.union([z.string(), z.number()]).transform(String).optional(), name: z.string().optional() }).passthrough().optional(),
  purchase: z.object({ status: z.string().optional() }).passthrough().optional(),
}).passthrough() }).passthrough()

export const hotmartHook = new Hono<{ Bindings: Env }>()
hotmartHook.post('/:token', async c => {
  const token = c.req.param('token')
  const hook = await c.env.DB.prepare("SELECT workspace_id,secret,secret_hash FROM integration_hooks WHERE token=? AND kind='hotmart'").bind(token).first<{ workspace_id: string; secret: string | null; secret_hash: string | null }>()
  if (!hook) throw new HTTPException(404)
  let expected = hook.secret_hash
  if (hook.secret !== null) {
    expected = await digest(hook.secret)
    await hashLegacy(c.env.DB, token, hook.secret, expected).run()
  }
  if (expected && !await equalSecret(await digest(c.req.header('X-HOTMART-HOTTOK') ?? ''), expected)) throw new HTTPException(401)
  const parsed = payload.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) throw new HTTPException(400)
  const ws = hook.workspace_id, { event, data } = parsed.data, eventId = eventIdOf(parsed.data.id)
  await c.env.DB.prepare("UPDATE integration_hooks SET last_received_at=? WHERE token=?").bind(Date.now(), token).run()
  // A reentrega do mesmo id responde 200 sem reprocessar. Evento sem id (fora do contrato 2.0.0) é processado como antes.
  if (eventId && !(await c.env.DB.prepare('INSERT INTO hotmart_events (workspace_id,event_id,received_at) VALUES (?,?,?) ON CONFLICT DO NOTHING').bind(ws, eventId, Date.now()).run()).meta.changes)
    return c.json({ accepted: true, duplicate: true, started: 0 })
  try {
    const started = await startFlows(c.env, ws, eventId, event, data)
    // Nada iniciado (automação ainda não publicada, gatilho pausado, contato sem canal): a marca sai para o "reenviar" do histórico
    // da Hotmart funcionar depois. Repetir é seguro: a execução tem id derivado do evento.
    if (eventId && started === 0) await c.env.DB.prepare('DELETE FROM hotmart_events WHERE workspace_id=? AND event_id=?').bind(ws, eventId).run()
    return c.json({ accepted: true, started })
  } catch (error) {
    // Falhou no meio: solta o id para a Hotmart reenviar. Contato e campos são reaproveitados e a execução tem id derivado do evento.
    if (eventId) await c.env.DB.prepare('DELETE FROM hotmart_events WHERE workspace_id=? AND event_id=?').bind(ws, eventId).run()
    throw error
  }
})

async function startFlows(env: Env, ws: string, eventId: string | undefined, event: string, data: z.infer<typeof payload>['data']): Promise<number> {
  const email = data.buyer?.email?.toLowerCase(), phone = (data.buyer?.checkout_phone ?? data.buyer?.phone ?? '').replace(/\D/g, '') || null
  if (!email && !phone) return 0
  let contact = await env.DB.prepare("SELECT id FROM contacts WHERE workspace_id=? AND status<>'deleted' AND (email=? OR phone=?) LIMIT 1").bind(ws, email ?? null, phone).first<string>('id')
  if (!contact) {
    contact = crypto.randomUUID()
    const [first, ...rest] = (data.buyer?.name ?? '').trim().split(/\s+/)
    await env.DB.prepare("INSERT INTO contacts(id,workspace_id,first_name,last_name,email,phone,optin_source) VALUES (?,?,?,?,?,?,'hotmart')").bind(contact, ws, first || null, rest.join(' ') || null, email ?? null, phone).run()
  }
  const context: Record<string, string> = { produto: data.product?.name ?? '', status: data.purchase?.status ?? '', evento: event }
  await env.DB.batch(Object.entries(context).map(([name, value]) => env.DB.prepare(`INSERT INTO contact_field_values (workspace_id,contact_id,field_id,value)
    SELECT ?,?,id,? FROM custom_fields WHERE workspace_id=? AND lower(name)=? AND scope='contact' AND type='text' AND archived=0
    ON CONFLICT(contact_id,field_id) DO UPDATE SET value=excluded.value,updated_at=?`).bind(ws, contact, JSON.stringify(value), ws, name, Date.now())))
  const triggers = await env.DB.prepare(`SELECT t.id,t.config,a.published_version_id FROM triggers t JOIN automations a ON a.workspace_id=t.workspace_id AND a.id=t.automation_id
    WHERE t.workspace_id=? AND t.kind='external_trigger' AND json_extract(t.config,'$.source')='hotmart' AND t.status='active' AND a.status='live' AND a.deleted_at IS NULL AND a.published_version_id IS NOT NULL`)
    .bind(ws).all<{ id: string; config: string; published_version_id: string }>()
  const link = await env.DB.prepare(`SELECT cc.channel_id FROM contact_channels cc JOIN channels ch ON ch.workspace_id=cc.workspace_id AND ch.id=cc.channel_id
    WHERE cc.workspace_id=? AND cc.contact_id=? AND ch.archived_at IS NULL ORDER BY cc.updated_at DESC LIMIT 1`).bind(ws, contact).first<string>('channel_id')
  let started = 0
  for (const trigger of triggers.results) {
    const config = JSON.parse(trigger.config) as { node_id?: string; events?: string[]; product_ids?: string[] }
    if (!config.events?.includes(event) || config.product_ids?.length && !config.product_ids.includes(data.product?.id ?? '')) continue
    if (!link || !hasFlow(env)) continue
    // Com id, a execução de cada gatilho tem id derivado do evento: a reentrega depois de uma falha retoma a mesma, não cria outra.
    const runId = `hotmart-${eventId ? await stableId(ws, eventId, trigger.id) : crypto.randomUUID()}`
    await env.DB.prepare('INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,trigger_id,channel_id,start_node_id) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .bind(runId, ws, contact, trigger.published_version_id, trigger.id, link, config.node_id ?? null).run()
    await ensureWorkflow(env, runId)
    started++
  }
  return started
}
