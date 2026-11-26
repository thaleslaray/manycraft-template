// POST /api/dev/sign-in: o botão "Entrar (teste)" do painel. Só existe no desenvolvimento; fora dele é 404.
import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/env'
import { authRequest, origin, responseCookie, seedAuth } from './auth-helpers'

beforeEach(seedAuth)

const dev = { ...env, APP_ENV: 'development', DEV_WORKSPACE_ID: 'a' } as Env
const devSignIn = (bindings: Env, from = origin) =>
  app.request(`${origin}/api/dev/sign-in`, { method: 'POST', headers: { origin: from } }, bindings)
const counts = async () => ({
  sessions: (await env.DB.prepare('SELECT COUNT(*) AS n FROM session').first<number>('n'))!,
  codes: (await env.DB.prepare('SELECT COUNT(*) AS n FROM verification').first<number>('n'))!,
  emails: (await env.DB.prepare('SELECT COUNT(*) AS n FROM email_outbox').first<number>('n'))!,
})

it('no desenvolvimento abre sessão como dona do espaço de desenvolvimento, sem e-mail e sem código sobrando', async () => {
  const response = await devSignIn(dev)
  expect(response.status).toBe(200)
  expect(response.headers.get('set-cookie')).toMatch(/HttpOnly/i)
  const session = await (await authRequest('get-session', undefined, responseCookie(response))).json() as { user: { id: string; emailVerified: boolean } }
  expect(session.user).toMatchObject({ id: 'user-a', emailVerified: true })
  // O código criado foi usado na hora (o Better Auth apaga) e nada foi para o outbox.
  expect(await counts()).toMatchObject({ codes: 0, emails: 0 })
})

it.each(['production', 'staging', '', undefined])('com APP_ENV=%s responde 404 e não cria sessão, código nem e-mail', async appEnv => {
  const before = await counts()
  // Mesmo com o auto-login e o espaço de desenvolvimento ligados por engano.
  const response = await devSignIn({ ...dev, APP_ENV: appEnv, DEV_AUTO_LOGIN: '1' } as Env)
  expect(response.status).toBe(404)
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(await counts()).toEqual(before)
})

it('no desenvolvimento, pedido de outra origem ou sem origem é recusado sem sessão', async () => {
  const before = await counts()
  expect((await devSignIn(dev, 'https://outro.example')).status).toBe(403)
  const semOrigem = await app.request(`${origin}/api/dev/sign-in`, { method: 'POST' }, dev)
  expect(semOrigem.status).toBe(403)
  expect(await counts()).toEqual(before)
})

it('sem espaço de desenvolvimento semeado responde 404', async () => {
  expect((await devSignIn({ ...dev, DEV_WORKSPACE_ID: 'nao-existe' } as Env)).status).toBe(404)
})
