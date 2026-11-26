import { hashLegacyHottoks, hotmartHook, hotmartPanel } from './hotmart'
import { googleSheetsRoutes } from './google-sheets'
import { quickAutomations } from './quick-automations'
import { automationAnswersQuerySchema, automationDraftSchema, automationListQuerySchema, automationStatsQuerySchema, sharedAutomation } from './automation-actions'
import { apiKeys, findProfileKeyByHash, publicApi } from './public-api'
import { conversationSurfaces } from './conversation-surfaces'
import { basicActions } from './basic-actions'
import { triggersOverview } from './triggers-overview'
import { workspaceSettings } from './workspace-settings'
import { ACCOUNT_PHOTO_PATH } from './account-photo'
import { triggerMetrics } from './trigger-metrics'
import { contactPortability } from './contact-portability'
import { getCookie } from 'hono/cookie'
import { Hono, type Context, type Next } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z, ZodError } from 'zod'
import { repositoryFor, triggerPatchSchema } from './db'
import type { Env } from './env'
import { createAuth } from './auth'
import { finishAuthRequest, type OtpDelivery } from './auth-otp'
import { mayUseSessionCache, requestSession, sessionCookies } from './request-session'
import { sessionRoutes } from './session'
import { pixelPanel, pixelPublic } from './pixel'
import { compliance } from './compliance'
import { notificationTopics } from './notification-topics'
import { siteWidgetPublic, siteWidgets } from './site-widgets'
import { apps } from './apps'
import { metaReviewRoutes } from './channels/meta-review'
import { metaAccount } from './channels/meta-account'
import { emailPendingNotices, notices } from './notices'
import { memberAlerts, drainMemberAlerts } from './team-alerts'
import { runDueFollowUps } from './flow/follow-ups'
import { team, invitePublic, type AuthVariables } from './team'
import { media, mediaPublic } from './media'
import { type Role } from './permissions'
import { boundedBody, hash, limitWithRetry, publicBodyLimit } from './security'
import { apiKeyAllowed, apiKeyBlockReason, compileAllowed, NOT_RELEASED_MESSAGE, PANEL_ONLY_MESSAGE } from './api-key-access'
import { API_KEY_ALLOWED } from './api-rotas-liberadas'

const allowedForKey = compileAllowed(API_KEY_ALLOWED)
import { D1_TRACE_HEADER, D1_TRACE_RESULT_HEADER, rastrearD1 } from './d1-trace'
import { webhooks } from './integrations'
import { consumeInbound, cleanupInbound } from './jobs'
import { inbox, sendDueScheduledMessages } from './inbox/routes'
import { fireDueReminders } from './inbox/service'
import { contactActions, contactListQuerySchema } from './contacts'
import { apiDocs } from './api-docs/rotas'
import { contactImports } from './contact-imports'
import { segments } from './segments'
import { consumeContactImport } from './contact-import-worker'
import { contactSequences } from './contact-sequences'
import { hasFlow } from './flow/dispatch'
import { dispatchSequences } from './flow/sequences'
import { wakeConnectionWaits } from './flow/connection-wait'
import { sequenceInputSchema } from './db/sequences'
import { keywordActiveSchema, keywordPrioritySchema, keywordRuleInputSchema } from './db/keywords'
import { consumeBroadcast, recoverBroadcastQueue } from './db/broadcasts'
import { broadcastRoutes } from './broadcast-routes'
import { publicBroadcastRoutes } from './broadcast-links'
import { publicFlowRoutes } from './flow/link-click'
import { analyticsQuerySchema, getDashboard, getInboxInsights, getInsights } from './db/insights'
import { hooks } from './channels/core/hooks'
import { connections } from './connections'
import { messageTemplates } from './message-templates'
import { settings } from './settings'
import { reconcileConnections } from './channels/core/reconcile'
import { saveCommentTrigger } from './db/comment-triggers'
import { LIVE_COMMENT_WIDGET } from './db/automations'
import { saveStoryTrigger, storyWhere } from './db/story-triggers'
import { externalWhere, patchExternalTrigger } from './db/external-triggers'
import { refWhere, saveRefTrigger } from './db/ref-links'
import { authorize, devRole } from './permissions'
import { assertPublishable } from './channels/core/publish-check'
import { contactAvatar } from './channels/core/profiles'
import { emailRoutes, publicEmailRoutes } from './email-channel/routes'
import { receiveEmail } from './email-channel/receive'
import { consumeEmailSendingEvent, isEmailSendingEvent } from './email-channel/sending-events'
import { automationActions, assertUnlocked, type LockableAction } from './automation-actions'
import { automationTemplates } from './automation-templates'
import { automationLibrary } from './automation-library'
import { manychatImport } from './manychat-import'
import { automationTriggerActions } from './automation-trigger-actions'
import { keywordActions } from './keyword-actions'
import { rules } from './rules/routes'
import { externalRequests } from './external-requests'
import { dispatchRules } from './rules/runtime'

const app = new Hono<{
  Bindings: Env
  Variables: AuthVariables & { repository: ReturnType<typeof repositoryFor> }
}>()

