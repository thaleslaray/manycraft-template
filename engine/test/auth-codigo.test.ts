// Entrada por código de 6 dígitos no e-mail (plugin emailOTP + auth-otp.ts), pelas rotas HTTP reais do motor.
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import { otpDay, otpHasher } from '../src/auth-otp'
import { hash } from '../src/security'
import { authenticatedRequest, authRequest, codeLogin, emailLink, lastLoginCode, origin, password, requestLoginCode, responseCookie, seedAuth, signInWithCode } from './auth-helpers'

beforeEach(seedAuth)
afterEach(() => { vi.restoreAllMocks() })

type Bindings = typeof env
const closed = { ...env, SIGNUP_CLOSED: '1' } as Bindings
/** Produção com um provedor de e-mail falso (o envio de verdade é `EMAIL.send`). */
function production(extra: Partial<Bindings> = {}) {
  const send = vi.fn(async (_message: { to: string; subject: string; text: string }) => ({ messageId: 'falso' }))
  const bindings = { ...env, APP_ENV: 'production', RL_AUTH: undefined, EMAIL: { send } as unknown as SendEmail, EMAIL_FROM: 'acesso@example.test', ...extra } as Bindings
  return { bindings, send }
}
const body = async (response: Response) => await response.clone().json() as Record<string, unknown>
const otpRow = (email: string) => env.DB.prepare('SELECT value,expiresAt FROM verification WHERE identifier=?').bind(`sign-in-otp-${email}`).first<{ value: string; expiresAt: string }>()
const outbox = async (email: string) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE recipient=? AND kind='login_code'").bind(email).first<number>('n'))!
const dailyTotal = async () => await env.DB.prepare('SELECT total FROM login_code_daily WHERE day=?').bind(otpDay()).first<number>('total') ?? 0
const wrong = (otp: string) => otp === '000000' ? '111111' : '000000'
async function invite(email: string, expiresAt = Date.now() + 3600_000) {
  await env.DB.prepare("INSERT INTO invites(id,workspace_id,email,role,token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), 'a', email, 'editor', crypto.randomUUID(), expiresAt, Date.now()).run()
}
/** Pedido de código vindo de um IP (o limite é por `cf-connecting-ip`). */
const requestFrom = (ip: string, email: string, bindings: Bindings) => app.request(`${origin}/api/auth/email-otp/send-verification-otp`, {
  method: 'POST', headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ email, type: 'sign-in' }),
}, bindings)

