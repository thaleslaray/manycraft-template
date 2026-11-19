import { betterAuth } from 'better-auth'
import { magicLink } from 'better-auth/plugins/magic-link'
import { oneTap } from 'better-auth/plugins/one-tap'
import { APIError } from 'better-auth/api'
import { HTTPException } from 'hono/http-exception'
import type { Env } from './env'
import { sendEmail } from './email'
import { bucketOf } from './media-blocks'
import { disconnectMember, revokeMemberKeys } from './member-access'
export function createAuth(env: Env) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32 || !env.BETTER_AUTH_URL) {
    throw new HTTPException(503, { message: 'Autenticação não configurada.' })
  }
  const deletedMemberships = new Map<string, string[]>()
  return betterAuth({
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [new URL(env.BETTER_AUTH_URL).origin],
    logger: { disabled: true },
    emailAndPassword: {
      enabled: true, requireEmailVerification: true, minPasswordLength: 12,
      revokeSessionsOnPasswordReset: true,
      // As sessões já foram revogadas: as conexões ao vivo do inbox da pessoa caem na hora (o alarme do hub é a segunda barreira).
      onPasswordReset: async ({ user }) => {
        const memberships = await env.DB.prepare('SELECT workspace_id FROM workspace_members WHERE user_id=?').bind(user.id).all<{ workspace_id: string }>()
        await disconnectMember(env, memberships.results.map(row => row.workspace_id), user.id)
      },
      sendResetPassword: async ({ user, url }) => sendEmail(env, user.email, 'reset', url),
    },
    emailVerification: {
      sendOnSignUp: true, autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) => sendEmail(env, user.email, 'verification', url),
    },
    // Entrar com Google: só aparece quando o app do Google está configurado.
    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } } : {}),
    },
    // Cadastro fechado (400, não 403: o better-auth troca 403 no cadastro por uma resposta genérica de sucesso): toda criação de usuário (e-mail e senha, link mágico, Google) passa por aqui e exige convite válido para o e-mail.
    databaseHooks: { user: { create: { before: async user => {
      if (env.SIGNUP_CLOSED !== '1') return
      const invited = await env.DB.prepare('SELECT 1 AS ok FROM invites WHERE email=? AND expires_at>? LIMIT 1').bind(String(user.email ?? '').toLowerCase(), Date.now()).first()
      if (!invited) throw new APIError('BAD_REQUEST', { code: 'SIGNUP_CLOSED', message: 'O cadastro está fechado. Peça um convite a quem administra o espaço.' })
    } } } },
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
    advanced: { useSecureCookies: true, defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: 'lax' },
      // `createAuth` roda a cada pedido, e a validação de schema do Better Auth (sqlite_master + 2 batches de PRAGMA, 3 idas em fila ao D1) rodava junto, sem cache entre pedidos, e o pedido esperava por ela. O schema é das migrações em `migrations/`, conferidas por `scripts/check-migrations.mjs`.
      database: { validateSchema: false, joins: true } },
    // Só em produção: no desenvolvimento local o limite por IP travava as jornadas de login em série.
    // get-session fica fora: o limite guarda no D1, e cada abertura do painel pagaria duas idas ao banco só para contar.
    rateLimit: { enabled: env.APP_ENV !== 'development', storage: 'database', window: 60, max: 30,
      customRules: { '/get-session': false, '/sign-up/email': { window: 60, max: 5 }, '/sign-in/email': { window: 60, max: 5 }, '/request-password-reset': { window: 60, max: 5 }, '/send-verification-email': { window: 60, max: 5 } } },
    plugins: [magicLink({ storeToken: 'hashed', sendMagicLink: async ({ email, url }) => sendEmail(env, email, 'magic', url) }), ...(env.GOOGLE_CLIENT_ID ? [oneTap({ clientId: env.GOOGLE_CLIENT_ID })] : [])],
  })
}
