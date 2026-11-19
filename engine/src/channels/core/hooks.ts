import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { IntegrationEnv } from '../../integrations'
import type { RawWebhook } from '../contract'
import { connectionColumns, type ConnectionRow } from './connection'
import { runtimeFromRow, type ConnectionRuntime } from './runtime'
import { decodedBody } from './body-encoding'
import { digest, equalSecret, MAX_WEBHOOK_BYTES, noteRefused, readLimitedBody, parseJson, webhookErrors, WHATSAPP_MAX_WEBHOOK_BYTES } from './webhook-http'
import { openRow } from './credentials'
import { kindForMetaObject } from '../providers'
import { resolveProviderAdapter } from '../registry'
import { z } from 'zod'
import type { ChannelType } from '../types'
import { inboundEventSchema, sourceOf } from './queue'
import { liteRow } from './connection'
import type { DeliveryPart, InboundEventV2 } from '../contract'
import { processInboundFast } from '../../jobs'

/** Caminho rápido ligado (padrão): depois de enfileirar, o webhook já processa os eventos. FAST_INBOUND="off" volta a esperar a fila. */
function fastPath(env: IntegrationEnv, waitUntil: ((promise: Promise<void>) => void) | undefined, envelopes: unknown[]): void {
  if (!waitUntil || !envelopes.length || env.FAST_INBOUND === 'off' || !env.FLOW_RUN) return
  // Sem contexto de execução (chamada interna, teste) a fila basta.
  try { waitUntil(Promise.resolve()) } catch { return }
  waitUntil(processInboundFast(envelopes, env))
}

/** O que a tela da conexão mostra quando a Meta entrega mensagens com assinatura que não confere. */
export const SIGNATURE_REJECTED = 'A Meta mandou mensagens, mas a assinatura não confere com a chave secreta salva. Copie a chave secreta do app (Configurações do app > Básico > Mostrar) e cole em Trocar credencial.'

/** Events the provider cannot use are still acknowledged, but never silently: one counted line per delivery and reason.
 * Only the provider, the connection and the reason are logged (no ids, phones or text). */
function noteIgnored(rt: ConnectionRuntime, events: InboundEventV2[]): void {
  const counts = new Map<string, number>()
  for (const event of events) if (event.kind === 'ignored') counts.set(event.why, (counts.get(event.why) ?? 0) + 1)
  for (const [why, count] of counts) console.warn(JSON.stringify({ event: 'webhook_ignored', provider: rt.connection.provider, channelId: rt.connection.id, why, count }))
}

/** A delivery can reach the queue with 1,000 events. They go one at a time, in the order the provider sent them: concurrent sends reach the
 * queue in any order, and a status event overtaking the message it refers to is harder to undo than the extra round trips are to pay.
 * (`sendBatch` keeps the order too, but its 256 KB total per call cannot hold events that each carry a large payload.) */
async function enqueueAll<T>(items: T[], send: (item: T) => Promise<unknown>): Promise<void> {
  for (const item of items) await send(item)
}
/** The provider may repeat an event inside one delivery: one queue entry per account and key (the consumer dedupes redeliveries on the same key). */
function uniqueParts(parts: DeliveryPart[]): DeliveryPart[] {
  const seen = new Set<string>()
  return parts.filter(part => { const key = `${part.externalId ?? part.accountId ?? ''}\u0000${part.eventKey}`; return seen.has(key) ? false : (seen.add(key), true) })
}

/** One entry point for every provider: verify the delivery, interpret it, queue one entry per event key.
 * Nothing here knows which channel it is serving; the connection's provider does. */
export async function acceptHook(env: IntegrationEnv, rt: ConnectionRuntime, request: Request, waitUntil: (promise: Promise<void>) => void): Promise<{ accepted: true }> {
  if (!env.INBOUND) throw new HTTPException(503)
  const limit = rt.provider.maxWebhookBytes ?? MAX_WEBHOOK_BYTES
  return acceptRaw(env, rt, { method: 'POST', headers: request.headers, query: new URL(request.url).searchParams, body: await decodedBody(request.headers, await readLimitedBody(request, { bytes: limit, provider: rt.provider.id }), limit) }, waitUntil)
}