describe('pedir e entrar', () => {
  it('conta antiga pede código, recebe o e-mail e entra com o mesmo user.id, espaço e papel', async () => {
    const before = await env.DB.prepare('SELECT id,workspace_id,user_id,role FROM workspace_members WHERE user_id=?').bind('user-a').all()
    const sent = await requestLoginCode('a@example.test')
    expect(sent.status).toBe(200)
    expect(await sent.json()).toEqual({ success: true })
    const mail = await env.DB.prepare("SELECT subject,html,text FROM email_outbox WHERE recipient='a@example.test' AND kind='login_code'").first<{ subject: string; html: string; text: string }>()
    const otp = (await lastLoginCode('a@example.test'))!
    expect(otp).toMatch(/^\d{6}$/)
    expect(mail?.subject).toBe(`Seu código de acesso: ${otp}`)
    expect(mail?.text).toContain('10 minutos')
    expect(mail?.html).toContain(otp)
    expect(mail?.html).not.toContain('<a ')
    const login = await signInWithCode('a@example.test', otp)
    expect(login.status).toBe(200)
    expect(await body(login)).toMatchObject({ user: { id: 'user-a', email: 'a@example.test', emailVerified: true } })
    const cookie = responseCookie(login)
    expect(login.headers.get('set-cookie')).toMatch(/HttpOnly/i)
    expect(await (await authRequest('get-session', undefined, cookie)).json()).toMatchObject({ user: { id: 'user-a' } })
    const after = await env.DB.prepare('SELECT id,workspace_id,user_id,role FROM workspace_members WHERE user_id=?').bind('user-a').all()
    expect(after.results).toEqual(before.results)
    expect((await authenticatedRequest('contacts', 'a', {}, cookie)).status).toBe(200)
  })

  it('o código fica só como resumo com chave (nem ele nem o SHA-256 puro dele aparecem), vale 10 minutos e não entra duas vezes', async () => {
    const start = Date.now()
    await requestLoginCode('a@example.test')
    const otp = (await lastLoginCode('a@example.test'))!
    const row = (await otpRow('a@example.test'))!
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(otp)))
    const b64url = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(row.value).toMatch(/^[A-Za-z0-9_-]{43}:0$/)
    expect(row.value).not.toContain(otp)
    expect(row.value).not.toContain(b64url)
    expect(row.value).toBe(`${await otpHasher(env.BETTER_AUTH_SECRET!)(otp)}:0`)
    // Outro segredo, outro resumo: sem o segredo, o código não sai da linha.
    expect(row.value).not.toBe(`${await otpHasher('outro-segredo-de-teste-com-32-caracteres!!')(otp)}:0`)
    expect(Math.round((new Date(row.expiresAt).getTime() - start) / 1000)).toBeGreaterThanOrEqual(599)
    expect(Math.round((new Date(row.expiresAt).getTime() - start) / 1000)).toBeLessThanOrEqual(601)
    expect((await signInWithCode('a@example.test', otp)).status).toBe(200)
    const replay = await signInWithCode('a@example.test', otp)
    expect(replay.status).toBe(400)
    expect(replay.headers.get('set-cookie') ?? '').not.toContain('session_token=')
  })

  it('código errado responde 400 INVALID_OTP sem sessão', async () => {
    await requestLoginCode('a@example.test')
    const response = await signInWithCode('a@example.test', wrong((await lastLoginCode('a@example.test'))!))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'INVALID_OTP' })
    expect(response.headers.get('set-cookie') ?? '').not.toContain('session_token=')
  })

  it('código vencido responde 400 OTP_EXPIRED', async () => {
    await requestLoginCode('a@example.test')
    const otp = (await lastLoginCode('a@example.test'))!
    await env.DB.prepare('UPDATE verification SET expiresAt=? WHERE identifier=?').bind(new Date(Date.now() - 1000).toISOString(), 'sign-in-otp-a@example.test').run()
    const response = await signInWithCode('a@example.test', otp)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'OTP_EXPIRED' })
  })

  it('5 tentativas erradas esgotam o código: a 6ª, mesmo certa, é 403 TOO_MANY_ATTEMPTS; depois só um código novo entra', async () => {
    await requestLoginCode('a@example.test')
    const otp = (await lastLoginCode('a@example.test'))!
    for (let i = 0; i < 5; i++) {
      const attempt = await signInWithCode('a@example.test', wrong(otp))
      expect(attempt.status).toBe(400)
      expect(await attempt.json()).toMatchObject({ code: 'INVALID_OTP' })
    }
    const sixth = await signInWithCode('a@example.test', otp)
    expect(sixth.status).toBe(403)
    expect(await sixth.json()).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' })
    expect((await signInWithCode('a@example.test', otp)).status).toBe(400)
    await requestLoginCode('a@example.test')
    expect((await signInWithCode('a@example.test', (await lastLoginCode('a@example.test'))!)).status).toBe(200)
  })

  it('4 erradas e a 5ª certa ainda entra', async () => {
    await requestLoginCode('a@example.test')
    const otp = (await lastLoginCode('a@example.test'))!
    for (let i = 0; i < 4; i++) await signInWithCode('a@example.test', wrong(otp))
    expect((await signInWithCode('a@example.test', otp)).status).toBe(200)
  })

  it('pedir de novo invalida o código anterior', async () => {
    await requestLoginCode('a@example.test')
    const first = (await lastLoginCode('a@example.test'))!
    await requestLoginCode('a@example.test')
    const second = (await lastLoginCode('a@example.test'))!
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM verification WHERE identifier=?').bind('sign-in-otp-a@example.test').first('n')).toBe(1)
    if (first !== second) expect((await signInWithCode('a@example.test', first)).status).toBe(400)
    expect((await signInWithCode('a@example.test', second)).status).toBe(200)
  })

  it('conta antiga entra com o cadastro fechado e sem convite', async () => {
    const { user } = await codeLogin('b@example.test', closed)
    expect(user.id).toBe('user-b')
    expect(await env.DB.prepare("SELECT role FROM workspace_members WHERE user_id='user-b'").first('role')).toBe('owner')
  })
})

