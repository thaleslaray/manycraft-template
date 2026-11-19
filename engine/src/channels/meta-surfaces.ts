import { z } from 'zod'
import type { ConversationSurface, ProviderCtx } from './contract'

/** Product limits for the flat postback menus supported by these transports. A connection may narrow or disable either block. */
export const metaSurfaceProfile = {
  conversationStarters: { maxItems: 4, titleMax: 80 },
  mainMenu: { maxItems: 20, titleMax: 30 },
}
const surfaceSchema = z.object({
  kind: z.enum(['conversation_starters', 'main_menu']), enabled: z.boolean(),
  items: z.array(z.object({ title: z.string(), payload: z.string() })).max(20),
})

/** Messenger Profile API. Only the adapter supplies its account and Graph base; the product never branches on a channel name. */
export async function configureMetaSurface(ctx: ProviderCtx, configuration: ConversationSurface, graphBase: string, accountId: string,
  options: { platform?: 'instagram' } = {}): Promise<void> {
  const parsed = surfaceSchema.safeParse(configuration)
  if (!parsed.success) throw new Error('Configuração inválida para esta conexão.')
  const surface = parsed.data
  const limits = surface.kind === 'conversation_starters' ? ctx.connection.profile.conversationStarters : ctx.connection.profile.mainMenu
  if (!limits) throw new Error('Recurso indisponível nesta conexão.')
  const ceiling = surface.kind === 'conversation_starters' ? metaSurfaceProfile.conversationStarters : metaSurfaceProfile.mainMenu
  if (!/^\d{1,128}$/.test(accountId) || !ctx.credentials.accessToken || surface.enabled && (
    surface.items.length < 1 || surface.items.length > Math.min(limits.maxItems, ceiling.maxItems) || surface.items.some(item =>
      !item.title.trim() || [...item.title].length > Math.min(limits.titleMax, ceiling.titleMax) || !item.payload || new TextEncoder().encode(item.payload).length > 1000)
  )) throw new Error('Configuração inválida para esta conexão.')

  const field = surface.kind === 'conversation_starters' ? 'ice_breakers' : 'persistent_menu'
  // Instagram: ice_breakers é [{ call_to_actions: [{ question, payload }], locale? }] (docs-meta-instagram, messaging-api/ice-breakers.md, 'Create Ice Breakers').
  // Messenger (congelado) continua com a lista plana de antes.
  const value = surface.kind === 'conversation_starters'
    ? options.platform ? [{ call_to_actions: surface.items.map(item => ({ question: item.title, payload: item.payload })) }] : surface.items.map(item => ({ question: item.title, payload: item.payload }))
    : [{ locale: 'default', ...(options.platform ? {} : { composer_input_disabled: ctx.connection.settings.composerDisabled === true }),
      call_to_actions: surface.items.map(item => ({ type: 'postback', title: item.title, payload: item.payload })) }]
  try {
    const response = await ctx.fetch(`${graphBase}/${accountId}/messenger_profile`, {
      method: surface.enabled ? 'POST' : 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.credentials.accessToken}` },
      // Official fbsamples/postman/instagram-platform-api collection: platform is sent on POST; composer control is unavailable on Instagram.
      body: JSON.stringify(surface.enabled ? { ...(options.platform ? { platform: options.platform } : {}), [field]: value } : { fields: [field] }),
      signal: AbortSignal.timeout(20_000),
    })
    const result: unknown = await response.json()
    if (!response.ok || typeof result !== 'object' || result === null || 'error' in result ||
      !('result' in result && result.result === 'success' || 'success' in result && result.success === true)) throw new Error('provider_failure')
  } catch {
    // A Graph error body or a fetch exception can contain URLs, tokens and account data; none escapes this boundary.
    throw new Error('Não foi possível publicar a configuração no provedor.')
  }
}

/** Menu por usuário (custom_user_settings): no máximo 20 itens de postback; null apaga e volta ao menu da página. */
export async function configureMetaUserMenu(ctx: ProviderCtx, graphBase: string, externalUserId: string, items: { title: string; payload: string }[] | null): Promise<void> {
  if (!ctx.credentials.accessToken || !/^\d{1,64}$/.test(externalUserId)) throw new Error('Configuração inválida para esta conexão.')
  const limits = ctx.connection.profile.mainMenu
  if (!limits) throw new Error('Recurso indisponível nesta conexão.')
  if (items && (items.length < 1 || items.length > Math.min(limits.maxItems, 20) || items.some(i => !i.title.trim() || [...i.title].length > limits.titleMax))) throw new Error('Menu inválido.')
  const url = new URL(`${graphBase}/me/custom_user_settings`)
  if (!items) { url.searchParams.set('psid', externalUserId); url.searchParams.set('params', '["persistent_menu"]') }
  try {
    const r = await ctx.fetch(url, { method: items ? 'POST' : 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.credentials.accessToken}` },
      ...(items ? { body: JSON.stringify({ psid: externalUserId, persistent_menu: [{ locale: 'default', call_to_actions: items.map(i => ({ type: 'postback', title: i.title, payload: i.payload })) }] }) } : {}),
      signal: AbortSignal.timeout(20_000) })
    if (!r.ok) throw new Error('provider_failure')
  } catch { throw new Error('Não foi possível trocar o menu no provedor.') }
}