export async function acceptRaw(env: IntegrationEnv, rt: ConnectionRuntime, raw: RawWebhook, waitUntil: (promise: Promise<void>) => void): Promise<{ accepted: true }> {
  const provider = rt.provider
  if (!env.INBOUND) throw new HTTPException(503)
  const webhookSecret = await rt.webhookSecret()
  if (!webhookSecret) throw new HTTPException(503)
  const verdict = await provider.verifyWebhook(raw, { webhookSecret, credentials: await rt.credentials() })
  if (!verdict.ok) throw new HTTPException(verdict.status)
  const body = provider.decodeBody ? provider.decodeBody(raw) : parseJson(raw.body)
  const envelopes: unknown[] = []
  const send = async (target: ConnectionRuntime, eventId: string, payload: unknown) => {
    const envelope = inboundEventSchema.parse({ version: 1,
      provider: sourceOf(target.connection.kind), workspaceId: target.connection.workspaceId, channelId: target.connection.id, eventId,
      receivedAt: Date.now(), payload })
    await env.INBOUND!.send(envelope)
    envelopes.push(envelope)
  }
  // A delivery that bundles events (and accounts): this route only takes the events of its own connection's account.
  const parts = await provider.splitDelivery?.(body)
  if (parts) {
    // A part without an account belongs to whichever connection this route names (the URL already proved which one).
    const own = uniqueParts(parts).filter(part => part.externalId === undefined
      ? part.accountId === undefined || part.accountId === rt.connection.settings.accountId : part.externalId === rt.connection.externalId)
    noteIgnored(rt, own.flatMap(part => { try { return provider.parseInbound(part.payload, rt.connection) } catch { return [] } }))
    await enqueueAll(own, part => send(rt, part.eventKey, part.payload))
    fastPath(env, waitUntil, envelopes)
    return { accepted: true }
  }
  const events = provider.parseInbound(body, rt.connection)
  noteIgnored(rt, events)
  const credentials = await rt.credentials()
  // Acknowledge clicks before queue acceptance and outside its critical path.
  for (const event of events) if (event.kind === 'click' && provider.ack) waitUntil(provider.ack({ credentials, fetch: rt.fetch, connection: rt.connection }, event))
  const keys = [...new Set(events.flatMap(event => 'eventKey' in event && event.eventKey ? [event.eventKey] : []))]
  // Await durable queue acceptance: a failed send must make the provider retry.
  await enqueueAll(keys, eventKey => send(rt, eventKey, body))
  fastPath(env, waitUntil, envelopes)
  return { accepted: true }
}

export const hooks = new Hono<{ Bindings: IntegrationEnv }>()

/** Handshake some providers do with a GET (the verdict carries the challenge to echo). */
hooks.get('/:connectionId', async (c) => {
  const rt = await resolve(c.env, c.req.param('connectionId'))
  const webhookSecret = await rt.webhookSecret()
  if (!webhookSecret) throw new HTTPException(404)
  const verdict = await rt.provider.verifyWebhook({ method: 'GET', headers: c.req.raw.headers, query: new URL(c.req.url).searchParams, body: new Uint8Array() },
    { webhookSecret, credentials: await rt.credentials() })
  if (!verdict.ok) throw new HTTPException(verdict.status)
  return c.text(verdict.challenge ?? '')
})
hooks.post('/:connectionId', async (c) => {
  const rt = await resolve(c.env, c.req.param('connectionId'))
  return c.json(await acceptHook(c.env, rt, c.req.raw, promise => c.executionCtx.waitUntil(promise)))
})
hooks.onError(webhookErrors)

/** The connection comes from the URL, never from the payload or a header: unknown or disconnected is a 404. */
async function resolve(env: IntegrationEnv, connectionId: string): Promise<ConnectionRuntime> {
  const row = await env.DB.prepare(`SELECT ${connectionColumns} FROM channels WHERE id = ? AND status = 'connected'`).bind(connectionId).first<ConnectionRow>()
  if (!row) throw new HTTPException(404)
  return runtimeFromRow(env, row)
}