// Só desenvolvimento, e só com o header x-d1-trace: 1: conta as idas ao D1 do pedido (src/d1-trace.ts). Em produção é uma comparação e nada mais.
// Diagnóstico de desempenho em produção (PERF_LOG=1): uma linha por pedido com caminho mascarado (ids e tokens viram :id,
// sem query string), status, tempo total e as idas ao D1 com a duração de cada uma. Nada de SQL com valores, cookie ou corpo.
const caminhoMascarado = (path: string) => path.split('/').map(seg => /\d/.test(seg) && seg.length >= 8 || seg.length > 24 ? ':id' : seg).join('/')
app.use('*', async (c, next) => {
  if ((c.env as { PERF_LOG?: string }).PERF_LOG !== '1' || c.env.APP_ENV === 'development') return next()
  const caminho = caminhoMascarado(c.req.path)
  const idas: string[] = []
  const rastro = rastrearD1(c.env.DB, '', linha => { const m = /\((\d+)ms\) (.*)$/.exec(linha); if (m && !linha.includes('RESUMO')) idas.push(`${m[2]} ${m[1]}ms`) })
  c.env = { ...c.env, DB: rastro.db }
  const inicio = performance.now()
  await next()
  const { idas: n, emFila } = rastro.fim()
  console.log(`[perf] ${c.req.method} ${caminho} ${c.res.status} ${(performance.now() - inicio).toFixed(0)}ms d1=${n}/${emFila} ${idas.join(' | ')}`)
})
app.use('*', async (c, next) => {
  if (c.env.APP_ENV !== 'development' || c.req.header(D1_TRACE_HEADER) !== '1') return next()
  const rastro = rastrearD1(c.env.DB, `${c.req.method} ${c.req.path}`)
  c.env = { ...c.env, DB: rastro.db }
  await next()
  const { idas, emFila } = rastro.fim()
  try { c.res.headers.set(D1_TRACE_RESULT_HEADER, `${idas},${emFila}`) } catch { c.res = new Response(c.res.body, { status: c.res.status, headers: new Headers([...c.res.headers, [D1_TRACE_RESULT_HEADER, `${idas},${emFila}`]]) }) }
})
// Repassa ao navegador os cookies que a leitura da sessão preparou (cache de 60 s, renovação). Sem isso o cache só nasce no login.
app.use('/api/*', async (c, next) => {
  await next()
  const cookies = sessionCookies(c.req.raw)
  if (!cookies.length || c.res.status === 101) return
  try { for (const cookie of cookies) c.res.headers.append('Set-Cookie', cookie) }
  catch { const headers = new Headers(c.res.headers); for (const cookie of cookies) headers.append('Set-Cookie', cookie); c.res = new Response(c.res.body, { status: c.res.status, headers }) }
})
app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('X-Content-Type-Options', 'nosniff')
  await next()
})
// Estado booleano em toda rota da API: cabeçalho x-state (true em sucesso, false em erro), sem mudar o corpo.
app.use('/api/*', async (c, next) => {
  await next()
  // Upgrade de WebSocket (101) tem cabeçalhos imutáveis: fica sem o x-state.
  if (c.res.status !== 101) { try { c.res.headers.set('x-state', String(c.res.status < 400)) } catch { /* resposta imutável */ } }
})
// Teto de corpo das rotas públicas que leem corpo (o das autenticadas vem mais abaixo). Webhooks de canal e /api/media têm limite próprio.
const publicBody = publicBodyLimit(64 * 1024)
for (const path of ['/api/pixel/event', '/api/invite-preview', '/api/hooks/hotmart/*', '/api/email-public/*', '/api/broadcast-public/*', '/api/flow-public/*', '/api/session/*']) app.use(path, publicBody)
// A API pública aceita conteúdo v2 com até 10 mensagens de 2.000 caracteres e 3 botões com URL por mensagem: perto de 90 KB no limite do formato.
app.use('/api/public/v1/*', publicBodyLimit(256 * 1024))
app.route('/api/webhooks', webhooks)
app.route('/api/hooks/hotmart', hotmartHook)
app.route('/api/hooks', hooks)
app.route('/api/email-public', publicEmailRoutes)
app.route('/api/broadcast-public', publicBroadcastRoutes)
app.route('/api/flow-public', publicFlowRoutes)
app.get('/api/automation-share/:token', async c => {
  const shared = /^[a-f0-9]{36}$/.test(c.req.param('token')) ? await sharedAutomation(c.env.DB, c.req.param('token')) : null
  if (!shared) return c.json({ error: 'Link inválido.' }, 404)
  return c.json(shared)
})
app.route('/api/public/v1', publicApi)
app.route('/api/docs', apiDocs)
app.route('/api', pixelPublic)
app.route('/api', siteWidgetPublic)
app.route('/api', mediaPublic)
app.route('/api/session', sessionRoutes)
app.route('/api', invitePublic)
app.on(['GET', 'POST'], '/api/auth/*', async c => {
  // Better Auth validates its own endpoint bodies/query with Zod and enforces Origin.
  if (c.req.method === 'POST') {
    const body = await boundedBody(c.req.raw.clone(), 64 * 1024)
    if (!body.byteLength) throw new HTTPException(400)
  }
  const key = await hash(c.req.header('cf-connecting-ip') ?? 'local')
  if (c.req.path !== '/api/auth/get-session' && c.env.RL_AUTH && !(await c.env.RL_AUTH.limit({ key })).success) throw new HTTPException(429)
  // get-session decide se a pessoa ainda está dentro (painel, login, "Encerrar sessões"): sempre do banco, nunca do cache de 60 s.
  if (c.req.method === 'GET' && c.req.path === '/api/auth/get-session') {
    const url = new URL(c.req.url)
    url.searchParams.set('disableCookieCache', 'true')
    return createAuth(c.env).handler(new Request(url, c.req.raw))
  }
  // Rotas fechadas e travas do pedido de código: hook `before` do Better Auth (authGate, por rota resolvida).
  // Aqui só a falha do envio do código, que ele engole e responde 200.
  const delivery: OtpDelivery = {}
  return finishAuthRequest(c.env, await createAuth(c.env, delivery).handler(c.req.raw), delivery)
})
app.get('/api/dev/workspace', async c => {
  if (c.env.APP_ENV !== 'development') throw new HTTPException(404)
  const workspace = await c.env.DB.prepare(`SELECT id AS workspace_id,name FROM workspaces WHERE id=?`)
    .bind(c.env.DEV_WORKSPACE_ID ?? 'demo-workspace').first<{ workspace_id: string; name: string }>()
  if (!workspace) throw new HTTPException(404, { message: 'Execute o seed de desenvolvimento.' })
  return c.json(workspace)
})
// Só desenvolvimento: o botão "Entrar (teste)" do painel abre sessão como dona do espaço de desenvolvimento
// (`DEV_WORKSPACE_ID`, a Lia do seed), sem senha e sem e-mail: o código é criado e usado aqui mesmo pela API do
// Better Auth (`createVerificationOTP` só existe no servidor), então a sessão nasce pelo mesmo caminho da entrada
// por código. Fora do desenvolvimento responde 404 antes de qualquer outra coisa.
app.post('/api/dev/sign-in', async c => {
  if (c.env.APP_ENV !== 'development') throw new HTTPException(404)
  // Só o próprio painel: outro site não abre sessão de teste no navegador de quem o visita.
  if (c.req.header('origin') !== new URL(c.env.BETTER_AUTH_URL ?? c.req.url).origin) throw new HTTPException(403, { message: 'Origem não permitida.' })
  const owner = await c.env.DB.prepare(`SELECT u.email FROM workspace_members m JOIN "user" u ON u.id=m.user_id
    WHERE m.workspace_id=? AND m.role='owner' ORDER BY m.created_at,m.id LIMIT 1`)
    .bind(c.env.DEV_WORKSPACE_ID ?? 'demo-workspace').first<{ email: string }>()
  if (!owner) throw new HTTPException(404, { message: 'Execute o seed de desenvolvimento.' })
  const auth = createAuth(c.env)
  const otp = await auth.api.createVerificationOTP({ body: { email: owner.email, type: 'sign-in' } })
  return auth.api.signInEmailOTP({ body: { email: owner.email, otp }, headers: c.req.raw.headers, asResponse: true })
})
/** An <img> (or <audio>) cannot send x-workspace; only the avatar and the inbox file routes may select the workspace by query. Session and membership are still verified. */
const avatarPath = new RegExp(`^(?:/api/contacts/[^/]+/avatar|${ACCOUNT_PHOTO_PATH}/[a-f0-9-]{36}|/api/inbox/media/[a-f0-9-]{36})$`)
const workspaceFor = (c: { req: { path: string; method: string; header(name: string): string | undefined; query(name: string): string | undefined } }) =>
  c.req.header('x-workspace') ?? (c.req.method === 'GET' && avatarPath.test(c.req.path) ? c.req.query('workspace') : undefined)
