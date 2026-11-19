import { z } from 'zod'
import { makeInstagramGraphProvider } from './instagram-graph'
import { APP_SECRET_MISMATCH, checkAppSecret, checkInstagramPermissions, appWebhookReason, subscribeAppWebhook, subscribePage, takeThreadControl } from './instagram-permissions'

// Instagram API with Unified Login (docs-meta-instagram, overview.md e webhooks/setup.md): o token é de usuário do sistema e fala com graph.facebook.com.
// Sem login pela Meta: a conexão usa só o token e o ID colados.
export const INSTAGRAM_UNIFIED_HOST = 'https://graph.facebook.com'

/** Instagram DMs, comentários e stories pelo login unificado (graph.facebook.com, token de usuário do sistema). */
export const instagramUnified = makeInstagramGraphProvider({
  id: 'instagram_unified',
  host: INSTAGRAM_UNIFIED_HOST,
  async connect(ctx, graph) {
    const account = ctx.credentials.accountId ?? ''
    if (!/^\d{1,128}$/.test(account)) return { kind: 'failed' as const, code: 'invalid_credentials', detail: 'Instagram did not accept the access token for this account' }
    try {
      // /me é o usuário do sistema e /me/assigned_instagram_accounts volta vazio: o ID colado é conferido lendo a própria conta.
      const response = await ctx.fetch(`${graph.base}/${encodeURIComponent(account)}?fields=id,username`,
        { headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` }, signal: AbortSignal.timeout(10_000) })
      if (response.status >= 500 || response.status === 429) return { kind: 'failed' as const, code: 'unreachable', detail: 'Instagram is unavailable' }
      const body = await response.json().catch(() => null)
      const profile = z.object({ id: z.string(), username: z.string().optional() }).safeParse(body)
      // `id` precisa ser o ID colado: é o mesmo que chega em entry.id nos webhooks.
      if (!response.ok || !profile.success || profile.data.id !== account) {
        return { kind: 'failed' as const, code: 'invalid_credentials', detail: 'Instagram did not accept the access token for this account' }
      }
      // Chave errada passaria aqui e só apareceria como webhook recusado: a conexão nem é salva.
      if (await checkAppSecret(ctx, graph.base) === 'mismatch') return { kind: 'failed' as const, code: 'invalid_credentials', detail: 'App secret does not belong to the token app', message: APP_SECRET_MISMATCH }
      const webhookSubscribed = await graph.subscribeAccount(account)
      // A Página ligada também precisa do app inscrito, senão a DM não chega. Falha aqui não derruba a conexão: a conferência mostra o passo.
      await subscribePage(ctx, graph.base)
      // O webhook do app NÃO é assinado aqui: na criação a conexão ainda não está gravada e a Meta recusaria o callback (GET de verificação).
      // Ele é assinado em registerWebhook (depois de gravar) e na conferência (Atualizar conexão).
      return { kind: 'done' as const, externalId: account, webhookSubscribed, ...(profile.data.username ? { displayName: `@${profile.data.username}` } : {}) }
    } catch { return { kind: 'failed' as const, code: 'unreachable', detail: 'Instagram could not be reached' } }
  },
  checkPermissions: checkInstagramPermissions,
  takeThreadControl,
  async subscribeAppWebhook(ctx, base) {
    const result = await subscribeAppWebhook(ctx, base)
    return result.status === 'ok' ? { ok: true as const } : { ok: false as const, reason: appWebhookReason(result) }
  },
  // Normalmente o ManyCraft assina o webhook sozinho ao conectar; estes passos só aparecem quando a assinatura automática falha.
  webhookChecklist: ['O ManyCraft tentou assinar o webhook sozinho e não conseguiu (o motivo está acima). Resolva o motivo e clique em Atualizar conexão, ou faça à mão:',
    'No painel de desenvolvedores da Meta, abra o app e vá em Casos de uso > Instagram > "API setup with Unified login" > "3. Configurar webhooks".',
    'Cole a URL de retorno e o token de verificação acima e confirme.', 'Assine os campos "messages", "messaging_postbacks", "messaging_seen", "messaging_referral", "comments", "live_comments" e "standby".',
    'No card "2. Gerar tokens de acesso", ligue "Assinatura do webhook" na conta do Instagram.'],
})