/** Pre-layer route of the single bot. Each connection owns its webhook secret, so the secret header finds the connection;
 * the delivery then goes through the same pipeline (and the same verification) as /api/hooks/:id. */
export const legacyHooks = new Hono<{ Bindings: IntegrationEnv }>()
legacyHooks.onError(webhookErrors)
legacyHooks.post('/telegram', async (c) => {
  const supplied = c.req.header('X-Telegram-Bot-Api-Secret-Token')
  if (!supplied) throw new HTTPException(401)
  const row = await c.env.DB.prepare(`SELECT ${connectionColumns} FROM channels WHERE type = 'telegram' AND status = 'connected' AND webhook_secret_hash = ?`)
    .bind(await digest(supplied)).first<ConnectionRow>()
  if (!row) throw new HTTPException(401)
  return c.json(await acceptHook(c.env, await runtimeFromRow(c.env, row), c.req.raw, promise => c.executionCtx.waitUntil(promise)))
})

/** Teto de contas distintas por entrega na rota compartilhada. Os exemplos oficiais da Meta trazem 1; 50 é folga (e o mesmo limite de conexões por conta). */
const MAX_SHARED_ACCOUNTS = 50

/** Shared app route (Meta): one delivery can carry several accounts. Each account's connection proves the delivery with its own
 * app secret, and only then does every event go to the connection that owns the account it names. */
/** No máximo uma tentativa de assumir a mesma conversa a cada 10 min (por isolate; memória limitada). */
const TAKE_CONTROL_EVERY_MS = 10 * 60_000
const takeControlTried = new Map<string, number>()
function shouldTakeControl(key: string, now = Date.now()): boolean {
  const last = takeControlTried.get(key)
  if (last !== undefined && now - last < TAKE_CONTROL_EVERY_MS) return false
  if (takeControlTried.size >= 5000) for (const [k, at] of takeControlTried) if (now - at >= TAKE_CONTROL_EVERY_MS || takeControlTried.size >= 5000) takeControlTried.delete(k)
  takeControlTried.set(key, now)
  return true
}

/** Conversa em standby (outro app é o dono): depois de enfileirar, tenta assumir fora do caminho da resposta. Só loga {event, ok, code}. */
async function takeControl(target: ConnectionRuntime, userId: string): Promise<void> {
  const take = target.provider.takeThreadControl
  if (!take) return
  // Nunca rejeita: roda em waitUntil e, sem contexto de execução, solto (credenciais ilegíveis contam como falha).
  const result = await (async () => take({ connection: target.connection, credentials: await target.credentials(), fetch: target.fetch }, userId))().catch(() => ({ ok: false, code: 'error' as string | number }))
  console.log(JSON.stringify({ event: 'instagram_take_control', ok: result.ok, code: result.code ?? null }))
}

