import { env } from 'cloudflare:workers'
import { makeSignature } from 'better-auth/crypto'
import { createAuth } from '../src/auth'
import { app } from '../src/index'
import type { Env } from '../src/env'
import { seed } from './fixtures'

export const password = 'Senha-ficticia-segura-2026!'
export const origin = 'https://engine.test'

/** Fixture sessions use Better Auth's adapter and cookie signature; HTTP auth has its own tests. */
export async function fixtureCookie(workspace = 'a'): Promise<string> {
  const ctx = await createAuth(env).$context
  const session = await ctx.internalAdapter.createSession(`user-${workspace}`)
  return `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${await makeSignature(session.token, ctx.secret)}`)}`
}

export async function seedAuth() {
  await env.DB.prepare('DELETE FROM workspaces').run()
  await env.DB.prepare('DELETE FROM "user"').run()
  await env.DB.batch(['verification', 'rateLimit', 'email_outbox', 'request_limits', 'invites'].map(table => env.DB.prepare(`DELETE FROM "${table}"`)))
  await seed()
  const ctx = await createAuth(env).$context
  for (const workspace of ['a', 'b']) {
    await ctx.internalAdapter.createUser({ id: `user-${workspace}`, name: `Pessoa ${workspace}`, email: `${workspace}@example.test`, emailVerified: true }, { method: 'test-fixture' })
    await env.DB.prepare("INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES (?,?,?,'owner')")
      .bind(`member-${workspace}`, workspace, `user-${workspace}`).run()
  }
}

export async function authenticatedRequest(path: string, workspace = 'a', init: RequestInit = {}, cookie?: string, bindings: Env = env) {
  const headers = new Headers(init.headers)
  headers.set('x-workspace', workspace)
  headers.set('origin', origin)
  if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  headers.set('cookie', cookie ?? await fixtureCookie(workspace))
  return app.request(`${origin}/api/${path}`, { ...init, headers }, bindings)
}

export function authRequest(path: string, body?: unknown, cookie?: string, bindings: Env = env) {
  return app.request(`${origin}/api/auth/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, bindings)
}

export function responseCookie(response: Response): string {
  const cookie = response.headers.get('set-cookie')?.match(/(?:^|,\s*)(__Secure-better-auth\.session_token=[^;]+)/)?.[1]
  if (!cookie) throw new Error('A resposta de login não criou o cookie da sessão.')
  return cookie
}

export async function emailLink(email: string, kind: string): Promise<URL> {
  const row = await env.DB.prepare('SELECT text FROM email_outbox WHERE recipient=? AND kind=? ORDER BY created_at DESC LIMIT 1').bind(email, kind).first<{ text: string }>()
  const url = row?.text.match(/https:\/\/[^\s]+/)?.[0]
  if (!url) throw new Error(`E-mail de ${kind} não encontrado no outbox de desenvolvimento.`)
  return new URL(url)
}