/** Sem o cabeçalho, quem chama (curl, script) via só "Dados inválidos" sem path: diz qual cabeçalho falta. */
const resolveWorkspace = (c: Parameters<typeof workspaceFor>[0]) => {
  const parsed = z.string().min(1).max(128).safeParse(workspaceFor(c))
  if (!parsed.success) throw new HTTPException(400, { message: 'Informe o espaço de trabalho no cabeçalho x-workspace.' })
  return parsed.data
}
app.use('/api/*', async (c, next) => {
  if (!['GET', 'HEAD'].includes(c.req.method) && c.req.path !== '/api/media') {
    // Rich email designs and CSV uploads have separate bounded payload budgets.
    const designBody = ['/api/email/drafts', '/api/email/test'].includes(c.req.path)
    const maxBody = designBody ? 5 * 1024 * 1024 : c.req.path === '/api/contact-imports' ? 2 * 1024 * 1024 : (c.req.path === '/api/imports/manychat' || c.req.path === '/api/imports/manychat/fragment') ? 4 * 1024 * 1024 : 64 * 1024
    await boundedBody(c.req.raw.clone(), maxBody)
  }
  // Chave de perfil (`Authorization: Bearer perfil:<segredo>` + x-workspace): vira o mesmo principal do painel,
  // com o papel real no espaço; as permissões são as das rotas (`authorize`). Se vierem cookie E chave, a chave manda:
  // o pedido é tratado como API (sem Origin, com escopo, limite e log via=api). A chave do espaço não abre o painel.
  const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1]
  if (bearer) {
    if (!bearer.startsWith('perfil:')) throw new HTTPException(401, { message: 'Use a chave de perfil (Bearer perfil:<chave>). A chave do espaço vale só em /api/public/v1.' })
    const secret = bearer.slice('perfil:'.length)
    // O limite conta antes de qualquer busca: segredo inválido, espaço alheio e rota barrada também gastam.
    await limitWithRetry(c.env, `api-key:${secret}`, Number(c.env.API_KEY_RATE_LIMIT) || 600)
    if (apiKeyBlockReason(c.req.method, c.req.path, c.req.header('upgrade'))) throw new HTTPException(403, { message: PANEL_ONLY_MESSAGE })
    if (!apiKeyAllowed(c.req.method, c.req.path, allowedForKey)) throw new HTTPException(403, { message: NOT_RELEASED_MESSAGE })
    const workspaceId = resolveWorkspace(c)
    const key = await findProfileKeyByHash(c.env, await hash(secret))
    if (!key) throw new HTTPException(401, { message: 'Chave inválida ou revogada.' })
    // Igual ao cookie: dono com e-mail não verificado não entra.
    if (!key.email_verified) throw new HTTPException(401, { message: 'Entre com uma conta verificada.' })
    // Igual ao painel: espaço em que a pessoa não é membro responde 404.
    const member = await c.env.DB.prepare('SELECT id,role FROM workspace_members WHERE user_id=? AND workspace_id=?').bind(key.user_id, workspaceId).first<{ id: string; role: Role }>()
    if (!member) throw new HTTPException(404, { message: 'Workspace não encontrado.' })
    if (key.scope === 'read' && !['GET', 'HEAD'].includes(c.req.method)) throw new HTTPException(403, { message: 'Esta chave é só de leitura.' })
    // Uso gravado no máximo uma vez por minuto (evita uma escrita a cada pedido).
    const now = Date.now()
    if (!key.last_used_at || now - key.last_used_at > 60_000) await c.env.DB.prepare('UPDATE user_api_keys SET last_used_at=? WHERE id=?').bind(now, key.id).run()
    const principal = { userId: key.user_id, workspaceId, role: member.role }
    c.set('userId', key.user_id); c.set('email', key.email); c.set('memberId', member.id); c.set('principal', principal)
    c.set('via', 'api'); c.set('apiKeyId', key.id)
    c.set('repository', repositoryFor(c.env, workspaceId, principal))
    await next(); return
  }
  // Só o cookie de sessão conta: outros cookies do localhost não desligam o auto-login.
  if (c.env.DEV_AUTO_LOGIN === '1' && !Object.keys(getCookie(c)).some(k => k.endsWith('session_token'))) {
    if (c.env.APP_ENV !== 'development') throw new HTTPException(403, { message: 'Acesso de desenvolvimento desabilitado.' })
    const workspaceId = resolveWorkspace(c)
    const owner = await c.env.DB.prepare(`SELECT m.id,m.user_id,u.email FROM workspace_members m JOIN "user" u ON u.id=m.user_id
      WHERE m.workspace_id=? AND m.role='owner' ORDER BY m.created_at,m.id LIMIT 1`)
      .bind(workspaceId).first<{ id: string; user_id: string; email: string }>()
    if (!owner) throw new HTTPException(404, { message: 'Workspace de desenvolvimento não encontrado.' })
    const origin = c.req.header('origin')
    if (origin && origin !== new URL(c.req.url).origin && origin !== new URL(c.env.BETTER_AUTH_URL ?? c.req.url).origin) throw new HTTPException(403)
    const principal = { userId: owner.user_id, workspaceId, role: devRole(c.env) }
    c.set('via', 'painel'); c.set('userId', owner.user_id); c.set('email', owner.email); c.set('memberId', owner.id); c.set('principal', principal)
    c.set('repository', repositoryFor(c.env, workspaceId, principal))
    await next(); return
  }
  // A workspace header selects context only after a real session is verified.
  const session = await requestSession(c.env, c.req.raw, mayUseSessionCache(c.req.method, c.req.path, c.req.header('upgrade')))
  if (!session?.user.emailVerified) throw new HTTPException(401, { message: 'Entre com uma conta verificada.' })
  c.set('userId', session.user.id); c.set('via', 'painel')
  c.set('sessionId', session.session.id)
  c.set('email', session.user.email)
  if (!['GET', 'HEAD'].includes(c.req.method)) {
    if (c.req.header('origin') !== new URL(c.env.BETTER_AUTH_URL!).origin) throw new HTTPException(403, { message: 'Origem não permitida.' })
  }
  if (['/api/workspaces', '/api/invites/accept', '/api/access-requests', '/api/account/sign-out-everywhere'].includes(c.req.path)) {
    await next(); return
  }
  const workspaceId = resolveWorkspace(c)
  const member = await c.env.DB.prepare('SELECT id,role FROM workspace_members WHERE user_id=? AND workspace_id=?')
    .bind(session.user.id, workspaceId).first<{ id: string; role: Role }>()
  if (!member) throw new HTTPException(404, { message: 'Workspace não encontrado.' })
  const principal = { userId: session.user.id, workspaceId, role: member.role }
  c.set('principal', principal)
  c.set('memberId', member.id)
  c.set('repository', repositoryFor(c.env, workspaceId, principal))
  await next()
})
/** Ação de uma rota de automação, para as permissões por automação (editar, mover, excluir, restaurar, exportar, compartilhar, excluir de vez). */
async function automationActionOf(c: Context<{ Bindings: Env; Variables: AuthVariables }>): Promise<LockableAction[]> {
  const path = c.req.path, method = c.req.method
  if (path.endsWith('/trash')) return ['delete']
  if (path.endsWith('/restore')) return ['restore']
  if (path.endsWith('/share')) return ['share']
  if (/\/(copy-to|duplicate|convert)$/.test(path)) return ['export']
  if (method === 'DELETE' && /^\/api\/automations\/[^/]+$/.test(path)) return ['purge']
  if (method === 'PATCH' && /^\/api\/automations\/[^/]+$/.test(path)) {
    // Toda ação presente no corpo conta: nome/status pedem 'edit' e folder_id pede 'move', mesmo juntos.
    const body = await c.req.raw.clone().json().catch(() => ({})) as Record<string, unknown>
    const actions: LockableAction[] = []
    if ('name' in body || 'status' in body || !('folder_id' in body)) actions.push('edit')
    if ('folder_id' in body) actions.push('move')
    return actions
  }
  return ['edit']
}
async function lockedGuard(c: Context<{ Bindings: Env; Variables: AuthVariables }>, next: Next) {
  if (['GET', 'HEAD'].includes(c.req.method) || c.req.path.endsWith('/lock') || !c.var.principal) return next()
  for (const action of await automationActionOf(c)) await assertUnlocked(c.env.DB, c.var.principal.workspaceId, c.req.param('id')!, action, c.var.principal)
  return next()
}
// Log de atividade: toda alteração bem-sucedida feita pelo painel (o corpo nunca é guardado, só método e rota).
app.use('/api/*', async (c, next) => {
  await next()
  if (['GET', 'HEAD'].includes(c.req.method) || c.res.status >= 400 || !c.var.principal) return
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO activity_log (workspace_id,user_id,method,path,status,via,api_key_id) VALUES (?,?,?,?,?,?,?)').bind(c.var.principal.workspaceId, c.var.principal.userId, c.req.method, c.req.path.slice(0, 300), c.res.status, c.var.via ?? 'painel', c.var.apiKeyId ?? null),
      c.env.DB.prepare('DELETE FROM activity_log WHERE workspace_id=? AND created_at<?').bind(c.var.principal.workspaceId, Date.now() - 90 * 86_400_000),
    ])
  } catch (error) { logTaskError('activity_log_unavailable', error) }
})
app.get('/api/activity-log', async c => {
  authorize(c.var.principal, 'team')
  const rows = await c.env.DB.prepare(`SELECT a.id,a.method,a.path,a.status,a.created_at,coalesce(nullif(u.name,''),u.email) AS user_name,a.via,a.api_key_id,k.name AS api_key_name,k.last4 AS api_key_last4 FROM activity_log a
    LEFT JOIN "user" u ON u.id=a.user_id LEFT JOIN user_api_keys k ON k.id=a.api_key_id WHERE a.workspace_id=? ORDER BY a.id DESC LIMIT 200`).bind(c.var.principal.workspaceId).all()
  return c.json({ items: rows.results })
})
app.use('/api/*', async (c, next) => {
  await next()
  if (!['GET','HEAD'].includes(c.req.method) && c.res.status<400 && c.var.principal) {
    try { await dispatchRules(c.env,Date.now(),c.var.principal.workspaceId) }
    catch (error) { logTaskError('rule_dispatch_unavailable', error) } // The mutation already committed; cron recovers its durable events.
  }
})
// Automação travada: quem não é dono nem administrador só lê (rascunho, publicação, gatilhos, lixeira, mover e excluir ficam bloqueados).
app.use('/api/automations/:id/*', lockedGuard)
app.use('/api/automations/:id', lockedGuard)
app.route('/api/rules', rules)
app.route('/api', team)
app.route('/api', media)
app.route('/api/inbox', inbox)
app.route('/api', contactActions)
app.route('/api', contactPortability)
app.route('/api', contactImports)
app.route('/api', segments)
app.route('/api', contactSequences)
app.route('/api/connections', connections)
app.route('/api/message-templates', messageTemplates)
app.route('/api', settings)
app.route('/api', apiKeys)
app.route('/api/email', emailRoutes)
app.route('/api', automationActions)
app.route('/api', quickAutomations)
app.route('/api', googleSheetsRoutes)
app.route('/api', hotmartPanel)
app.route('/api', pixelPanel)
app.route('/api', compliance)
app.route('/api', notificationTopics)
app.route('/api', siteWidgets)
app.route('/api', apps)
app.route('/api', metaReviewRoutes)
app.route('/api', metaAccount)
app.route('/api', notices)
app.route('/api', memberAlerts)
app.route('/api', automationTemplates)
app.route('/api', automationLibrary)
app.route('/api', manychatImport)
app.route('/api', automationTriggerActions)
app.route('/api', keywordActions)
app.route('/api', basicActions)
app.route('/api', triggersOverview)
app.route('/api', workspaceSettings)
app.route('/api', triggerMetrics)
app.route('/api', externalRequests)
app.route('/api', conversationSurfaces)

