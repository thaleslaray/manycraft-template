import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { Env } from '../env'
import type { AuthVariables } from '../team'
import { authorize } from '../permissions'
import { connectionRuntime } from './core/runtime'
import { metaRefusalNotice, metaRefusalStatus, NO_CREDENTIALS, parseMetaError } from './core/meta-error'
import type { MetaErrorInfo } from './types'

/** Revisão de recursos de mensagem da Meta: o que a conexão pode usar, com o status de cada recurso.
 * Permissões do token (`/me/permissions`: granted, declined, expired) e, quando há página, a revisão de recursos
 * de mensagem da página (`/{page}/messaging_feature_review`: approved, pending, rejected, limited). */
export type ReviewItem = { feature: string; source: 'permission' | 'messaging_feature'; status: string }
const metaProviders = new Set(['messenger_page', 'instagram_unified', 'meta_whatsapp_cloud'])

type GraphRead = { data: Record<string, unknown>[] } | { error?: MetaErrorInfo }
async function graph(fetcher: typeof fetch, url: string, token: string): Promise<GraphRead> {
  const r = await fetcher(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null)
  const body = r ? await r.json().catch(() => null) as { data?: Record<string, unknown>[] } | null : null
  if (r?.ok && Array.isArray(body?.data)) return { data: body.data }
  return { error: parseMetaError(body) }
}

/** `missing_credentials`: a conexão não tem token guardado (nada vai à Meta). `failed`: a Meta não devolveu, com o erro dela quando respondeu. */
export type MetaReviewResult = { items: ReviewItem[] } | { failure: 'missing_credentials' } | { failure: 'failed'; meta?: MetaErrorInfo }
export async function metaReview(fetcher: typeof fetch, apiBase: string, credentials: Record<string, string | undefined>): Promise<MetaReviewResult> {
  const token = credentials.accessToken
  if (!token) return { failure: 'missing_credentials' }
  const permissions = await graph(fetcher, `${apiBase}/me/permissions`, token)
  const pageId = credentials.pageId
  const features = pageId && /^\d{1,64}$/.test(pageId) ? await graph(fetcher, `${apiBase}/${pageId}/messaging_feature_review`, token) : undefined
  const ok = (read?: GraphRead) => read && 'data' in read ? read.data : undefined
  if (!ok(permissions) && !ok(features)) {
    const meta = ('error' in permissions && permissions.error) || (features && 'error' in features ? features.error : undefined)
    return { failure: 'failed', ...(meta ? { meta } : {}) }
  }
  return { items: [
    ...(ok(permissions) ?? []).flatMap(p => typeof p.permission === 'string' ? [{ feature: p.permission, source: 'permission' as const, status: String(p.status ?? 'unknown') }] : []),
    ...(ok(features) ?? []).flatMap(f => typeof f.feature === 'string' ? [{ feature: f.feature, source: 'messaging_feature' as const, status: String(f.status ?? 'unknown') }] : []),
  ] }
}

export const metaReviewRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
metaReviewRoutes.get('/connections/:id/meta-review', async c => {
  authorize(c.var.principal, 'team')
  const runtime = await connectionRuntime(c.env, c.var.principal.workspaceId, c.req.param('id')).catch(() => null)
  if (!runtime) throw new HTTPException(404)
  if (!metaProviders.has(runtime.connection.provider)) throw new HTTPException(409, { message: 'Só conexões da Meta têm revisão de recursos.' })
  const settings = runtime.connection.settings
  const apiBase = `${typeof settings.apiBase === 'string' ? settings.apiBase : 'https://graph.facebook.com'}/v26.0`
  const result = await metaReview(runtime.fetch, apiBase, await runtime.credentials() as Record<string, string | undefined>)
  if ('items' in result) return c.json({ items: result.items })
  if (result.failure === 'missing_credentials') throw new HTTPException(409, { message: NO_CREDENTIALS })
  // A Meta respondeu com erro: repassa código/subcódigo traduzidos; sem resposta (rede, 5xx sem corpo) é falha dela, 502.
  if (result.meta) throw new HTTPException(metaRefusalStatus(result.meta), { message: metaRefusalNotice('a revisão de recursos', result.meta) })
  throw new HTTPException(502, { message: 'A Meta não devolveu a revisão de recursos.' })
})