describe('quem não pode entrar não recebe código', () => {
  it('cadastro fechado, sem conta e sem convite: o mesmo 200 de quem tem conta, nenhum e-mail, nenhuma linha de código, nada no teto', async () => {
    const limited = { ...closed, OTP_DAILY_LIMIT: '10' } as Bindings
    const log = vi.spyOn(console, 'log')
    const stranger = await requestLoginCode('intruso@example.test', limited)
    const member = await requestLoginCode('a@example.test', limited)
    expect(stranger.status).toBe(member.status)
    expect(await stranger.json()).toEqual(await member.json())
    expect(await outbox('intruso@example.test')).toBe(0)
    expect(await otpRow('intruso@example.test')).toBeNull()
    expect(log.mock.calls.flat().join('\n')).not.toContain('intruso@example.test')
    expect(await dailyTotal()).toBe(1)
    expect((await signInWithCode('intruso@example.test', '123456', limited)).status).toBe(400)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "user" WHERE email=?').bind('intruso@example.test').first('n')).toBe(0)
  })

  it('cadastro fechado, e-mail com convite: o código cria a conta verificada (nome vazio) e o aceite do convite funciona', async () => {
    const email = 'convidada-otp@example.test'
    expect((await authenticatedRequest('team/invites', 'a', { method: 'POST', body: JSON.stringify({ email, role: 'administrator' }) })).status).toBe(201)
    const token = (await emailLink(email, 'invite')).hash.slice(1)
    const { user, cookie } = await codeLogin(email, closed)
    expect(user).toMatchObject({ email, emailVerified: true, name: '' })
    const accept = await app.request(`${origin}/api/invites/accept`, { method: 'POST', headers: { origin, 'content-type': 'application/json', cookie }, body: JSON.stringify({ token }) }, closed)
    expect(accept.status).toBe(200)
    expect((await env.DB.prepare('SELECT workspace_id,role FROM workspace_members WHERE user_id=?').bind(user.id).all()).results).toEqual([{ workspace_id: 'a', role: 'administrator' }])
    // Nome vazio não quebra o motor: equipe, sessão do painel e o aviso de chave revogada usam o e-mail no lugar.
    const team = await authenticatedRequest('team', 'a')
    expect(team.status).toBe(200)
    expect(JSON.stringify(await team.json())).toContain(email)
    const session = await authenticatedRequest('session/workspace', 'a', {}, cookie)
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({ user_name: email })
    expect((await authenticatedRequest('api-keys', 'a', { method: 'POST' }, cookie)).status).toBe(201)
    expect((await authRequest('delete-user', {}, cookie, closed)).status).toBe(200)
    const notice = await env.DB.prepare("SELECT message FROM workspace_notices WHERE workspace_id='a' AND message LIKE '%chave de API%'").first<string>('message')
    expect(notice).toContain(`A chave de API criada por ${email} foi desativada`)
  })
})