app.get('/api/keywords', async c => {
  z.object({}).strict().parse(c.req.query())
  return c.json(await c.var.repository.listKeywordRules())
})
/** Automação à qual a regra de palavra-chave está ligada hoje (a trava vale para ela e para a que a regra passa a disparar). */
async function keywordAutomationOf(db: D1Database, workspaceId: string, id: string) {
  return db.prepare('SELECT t.automation_id FROM keywords k JOIN triggers t ON t.workspace_id=k.workspace_id AND t.id=k.trigger_id WHERE k.workspace_id=? AND k.id=?')
    .bind(workspaceId, id).first<string>('automation_id')
}
app.post('/api/keywords', async c => {
  const input = keywordRuleInputSchema.parse(await readJson(c.req.raw))
  await assertUnlocked(c.env.DB, c.var.principal.workspaceId, input.automation_id, 'edit', c.var.principal)
  return c.json(await c.var.repository.saveKeywordRule(input), 201)
})
app.patch('/api/keywords/:id/priority', async c => {
  const id = z.string().min(1).max(128).parse(c.req.param('id'))
  const { target } = keywordPrioritySchema.parse(await readJson(c.req.raw))
  return c.json(await c.var.repository.moveKeywordRule(id, target))
})
app.patch('/api/keywords/:id', async c => {
  const id = z.string().min(1).max(128).parse(c.req.param('id'))
  const body = await readJson(c.req.raw)
  const toggle = keywordActiveSchema.safeParse(body)
  const current = await keywordAutomationOf(c.env.DB, c.var.principal.workspaceId, id)
  if (current) await assertUnlocked(c.env.DB, c.var.principal.workspaceId, current, 'edit', c.var.principal)
  if (!toggle.success) {
    const next = keywordRuleInputSchema.parse(body)
    await assertUnlocked(c.env.DB, c.var.principal.workspaceId, next.automation_id, 'edit', c.var.principal)
  }
  return c.json(toggle.success ? await c.var.repository.setKeywordRuleActive(id, toggle.data.active)
    : await c.var.repository.saveKeywordRule(keywordRuleInputSchema.parse(body), id))
})
app.delete('/api/keywords/:id', async c => {
  const id = z.string().min(1).max(128).parse(c.req.param('id'))
  const current = await keywordAutomationOf(c.env.DB, c.var.principal.workspaceId, id)
  if (current) await assertUnlocked(c.env.DB, c.var.principal.workspaceId, current, 'edit', c.var.principal)
  return c.json(await c.var.repository.deleteKeywordRule(id))
})

