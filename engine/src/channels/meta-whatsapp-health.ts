import { z } from 'zod'
import type { SyncContext } from './contract'
import { categories, statuses } from './meta-templates'

/** Avisos sobre a conta e sobre os contatos (user_preferences, qualidade, limites, alertas, restrições, revisão, modelos).
 * Chegam como eventos "ignorados" pelo executor de fluxo (nada a executar) e são gravados em `sync`. */
export type AccountItem = { eventKey: string; externalId?: string; accountId?: string; payload: Record<string, unknown> }

export const accountFields = ['user_preferences', 'phone_number_quality_update', 'business_capability_update', 'account_alerts', 'account_update',
  'account_review_update', 'message_template_status_update', 'message_template_quality_update', 'template_category_update'] as const

const accountEvents = ['ACCOUNT_RESTRICTION', 'ACCOUNT_VIOLATION', 'DISABLED_UPDATE', 'ACCOUNT_DELETED', 'ACCOUNT_OFFBOARDED', 'ACCOUNT_RECONNECTED']
const hash = (value: string) => { let h = 5381; for (let i = 0; i < value.length; i++) h = ((h * 33) ^ value.charCodeAt(i)) >>> 0; return h.toString(36) }
const phoneNumberId = z.object({ phone_number_id: z.string().min(1).max(512) })
const preference = z.object({ user_id: z.string().max(512).optional(), wa_id: z.string().max(64).optional(), category: z.string().max(64),
  value: z.enum(['stop', 'resume']), timestamp: z.coerce.number().int().nonnegative() })

/** The queue items of one change of an `entry` (empty when the field is not an account notice or cannot be read). */
export function accountItems(accountId: string | undefined, time: number | undefined, change: { field: string; value: Record<string, unknown> }): AccountItem[] {
  const { field, value } = change
  if (!(accountFields as readonly string[]).includes(field)) return []
  if (field === 'user_preferences') {
    const located = phoneNumberId.safeParse(value.metadata)
    if (!located.success) return []
    // One unreadable item must not cost the contacts of the same notice their opt-out: each is read on its own.
    return z.array(z.unknown()).catch([]).parse(value.user_preferences).flatMap(raw => {
      const parsed = preference.passthrough().safeParse(raw)
      if (!parsed.success) return []
      const item = parsed.data
      const user = item.user_id ?? item.wa_id
      if (!user) return []
      const eventKey = `pref:${item.timestamp}:${user}:${item.value}`
      return [{ eventKey, externalId: located.data.phone_number_id, payload: { ...item, id: eventKey, field, kind: 'account', at: item.timestamp * 1000 } }]
    })
  }
  if (!accountId) return []
  // Only the account events that are booked: the rest of `account_update` (partners, ad accounts...) has nothing to say here.
  if (field === 'account_update' && !accountEvents.includes(String(value.event))) return []
  const at = (time ?? Math.floor(Date.now() / 1000)) * 1000
  const eventKey = `acct:${field}:${time ?? 0}:${hash(JSON.stringify(value))}`
  return [{ eventKey, accountId, payload: { ...value, id: eventKey, field, kind: 'account', at } }]
}

type Payload = Record<string, unknown> & { at: number }
const text = (max: number) => z.string().max(max)
const keyOf = /^[A-Z][A-Z0-9_]{0,63}$/

/** One part of the health of a connection. A notice older than the one already kept never replaces it. `null` clears the part, but keeps a mark
 * with the time of the clearing (`cleared`), so an older notice that arrives late cannot bring it back; the panel never sees a cleared part.
 * `merge` adds the fields to what is already known instead of replacing it. */
async function setHealth(ctx: SyncContext, path: string, value: Record<string, unknown> | null, at: number, merge = false) {
  const stored = JSON.stringify(value === null ? { cleared: true, at } : { ...value, at })
  await ctx.env.DB.prepare(`UPDATE channels SET provider_health = json_set(provider_health, '$.' || ?, ${merge && value !== null
    ? "json_patch(coalesce(json_extract(provider_health, '$.' || ?), '{}'), json(?))" : 'json(?)'})
    WHERE workspace_id = ? AND id = ? AND coalesce(json_extract(provider_health, '$.' || ? || '.at'), 0) <= ?`)
    .bind(path, ...(merge && value !== null ? [path] : []), stored, ctx.event.workspaceId, ctx.connection.id, path, at).run()
}

