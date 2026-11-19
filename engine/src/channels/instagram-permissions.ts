import type { ConnectContext, ConnectStep, PermissionItem, ProviderCtx } from './contract'

/** Conferência da conexão do Instagram pelo login unificado (token de usuário do sistema colado, graph.facebook.com).
 * A conferência é por prova, com leituras documentadas que exigem cada permissão (docs-meta-instagram: conversations-api.md pede instagram_manage_messages;
 * comentários pedem instagram_manage_comments), e a lista de /me/permissions marca a que a Meta diz recusada.
 * Código 190 é token inválido ou vencido; 10 e 200-299 são permissão não concedida (instagram-graph-api/reference/error-codes.md, tabela de erros). */
type Probe = 'ok' | 'denied' | 'expired' | 'unknown'

const FIX_TOKEN = 'Gere um token novo no painel da Meta (API setup with Unified login > Gerar tokens de acesso) e cole em Trocar credencial.'
const fixPermission = (permission: string, what: string) =>
  `No painel da Meta, abra seu app, vá em Login do Facebook para Empresas > configuração, adicione a permissão ${permission} (${what}), gere um token novo e cole em Trocar credencial.`

async function probe(ctx: ConnectContext, url: string): Promise<{ result: Probe; body?: Record<string, unknown> }> {
  try {
    const response = await ctx.fetch(url, { headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` }, signal: AbortSignal.timeout(10_000) })
    const body = await response.json().catch(() => null) as Record<string, unknown> | null
    if (response.ok) return { result: 'ok', ...(body ? { body } : {}) }
    const code = (body?.error as { code?: unknown } | undefined)?.code
    if (code === 190 || response.status === 401) return { result: 'expired' }
    if (code === 10 || typeof code === 'number' && code >= 200 && code <= 299) return { result: 'denied' }
    return { result: 'unknown' }
  } catch { return { result: 'unknown' } }
}

/** Prova de que a chave secreta é do app que gerou o token, sem a chave sair daqui: appsecret_proof = HMAC-SHA256(token) com a chave
 * (graph-api/guides/secure-requests). A Meta recusa a chamada com erro 100 citando appsecret_proof quando a chave não é desse app.
 * É a mesma chave que confere a assinatura dos webhooks: chave errada aqui é webhook recusado depois. */
export async function appSecretProof(token: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(token)))
  return [...signature].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function checkAppSecret(ctx: ConnectContext, base: string): Promise<'ok' | 'mismatch' | 'unknown'> {
  const { accessToken, appSecret, accountId } = ctx.credentials
  if (!accessToken || !appSecret) return 'unknown'
  try {
    const url = new URL(`${base}/${encodeURIComponent(accountId ?? 'me')}`)
    url.searchParams.set('fields', 'id,username')
    url.searchParams.set('appsecret_proof', await appSecretProof(accessToken, appSecret))
    const response = await ctx.fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) })
    if (response.ok) return 'ok'
    const error = ((await response.json().catch(() => null)) as { error?: { code?: unknown; message?: unknown } } | null)?.error
    return error?.code === 100 && /appsecret_proof/i.test(String(error.message ?? '')) ? 'mismatch' : 'unknown'
  } catch { return 'unknown' }
}

export const APP_SECRET_MISMATCH = 'A chave secreta não é do app que gerou este token. No painel da Meta, abra o app do token, vá em Configurações do app > Básico, clique em Mostrar na Chave secreta e cole de novo.'

/** Página do Facebook ligada ao Instagram. No login unificado a Meta só entrega DM se a Página tiver o app em /{page-id}/subscribed_apps;
 * inscrever só o Instagram não basta. A Página e o token dela saem de /me/accounts (o token da Página é usado na hora e nunca guardado). */
export type PageResult = { status: 'ok'; pageId: string; pageName?: string } | { status: 'no_permission'; missing: string[] } | { status: 'not_linked' } | { status: 'refused'; pageName?: string } | { status: 'unknown' }
export const PAGE_PERMISSIONS = ['pages_show_list', 'pages_manage_metadata', 'pages_messaging']
export const PAGE_FIELDS = ['messages', 'messaging_postbacks', 'message_reads', 'messaging_referrals', 'message_reactions']
// connect e conferência rodam com o mesmo contexto no "Atualizar conexão": a inscrição da Página acontece uma vez só.
const pageResults = new WeakMap<ConnectContext, PageResult>()

async function readPermissions(ctx: ConnectContext, base: string): Promise<{ permission?: unknown; status?: unknown }[] | undefined> {
  const listed = await probe(ctx, `${base}/me/permissions`)
  return Array.isArray(listed.body?.data) ? listed.body.data as { permission?: unknown; status?: unknown }[] : undefined
}

export async function subscribePage(ctx: ConnectContext, base: string): Promise<PageResult> {
  const result = await findAndSubscribePage(ctx, base)
  pageResults.set(ctx, result)
  return result
}

async function findAndSubscribePage(ctx: ConnectContext, base: string): Promise<PageResult> {
  const account = ctx.credentials.accountId ?? ''
  const pages = await probe(ctx, `${base}/me/accounts?fields=id,name,access_token,instagram_business_account&limit=100`)
  const list = Array.isArray(pages.body?.data) ? pages.body.data as { id?: unknown; name?: unknown; access_token?: unknown; instagram_business_account?: { id?: unknown } }[] : undefined
  const page = list?.find(p => p.instagram_business_account?.id === account && typeof p.id === 'string')
  if (page) {
    const pageName = typeof page.name === 'string' ? page.name.slice(0, 120) : undefined
    if (typeof page.access_token === 'string') try {
      const url = new URL(`${base}/${encodeURIComponent(page.id as string)}/subscribed_apps`)
      url.searchParams.set('subscribed_fields', PAGE_FIELDS.join(','))
      const response = await ctx.fetch(url.toString(), { method: 'POST', headers: { Authorization: `Bearer ${page.access_token}` }, signal: AbortSignal.timeout(10_000) })
      const body = await response.json().catch(() => null) as { success?: unknown } | null
      if (response.ok && body?.success === true) return { status: 'ok', pageId: page.id as string, ...(pageName ? { pageName } : {}) }
    } catch { return { status: 'unknown' } }
    const missing = await missingPagePermissions(ctx, base)
    return missing?.length ? { status: 'no_permission', missing } : { status: 'refused', ...(pageName ? { pageName } : {}) }
  }
  // Sem a Página na lista: ou o token não tem permissão de Página, ou a Página não está ligada a este Instagram.
  if (pages.result === 'expired' || (pages.result === 'unknown' && !list)) return { status: 'unknown' }
  const missing = await missingPagePermissions(ctx, base)
  if (missing === undefined) return list ? { status: 'not_linked' } : { status: 'unknown' }
  return missing.length ? { status: 'no_permission', missing } : { status: 'not_linked' }
}

async function missingPagePermissions(ctx: ConnectContext, base: string): Promise<string[] | undefined> {
  const granted = await readPermissions(ctx, base)
  if (!granted?.length) return undefined
  return PAGE_PERMISSIONS.filter(permission => !granted.some(p => p.permission === permission && p.status === 'granted'))
}

const FIX_PAGE_PERMISSION = 'No painel da Meta, abra seu app e adicione o caso de uso "Messenger" (interagir com clientes no Messenger). Depois, em Login do Facebook para Empresas, abra a SEGUNDA tela chamada "Configurações" (abaixo de "Início rápido"), edite a configuração e marque pages_show_list, pages_manage_metadata e pages_messaging junto com as do Instagram. Gere um token novo marcando a conta do Instagram E a Página do Facebook e cole em Trocar credencial.'
function pageItem(result: PageResult): PermissionItem {
  const label = 'Página do Facebook'
  switch (result.status) {
    case 'ok': return { key: 'page', label, status: 'ok' }
    case 'no_permission': return { key: 'page', label, status: 'missing', fix: `O token não tem permissão para a Página do Facebook (falta ${result.missing.join(', ')}). Sem isso as mensagens do Instagram não chegam. ${FIX_PAGE_PERMISSION}` }
    case 'not_linked': return { key: 'page', label, status: 'missing', fix: 'O token não mostra nenhuma Página do Facebook ligada a esta conta do Instagram, e sem ela as mensagens não chegam. Confira se o Instagram está ligado à Página (no Instagram: Configurações > Central de contas, ou na Página: Configurações > Contas vinculadas) e gere um token novo marcando a conta do Instagram E a Página. Depois cole em Trocar credencial.' }
    case 'refused': return { key: 'page', label, status: 'missing', fix: `A Meta não deixou inscrever o app na Página${result.pageName ? ` "${result.pageName}"` : ''}. ${FIX_PAGE_PERMISSION}` }
    default: return { key: 'page', label, status: 'unknown', fix: 'Não foi possível conferir a Página do Facebook agora. Tente atualizar de novo em alguns minutos.' }
  }
}

/** Webhook do app (tópico instagram), assinado pelo próprio ManyCraft com o token do app `{app-id}|{app-secret}` (graph-api/webhooks: /{app-id}/subscriptions).
 * O app id sai de GET /app com o token do usuário do sistema. Antes de assinar, lê as assinaturas: se o tópico instagram aponta para outro callback
 * (outro sistema), não troca. Chave e token do app nunca vão para log. */
export type AppWebhookResult = { status: 'ok' } | { status: 'other_callback'; host: string } | { status: 'no_secret' } | { status: 'refused'; code?: number } | { status: 'unknown' }
export const APP_WEBHOOK_FIELDS = ['messages', 'messaging_postbacks', 'messaging_seen', 'messaging_referral', 'message_reactions', 'message_edit', 'comments', 'live_comments', 'mentions', 'standby']
const appWebhookResults = new WeakMap<ConnectContext, AppWebhookResult>()

export async function subscribeAppWebhook(ctx: ConnectContext, base: string): Promise<AppWebhookResult> {
  const result = await subscribeAppWebhookOnce(ctx, base).catch((): AppWebhookResult => ({ status: 'unknown' }))
  appWebhookResults.set(ctx, result)
  return result
}

async function subscribeAppWebhookOnce(ctx: ConnectContext, base: string): Promise<AppWebhookResult> {
  const { accessToken, appSecret } = ctx.credentials
  if (!accessToken || !appSecret) return { status: 'no_secret' }
  if (!ctx.hookUrl || !ctx.webhookSecret) return { status: 'unknown' }
  const app = await probe(ctx, `${base}/app?fields=id`)
  const appId = typeof app.body?.id === 'string' && /^\d{1,64}$/.test(app.body.id) ? app.body.id : undefined
  if (!appId) return { status: 'unknown' }
  const auth = { Authorization: `Bearer ${appId}|${appSecret}` }
  const listed = await ctx.fetch(`${base}/${appId}/subscriptions`, { headers: auth, signal: AbortSignal.timeout(10_000) })
  const listBody = await listed.json().catch(() => null) as { data?: { object?: unknown; callback_url?: unknown }[]; error?: { code?: unknown } } | null
  if (!listed.ok) return { status: 'refused', ...(typeof listBody?.error?.code === 'number' ? { code: listBody.error.code } : {}) }
  const current = listBody?.data?.find(item => item.object === 'instagram')
  if (current && typeof current.callback_url === 'string' && current.callback_url !== ctx.hookUrl) {
    let host = 'outro endereço'
    try { host = new URL(current.callback_url).host } catch { /* fica o texto genérico */ }
    return { status: 'other_callback', host }
  }
  const form = new URLSearchParams({ object: 'instagram', callback_url: ctx.hookUrl, verify_token: ctx.webhookSecret, fields: APP_WEBHOOK_FIELDS.join(','), include_values: 'true' })
  const response = await ctx.fetch(`${base}/${appId}/subscriptions`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(), signal: AbortSignal.timeout(15_000) })
  const body = await response.json().catch(() => null) as { success?: unknown; error?: { code?: unknown } } | null
  if (response.ok && body?.success === true) return { status: 'ok' }
  return { status: 'refused', ...(typeof body?.error?.code === 'number' ? { code: body.error.code } : {}) }
}

/** Por que a assinatura automática do webhook do app não aconteceu, em pt-BR para o modal do passo manual. */
export function appWebhookReason(result: AppWebhookResult): string {
  switch (result.status) {
    case 'ok': return ''
    case 'other_callback': return `o webhook do Instagram deste app já aponta para ${result.host}, de outro sistema, e o ManyCraft não troca sozinho.`
    case 'no_secret': return 'sem a chave secreta do app o ManyCraft não consegue assinar o webhook sozinho.'
    case 'refused': return `a Meta não aceitou assinar o webhook do app${result.code !== undefined ? ` (código ${result.code})` : ''}.`
    default: return 'não foi possível falar com a Meta para assinar o webhook agora.'
  }
}

function webhookItem(app: AppWebhookResult | undefined, step: ConnectStep): PermissionItem {
  const label = 'Webhook'
  if (app?.status === 'ok') return { key: 'webhook', label, status: 'ok' }
  if (app?.status === 'other_callback') return { key: 'webhook', label, status: 'missing', fix: `O webhook do Instagram deste app já aponta para ${app.host}, de outro sistema, e o ManyCraft não troca sozinho. Se quiser que as mensagens venham para cá, no painel da Meta vá em Webhooks > Instagram e troque a URL de retorno e o token de verificação pelos mostrados nesta tela. Depois clique em Atualizar conexão.` }
  if (app?.status === 'no_secret') return step.kind === 'done' && step.webhookSubscribed === true ? { key: 'webhook', label, status: 'ok' }
    : { key: 'webhook', label, status: 'unknown', fix: 'Sem a chave secreta do app o ManyCraft não consegue assinar o webhook sozinho. Cole a chave em Trocar credencial ou confira no painel da Meta, em Webhooks, a URL de retorno e os campos.' }
  if (app?.status === 'refused') return { key: 'webhook', label, status: 'missing', fix: `A Meta não aceitou assinar o webhook do app${app.code !== undefined ? ` (código ${app.code})` : ''}. No painel da Meta, em Webhooks > Instagram, cole a URL de retorno e o token de verificação desta tela e assine os campos ${APP_WEBHOOK_FIELDS.join(', ')}. Depois clique em Atualizar conexão.` }
  return { key: 'webhook', label, status: 'unknown', fix: 'Não foi possível assinar o webhook do app agora. Tente atualizar de novo; se continuar, confira no painel da Meta, em Webhooks, a URL de retorno e os campos.' }
}

/** Assume a conversa que está com outro app (conversation-routing/apis.md, "Take thread control": POST /PAGE-ID/take_thread_control com recipient = IGSID,
 * token da Página). O token da Página sai de /me/accounts na hora e não é guardado. Nunca lança; não loga tokens. */
export async function takeThreadControl(ctx: ProviderCtx, userId: string, base: string): Promise<{ ok: boolean; code?: number | string }> {
  try {
    const account = ctx.credentials.accountId ?? ''
    const pages = await ctx.fetch(`${base}/me/accounts?fields=id,access_token,instagram_business_account&limit=100`, { headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` }, signal: AbortSignal.timeout(10_000) })
    const list = (await pages.json().catch(() => null) as { data?: { id?: unknown; access_token?: unknown; instagram_business_account?: { id?: unknown } }[] } | null)?.data
    const page = Array.isArray(list) ? list.find(p => p.instagram_business_account?.id === account && typeof p.id === 'string' && typeof p.access_token === 'string') : undefined
    if (!page) return { ok: false, code: pages.ok ? 'no_page' : pages.status }
    const response = await ctx.fetch(`${base}/${encodeURIComponent(page.id as string)}/take_thread_control`, { method: 'POST',
      headers: { Authorization: `Bearer ${page.access_token as string}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: userId }, metadata: 'manycraft_standby' }), signal: AbortSignal.timeout(10_000) })
    const body = await response.json().catch(() => null) as { success?: unknown; error?: { code?: unknown } } | null
    if (response.ok && body?.success === true) return { ok: true }
    return { ok: false, code: typeof body?.error?.code === 'number' ? body.error.code : response.status }
  } catch { return { ok: false, code: 'network' } }
}

/** Não há leitura documentada do app padrão do encaminhamento de conversas (conversation-routing.md só descreve a tela da Página e a troca de dono por conversa). */
const routingItem: PermissionItem = { key: 'routing', label: 'Encaminhamento de conversas', status: 'unknown',
  fix: 'Não dá para conferir daqui. Se outro app (como o Manychat) já atendeu este Instagram, entre logado na Página em https://www.facebook.com/settings/?tab=ig_conversation_routing e remova o app antigo. Depois, no Meta Business Suite, vá em Configurações > Integrações > Encaminhamento da conversa, escolha esta conta e coloque o ManyCraft como app padrão. Conversas antigas continuam com o app que era dono; teste com um perfil que nunca conversou com a conta.' }

// A Meta só libera curtir comentário (POST /<conta>/likes) no login com Facebook. Não há o que consertar.
const likesItem: PermissionItem = { key: 'likes', label: 'Curtidas em comentários', status: 'unavailable', fix: 'Curtir comentário não está disponível nesta conexão.' }

export async function checkInstagramPermissions(ctx: ConnectContext, step: ConnectStep, base: string): Promise<PermissionItem[]> {
  const account = encodeURIComponent(ctx.credentials.accountId ?? '')
  // /me é o usuário do sistema: o token se prova lendo a conta colada.
  const token = await probe(ctx, `${base}/${account}?fields=id,username`)
  const notChecked = (key: string, label: string): PermissionItem => ({ key, label, status: 'unknown', fix: 'Não conferido porque o token não foi aceito.' })
  const tokenItem: PermissionItem = token.result === 'ok' ? { key: 'token', label: 'Token de acesso', status: 'ok' }
    : token.result === 'expired' ? { key: 'token', label: 'Token de acesso', status: 'missing', fix: `O token venceu ou foi revogado. ${FIX_TOKEN}` }
    : token.result === 'denied' ? { key: 'token', label: 'Token de acesso', status: 'unknown', fix: 'A Meta negou o acesso a esta conta com este token. Confira se a conta está atribuída ao usuário do sistema e se o token tem as permissões do app; se precisar, gere um token novo e cole em Trocar credencial.' }
    : { key: 'token', label: 'Token de acesso', status: 'unknown', fix: 'A Meta não respondeu agora. Tente atualizar de novo em alguns minutos.' }
  const hasSecret = Boolean(ctx.credentials.appSecret)
  if (token.result !== 'ok') return [tokenItem, ...(hasSecret ? [notChecked('secret', 'Chave secreta do app')] : []), notChecked('messages', 'Mensagens'), notChecked('comments', 'Comentários'), likesItem, notChecked('webhook', 'Webhook'), notChecked('page', 'Página do Facebook'), routingItem]
  const secret = hasSecret ? await checkAppSecret(ctx, base) : undefined
  const secretItems: PermissionItem[] = secret === undefined ? [] : [secret === 'ok' ? { key: 'secret', label: 'Chave secreta do app', status: 'ok' }
    : secret === 'mismatch' ? { key: 'secret', label: 'Chave secreta do app', status: 'missing', fix: APP_SECRET_MISMATCH }
    : { key: 'secret', label: 'Chave secreta do app', status: 'unknown', fix: 'Não foi possível conferir a chave agora. Tente atualizar de novo.' }]

  const messages = await probe(ctx, `${base}/${account}/conversations?platform=instagram&limit=1`)
  const listed = await probe(ctx, `${base}/me/permissions`)
  // Recusada ou ausente na lista (lista lida e não vazia); lista fora do ar ou vazia não diz nada.
  const granted = Array.isArray(listed?.body?.data) ? listed.body.data as { permission?: unknown; status?: unknown }[] : undefined
  const declined = (permission: string) => Boolean(granted?.length) && !granted!.some(p => p.permission === permission && p.status === 'granted')
  // A prova por leitura prevalece: a lista só marca "falta" quando a leitura não deu ok (ou nem existe leitura para o item).
  const messagesItem: PermissionItem = messages.result === 'ok' ? { key: 'messages', label: 'Mensagens', status: 'ok' }
    : messages.result === 'denied' || (messages.result === 'unknown' && declined('instagram_manage_messages')) ? { key: 'messages', label: 'Mensagens', status: 'missing', fix: fixPermission('instagram_manage_messages', 'gerenciar mensagens') }
    : { key: 'messages', label: 'Mensagens', status: 'unknown', fix: 'Não foi possível conferir agora. Tente atualizar de novo.' }

  // Comentários só se leem em uma publicação: pega a mais recente da conta.
  const media = await probe(ctx, `${base}/${account}/media?fields=id&limit=1`)
  const mediaId = Array.isArray(media.body?.data) ? (media.body.data[0] as { id?: unknown } | undefined)?.id : undefined
  const comments = typeof mediaId === 'string' ? await probe(ctx, `${base}/${encodeURIComponent(mediaId)}/comments?limit=1`) : undefined
  const commentsState: PermissionItem['status'] = comments?.result === 'ok' ? 'ok' : comments?.result === 'denied' || ((!comments || comments.result === 'unknown') && declined('instagram_manage_comments')) ? 'missing' : 'unknown'
  const commentsFix = commentsState === 'missing' ? fixPermission('instagram_manage_comments', 'gerenciar comentários')
    : commentsState === 'unknown' ? (comments ? 'Não foi possível conferir agora. Tente atualizar de novo.' : 'A conta ainda não tem publicações para a conferência. Publique algo e atualize de novo.') : undefined
  const withFix = (key: string, label: string): PermissionItem => ({ key, label, status: commentsState, ...(commentsFix ? { fix: commentsFix } : {}) })

  const webhook = webhookItem(appWebhookResults.get(ctx) ?? await subscribeAppWebhook(ctx, base), step)
  const page = pageItem(pageResults.get(ctx) ?? await subscribePage(ctx, base))
  return [tokenItem, ...secretItems, messagesItem, withFix('comments', 'Comentários'), likesItem, webhook, page, routingItem]
}