describe('limites', () => {
  it('limite por IP: o 6º pedido no minuto do mesmo IP é 429, inclusive para e-mail que não pode entrar', async () => {
    const { bindings, send } = production({ SIGNUP_CLOSED: '1' } as Partial<Bindings>)
    for (let i = 0; i < 5; i++) expect((await requestFrom('203.0.113.7', `pessoa${i}@example.test`, bindings)).status).toBe(200)
    const sixth = await requestFrom('203.0.113.7', 'a@example.test', bindings)
    expect(sixth.status).toBe(429)
    expect(await sixth.json()).toEqual({ code: 'MUITOS_PEDIDOS_DE_CODIGO', message: 'Muitos pedidos de código. Tente de novo mais tarde ou entre com o Google.' })
    expect(send).not.toHaveBeenCalled()
    expect((await requestFrom('198.51.100.9', 'a@example.test', bindings)).status).toBe(200)
    expect(send).toHaveBeenCalledOnce()
  })

  /** Vira a janela de 1 minuto do IP (simula pedidos espalhados na hora sem esperar). */
  const nextMinute = async (ip: string) => { await env.DB.prepare('UPDATE request_limits SET reset_at=0 WHERE key=?').bind(await hash(`codigo-ip:${ip}`)).run() }

  it('par e-mail+IP: o mesmo IP pedindo 6 vezes na hora para o mesmo e-mail recebe 429 na 6ª; outro IP segue', async () => {
    const { bindings, send } = production()
    for (let i = 0; i < 5; i++) { expect((await requestFrom('203.0.113.7', 'a@example.test', bindings)).status).toBe(200); await nextMinute('203.0.113.7') }
    const sixth = await requestFrom('203.0.113.7', 'a@example.test', bindings)
    expect(sixth.status).toBe(429)
    expect(await sixth.json()).toEqual({ code: 'MUITOS_PEDIDOS_DE_CODIGO', message: 'Muitos pedidos de código. Tente de novo mais tarde ou entre com o Google.' })
    expect(send).toHaveBeenCalledTimes(5)
    expect((await requestFrom('198.51.100.9', 'a@example.test', bindings)).status).toBe(200)
    expect(send).toHaveBeenCalledTimes(6)
  })

  it('ataque: terceiros de outros IPs não travam a vítima; a caixa recebe no máximo 10 por hora e o último código segue valendo', async () => {
    const sent: string[] = []
    const send = vi.fn(async (message: { subject: string }) => { sent.push(message.subject.match(/\d{6}/)![0]); return { messageId: 'falso' } })
    const { bindings } = production({ EMAIL: { send } as unknown as SendEmail, OTP_DAILY_LIMIT: '100' } as Partial<Bindings>)
    const victim = '198.51.100.1'
    expect((await requestFrom(victim, 'a@example.test', bindings)).status).toBe(200)
    // Terceiros: 30 pedidos de 30 IPs diferentes na mesma hora.
    const attack: number[] = []
    for (let i = 0; i < 30; i++) attack.push((await requestFrom(`203.0.113.${i + 1}`, 'a@example.test', bindings)).status)
    expect(attack.every(status => status === 200)).toBe(true)
    expect(send).toHaveBeenCalledTimes(10)
    expect(await dailyTotal()).toBe(10)
    const last = sent.at(-1)!
    // A vítima pede de novo do IP dela (dentro do limite do par): nenhum 429, nenhum e-mail novo, o código não muda.
    for (let i = 0; i < 4; i++) {
      await nextMinute(victim)
      const again = await requestFrom(victim, 'a@example.test', bindings)
      expect(again.status).toBe(200)
      expect(await again.json()).toEqual({ success: true })
    }
    expect(send).toHaveBeenCalledTimes(10)
    expect(await dailyTotal()).toBe(10)
    expect((await signInWithCode('a@example.test', last, bindings)).status).toBe(200)
  })

  it('o teto por e-mail silencia igual o e-mail que não pode entrar (mesma resposta, nada gravado)', async () => {
    const { bindings, send } = production({ SIGNUP_CLOSED: '1' } as Partial<Bindings>)
    for (let i = 0; i < 12; i++) {
      const response = await requestFrom(`203.0.113.${i + 1}`, 'intruso@example.test', bindings)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ success: true })
    }
    expect(send).not.toHaveBeenCalled()
    expect(await otpRow('intruso@example.test')).toBeNull()
  })

  it('pedido barrado pelo par e-mail+IP não consome a cota do e-mail', async () => {
    const { bindings, send } = production()
    // Um IP só: 5 passam, as 20 seguintes são 429 do par e não contam no e-mail.
    for (let i = 0; i < 25; i++) { await requestFrom('203.0.113.7', 'a@example.test', bindings); await nextMinute('203.0.113.7') }
    expect(send).toHaveBeenCalledTimes(5)
    // Sobram 5 da cota do e-mail para outros IPs: 5 enviam, a seguinte é silenciada.
    for (let i = 0; i < 6; i++) expect((await requestFrom(`198.51.100.${i + 1}`, 'a@example.test', bindings)).status).toBe(200)
    expect(send).toHaveBeenCalledTimes(10)
  })

  it('a entrada com código aceita 10 por minuto por IP: a 11ª é 429', async () => {
    const { bindings } = production()
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) statuses.push((await signInWithCode('a@example.test', '000000', bindings)).status)
    expect(statuses.slice(0, 10).every(status => status === 400)).toBe(true)
    expect(statuses[10]).toBe(429)
  })

  it('teto diário: estourado, o pedido responde erro claro e nenhum e-mail sai; o teto conta só o que saiu de fato', async () => {
    const limited = { ...closed, OTP_DAILY_LIMIT: '2' } as Bindings
    expect((await requestLoginCode('a@example.test', limited)).status).toBe(200)
    // Quem não pode entrar não gasta o teto.
    expect((await requestLoginCode('intruso@example.test', limited)).status).toBe(200)
    expect(await dailyTotal()).toBe(1)
    expect((await requestLoginCode('b@example.test', limited)).status).toBe(200)
    expect(await dailyTotal()).toBe(2)
    const over = await requestLoginCode('a@example.test', limited)
    expect(over.status).toBe(429)
    expect(await over.json()).toEqual({ code: 'LIMITE_DIARIO_DE_CODIGOS', message: 'O limite diário de códigos de acesso foi atingido. Tente de novo amanhã ou entre com o Google.' })
    expect(await outbox('a@example.test')).toBe(1)
    // O código que já tinha saído continua valendo; quem não pode entrar vê o mesmo 429.
    expect((await signInWithCode('a@example.test', (await lastLoginCode('a@example.test'))!, limited)).status).toBe(200)
    expect((await requestLoginCode('intruso@example.test', limited)).status).toBe(429)
    expect(await dailyTotal()).toBe(2)
  })

  it('teto diário: envio que falhou não conta e não deixa código gravado', async () => {
    const send = vi.fn(async () => { throw new Error('provedor fora do ar') })
    const { bindings } = production({ EMAIL: { send } as unknown as SendEmail, OTP_DAILY_LIMIT: '5' } as Partial<Bindings>)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await requestLoginCode('a@example.test', bindings)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ code: 'ENVIO_DO_CODIGO_FALHOU', message: 'Não foi possível enviar o código agora. Tente de novo em alguns minutos.' })
    expect(send).toHaveBeenCalledOnce()
    expect(await dailyTotal()).toBe(0)
    expect(await otpRow('a@example.test')).toBeNull()
  })

  it('sem OTP_DAILY_LIMIT, produção usa 100 por dia', async () => {
    const { bindings } = production()
    await env.DB.prepare('INSERT INTO login_code_daily(day,total) VALUES (?,99)').bind(otpDay()).run()
    expect((await requestFrom('203.0.113.1', 'a@example.test', bindings)).status).toBe(200)
    expect(await dailyTotal()).toBe(100)
    expect((await requestFrom('203.0.113.2', 'b@example.test', bindings)).status).toBe(429)
  })
})

