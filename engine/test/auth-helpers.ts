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
  await env.DB.batch(['verification', 'rateLimit', 'email_outbox', 'request_limits', 'invites', 'login_code_daily'].map(table => env.DB.prepare(`DELETE FROM "${table}"`)))
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

/** A senha está desligada por padrão (PASSWORD_LOGIN): só os testes do caminho por senha usam estes bindings. */
export const withPassword = { ...env, PASSWORD_LOGIN: '1' } as Env

/** Último código de login no outbox de desenvolvimento (o código vai no texto do e-mail). */
export async function lastLoginCode(email: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT text FROM email_outbox WHERE recipient=? AND kind='login_code' ORDER BY rowid DESC LIMIT 1").bind(email).first<{ text: string }>()
  return row?.text.match(/\b(\d{6})\b/)?.[1]
}

export const requestLoginCode = (email: string, bindings: Env = env) =>
  authRequest('email-otp/send-verification-otp', { email, type: 'sign-in' }, undefined, bindings)

export const signInWithCode = (email: string, otp: string, bindings: Env = env) =>
  authRequest('sign-in/email-otp', { email, otp }, undefined, bindings)

/** Entra pelo caminho real do painel: pede o código, lê no outbox e troca pela sessão. Cria a conta se o cadastro permitir. */
export async function codeLogin(email: string, bindings: Env = env) {
  const sent = await requestLoginCode(email, bindings)
  if (sent.status !== 200) throw new Error(`Pedido de código respondeu ${sent.status}.`)
  const otp = await lastLoginCode(email)
  if (!otp) throw new Error('Código de login não encontrado no outbox de desenvolvimento.')
  const response = await signInWithCode(email, otp, bindings)
  if (response.status !== 200) throw new Error(`Entrada por código respondeu ${response.status}.`)
  const { user } = await response.clone().json() as { user: { id: string; email: string; name: string; emailVerified: boolean } }
  return { response, user, cookie: responseCookie(response) }
}