app.get('/api/sequences/flows', async c => {
  z.object({}).strict().parse(c.req.query())
  return c.json(await c.var.repository.listSequenceFlows())
})
app.get('/api/sequences', async c => {
  z.object({}).strict().parse(c.req.query())
  return c.json(await c.var.repository.listSequences())
})
app.get('/api/sequences/:id', async c => {
  const sequence = await c.var.repository.getSequence(z.string().min(1).max(128).parse(c.req.param('id')))
  if (!sequence) throw new HTTPException(404)
  return c.json(sequence)
})
app.post('/api/sequences', async c => c.json(await c.var.repository.saveSequence(sequenceInputSchema.parse(await readJson(c.req.raw))), 201))
app.patch('/api/sequences/:id', async c => c.json(await c.var.repository.saveSequence(sequenceInputSchema.parse(await readJson(c.req.raw)), z.string().min(1).max(128).parse(c.req.param('id')))))
app.delete('/api/sequences/:id', async c => c.json(await c.var.repository.deleteSequence(z.string().min(1).max(128).parse(c.req.param('id')))))

app.get('/api/automations', async (c) => {
  const q = automationListQuerySchema.parse(c.req.query())
  return c.json(await c.var.repository.listAutomations({
    ...q, folder_id: q.folder_id === 'null' ? null : q.folder_id,
  }))
})
/** Respostas da coleta (perguntas) de uma automação: tabela ou CSV, mais recentes primeiro, até 5.000 linhas. */
app.get('/api/automations/:id/answers', async (c) => {
  authorize(c.var.principal, 'automation:read')
  const ws = c.var.principal.workspaceId, automation = z.string().min(1).max(128).parse(c.req.param('id'))
  const query = automationAnswersQuerySchema.parse(c.req.query())
  const rows = await c.env.DB.prepare(`SELECT a.answered_at,q.node_id,json_extract(q.config,'$.text') AS question,a.value,c.id AS contact_id,
      trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')) AS contact_name,c.email,c.phone
    FROM flow_question_answers a JOIN flow_questions q ON q.run_id=a.run_id AND q.step_index=a.step_index
    JOIN flow_runs r ON r.id=q.run_id JOIN automation_versions av ON av.workspace_id=r.workspace_id AND av.id=r.automation_version_id
    JOIN contacts c ON c.workspace_id=q.workspace_id AND c.id=q.contact_id
    WHERE q.workspace_id=? AND av.automation_id=? AND a.outcome='success' AND c.status<>'deleted' AND (? IS NULL OR q.node_id=?)
    ORDER BY a.answered_at DESC LIMIT 5000`).bind(ws, automation, query.node ?? null, query.node ?? null)
    .all<{ answered_at: number | null; node_id: string; question: string; value: string | null; contact_id: string; contact_name: string; email: string | null; phone: string | null }>()
  const data = rows.results.map(r => ({ ...r, answered_at: r.answered_at ? new Date(r.answered_at).toISOString() : null,
    value: r.value === null ? null : JSON.parse(r.value) as unknown }))
  if (query.format === 'json') return c.json(data)
  const cell = (v: unknown) => { const text = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
    // Fórmula vira texto na planilha (=, +, -, @ no início não executam).
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text
    return /[",\n;]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe }
  const csv = [['respondido_em', 'pergunta', 'resposta', 'contato', 'contato_id', 'email', 'telefone'].join(','),
    ...data.map(r => [r.answered_at, r.question, r.value, r.contact_name, r.contact_id, r.email, r.phone].map(cell).join(','))].join('\n')
  return c.body(csv, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="respostas-${automation}.csv"` })
})
app.get('/api/automations/:id', async (c) => {
  const result = await c.var.repository.getAutomation(z.string().min(1).max(128).parse(c.req.param('id')))
  if (!result) throw new HTTPException(404, { message: 'Automação não encontrada.' })
  return c.json(result)
})
app.get('/api/automations/:id/called-by', async (c) => {
  z.object({}).strict().parse(c.req.query())
  return c.json({ rows: await c.var.repository.getAutomationCalledBy(z.string().min(1).max(128).parse(c.req.param('id'))) })
})
app.get('/api/automations/:id/stats', async (c) => {
  const { period_days } = automationStatsQuerySchema.parse(c.req.query())
  return c.json(await c.var.repository.getAutomationStats(z.string().min(1).max(128).parse(c.req.param('id')), period_days))
})
app.get('/api/automations/:id/triggers', async (c) => {
  z.object({}).strict().parse(c.req.query())
  return c.json(await c.var.repository.listAutomationTriggers(z.string().min(1).max(128).parse(c.req.param('id'))))
})
app.patch('/api/automations/:id/triggers/:triggerId', async (c) => {
  const params = z.object({ id: z.string().min(1).max(128), triggerId: z.string().min(1).max(128) }).parse(c.req.param())
  const raw = await readJson(c.req.raw)
  const comment = await c.env.DB.prepare("SELECT id FROM triggers WHERE workspace_id=? AND automation_id=? AND id=? AND kind='widget' AND widget_type IN ('feed_comment','feed_comment_trigger',?)").bind(c.var.principal.workspaceId, params.id, params.triggerId, LIVE_COMMENT_WIDGET).first()
  if (comment) {
    authorize(c.var.principal, 'edit')
    return c.json(await saveCommentTrigger(c.env.DB, c.var.principal.workspaceId, params.id, raw, params.triggerId))
  }
  const story = await c.env.DB.prepare(`SELECT t.id FROM triggers t WHERE t.workspace_id=? AND t.automation_id=? AND t.id=? AND ${storyWhere}`).bind(c.var.principal.workspaceId, params.id, params.triggerId).first()
  if (story) {
    authorize(c.var.principal, 'edit')
    return c.json(await saveStoryTrigger(c.env.DB, c.var.principal.workspaceId, params.id, raw, params.triggerId))
  }
  const ref = await c.env.DB.prepare(`SELECT t.id FROM triggers t WHERE t.workspace_id=? AND t.automation_id=? AND t.id=? AND ${refWhere}`).bind(c.var.principal.workspaceId, params.id, params.triggerId).first()
  if (ref) {
    authorize(c.var.principal, 'edit')
    return c.json(await saveRefTrigger(c.env.DB, c.var.principal.workspaceId, params.id, raw, params.triggerId))
  }
  const external = await c.env.DB.prepare(`SELECT t.id FROM triggers t WHERE t.workspace_id=? AND t.automation_id=? AND t.id=? AND ${externalWhere}`).bind(c.var.principal.workspaceId, params.id, params.triggerId).first()
  if (external) {
    authorize(c.var.principal, 'edit')
    return c.json(await patchExternalTrigger(c.env.DB, c.var.principal.workspaceId, params.id, params.triggerId, raw))
  }
  const body = triggerPatchSchema.parse(raw)
  return c.json(await c.var.repository.updateAutomationTrigger(params.id, params.triggerId, body))
})
app.put('/api/automations/:id/draft', async (c) => {
  const body = automationDraftSchema.parse(await readJson(c.req.raw))
  return c.json(await c.var.repository.saveDraft(z.string().min(1).max(128).parse(c.req.param('id')), body.graph))
})
app.post('/api/automations/:id/publish', async (c) => {
  const id = z.string().min(1).max(128).parse(c.req.param('id'))
  authorize(c.var.principal, 'edit')
  // The connections tied to the triggers must be able to deliver every step (409 names the feature, the step and the connection).
  await assertPublishable(c.env, c.var.principal.workspaceId, id)
  return c.json(await c.var.repository.publishAutomation(id), 201)
})
app.get('/api/contacts', async (c) => {
  const { cursor, ...filter } = contactListQuerySchema.parse(c.req.query())
  return c.json(await c.var.repository.listContacts(cursor ?? null, filter))
})
/** Atalhos da lateral de contatos: quantos contatos cada gatilho trouxe e quantos estão em cada sequência. */
app.get('/api/contact-facets', async (c) => {
  authorize(c.var.principal, 'read')
  const ws = c.var.principal.workspaceId
  const [triggers, sequences] = await Promise.all([
    c.env.DB.prepare(`SELECT t.id,t.name,count(c.id) AS count FROM triggers t JOIN contacts c ON c.workspace_id=t.workspace_id AND c.optin_source='trigger:'||t.id AND c.status<>'deleted'
      WHERE t.workspace_id=? GROUP BY t.id,t.name ORDER BY count DESC,t.name LIMIT 50`).bind(ws).all<{ id: string; name: string; count: number }>(),
    c.env.DB.prepare(`SELECT s.id,s.name,count(ss.contact_id) AS count FROM sequences s LEFT JOIN sequence_subscriptions ss ON ss.workspace_id=s.workspace_id AND ss.sequence_id=s.id
      WHERE s.workspace_id=? GROUP BY s.id,s.name ORDER BY s.name LIMIT 50`).bind(ws).all<{ id: string; name: string; count: number }>(),
  ])
  return c.json({ triggers: triggers.results, sequences: sequences.results })
})
app.get('/api/contacts/:id', async (c) => {
  const result = await c.var.repository.getContact(z.string().min(1).max(128).parse(c.req.param('id')))
  if (!result) throw new HTTPException(404, { message: 'Contato não encontrado.' })
  return c.json(result)
})
app.get('/api/contacts/:id/avatar', async (c) => {
  const id = z.string().min(1).max(128).parse(c.req.param('id'))
  const bytes = await contactAvatar(c.env, c.var.principal.workspaceId, id)
  const headers = { 'Cache-Control': 'private, max-age=' + (bytes ? 86400 : 300) }
  if (!bytes) return new Response(null, { status: 404, headers })
  return new Response(bytes, { status: 200, headers: { ...headers, 'Content-Type': 'image/jpeg', 'X-Content-Type-Options': 'nosniff' } })
})
app.get('/api/tags', async (c) => { z.object({}).strict().parse(c.req.query()); return c.json(await c.var.repository.listTags()) })
app.get('/api/fields', async (c) => { z.object({}).strict().parse(c.req.query()); return c.json(await c.var.repository.listFields()) })

app.route('/api/broadcasts', broadcastRoutes)

const analyticsQuery = (query: Record<string,string>) => {
  const now = Math.floor(Date.now()/1000)
  const parsed = analyticsQuerySchema.parse(query)
  const value = { ...parsed, from: parsed.from ?? now-7*86400, to: parsed.to ?? now }
  if (value.from>=value.to || value.to-value.from>365*86400) throw new HTTPException(400,{message:'Escolha um intervalo válido de até 365 dias.'})
  return value
}
app.get('/api/dashboard',async c => c.json(await getDashboard(c.env,c.var.principal,analyticsQuery(c.req.query()))))
app.get('/api/insights',async c => c.json(await getInsights(c.env,c.var.principal,analyticsQuery(c.req.query()))))
app.get('/api/insights/inbox',async c => { const q = analyticsQuery(c.req.query()); return c.json(await getInboxInsights(c.env,c.var.principal,{ from: q.from, to: q.to })) })

async function readJson(request: Request): Promise<unknown> {
  try { return await request.json() }
  catch { throw new HTTPException(400, { message: 'JSON inválido.' }) }
}

app.notFound((c) => c.json({ error: 'Recurso não encontrado.' }, 404))
/** Frase padrão para `HTTPException` lançada sem mensagem: o cliente nunca recebe `error` vazio. */
const defaultErrorMessages: Record<number, string> = { 400: 'Pedido inválido.', 401: 'Faça login para continuar.', 403: 'Sem permissão para esta ação.', 404: 'Recurso não encontrado.',
  405: 'Método não aceito nesta rota.', 409: 'O pedido conflita com o estado atual.', 413: 'Conteúdo grande demais.', 415: 'Formato de conteúdo não aceito.', 422: 'Não foi possível processar o pedido.',
  429: 'Muitos pedidos. Aguarde um instante e tente de novo.', 502: 'O provedor não respondeu como esperado.', 503: 'Serviço indisponível agora. Tente de novo em instantes.' }
const defaultErrorMessage = (status: number) => defaultErrorMessages[status] ?? (status >= 500 ? 'Não foi possível concluir a operação.' : 'Não foi possível concluir o pedido.')
app.onError((error, c) => {
  if (error instanceof HTTPException) {
    const retry = error.res?.headers.get('Retry-After')
    if (retry) c.header('Retry-After', retry)
    return c.json({ error: error.message || defaultErrorMessage(error.status) }, error.status)
  }
  if (error instanceof ZodError) return c.json({ error: 'Dados inválidos.', issues: error.issues.map(issue => ({ code: issue.code, path: issue.path, ...(issue.code === 'unrecognized_keys' ? { keys: issue.keys } : {}) })) }, 400)
  // Erros de domínio conhecidos do repositório; detalhes do SQL nunca vão ao cliente.
  if ('status' in error && error.status === 404) return c.json({ error: 'Recurso não encontrado.' }, 404)
  if ('status' in error && error.status === 400) return c.json({ error: error.message }, 400)
  if ('status' in error && error.status === 409) return c.json({ error: error.message }, 409)
  console.error('api_error', { name: error.name, path: caminhoMascarado(new URL(c.req.url).pathname), message: String(error.message).slice(0, 240) })
  return c.json({ error: 'Não foi possível concluir a operação.' }, 500)
})

import { recoverInlineRuns } from './flow/inline'
import { logTaskError } from './log-error'

export default {
  fetch: app.fetch,
  async email(message: ForwardableEmailMessage, env: Env) {
    await receiveEmail(message, env)
  },
  async queue(batch: MessageBatch<unknown>, env: Env) {
    const inbound = [] as Message<unknown>[]
    for (const message of batch.messages) {
      const kind = message.body && typeof message.body === 'object' && 'kind' in message.body ? message.body.kind : undefined
      if (kind === 'contact_import') await consumeContactImport(message, env)
      else if (kind === 'broadcast') await consumeBroadcast(message, env)
      // Cloudflare Email Sending events (Event Subscription -> Queue) have a `type`, never a `kind`; they must not reach the inbound schema.
      else if (isEmailSendingEvent(message.body)) await consumeEmailSendingEvent(message, env)
      else inbound.push(message)
    }
    if (inbound.length) await consumeInbound({...batch,messages:inbound},env)
    try { await dispatchRules(env) }
    catch (error) { logTaskError('rule_dispatch_unavailable', error) }
  },
  async scheduled(event: ScheduledController, env: Env) {
    if (event.cron === '* * * * *') {
      try { await dispatchRules(env,Date.now(),undefined,{ dates: true }) }
      catch (error) { logTaskError('rule_dispatch_unavailable', error) }
      try { if (hasFlow(env)) await dispatchSequences(env) } catch (error) { logTaskError('sequences_unavailable', error) }
      try { if (hasFlow(env)) await wakeConnectionWaits(env) } catch (error) { logTaskError('connection_waits_unavailable', error) }
      try { if (hasFlow(env)) await recoverInlineRuns(env) } catch (error) { logTaskError('inline_recovery_unavailable', error) }
      try { await fireDueReminders(env) } catch (error) { logTaskError('inbox_reminders_unavailable', error) }
      try { await sendDueScheduledMessages(env) } catch (error) { logTaskError('inbox_scheduled_unavailable', error) }
      try { await drainMemberAlerts(env) } catch (error) { logTaskError('member_alerts_unavailable', error) }
      try { await emailPendingNotices(env) } catch (error) { logTaskError('notices_unavailable', error) }
      try { await runDueFollowUps(env) } catch (error) { logTaskError('follow_ups_unavailable', error) }
      return
    }
    // Every 5 minutes: providers that never redeliver a webhook are asked for what they saw. The daily jobs run on the other schedule.
    try { await reconcileConnections(env) } catch (error) { logTaskError('reconcile_unavailable', error) }
    if (event.cron === '*/5 * * * *') return
    try { await recoverBroadcastQueue(env) } catch (error) { logTaskError('broadcast_recovery_unavailable', error) }
    try { await cleanupInbound(env) } catch (error) { logTaskError('inbound_cleanup_unavailable', error) }
    try { await hashLegacyHottoks(env.DB) } catch (error) { logTaskError('hotmart_hottok_hash_unavailable', error) }
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare('DELETE FROM invites WHERE expires_at<=?').bind(now),
      env.DB.prepare('DELETE FROM request_limits WHERE reset_at<=?').bind(now),
      env.DB.prepare('DELETE FROM email_outbox WHERE created_at<?').bind(now - 86400_000),
      env.DB.prepare('DELETE FROM login_code_daily WHERE day<?').bind(new Date(now - 30 * 86400_000).toISOString().slice(0, 10)),
      env.DB.prepare('DELETE FROM email_sending_events WHERE received_at<?').bind(now - 30 * 86400_000),
      env.DB.prepare('DELETE FROM hotmart_events WHERE received_at<?').bind(now - 60 * 86400_000),
    ])
  },
}
export { app }
