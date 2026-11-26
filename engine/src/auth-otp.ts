// Entrada por código de 6 dígitos enviado ao e-mail (plugin `emailOTP` do Better Auth, ligado em auth.ts).
// As travas rodam num hook `before` do Better Auth (`authGate`), que ele chama DEPOIS de resolver a rota: a rota
// vem em `ctx.path` (o caminho do endpoint), então nenhuma variação de caminho que o roteador dele aceite pula a
// trava. Erro lançado ali volta ao pedido com status e corpo. Só a falha do envio precisa da rota do Hono: o
// Better Auth chama o envio dentro de `runInBackgroundOrAwait`, que engole a exceção e responde 200; a falha
// volta por `OtpDelivery` e `finishAuthRequest` troca a resposta (vale para qualquer caminho).
import { APIError } from 'better-auth/api'
import { z } from 'zod'
import type { Env } from './env'
import { deliverEmail, loginCodeEmail } from './email'
import { overLimit } from './security'

/** Validade do código em segundos (a mesma do plugin em auth.ts e do texto do e-mail). */
export const OTP_EXPIRES_IN_SECONDS = 600
/** Tentativas por código: depois disso só um código novo entra. */
export const OTP_ALLOWED_ATTEMPTS = 5
/** Teto diário padrão fora do desenvolvimento. `OTP_DAILY_LIMIT` troca; `0` desliga. */
export const OTP_DAILY_LIMIT_DEFAULT = 100
/** Pedidos de código (fora do desenvolvimento): por IP por minuto e por par e-mail+IP por hora (429 para quem pede);
 * por e-mail por hora, de qualquer IP, sem bloquear (acima disso o pedido é silenciado). */
export const OTP_SEND_PER_IP_PER_MINUTE = 5
export const OTP_SEND_PER_EMAIL_IP_PER_HOUR = 5
export const OTP_SEND_PER_EMAIL_PER_HOUR = 10

export const OTP_SEND_PATH = '/email-otp/send-verification-otp'
export const OTP_SIGN_IN_PATH = '/sign-in/email-otp'

/** "1" religa a entrada por senha (cadastro, login, troca e recuperação de senha). Padrão desligado. */
export const passwordLoginEnabled = (env: Pick<Env, 'PASSWORD_LOGIN'>) => env.PASSWORD_LOGIN === '1'

// Rotas de senha do Better Auth: 404 com a senha desligada (o Better Auth sozinho responderia 400 em algumas
// e deixaria outras de pé, como o link de confirmação de e-mail).
const PASSWORD_PATHS = new Set(['/sign-up/email', '/sign-in/email', '/request-password-reset', '/reset-password', '/forget-password',
  '/change-password', '/send-verification-email', '/verify-email'])
const PASSWORD_PREFIXES = ['/reset-password/']
// Rotas que o plugin abre e esta aplicação não usa: sempre 404. As de senha por código são outro jeito de
// trocar senha (que não existe no painel); as de confirmação e troca de e-mail não têm fluxo (o primeiro
// código já confirma o e-mail, e o código de outros tipos nunca é enviado).
const UNUSED_OTP_PATHS = new Set(['/email-otp/request-password-reset', '/email-otp/reset-password', '/forget-password/email-otp',
  '/email-otp/verify-email', '/email-otp/check-verification-otp', '/email-otp/request-email-change', '/email-otp/change-email'])

/** `path` é o caminho do endpoint do Better Auth (`ctx.path`), já resolvido pelo roteador dele. */
export function authRouteClosed(env: Pick<Env, 'PASSWORD_LOGIN'>, path: string) {
  if (UNUSED_OTP_PATHS.has(path)) return true
  if (passwordLoginEnabled(env)) return false
  return PASSWORD_PATHS.has(path) || PASSWORD_PREFIXES.some(prefix => path.startsWith(prefix))
}

export function otpDailyLimit(env: Pick<Env, 'OTP_DAILY_LIMIT' | 'APP_ENV'>) {
  const raw = env.OTP_DAILY_LIMIT?.trim()
  // No desenvolvimento o teto só vale se a variável estiver definida: as jornadas pedem muitos códigos por dia.
  if (!raw) return env.APP_ENV === 'development' ? 0 : OTP_DAILY_LIMIT_DEFAULT
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : OTP_DAILY_LIMIT_DEFAULT
}

/** Dia do teto no fuso de São Paulo (`AAAA-MM-DD`): o teto vira à meia-noite de Brasília. */
export function otpDay(now = new Date()) {
  return now.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' })
}

