import { z } from 'zod'

/** The WhatsApp Business Account (WABA) behind a pasted token, and the app's subscription to its webhooks.
 * Nothing here logs in through Meta: it uses only the token the person pasted. */
type Call = { base: string; token: string; fetch: typeof fetch }

const ok = async (response: Response) => response.ok ? await response.json().catch(() => undefined) : undefined

/** debug_token (solution-providers/manage-accounts.md, "Get shared Messaging account ID with access token"; permissions.md): the app that owns the token
 * and the accounts it was granted `whatsapp_business_management` on (granular_scopes[].target_ids). Any failure means "not known". */
const debugToken = z.object({ data: z.object({ app_id: z.coerce.string().optional(), granular_scopes: z.array(z.object({ scope: z.string(), target_ids: z.array(z.coerce.string()).optional() }).passthrough()).optional() }).passthrough() })
export async function inspectToken({ base, token, fetch }: Call): Promise<{ appId?: string; wabaIds: string[] }> {
  try {
    const parsed = debugToken.safeParse(await ok(await fetch(`${base}/debug_token?input_token=${encodeURIComponent(token)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })))
    if (!parsed.success) return { wabaIds: [] }
    const wabaIds = parsed.data.data.granular_scopes?.filter(s => s.scope === 'whatsapp_business_management').flatMap(s => s.target_ids ?? []) ?? []
    return { ...(parsed.data.data.app_id ? { appId: parsed.data.data.app_id } : {}), wabaIds: [...new Set(wabaIds.filter(id => /^\d{1,64}$/.test(id)))].slice(0, 10) }
  } catch { return { wabaIds: [] } }
}

/** What blocks or limits messaging on one node behind the number (WABA, business, app, the number itself). */
export type SendBlock = { entity: string; status: string; errors: { code: number; description?: string; solution?: string }[]; info?: string[] }
export type NumberHealth = { ownerWaba?: string; overall?: string; blocks: SendBlock[] }
const healthEntity = z.object({ entity_type: z.string().max(64), id: z.coerce.string().max(64).optional(), can_send_message: z.string().max(32).optional(),
  errors: z.array(z.object({ error_code: z.coerce.number().int(), error_description: z.string().optional(), possible_solution: z.string().optional() }).passthrough()).max(20).optional().catch(undefined),
  additional_info: z.array(z.string()).max(20).optional().catch(undefined) }).passthrough()
const healthBody = z.object({ health_status: z.object({ can_send_message: z.string().max(32).optional(), entities: z.array(z.unknown()).max(50) }).passthrough() })
const clip = (text: string | undefined, max: number) => text ? text.replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[oculto]').slice(0, max) : undefined
/** GET /{phone-number-id}?fields=health_status (support/health-status.md): the WABA entity is the account that owns the number (the one Meta looks
 * templates up in; a shared account also lists the number in /{waba}/phone_numbers), and every node whose `can_send_message` is not AVAILABLE says
 * what blocks sending. `can_receive_call_sip` is calling only and is ignored. Any failure means "not known" (undefined), never a broken connection. */
export async function readNumberHealth({ base, token, fetch }: Call, phoneNumberId: string): Promise<NumberHealth | undefined> {
  try {
    const response = await fetch(`${base}/${encodeURIComponent(phoneNumberId)}?fields=health_status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
    const parsed = healthBody.safeParse(await ok(response))
    if (!parsed.success) return undefined
    const entities = parsed.data.health_status.entities.flatMap(raw => { const one = healthEntity.safeParse(raw); return one.success ? [one.data] : [] })
    const waba = entities.find(e => e.entity_type === 'WABA')?.id
    const blocks = entities.filter(e => e.can_send_message && e.can_send_message !== 'AVAILABLE').map(e => ({ entity: e.entity_type, status: e.can_send_message!,
      errors: (e.errors ?? []).map(x => ({ code: x.error_code, ...(clip(x.error_description, 300) ? { description: clip(x.error_description, 300) } : {}), ...(clip(x.possible_solution, 300) ? { solution: clip(x.possible_solution, 300) } : {}) })),
      ...(e.additional_info?.length ? { info: e.additional_info.map(i => clip(i, 300)!).filter(Boolean) } : {}) }))
    return { ...(waba && /^\d{1,64}$/.test(waba) ? { ownerWaba: waba } : {}), ...(parsed.data.health_status.can_send_message ? { overall: parsed.data.health_status.can_send_message } : {}), blocks }
  } catch { return undefined }
}

/** First account of the token that lists this phone number. `owns` is the same proof used for a typed account id. Used only when the owner could
 * not be read from the number's health: a shared account lists the number too, so the first match may not be the owner. */
export async function discoverWaba(candidates: string[], owns: (wabaId: string) => Promise<boolean>): Promise<string | undefined> {
  for (const id of candidates) if (await owns(id)) return id
  return undefined
}

const subscribedApps = z.object({ data: z.array(z.object({ whatsapp_business_api_data: z.object({ id: z.coerce.string().optional() }).passthrough().optional() }).passthrough()) })
/** "You must individually subscribe to every Messaging account for which you want to receive webhooks" (solution-providers/manage-webhooks.md).
 * POST /{WABA}/subscribed_apps with no body is the documented call, BUT it also removes any alternate callback URL of that account (webhooks/override.md,
 * "Delete Messaging account alternate callback"). So it is only sent when the app is provably not in the list: our app id is known and absent, or the list is empty.
 * With another app in the list and our id unknown, nothing is changed. Returns whether the app is now known to be subscribed. */
export async function ensureSubscribed(call: Call, wabaId: string, appId: string | undefined): Promise<boolean> {
  const url = `${call.base}/${wabaId}/subscribed_apps`
  const headers = { Authorization: `Bearer ${call.token}` }
  try {
    const listed = subscribedApps.safeParse(await ok(await call.fetch(url, { headers, signal: AbortSignal.timeout(10_000) })))
    if (!listed.success) return false
    const ids = listed.data.data.map(app => app.whatsapp_business_api_data?.id)
    if (appId && ids.includes(appId)) return true
    if (!appId && ids.length > 0) return false
    const done = z.object({ success: z.literal(true) }).passthrough().safeParse(await ok(await call.fetch(url, { method: 'POST', headers, signal: AbortSignal.timeout(10_000) })))
    return done.success
  } catch { return false }
}