export async function acceptSharedDelivery(env: IntegrationEnv, kind: ChannelType, raw: RawWebhook, waitUntil?: (promise: Promise<void>) => void): Promise<{ accepted: true }> {
  const provider = (await runtimeFromRow(env, liteRow(kind, '', ''), { secrets: false })).provider
  const parts = await provider.splitDelivery?.(parseJson(raw.body))
  if (!parts) throw new HTTPException(400)
  if (!parts.length) return { accepted: true }
  if (!env.INBOUND) throw new HTTPException(503)
  const located = new Map<string, ConnectionRuntime>()
  /** Events about the account itself (no single connection): every connection that holds the account gets them. */
  const holders = new Map<string, ConnectionRuntime[]>()
  // A assinatura é conferida pelo provider da própria linha (provedores que dividem um canal não dividem a chave nem o host);
  // o provider padrão do canal só decide como a entrega é dividida.
  const verified = async (row: ConnectionRow) => {
    const rt = await runtimeFromRow(env, row)
    const verdict = await rt.provider.verifyWebhook(raw, { webhookSecret: (await rt.webhookSecret()) ?? '', credentials: await rt.credentials() })
    if (!verdict.ok) {
      // A entrega veio para uma conta conhecida, mas a assinatura não bate: quase sempre é a chave secreta do app errada na conexão.
      // Sem este registro a recusa fica invisível (a Meta só vê 401 e a tela continua "conectada").
      console.warn(JSON.stringify({ event: 'webhook_rejected', reason: 'signature', provider: row.provider, channelId: row.id }))
      await env.DB.prepare('UPDATE channels SET status_detail = ? WHERE workspace_id = ? AND id = ?')
        .bind(SIGNATURE_REJECTED, row.workspace_id, row.id).run().catch(() => undefined)
      throw new HTTPException(verdict.status)
    }
    // Entrega autenticada desfaz o aviso de assinatura recusada (a chave foi corrigida).
    await env.DB.prepare('UPDATE channels SET status_detail = NULL WHERE workspace_id = ? AND id = ? AND status_detail = ?')
      .bind(row.workspace_id, row.id, SIGNATURE_REJECTED).run().catch(() => undefined)
    return rt
  }
  // Trabalho antes da assinatura: só os ids distintos da entrega, com teto, e no máximo uma consulta por tipo de id (não uma por id).
  const externalIds = [...new Set(parts.flatMap(part => part.externalId === undefined ? [] : [part.externalId]))]
  const accountIds = [...new Set(parts.flatMap(part => part.externalId === undefined && part.accountId !== undefined ? [part.accountId] : []))]
  // A shared route can only place an event by the account it names.
  if (parts.some(part => part.externalId === undefined && part.accountId === undefined)) throw new HTTPException(400)
  if (externalIds.length + accountIds.length > MAX_SHARED_ACCOUNTS) throw new HTTPException(413)
  const marks = (list: string[]) => list.map(() => '?').join(',')
  const byExternal = new Map<string, ConnectionRow>()
  if (externalIds.length) {
    const rows = await env.DB.prepare(`SELECT ${connectionColumns} FROM channels WHERE type = ? AND external_id IN (${marks(externalIds)}) AND status = 'connected'`)
      .bind(kind, ...externalIds).all<ConnectionRow>()
    for (const row of rows.results) byExternal.set(row.external_id, row)
  }
  const byAccount = new Map<string, ConnectionRow[]>()
  if (accountIds.length) {
    const rows = await env.DB.prepare(`SELECT ${connectionColumns}, json_extract(settings, '$.accountId') AS holder_account FROM channels
      WHERE type = ? AND json_extract(settings, '$.accountId') IN (${marks(accountIds)}) AND status = 'connected' ORDER BY id`)
      .bind(kind, ...accountIds).all<ConnectionRow & { holder_account: string }>()
    for (const row of rows.results) { const list = byAccount.get(row.holder_account) ?? []; if (list.length < 50) { list.push(row); byAccount.set(row.holder_account, list) } }
  }
  for (const { externalId, accountId } of parts) {
    if (externalId === undefined && accountId !== undefined) {
      if (holders.has(accountId)) continue
      // Each holder proves the delivery on its own: one that cannot (revoked token, another app's secret) is left out, it never costs the others their events.
      holders.set(accountId, (await Promise.all((byAccount.get(accountId) ?? []).map(row => verified(row).catch(() => undefined)))).filter((rt): rt is ConnectionRuntime => !!rt))
      continue
    }
    if (externalId === undefined) throw new HTTPException(400)
    if (located.has(externalId)) continue
    const row = byExternal.get(externalId)
    // An account this system does not hold (another system's page, an archived connection) is skipped: it must not cost the others their events.
    if (!row) continue
    located.set(externalId, await verified(row))
  }
  // With no known account at all, nothing can prove the delivery.
  if (!located.size && ![...holders.values()].some(list => list.length)) {
    // Ids de conta não são segredo e são o que falta para entender a recusa (conta não conectada aqui ou id diferente do colado).
    if (!byExternal.size && ![...byAccount.values()].some(list => list.length)) {
      console.warn(JSON.stringify({ event: 'webhook_rejected', reason: 'unknown_account', kind, accounts: [...externalIds, ...accountIds].slice(0, 10) }))
    }
    throw new HTTPException(401)
  }
  // A partial failure returns an error; already queued items are safe to replay (consumer dedupe).
  const envelopes: unknown[] = []
  await enqueueAll(uniqueParts(parts), async (part) => {
    const targets = part.externalId === undefined ? holders.get(part.accountId!) ?? [] : [located.get(part.externalId)].filter((t): t is ConnectionRuntime => !!t)
    for (const target of targets) {
      noteIgnored(target, (() => { try { return target.provider.parseInbound(part.payload, target.connection) } catch { return [] } })())
      const envelope = inboundEventSchema.parse({ version: 1, provider: sourceOf(kind), workspaceId: target.connection.workspaceId, channelId: target.connection.id,
        eventId: part.eventKey, receivedAt: Date.now(), payload: part.payload })
      await env.INBOUND!.send(envelope)
      envelopes.push(envelope)
      if (part.standbySender && waitUntil && target.provider.takeThreadControl && shouldTakeControl(`${target.connection.id}:${part.standbySender}`)) {
        // Sem contexto de execução (chamada interna, teste) o waitUntil lança: o evento já está na fila, então só pula a tomada de controle.
        try { waitUntil(takeControl(target, part.standbySender)) } catch { /* sem contexto de execução */ }
      }
    }
  })
  fastPath(env, waitUntil, envelopes)
  return { accepted: true }
}