export async function dailyCapReached(env: Env, now = new Date()) {
  const max = otpDailyLimit(env)
  if (max === 0) return false
  const total = await env.DB.prepare('SELECT total FROM login_code_daily WHERE day=?').bind(otpDay(now)).first<number>('total')
  return (total ?? 0) >= max
}

/** Reserva um envio no teto do dia (atômico). false = teto cheio. Desfeita por `releaseDailySend` se o envio falhar. */
async function reserveDailySend(env: Env, day: string) {
  const max = otpDailyLimit(env)
  if (max === 0) return true
  const row = await env.DB.prepare(`INSERT INTO login_code_daily(day,total) VALUES (?,1)
    ON CONFLICT(day) DO UPDATE SET total=total+1 WHERE total<? RETURNING total`).bind(day, max).first<number>('total')
  return row !== null && row <= max
}
async function releaseDailySend(env: Env, day: string) {
  if (otpDailyLimit(env) === 0) return
  await env.DB.prepare('UPDATE login_code_daily SET total=max(total-1,0) WHERE day=?').bind(day).run()
}

/** Produção sem provedor de e-mail não entrega código: o pedido recebe erro claro, não um sucesso falso. */
export const emailDeliveryConfigured = (env: Pick<Env, 'APP_ENV' | 'EMAIL' | 'EMAIL_FROM'>) =>
  env.APP_ENV === 'development' || !!(env.EMAIL && env.EMAIL_FROM)

/** Com o cadastro fechado, só recebe código quem já tem conta ou tem convite válido (a mesma regra do hook de cadastro). */
export async function canReceiveLoginCode(env: Env, email: string) {
  if (env.SIGNUP_CLOSED !== '1') return true
  const ok = await env.DB.prepare(`SELECT EXISTS(SELECT 1 FROM "user" WHERE email=?) OR EXISTS(SELECT 1 FROM invites WHERE email=? AND expires_at>?) AS ok`)
    .bind(email, email, Date.now()).first<number>('ok')
  return ok === 1
}

/** Resumo do código com chave (HMAC-SHA-256 com o segredo do Better Auth, em base64url): se a tabela `verification`
 * vazar, os 6 dígitos não saem por força bruta, ao contrário do SHA-256 puro do `storeOTP: 'hashed'`. */
export function otpHasher(secret: string) {
  const key = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return async (otp: string) => {
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await key, new TextEncoder().encode(`login-otp:${otp}`)))
    return btoa(String.fromCharCode(...mac)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
}

/** Erros do pedido de código, no formato do Better Auth (`code` + `message`) que o painel já lê. */
export const OTP_ERRORS = {
  EMAIL_NAO_CONFIGURADO: { status: 503, message: 'O envio de e-mail ainda não foi configurado. Entre com o Google ou fale com quem administra o sistema.' },
  LIMITE_DIARIO_DE_CODIGOS: { status: 429, message: 'O limite diário de códigos de acesso foi atingido. Tente de novo amanhã ou entre com o Google.' },
  MUITOS_PEDIDOS_DE_CODIGO: { status: 429, message: 'Muitos pedidos de código. Tente de novo mais tarde ou entre com o Google.' },
  ENVIO_DO_CODIGO_FALHOU: { status: 503, message: 'Não foi possível enviar o código agora. Tente de novo em alguns minutos.' },
  TIPO_DE_CODIGO_NAO_SUPORTADO: { status: 400, message: 'Tipo de código não suportado.' },
  INVALID_EMAIL: { status: 400, message: 'E-mail inválido.' },
} as const
type OtpErrorCode = keyof typeof OTP_ERRORS
export class OtpError extends Error {
  constructor(readonly code: OtpErrorCode) { super(OTP_ERRORS[code].message) }
}
const otpErrorResponse = (code: OtpErrorCode) => Response.json({ code, message: OTP_ERRORS[code].message }, { status: OTP_ERRORS[code].status })
const API_STATUS = { 400: 'BAD_REQUEST', 429: 'TOO_MANY_REQUESTS', 503: 'SERVICE_UNAVAILABLE' } as const
const otpApiError = (code: OtpErrorCode) => new APIError(API_STATUS[OTP_ERRORS[code].status], { code, message: OTP_ERRORS[code].message })

/** Estado de um pedido: o envio (dentro do Better Auth) guarda aqui o e-mail e a falha que ele engoliria. */
export type OtpDelivery = { email?: string; error?: unknown }