/** The number a connection answers for, as the provider writes it on notices (digits only). Asked once and kept in the settings. */
async function numberOf(ctx: SyncContext, apiBase: string): Promise<string | undefined> {
  const kept = ctx.connection.settings.displayPhone
  if (typeof kept === 'string') return kept.replace(/\D/g, '')
  const phoneNumberId = ctx.credentials.phoneNumberId
  if (!phoneNumberId) return undefined
  try {
    const response = await ctx.fetch(`${apiBase}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number`, { headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` }, signal: AbortSignal.timeout(10_000) })
    const shown = z.object({ display_phone_number: z.string().max(64) }).safeParse(await response.json())
    if (!response.ok || !shown.success) return undefined
    await ctx.env.DB.prepare("UPDATE channels SET settings=json_set(settings,'$.displayPhone',?) WHERE workspace_id=? AND id=?").bind(shown.data.display_phone_number, ctx.event.workspaceId, ctx.connection.id).run()
    return shown.data.display_phone_number.replace(/\D/g, '')
  } catch { return undefined }
}

export async function recordAccountEvent(ctx: SyncContext, apiBase: string): Promise<void> {
  const payload = ctx.event.payload as Payload
  const at = Number(payload.at)
  if (!Number.isFinite(at)) return
  switch (payload.field) {
    case 'user_preferences': return recordPreference(ctx, payload)
    case 'phone_number_quality_update': {
      const v = z.object({ display_phone_number: text(64).optional(), event: text(64), current_limit: text(64).optional(),
        max_daily_conversations_per_business: z.union([z.string().max(64), z.number()]).optional() }).safeParse(payload)
      // The notice names the number by its display phone number: only the connection that answers for that number records it.
      if (!v.success) return
      const shown = v.data.display_phone_number?.replace(/\D/g, '')
      if (!shown || shown !== await numberOf(ctx, apiBase)) return
      await setHealth(ctx, 'quality', { event: v.data.event, ...(v.data.current_limit ? { limit: v.data.current_limit } : {}),
        ...(v.data.max_daily_conversations_per_business !== undefined ? { maxDaily: v.data.max_daily_conversations_per_business } : {}) }, at)
      return
    }
    case 'business_capability_update': {
      const v = z.object({ max_daily_conversations_per_business: z.union([z.string().max(64), z.number()]).optional(),
        max_daily_conversation_per_phone: z.union([z.string().max(64), z.number()]).optional(),
        max_phone_numbers_per_waba: z.number().optional(), max_phone_numbers_per_business: z.number().optional() }).safeParse(payload)
      if (!v.success) return
      const maxDaily = v.data.max_daily_conversations_per_business ?? v.data.max_daily_conversation_per_phone
      const maxNumbers = v.data.max_phone_numbers_per_waba ?? v.data.max_phone_numbers_per_business
      await setHealth(ctx, 'limits', { ...(maxDaily !== undefined ? { maxDaily } : {}), ...(maxNumbers !== undefined ? { maxNumbers } : {}) }, at, true)
      return
    }
    case 'account_alerts': {
      const v = z.object({ entity_type: text(64).optional(), alert_info: z.object({ alert_severity: text(32).optional(), alert_status: text(32).optional(),
        alert_type: z.string().regex(keyOf), alert_description: text(2000).optional() }) }).safeParse(payload)
      if (!v.success) return
      const info = v.data.alert_info
      await setHealth(ctx, `alerts.${info.alert_type}`, info.alert_status === 'ACTIVE' ? { severity: info.alert_severity ?? 'WARNING',
        ...(info.alert_description ? { description: info.alert_description.slice(0, 500) } : {}), ...(v.data.entity_type ? { entityType: v.data.entity_type } : {}) } : null, at)
      return
    }
    case 'account_review_update': {
      const v = z.object({ decision: text(32) }).safeParse(payload)
      if (v.success) await setHealth(ctx, 'review', { decision: v.data.decision }, at)
      return
    }
    case 'account_update': return recordAccountUpdate(ctx, payload, at, apiBase)
    case 'message_template_status_update': return recordTemplateStatus(ctx, payload, at)
    case 'message_template_quality_update': return recordTemplateQuality(ctx, payload)
    case 'template_category_update': return recordTemplateCategory(ctx, payload, at)
  }
}

async function recordAccountUpdate(ctx: SyncContext, payload: Payload, at: number, apiBase: string) {
  // account_update.md: `phone_number` is "only included for events about a single business phone number". The WABA notice then reaches every
  // connection of the account, but only the one that answers for that number books it. If our own number cannot be read, the warning is kept
  // (an account warning shown on the wrong number is better than one that never shows).
  if (typeof payload.phone_number === 'string') {
    const mine = await numberOf(ctx, apiBase)
    if (mine && payload.phone_number.replace(/\D/g, '') !== mine) return
  }
  switch (payload.event) {
    case 'ACCOUNT_RESTRICTION': {
      const v = z.object({ restriction_info: z.array(z.object({ restriction_type: z.string().regex(keyOf), expiration: z.number().optional() })).max(20) }).safeParse(payload)
      if (v.success) await setHealth(ctx, 'restrictions', { items: v.data.restriction_info.map(r => ({ type: r.restriction_type, ...(r.expiration ? { expiresAt: r.expiration * 1000 } : {}) })) }, at)
      return
    }
    case 'ACCOUNT_VIOLATION': {
      const v = z.object({ violation_info: z.object({ violation_type: text(64) }) }).safeParse(payload)
      if (v.success) await setHealth(ctx, 'violation', { type: v.data.violation_info.violation_type }, at)
      return
    }
    case 'DISABLED_UPDATE': {
      const v = z.object({ ban_info: z.object({ waba_ban_state: text(32) }) }).safeParse(payload)
      if (v.success) await setHealth(ctx, 'disabled', { state: v.data.ban_info.waba_ban_state }, at)
      return
    }
    case 'ACCOUNT_DELETED': return setHealth(ctx, 'removed', { event: 'deleted' }, at)
    case 'ACCOUNT_OFFBOARDED': return setHealth(ctx, 'removed', { event: 'offboarded' }, at)
    case 'ACCOUNT_RECONNECTED': return setHealth(ctx, 'removed', null, at)
  }
}

const extraStatuses: Record<string, string> = { REINSTATED: 'approved', LOCKED: 'paused' }
/** The model's status, category and rejection reason as the provider just announced them: no need to sync to see it. */
async function recordTemplateStatus(ctx: SyncContext, payload: Payload, at: number) {
  const v = z.object({ event: text(32), message_template_id: z.coerce.string().min(1).max(128), reason: text(200).optional(), message_template_category: text(32).optional(),
    rejection_info: z.object({ reason: text(2000).optional() }).optional() }).safeParse(payload)
  if (!v.success) return
  const status = extraStatuses[v.data.event.toUpperCase()] ?? statuses[v.data.event.toUpperCase()]
  if (!status) return
  const reason = status === 'rejected' ? (v.data.rejection_info?.reason ?? (v.data.reason && v.data.reason !== 'NONE' ? v.data.reason : null)) : null
  await ctx.env.DB.prepare(`UPDATE message_templates SET status=?, rejection_reason=?, category=coalesce(?, category), synced_at=?
    WHERE workspace_id=? AND channel_id=? AND provider_id=? AND (synced_at IS NULL OR synced_at<=?)`)
    .bind(status, reason?.slice(0, 2000) ?? null, categories[(v.data.message_template_category ?? '').toUpperCase()] ?? null, at,
      ctx.event.workspaceId, ctx.connection.id, v.data.message_template_id, at).run()
}
/** The category the provider moved a model to. A notice about a change still to come (`correct_category`) carries the current category and changes nothing. */
async function recordTemplateCategory(ctx: SyncContext, payload: Payload, at: number) {
  const v = z.object({ message_template_id: z.coerce.string().min(1).max(128), new_category: text(32), correct_category: text(32).optional() }).safeParse(payload)
  if (!v.success || v.data.correct_category) return
  const category = categories[v.data.new_category.toUpperCase()]
  if (!category) return
  await ctx.env.DB.prepare(`UPDATE message_templates SET category=?, synced_at=?
    WHERE workspace_id=? AND channel_id=? AND provider_id=? AND (synced_at IS NULL OR synced_at<=?)`).bind(category, at, ctx.event.workspaceId, ctx.connection.id, v.data.message_template_id, at).run()
}
async function recordTemplateQuality(ctx: SyncContext, payload: Payload) {
  const v = z.object({ new_quality_score: text(16), message_template_id: z.coerce.string().min(1).max(128) }).safeParse(payload)
  if (!v.success) return
  const score = v.data.new_quality_score.toLowerCase()
  await ctx.env.DB.prepare('UPDATE message_templates SET quality=? WHERE workspace_id=? AND channel_id=? AND provider_id=?')
    .bind(['green', 'yellow', 'red'].includes(score) ? score : 'unknown', ctx.event.workspaceId, ctx.connection.id, v.data.message_template_id).run()
}

/** A message arrived without any business-scoped user ID and was not kept (see parseItem). Booked as a health warning so it is not silent. */
export async function recordMissingBsuid(ctx: SyncContext, at: number): Promise<void> {
  await setHealth(ctx, 'alerts.NO_BSUID', { severity: 'WARNING', description: 'Chegou mensagem sem o identificador do contato (BSUID) e ela foi descartada.' }, at)
}

/** `stop` marks the contact (no more marketing); `resume` clears it. A notice older than the last one seen changes nothing. */
async function recordPreference(ctx: SyncContext, payload: Payload) {
  const v = preference.passthrough().safeParse(payload)
  if (!v.success || v.data.category !== 'marketing_messages') return
  const at = v.data.timestamp * 1000
  const blockedAt = v.data.value === 'stop' ? at : null
  const update = (identity: string) => ctx.env.DB.prepare(`UPDATE contact_channels SET marketing_blocked_at=?, marketing_preference_at=?
    WHERE workspace_id=? AND channel_id=? AND external_user_id=? AND (marketing_preference_at IS NULL OR marketing_preference_at<=?)`)
    .bind(blockedAt, at, ctx.event.workspaceId, ctx.connection.id, identity, at).run()
  const done = v.data.user_id ? await update(v.data.user_id) : undefined
  if (done?.meta.changes || !v.data.wa_id) return
  // user_preferences.md: `user_id` is omitted when business-scoped user IDs are not enabled, so the notice may name the person only by phone.
  // The opt-out is a compliance matter: it reaches the BSUID contact that carries that phone (or kept it as an alias) and the contact
  // started from the inbox by phone number. Always inside this connection.
  const digits = v.data.wa_id.replace(/^\+/, '')
  if (!/^[1-9]\d{6,14}$/.test(digits)) return
  const e164 = `+${digits}`
  await ctx.env.DB.prepare(`UPDATE contact_channels SET marketing_blocked_at=?, marketing_preference_at=?
    WHERE workspace_id=? AND channel_id=? AND (marketing_preference_at IS NULL OR marketing_preference_at<=?)
      AND ((identity_kind='wa_phone_legacy' AND external_user_id=?)
        OR (identity_kind='bsuid' AND (phone_e164=? OR id IN (SELECT contact_channel_id FROM contact_identity_aliases
          WHERE channel_id=? AND alias_kind='phone_e164' AND alias_value=?))))`)
    .bind(blockedAt, at, ctx.event.workspaceId, ctx.connection.id, at, digits, e164, ctx.connection.id, e164).run()
}
