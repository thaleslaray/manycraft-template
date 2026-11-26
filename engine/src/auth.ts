import { betterAuth } from 'better-auth'
import { oneTap } from 'better-auth/plugins/one-tap'
import { emailOTP } from 'better-auth/plugins/email-otp'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { HTTPException } from 'hono/http-exception'
import type { Env } from './env'
import { sendEmail } from './email'
import { authGate, canReceiveLoginCode, deliverLoginCode, OTP_ALLOWED_ATTEMPTS, OTP_EXPIRES_IN_SECONDS, OTP_SEND_PATH, OTP_SIGN_IN_PATH, otpHasher, passwordLoginEnabled, type OtpDelivery } from './auth-otp'
import { bucketOf } from './media-blocks'
import { disconnectMember, revokeMemberKeys } from './member-access'
/** `delivery`: a rota do Hono passa, para receber a falha do envio do código que o Better Auth engole (auth-otp.ts). */
export function createAuth(env: Env, delivery?: OtpDelivery) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32 || !env.BETTER_AUTH_URL) {
    throw new HTTPException(503, { message: 'Autenticação não configurada.' })
  }
  const deletedMemberships = new Map<string, string[]>()
  // Entrada por senha só com PASSWORD_LOGIN=1 (padrão desligado; a entrada é por código). Desligada, as rotas de
  // senha respondem 404 pelo hook `before` (authGate, em auth-otp.ts) e o link de confirmação não existe.
  const password = passwordLoginEnabled(env)
  return betterAuth({
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [new URL(env.BETTER_AUTH_URL).origin],
    logger: { disabled: true },
    emailAndPassword: {
      enabled: password, requireEmailVerification: true, minPasswordLength: 12,
      revokeSessionsOnPasswordReset: true,
      // As sessões já foram revogadas: as conexões ao vivo do inbox da pessoa caem na hora (o alarme do hub é a segunda barreira).
      onPasswordReset: async ({ user }) => {
        const memberships = await env.DB.prepare('SELECT workspace_id FROM workspace_members WHERE user_id=?').bind(user.id).all<{ workspace_id: string }>()
        await disconnectMember(env, memberships.results.map(row => row.workspace_id), user.id)
      },
      sendResetPassword: async ({ user, url }) => sendEmail(env, user.email, 'reset', url),
    },
    // O link de confirmação só existe para quem cadastra senha. Pelo código, a conta já nasce com o e-mail confirmado.
    ...(password ? { emailVerification: {
      sendOnSignUp: true, autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) => sendEmail(env, user.email, 'verification', url),
    } } : {}),
    // Entrar com Google: só aparece quando o app do Google está configurado.
    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } } : {}),
    },
    // Cadastro fechado (400, não 403: o better-auth troca 403 no cadastro por uma resposta genérica de sucesso): toda criação de usuário (código por e-mail, e-mail e senha, Google) passa por aqui e exige convite válido para o e-mail.
    databaseHooks: { user: { create: { before: async user => {
      if (env.SIGNUP_CLOSED !== '1') return
      const invited = await env.DB.prepare('SELECT 1 AS ok FROM invites WHERE email=? AND expires_at>? LIMIT 1').bind(String(user.email ?? '').toLowerCase(), Date.now()).first()
      if (!invited) throw new APIError('BAD_REQUEST', { code: 'SIGNUP_CLOSED', message: 'O cadastro está fechado. Peça um convite a quem administra o espaço.' })
    } } } },
    // Travas por rota resolvida (`ctx.path`): 404 das rotas fechadas e as do pedido de código (auth-otp.ts).
    hooks: { before: createAuthMiddleware(async ctx => authGate(env, ctx)) },
    account: { encryptOAuthTokens: true },
    // Cache da sessão em cookie por 60 s (src/request-session.ts diz quando vale): atraso máximo de 60 s para uma sessão encerrada seguir valendo em leituras comuns (GET fora das rotas sensíveis) de OUTROS aparelhos; escritas e rotas sensíveis leem o banco. Sem `refreshCache` (é para quem não tem banco).
    session: { cookieCache: { enabled: true, maxAge: 60, strategy: 'compact' }, expiresIn: 60 * 60 * 24 * 7, freshAge: 60 * 60 },
    user: { deleteUser: { enabled: true,
      // A conta sai: as chaves de API do espaço que ela criou são revogadas e as conexões ao vivo do inbox caem depois da exclusão.
      afterDelete: async user => { await disconnectMember(env, deletedMemberships.get(user.id) ?? [], user.id); deletedMemberships.delete(user.id) },
      beforeDelete: async user => {
      const memberships = await env.DB.prepare('SELECT workspace_id FROM workspace_members WHERE user_id=?').bind(user.id).all<{ workspace_id: string }>()
      deletedMemberships.set(user.id, memberships.results.map(row => row.workspace_id))
      const media = await env.DB.prepare(`SELECT m.object_key,m.bucket FROM media_objects m JOIN workspace_members w
        ON w.workspace_id=m.workspace_id WHERE w.user_id=? AND w.role='owner'`).bind(user.id).all<{object_key: string; bucket: string}>()
      if (media.results.some(object => !bucketOf(env, object.bucket))) throw new HTTPException(503)
      for (const object of media.results) await bucketOf(env, object.bucket)!.delete(object.object_key)
      await env.DB.batch(revokeMemberKeys(env.DB, null, user.id, 'a conta dessa pessoa foi excluída'))
    } } },
    // O IP do limite do Better Auth vem do mesmo cabeçalho que o RL_AUTH usa (index.ts).
    advanced: { useSecureCookies: true, ipAddress: { ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'] }, defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: 'lax' },
      // `createAuth` roda a cada pedido, e a validação de schema do Better Auth (sqlite_master + 2 batches de PRAGMA, 3 idas em fila ao D1) rodava junto, sem cache entre pedidos, e o pedido esperava por ela. O schema é das migrações em `migrations/`, conferidas por `scripts/check-migrations.mjs`.
      database: { validateSchema: false, joins: true } },
    // Só em produção: no desenvolvimento local o limite por IP travava as jornadas de login em série.
    // get-session fica fora: o limite guarda no D1, e cada abertura do painel pagaria duas idas ao banco só para contar.
    // Código por e-mail: o pedido (`/email-otp/send-verification-otp`) é limitado no authGate, antes da checagem de
    // quem pode receber, para a resposta não revelar quem tem conta; aqui fica desligado para não contar duas vezes.
    // A entrada com o código aceita 10 por minuto por IP: cabem as 5 tentativas de um código e as de um segundo,
    // e o `RL_AUTH` (30 por minuto por IP em todo /api/auth) segue valendo por cima.
    rateLimit: { enabled: env.APP_ENV !== 'development', storage: 'database', window: 60, max: 30,
      customRules: { '/get-session': false, '/sign-up/email': { window: 60, max: 5 }, '/sign-in/email': { window: 60, max: 5 }, '/request-password-reset': { window: 60, max: 5 }, '/send-verification-email': { window: 60, max: 5 },
        [OTP_SEND_PATH]: false, [OTP_SIGN_IN_PATH]: { window: 60, max: 10 } } },
    plugins: [
      // Código de 6 dígitos por 10 minutos, guardado só como resumo com chave (HMAC-SHA-256 com o segredo) na tabela
      // `verification`; 5 tentativas por código. O envio passa por auth-otp.ts: só `sign-in`, teto diário e falha
      // devolvida ao pedido.
      emailOTP({ otpLength: 6, expiresIn: OTP_EXPIRES_IN_SECONDS, storeOTP: { hash: otpHasher(env.BETTER_AUTH_SECRET) }, allowedAttempts: OTP_ALLOWED_ATTEMPTS,
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (delivery) delivery.email = email
          try {
            // Segunda barreira (o authGate já respondeu sem chegar aqui): com o cadastro fechado, só envia a quem pode entrar.
            if (!await canReceiveLoginCode(env, email.toLowerCase())) return
            await deliverLoginCode(env, email, otp, type)
          } catch (error) { if (delivery) delivery.error = error; throw error }
        } }),
      ...(env.GOOGLE_CLIENT_ID ? [oneTap({ clientId: env.GOOGLE_CLIENT_ID })] : []),
    ],
  })
}