/** Entrega o código (chamado pelo `sendVerificationOTP` do plugin). Conta no teto só o que sai de fato. */
export async function deliverLoginCode(env: Env, email: string, otp: string, type: string) {
  if (type !== 'sign-in') throw new OtpError('TIPO_DE_CODIGO_NAO_SUPORTADO')
  const day = otpDay()
  if (!await reserveDailySend(env, day)) throw new OtpError('LIMITE_DIARIO_DE_CODIGOS')
  try {
    await deliverEmail(env, email, 'login_code', loginCodeEmail(otp, OTP_EXPIRES_IN_SECONDS / 60))
  } catch (error) {
    await releaseDailySend(env, day)
    throw error
  }
  // As jornadas leem esta linha no terminal do motor: não mude o formato. Nunca em produção.
  if (env.APP_ENV === 'development') console.log(`[auth] código de login para ${email}: ${otp}`)
}

/** O que o hook `before` recebe do Better Auth (só o que a trava usa). */
type GateContext = { path?: string; body?: unknown; request?: Request; headers?: Headers; json: (body: Record<string, unknown>) => unknown }

/**
 * Hook `before` de toda rota do Better Auth. Rotas fechadas: 404. Pedido de código: as travas que valem para
 * qualquer e-mail (tipo, provedor, teto, limites por IP, por par e-mail+IP e por e-mail) vêm antes da que depende de quem é o e-mail,
 * para a resposta não revelar quem tem conta ou convite. Quem não pode entrar recebe o mesmo `{ success: true }`,
 * sem e-mail e sem código gravado (o endpoint nem roda).
 */
export async function authGate(env: Env, ctx: GateContext) {
  const path = ctx.path ?? ''
  if (authRouteClosed(env, path)) throw new APIError('NOT_FOUND', { code: 'NOT_FOUND', message: 'Recurso não encontrado.' })
  if (path !== OTP_SEND_PATH) return
  const body = (ctx.body ?? {}) as { email?: unknown; type?: unknown }
  // Corpo fora do formato: o endpoint valida e recusa (nada é enviado).
  if (typeof body.email !== 'string' || typeof body.type !== 'string') return
  if (body.type !== 'sign-in') throw otpApiError('TIPO_DE_CODIGO_NAO_SUPORTADO')
  const email = body.email.toLowerCase()
  if (!z.email().safeParse(email).success) throw otpApiError('INVALID_EMAIL')
  if (!emailDeliveryConfigured(env)) throw otpApiError('EMAIL_NAO_CONFIGURADO')
  if (await dailyCapReached(env)) throw otpApiError('LIMITE_DIARIO_DE_CODIGOS')
  // Mesma regra do limite do Better Auth: só fora do desenvolvimento (as jornadas entram em série).
  // Ordem: IP por minuto, par e-mail+IP por hora (os dois com 429 só para quem pede), e só então o e-mail por hora.
  // Pedido barrado antes não chega a contar no e-mail: um IP sozinho não empurra a pessoa para o silêncio.
  // O teto por e-mail não bloqueia ninguém: acima dele, o mesmo 200, sem e-mail novo e sem trocar o código (o último
  // que chegou continua valendo), para um terceiro que sabe o e-mail não travar a entrada da pessoa.
  if (env.APP_ENV !== 'development') {
    const ip = (ctx.request?.headers ?? ctx.headers)?.get('cf-connecting-ip') ?? 'local'
    if (await overLimit(env, `codigo-ip:${ip}`, OTP_SEND_PER_IP_PER_MINUTE, 60_000)
      || await overLimit(env, `codigo-email-ip:${email}|${ip}`, OTP_SEND_PER_EMAIL_IP_PER_HOUR, 3600_000)) throw otpApiError('MUITOS_PEDIDOS_DE_CODIGO')
    if (await overLimit(env, `codigo-email:${email}`, OTP_SEND_PER_EMAIL_PER_HOUR, 3600_000)) return ctx.json({ success: true })
  }
  if (!await canReceiveLoginCode(env, email)) return ctx.json({ success: true })
}

/** Depois do handler do Better Auth: se o envio do código falhou (e ele respondeu 200 assim mesmo), apaga o código
 * gravado e devolve o erro. Não olha o caminho: só há falha registrada se o envio rodou. */
export async function finishAuthRequest(env: Env, response: Response, delivery: OtpDelivery) {
  if (delivery.error === undefined) return response
  // O código foi gravado mas não saiu: apaga para não ficar um código válido que ninguém recebeu.
  if (delivery.email) await env.DB.prepare('DELETE FROM verification WHERE identifier=?').bind(`sign-in-otp-${delivery.email.toLowerCase()}`).run()
  if (delivery.error instanceof OtpError) return otpErrorResponse(delivery.error.code)
  console.error(JSON.stringify({ event: 'login_code_delivery_failed', error: delivery.error instanceof Error ? delivery.error.name : typeof delivery.error }))
  return otpErrorResponse('ENVIO_DO_CODIGO_FALHOU')
}
