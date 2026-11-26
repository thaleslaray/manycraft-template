// Variações de caminho não pulam as travas do login por código: elas rodam num hook `before` do Better Auth
// (authGate), pela rota que o roteador dele resolveu, e não por comparação de texto do caminho no Hono.
import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { createAuth } from '../src/auth'
import { app } from '../src/index'
import { origin, password, seedAuth } from './auth-helpers'

beforeEach(seedAuth)
const closed = { ...env, SIGNUP_CLOSED: '1' } as typeof env
const stranger = 'intruso@example.test'
const post = (path: string, body: unknown, bindings: typeof env) => app.request(`${origin}${path}`, {
  method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
}, bindings)
const sentTo = async (email: string) => await env.DB.prepare('SELECT COUNT(*) AS n FROM email_outbox WHERE recipient=?').bind(email).first<number>('n')
const otpRows = async (email: string) => await env.DB.prepare('SELECT COUNT(*) AS n FROM verification WHERE identifier=?').bind(`sign-in-otp-${email}`).first<number>('n')

// Pedido de código para quem não pode entrar (cadastro fechado, sem conta e sem convite): toda variação responde
// 404 (o Better Auth não atende) ou o mesmo 200 da trava; nunca sai e-mail nem fica código gravado.
const sendVariants = [
  '/api/auth/email-otp/send-verification-otp',
  '/api/auth/email-otp/send-verification-otp/',
  '/api/auth//email-otp/send-verification-otp',
  '/api/auth/email-otp//send-verification-otp',
  '/api/auth/EMAIL-OTP/SEND-VERIFICATION-OTP',
  '/api/auth/email-otp/Send-Verification-Otp',
  '/api/auth/email%2Dotp/send-verification-otp',
  '/api/auth/email-otp%2Fsend-verification-otp',
  '/api/auth/email-%6Ftp/send-verification-otp',
  '/api/auth/%65mail-otp/send-verification-otp',
  '/api/auth/email-otp/send-verification-otp?x=1',
  '/api/auth/./email-otp/send-verification-otp',
  '/api/auth/x/../email-otp/send-verification-otp',
  '/api/auth/email-otp/send-verification-otp;x',
]
it.each(sendVariants)('pedido de código em %s não envia a quem não pode entrar', async path => {
  const response = await post(path, { email: stranger, type: 'sign-in' }, closed)
  expect([200, 404]).toContain(response.status)
  if (response.status === 200) expect(await response.json()).toEqual({ success: true })
  expect(await sentTo(stranger)).toBe(0)
  expect(await otpRows(stranger)).toBe(0)
})

// Rotas fechadas (senha desligada e as do plugin que o painel não usa): nenhuma variação é atendida.
const closedVariants: [string, unknown][] = [
  ['/api/auth/sign-in/email/', { email: 'a@example.test', password }],
  ['/api/auth//sign-in/email', { email: 'a@example.test', password }],
  ['/api/auth/SIGN-IN/EMAIL', { email: 'a@example.test', password }],
  ['/api/auth/sign%2Din/email', { email: 'a@example.test', password }],
  ['/api/auth/./sign-in/email', { email: 'a@example.test', password }],
  ['/api/auth/sign-up/email/', { name: 'Nova', email: 'nova@example.test', password }],
  ['/api/auth/sign-up/%65mail', { name: 'Nova', email: 'nova@example.test', password }],
  ['/api/auth/email-otp/verify-email/', { email: 'a@example.test', otp: '123456' }],
  ['/api/auth/email-otp/reset-password/', { email: 'a@example.test', otp: '123456', password }],
  ['/api/auth/email-otp//reset-password', { email: 'a@example.test', otp: '123456', password }],
  ['/api/auth/email-otp/reset%2Dpassword', { email: 'a@example.test', otp: '123456', password }],
  ['/api/auth/email-otp/request-password-reset/', { email: 'a@example.test' }],
  ['/api/auth/email-%6Ftp/request-password-reset', { email: 'a@example.test' }],
  ['/api/auth/forget-password/email-otp/', { email: 'a@example.test' }],
  ['/api/auth/email-otp/check-verification-otp/', { email: 'a@example.test', type: 'sign-in', otp: '123456' }],
  ['/api/auth/request-password-reset/', { email: 'a@example.test', redirectTo: `${origin}/r` }],
  ['/api/auth/send-verification-email/', { email: 'a@example.test' }],
]
it.each(closedVariants)('rota fechada em %s responde 404 e não envia nada', async (path, body) => {
  expect((await post(path, body, env)).status).toBe(404)
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM email_outbox').first('n')).toBe(0)
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM verification').first('n')).toBe(0)
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "user" WHERE email=?').bind('nova@example.test').first('n')).toBe(0)
})

// A trava é do Better Auth, não do Hono: chamando o handler dele direto, sem a rota do motor na frente.
const direct = (path: string, body: unknown, bindings: typeof env) => createAuth(bindings).handler(new Request(`${origin}${path}`, {
  method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
it('handler do Better Auth direto: rotas de senha e do plugin respondem 404', async () => {
  for (const path of ['/api/auth/sign-in/email', '/api/auth/sign-up/email', '/api/auth/email-otp/reset-password', '/api/auth/email-otp/verify-email']) {
    expect((await direct(path, { name: 'Nova', email: 'nova@example.test', password, otp: '123456' }, env)).status).toBe(404)
  }
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "user" WHERE email=?').bind('nova@example.test').first('n')).toBe(0)
})
it('handler do Better Auth direto: quem não pode entrar recebe 200 sem e-mail nem código; tipo errado é 400', async () => {
  const response = await direct('/api/auth/email-otp/send-verification-otp', { email: stranger, type: 'sign-in' }, closed)
  expect(response.status).toBe(200)
  expect(await sentTo(stranger)).toBe(0)
  expect(await otpRows(stranger)).toBe(0)
  const wrongType = await direct('/api/auth/email-otp/send-verification-otp', { email: 'a@example.test', type: 'forget-password' }, env)
  expect(wrongType.status).toBe(400)
  expect(await wrongType.json()).toEqual({ code: 'TIPO_DE_CODIGO_NAO_SUPORTADO', message: 'Tipo de código não suportado.' })
  expect(await sentTo('a@example.test')).toBe(0)
})