describe('provedor e log', () => {
  it('produção sem provedor de e-mail: erro claro em vez de sucesso falso, sem código gravado', async () => {
    const bindings = { ...env, APP_ENV: 'production', RL_AUTH: undefined, EMAIL: undefined, EMAIL_FROM: undefined } as unknown as Bindings
    const response = await requestLoginCode('a@example.test', bindings)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ code: 'EMAIL_NAO_CONFIGURADO', message: 'O envio de e-mail ainda não foi configurado. Entre com o Google ou fale com quem administra o sistema.' })
    expect(await otpRow('a@example.test')).toBeNull()
    // Vale para qualquer e-mail (não revela quem tem conta).
    expect((await requestLoginCode('ninguem@example.test', { ...bindings, SIGNUP_CLOSED: '1' } as Bindings)).status).toBe(503)
  })

  it('no local o código sai no terminal numa linha de formato fixo', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await requestLoginCode('a@example.test')
    expect(log).toHaveBeenCalledWith(`[auth] código de login para a@example.test: ${await lastLoginCode('a@example.test')}`)
  })

  it('em produção o código vai só pelo provedor, nunca para o log', async () => {
    const { bindings, send } = production()
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info')]
    expect((await requestLoginCode('a@example.test', bindings)).status).toBe(200)
    const message = send.mock.calls[0]![0]
    expect(message).toMatchObject({ to: 'a@example.test', from: 'acesso@example.test' })
    const otp = message.subject.match(/\d{6}/)![0]
    expect(message.text).toContain(otp)
    expect(JSON.stringify(spies.flatMap(spy => spy.mock.calls))).not.toContain(otp)
    expect(await outbox('a@example.test')).toBe(0)
  })
})

