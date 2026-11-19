import { EmailAdapter } from './email-adapter'
import { cloudflareEmail } from './cloudflare-email'
import type { AdapterEnv } from './core/credentials'
import type { ChannelKind, ProviderAdapter, ProviderId, StoredProvider } from './contract'
import { InstagramAdapter } from './instagram'
import { resolveProvider } from './providers'
import { MessengerAdapter } from './messenger'
import { messengerPage } from './messenger-page'
import { TelegramAdapter } from './telegram'
import { instagramUnified } from './instagram-unified'
import { metaWhatsappCloud } from './meta-whatsapp-cloud'
import { telegramBot } from './telegram-bot'
import type { ChannelAdapter } from './types'
import { WhatsAppAdapter } from './whatsapp'
import { UazapiAdapter } from './uazapi-adapter'
import { uazapi } from './uazapi'
import { ZapiAdapter } from './zapi-adapter'
import { zapi } from './zapi'

export { hasDefaultProvider, providerFor, providerIds, providers, resolveProvider } from './providers'

/** Adapter factories per provider. Today they wrap the existing ChannelAdapter classes;
 * a new provider is one adapter plus one line here (and its entry in providers.ts). */
const adapters: Record<ProviderId, (env: AdapterEnv) => ChannelAdapter> = {
  telegram_bot: (env) => new TelegramAdapter(env),
  meta_whatsapp_cloud: (env) => new WhatsAppAdapter(env),
  uazapi: (env) => new UazapiAdapter(env),
  instagram_unified: (env) => new InstagramAdapter(env, instagramUnified),
  messenger_page: (env) => new MessengerAdapter(env),
  zapi: (env) => new ZapiAdapter(env),
  cloudflare_email: (env) => new EmailAdapter(env),
}

/** Channel/provider pair -> adapter. Unknown pairs throw; 'legacy' or missing provider uses the channel default. */
export function resolveAdapter(kind: ChannelKind, provider: StoredProvider | undefined, env: AdapterEnv): ChannelAdapter {
  return adapters[resolveProvider(kind, provider).id](env)
}

/** Every provider on the contract: webhooks enter only through these (core/hooks.ts, then core/inbound.ts from the queue). */
const contractProviders: Record<ProviderId, ProviderAdapter> = { telegram_bot: telegramBot, meta_whatsapp_cloud: metaWhatsappCloud, uazapi, instagram_unified: instagramUnified, messenger_page: messengerPage, zapi, cloudflare_email: cloudflareEmail }
/** Provider id -> adapter on the contract (no channel kind needed). */
export const providerAdapterById = (id: string): ProviderAdapter | undefined => contractProviders[id as ProviderId]
export function resolveProviderAdapter(kind: ChannelKind, provider: StoredProvider | undefined): ProviderAdapter {
  return contractProviders[resolveProvider(kind, provider).id]
}