const handshake = z.object({
  'hub.mode': z.literal('subscribe'), 'hub.verify_token': z.string().min(1).max(512),
  'hub.challenge': z.string().min(1).max(1024).regex(/^[a-zA-Z0-9_-]+$/),
})
/** Pre-layer shared app route: one URL (and one verify token) for every Meta product of the app.
 * Kept because the Meta app's webhook points here; it goes away once no connection depends on it (check production before removing).
 * Verify token and app secret are read from the connections' own credentials. */
legacyHooks.get('/meta', async (c) => {
  const query = handshake.parse(c.req.query())
  // The verify token belongs to the connections (encrypted on their rows), never to the Worker environment.
  // Any live row answers (not only 'connected'): the app subscription is made right after the row is stored, and a row still 'pending'/'error'
  // has to pass Meta's check to leave that state. Archived rows and rows disabled by the team ('disconnected') never answer.
  // Only rows whose stored token hash matches are decrypted (rows from before the hash existed are the bounded fallback).
  const rows = await c.env.DB.prepare(`SELECT ${connectionColumns} FROM channels WHERE archived_at IS NULL AND status <> 'disconnected' AND type IN ('whatsapp','instagram','messenger')
    AND (webhook_secret_hash = ? OR webhook_secret_hash IS NULL)`).bind(await digest(query['hub.verify_token'])).all<ConnectionRow>()
  for (const row of rows.results) {
    const credentials = await openRow(c.env, row.workspace_id, row.id, row)
    const token = credentials.webhookSecret ?? credentials.verifyToken
    if (token && await equalSecret(query['hub.verify_token'], token)) return c.text(query['hub.challenge'])
  }
  throw new HTTPException(403)
})
legacyHooks.post('/meta', async (c) => {
  if (!c.env.INBOUND) throw new HTTPException(503)
  // The largest limit of any Meta product is read; the product found in the body then holds the delivery to its own.
  const bytes = await readLimitedBody(c.req.raw, { bytes: WHATSAPP_MAX_WEBHOOK_BYTES, provider: 'meta' })
  // Only the object discriminator is inspected before authentication; no identity is resolved yet.
  const raw = parseJson(bytes)
  const object = typeof raw === 'object' && raw !== null ? (raw as { object?: unknown }).object : undefined
  const kind = kindForMetaObject(object)
  if (!kind) throw new HTTPException(400)
  const adapter = resolveProviderAdapter(kind, undefined)
  const limit = adapter.maxWebhookBytes ?? MAX_WEBHOOK_BYTES
  if (bytes.byteLength > limit) { noteRefused(adapter.id, 'payload_too_large', { limitBytes: limit }); throw new HTTPException(413) }
  return c.json(await acceptSharedDelivery(c.env, kind, { method: 'POST', headers: c.req.raw.headers, query: new URL(c.req.url).searchParams, body: bytes }, promise => c.executionCtx.waitUntil(promise)))
})
