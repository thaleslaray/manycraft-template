import type { MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { Env } from './env'
export async function hash(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('')
}
/** Janela fixa atômica no D1 (a chave vai com hash: e-mail/IP/segredo não ficam nos contadores). Devolve a contagem e os segundos até a janela virar. */
async function countRequest(env: Env, key: string, windowMs: number) {
  const now = Date.now()
  const row = await env.DB.prepare(`INSERT INTO request_limits(key,count,reset_at) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET count = CASE WHEN reset_at <= ? THEN 1 ELSE count+1 END,
    reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END RETURNING count,reset_at`)
    .bind(await hash(key), now + windowMs, now, now, now + windowMs).first<{ count: number; reset_at: number }>()
  return { count: row?.count ?? Infinity, retryAfter: Math.max(1, Math.ceil(((row?.reset_at ?? now + windowMs) - now) / 1000)) }
}
export async function limit(env: Env, key: string, max = 5, windowMs = 60_000) {
  if ((await countRequest(env, key, windowMs)).count > max) throw new HTTPException(429, { message: 'Limite temporário atingido. Aguarde para tentar novamente.' })
}
/** Mesma janela fixa do `limit`, mas o 429 leva `Retry-After` (segundos até a janela virar): para quem chama por API. */
export async function limitWithRetry(env: Env, key: string, max: number, windowMs = 60_000) {
  const { count, retryAfter } = await countRequest(env, key, windowMs)
  if (count > max) throw new HTTPException(429, { message: 'Limite de pedidos da chave atingido. Aguarde para tentar novamente.', res: new Response(null, { status: 429, headers: { 'Retry-After': String(retryAfter) } }) })
}
export async function json(request: Request) {
  try { return await request.json() as unknown }
  catch { throw new HTTPException(400, { message: 'JSON inválido.' }) }
}
export async function boundedBody(request: Request, max: number): Promise<ArrayBuffer> {
  if (Number(request.headers.get('content-length')) > max) throw new HTTPException(413)
  const reader = request.body?.getReader()
  if (!reader) return new ArrayBuffer(0)
  const chunks: Uint8Array[] = []; let size = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) { void reader.cancel(); throw new HTTPException(413) }
    chunks.push(value)
  }
  const result = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result.buffer
}
/** Teto de corpo para rota pública, aplicado antes do roteador: recusa pelo Content-Length ou ao passar do teto na leitura (corpo sem tamanho declarado também). */
export const publicBodyLimit = (max: number): MiddlewareHandler => async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) await boundedBody(c.req.raw.clone(), max)
  await next()
}
