import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import { requestSession } from './request-session'
import type { Env } from './env'
import { devRole, type Role } from './permissions'

/** Bootstrap do painel: contexto derivado da sessão, nunca de um workspace da URL. */
export const sessionRoutes = new Hono<{ Bindings: Env }>()
sessionRoutes.get('/workspace', async c => {
  // Sem cookie não há sessão a verificar; o auto-login de desenvolvimento não depende de BETTER_AUTH_*.
  // Só o cookie de sessão conta: outros cookies do localhost não desligam o auto-login.
  const temSessao = Object.keys(getCookie(c)).some(k => k.endsWith('session_token'))
  const session = temSessao ? await requestSession(c.env, c.req.raw, true) : null
  if (session?.user.emailVerified) {
    const workspace = await c.env.DB.prepare(`SELECT w.id AS workspace_id,w.name,m.role,? AS user_name FROM workspaces w
      JOIN workspace_members m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY (w.id=?) DESC,m.created_at,m.id LIMIT 1`)
      .bind(session.user.name || session.user.email, session.user.id, getCookie(c, 'workspace_context') ?? '')
      .first<{ workspace_id: string; name: string; role: Role }>()
    return c.json(workspace)
  }
  if (!temSessao && c.env.APP_ENV === 'development' && c.env.DEV_AUTO_LOGIN === '1') {
    const workspace = await c.env.DB.prepare('SELECT id AS workspace_id,name FROM workspaces WHERE id=?')
      .bind(c.env.DEV_WORKSPACE_ID || 'demo-workspace').first<{ workspace_id: string; name: string }>()
    if (!workspace) throw new HTTPException(404, { message: 'Execute o seed de desenvolvimento.' })
    return c.json({ ...workspace, role: devRole(c.env), user_name: 'Desenvolvimento' })
  }
  throw new HTTPException(401, { message: 'Entre com uma conta verificada.' })
})

/** Provedores de entrada configurados neste ambiente (a tela de login só mostra os botões que funcionam). */
sessionRoutes.get('/providers', c => c.json({ google: !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET), google_client_id: c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET ? c.env.GOOGLE_CLIENT_ID : null }))
