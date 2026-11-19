import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from '../env'
import type { AuthVariables } from '../team'
import { authorize } from '../permissions'
import { connectionRuntime } from './core/runtime'
import { metaRefusalNotice, metaRefusalStatus, NO_CREDENTIALS, parseMetaError } from './core/meta-error'

export const metaAccount = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
/** Nome de usuário do número na Meta (`/{phone-number-id}/username`: GET lê, POST pede ou troca, DELETE apaga).
 * O pedido nasce reservado e a Meta aprova depois (status reserved, approved, deleted). */
export const usernamePattern = /^(?![^.]*\.(com|net|org|br|io)$)[a-z0-9._]{3,35}$/i
const usernameMessage = 'Use de 3 a 35 letras, números, ponto ou sublinhado, sem terminar em domínio.'
/** POST /connections/:id/username. `username` vira texto (sem espaços nas pontas) antes da regra; outros campos são ignorados. */
export const connectionUsernameSchema = z.object({
  username: z.preprocess(v => String(v ?? '').trim(), z.string().regex(usernamePattern, usernameMessage)).describe('Nome de usuário: 3 a 35 letras, números, ponto ou sublinhado, sem terminar em domínio (.com, .br...).'),
})
async function usernameCall(c: { env: Env; var: AuthVariables; req: { param: (k: string) => string } }, method: 'GET' | 'POST' | 'DELETE', username?: string) {
  const rt = await connectionRuntime(c.env, c.var.principal.workspaceId, c.req.param('id')).catch(() => null)
  if (!rt) throw new HTTPException(404)
  if (rt.connection.provider !== 'meta_whatsapp_cloud') throw new HTTPException(409, { message: 'Só a API oficial tem nome de usuário.' })
  const creds = await rt.credentials()
  if (!creds.accessToken) throw new HTTPException(409, { message: NO_CREDENTIALS })
  const s = rt.connection.settings
  const url = `${typeof s.apiBase === 'string' ? s.apiBase : 'https://graph.facebook.com'}/v26.0/${encodeURIComponent(creds.phoneNumberId ?? '')}/username`
  const r = await rt.fetch(url, { method, headers: { Authorization: `Bearer ${creds.accessToken}`, 'Content-Type': 'application/json' }, ...(username ? { body: JSON.stringify({ username }) } : {}), signal: AbortSignal.timeout(15_000) }).catch(() => null)
  const body = r ? await r.json().catch(() => ({})) as Record<string, unknown> : null
  if (!r?.ok) {
    // Recusa de regra (nome em uso, número sem elegibilidade, token) chega com `error` da Graph: frase traduzida e 4xx; sem resposta é falha da Meta.
    const meta = parseMetaError(body)
    if (meta) throw new HTTPException(metaRefusalStatus(meta), { message: metaRefusalNotice('o pedido do nome de usuário', meta) })
    throw new HTTPException(502, { message: 'A Meta não respondeu ao pedido do nome de usuário. Tente de novo em instantes.' })
  }
  return body ?? {}
}
metaAccount.get('/connections/:id/username', async c => { authorize(c.var.principal, 'team'); return c.json(await usernameCall(c, 'GET')) })
metaAccount.post('/connections/:id/username', async c => {
  authorize(c.var.principal, 'team')
  const parsed = connectionUsernameSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) throw new HTTPException(400, { message: usernameMessage })
  return c.json(await usernameCall(c, 'POST', parsed.data.username))
})
metaAccount.delete('/connections/:id/username', async c => { authorize(c.var.principal, 'team'); return c.json(await usernameCall(c, 'DELETE')) })