describe('senha desligada e link removido', () => {
  // Com PASSWORD_LOGIN desligado (padrão dos testes e de produção), cada rota de senha responde 404.
  const passwordRoutes: [string, string, unknown?][] = [
    ['POST', 'sign-up/email', { name: 'Nova', email: 'nova-senha@example.test', password }],
    ['POST', 'sign-in/email', { email: 'a@example.test', password }],
    ['POST', 'request-password-reset', { email: 'a@example.test', redirectTo: `${origin}/reset` }],
    ['POST', 'forget-password', { email: 'a@example.test', redirectTo: `${origin}/reset` }],
    ['POST', 'reset-password', { token: 'x'.repeat(24), newPassword: 'Outra-senha-ficticia-segura-2026!' }],
    ['GET', `reset-password/${'x'.repeat(24)}?callbackURL=${encodeURIComponent(`${origin}/reset`)}`],
    ['POST', 'change-password', { currentPassword: password, newPassword: 'Outra-senha-ficticia-segura-2026!' }],
    ['POST', 'send-verification-email', { email: 'a@example.test' }],
    ['GET', `verify-email?token=${'x'.repeat(24)}`],
    ['POST', 'email-otp/request-password-reset', { email: 'a@example.test' }],
    ['POST', 'email-otp/reset-password', { email: 'a@example.test', otp: '123456', password: 'Outra-senha-ficticia-segura-2026!' }],
    ['POST', 'forget-password/email-otp', { email: 'a@example.test' }],
    ['POST', 'email-otp/verify-email', { email: 'a@example.test', otp: '123456' }],
    ['POST', 'email-otp/check-verification-otp', { email: 'a@example.test', type: 'sign-in', otp: '123456' }],
    ['POST', 'sign-in/magic-link', { email: 'a@example.test', callbackURL: `${origin}/painel` }],
    ['GET', `magic-link/verify?token=${'x'.repeat(32)}`],
  ]
  it.each(passwordRoutes)('%s /api/auth/%s responde 404', async (method, path, payload) => {
    const cookie = responseCookie(await signInWithCode('a@example.test', await (async () => { await requestLoginCode('a@example.test'); return (await lastLoginCode('a@example.test'))! })()))
    const response = await app.request(`${origin}/api/auth/${path}`, {
      method, headers: { origin, 'content-type': 'application/json', cookie }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }, env)
    expect(response.status).toBe(404)
  })

  it('ninguém cria conta, entra ou troca senha por elas, e nenhum e-mail sai', async () => {
    const credential = await env.DB.prepare("INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES ('acc-a','user-a','credential','user-a','hash-antigo',?,?) RETURNING id")
      .bind(new Date().toISOString(), new Date().toISOString()).first('id')
    expect(credential).toBe('acc-a')
    for (const [method, path, payload] of passwordRoutes) {
      await app.request(`${origin}/api/auth/${path}`, { method, headers: { origin, 'content-type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }, env)
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "user" WHERE email=?').bind('nova-senha@example.test').first('n')).toBe(0)
    expect(await env.DB.prepare("SELECT password FROM account WHERE id='acc-a'").first('password')).toBe('hash-antigo')
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM session').first('n')).toBe(0)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM email_outbox').first('n')).toBe(0)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM verification').first('n')).toBe(0)
  })

  it('o pedido de código só aceita o tipo sign-in', async () => {
    for (const type of ['forget-password', 'email-verification', 'change-email']) {
      const response = await authRequest('email-otp/send-verification-otp', { email: 'a@example.test', type })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ code: 'TIPO_DE_CODIGO_NAO_SUPORTADO', message: 'Tipo de código não suportado.' })
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM verification').first('n')).toBe(0)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM email_outbox').first('n')).toBe(0)
  })
})
