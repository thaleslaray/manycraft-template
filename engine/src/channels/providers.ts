import { unavailableMedia } from '../schemas/message-media'
import { cloudflareEmailMeta } from './cloudflare-email-meta'
import { zapiMeta } from './zapi-meta'
import { metaSurfaceProfile } from './meta-surfaces'
import type { ChannelKind, ChannelProfile, ProfilePatch, ProviderId, StoredProvider } from './contract'

/** Provider metadata only (no adapter imports, so profile merging stays light and cycle-free). */
export interface ProviderMeta {
  id: ProviderId; kinds: readonly ChannelKind[]; patch: ProfilePatch
  api: { base: string; docs: string }            // host the adapter calls (a test reads the adapter source and compares) and the docs-* skill that documents it
  label: string                                  // channel name in user-facing messages
  live: boolean                                  // has a working transport; false = declared only
  frozen?: boolean                               // kept working for existing connections, but no longer offered to connect (owner decision)
  contacts: 'managed' | 'generic'                // managed: the adapter syncs contacts and requires recorded opt-in
  broadcast: boolean                             // can be the sending connection of a broadcast
  metaObject?: string                            // the `object` Meta puts on this provider's deliveries to a shared app webhook
  profile?: Partial<ChannelProfile['profile']>   // what fetchProfile can fill (avatar: the panel proxies it)
  connect?: ConnectSpec                          // how the panel connects it; absent = not connectable yet
  options?: OptionField[]                        // per-connection settings the provider adds (the panel renders them; the channel never shows them)
}

/** A non secret setting of a connection, off or empty by default. Stored in channels.settings under `key`. */
export type OptionField = { key: string; label: string; type: 'boolean' | 'text'; help?: string; max?: number; dependsOn?: string }

export type CredentialField = { key: string; label: string; secret: boolean; optional?: boolean; help?: string; pattern?: string }
/** What the connect form asks and how the webhook gets registered. The panel renders this; it never names a channel. */
export interface ConnectSpec {
  fields: CredentialField[]
  accountIdField?: string                        // a credential naming the provider account above the connection (events about the account reach every connection that holds it)
  externalIdField?: string                       // the field that names the account when the provider cannot look it up
  webhook: 'auto' | 'manual'                     // auto: registered through the provider API; manual: guided step
  hook: 'connection' | 'shared'                  // connection: /api/hooks/:id; shared: the app-wide route (Meta, until its slice moves)
  verifyTokenField?: string                      // generated when left blank; shown in the guided step
  /** A manual provider that tries to register the webhook itself first (registersSharedWebhook): `form` is said under the connect form,
   * `done` after the provider accepted it. The guided step stays the fallback. */
  autoWebhook?: { form: string; done: string }
  notice?: string
  pairing?: 'qr'                                 // the connection is paired after saving, by reading a QR code (the panel opens that step)
}

/** Card and gallery on the Cloud API: 2 to 10 cards go as an interactive carousel, a single card as a media message with buttons (rules in schemas/message-cards.ts). */
const whatsappCards = { maxCards: 10, titleMax: 1024, subtitleMax: 1024, maxButtons: 3, adaptation: 'interactive_carousel' as const }

export const providers: Record<ProviderId, ProviderMeta> = {
  telegram_bot: { id: 'telegram_bot', api: { base: 'https://api.telegram.org', docs: 'docs-telegram-bot' }, kinds: ['telegram'], patch: {}, label: 'Telegram', live: true, contacts: 'generic', broadcast: true, profile: { avatar: 'bytes' },
    connect: { webhook: 'auto', hook: 'connection', fields: [{ key: 'botToken', label: 'Token do bot', secret: true, pattern: '^\\d+:[A-Za-z0-9_-]+$', help: 'Criado no @BotFather.' }] } },
  meta_whatsapp_cloud: { id: 'meta_whatsapp_cloud', api: { base: 'https://graph.facebook.com', docs: 'docs-meta-whatsapp' }, kinds: ['whatsapp'], patch: { cards: whatsappCards, inbound: { media: true } }, label: 'WhatsApp', live: true, contacts: 'managed', broadcast: true, metaObject: 'whatsapp_business_account',
    connect: { webhook: 'manual', hook: 'shared', accountIdField: 'wabaId', externalIdField: 'phoneNumberId', verifyTokenField: 'verifyToken',
      // O webhook vai só para o número (endereço alternativo da Meta), nunca para o app, que pode ser dividido com outro sistema.
      autoWebhook: { form: 'Depois de salvar, configuramos o webhook só neste número pela API da Meta, sem mexer na URL do app. Se a Meta recusar, mostramos a URL e o token para colar no app.',
        done: 'Webhook configurado no número pela API da Meta, sem mexer na URL do app. Os avisos da conta (qualidade, limites, alertas e status dos modelos) só chegam com esses campos assinados no app da Meta.' },
      fields: [
      { key: 'accessToken', label: 'Token de acesso', secret: true },
      { key: 'phoneNumberId', label: 'ID do número de telefone', secret: false, pattern: '^\\d+$' },
      { key: 'wabaId', label: 'ID da conta do WhatsApp Business (WABA)', secret: false, optional: true, pattern: '^\\d+$', help: 'No painel da Meta: WhatsApp > Configuração da API, abaixo do ID do número de telefone. Sem ele não há modelos de mensagem (criar, sincronizar e enviar). Em branco, tentamos achar pelo token.' },
      { key: 'appSecret', label: 'Chave secreta do app', secret: true },
      { key: 'verifyToken', label: 'Token de verificação', secret: true, optional: true, help: 'Em branco: geramos um.' }] } },  // the whatsapp profile already is the Cloud API's
  // Docs: https://docs.uazapi.com (authentication: instance `token` header; the server URL is the customer's own subdomain).
  uazapi: { id: 'uazapi', api: { base: 'https://<subdominio>.uazapi.com', docs: 'docs-uazapi' }, kinds: ['whatsapp'], label: 'WhatsApp não oficial (UAZAPI)', live: true, contacts: 'managed', broadcast: false,
    patch: {
      media: unavailableMedia,
      remove: ['window', 'templates', 'list'],                      // no 24h window, no approved templates
      initiator: 'business_with_optin', identity: { key: 'phone_e164', phoneGuaranteed: false, address: 'jid' },
      groups: { inbound: true, reply: true, mentionDetect: true },  // task 07; the mention format is NOT yet verified against a real payload (see mentionsAccount in uazapi.ts)
      unstable: ['buttons', 'list', 'cards'],                        // docs: mixing reply buttons with url/call "does not show on WhatsApp Web"
      risk: { banOnColdOutreach: true },
    },
    connect: { webhook: 'auto', hook: 'connection', pairing: 'qr', fields: [
      { key: 'serverUrl', label: 'Endereço do servidor', secret: false, pattern: '^https://[^\\s/]+/?$', help: 'O endereço da sua UAZAPI, como https://suaempresa.uazapi.com.' },
      { key: 'token', label: 'Token da instância', secret: true, help: 'Token da instância ou token de administrador do servidor (com o de administrador, a conexão encontra a instância sozinha e guarda o token para gerenciar a Uazapi pelo painel).' },
      { key: 'instanceName', label: 'Instância (se a conta tiver mais de uma)', secret: false, optional: true, help: 'Só vale com o token de administrador: o nome da instância que vai receber e responder mensagens.' }],
      notice: 'Esta conexão não é oficial. O WhatsApp pode bloquear o número, principalmente se você mandar mensagem para quem não escreveu primeiro ou enviar em volume. Prefira um número que já responde clientes e não use um número que você não pode perder.' },
    options: [
      { key: 'typing', type: 'boolean', label: 'Mostrar "digitando…" antes de enviar', help: 'Cada resposta espera um instante e o contato vê o indicador de digitação.' },
      { key: 'markRead', type: 'boolean', label: 'Marcar como lida ao receber' },
      { key: 'rejectCalls', type: 'boolean', label: 'Recusar ligações' },
      { key: 'rejectCallMessage', type: 'text', max: 500, dependsOn: 'rejectCalls', label: 'Mensagem ao recusar a ligação', help: 'Em branco: a ligação é recusada sem mensagem.' },
      { key: 'unopenedMessageText', type: 'text', max: 500, label: 'Texto para mensagem que não pôde ser aberta', help: 'Enviado quando chega uma mensagem que o WhatsApp não conseguiu abrir. Em branco: não responde.' },
    ] },
  // Login unificado: token de usuário do sistema em graph.facebook.com. É o único provedor do Instagram.
  instagram_unified: { id: 'instagram_unified', api: { base: 'https://graph.facebook.com', docs: 'docs-meta-instagram' }, kinds: ['instagram'], patch: { ...metaSurfaceProfile, cards: { adaptation: 'generic_template' }, comments: { like: false } }, label: 'Instagram', live: true, contacts: 'managed', broadcast: true, metaObject: 'instagram', profile: { avatar: 'url' },
    connect: { webhook: 'manual', hook: 'shared', externalIdField: 'accountId', verifyTokenField: 'verifyToken', fields: [
      { key: 'accessToken', label: 'Token de acesso', secret: true },
      { key: 'accountId', label: 'ID da conta do Instagram', secret: false, pattern: '^\\d+$', help: 'O número que aparece embaixo do @ no painel da Meta.' },
      { key: 'appSecret', label: 'Chave secreta do app da Meta', secret: true, help: 'Painel da Meta: Configurações do app > Básico > Chave secreta do app.' }],
      // Sem campo de token de verificação: o ManyCraft gera um (verifyTokenField continua para guardar o gerado) e assina o webhook sozinho.
      notice: "Para apps da Meta criados com 'API setup with Unified login'. Ao criar a configuração, escolha a expiração 'O token nunca expira': o painel não renova o token e só avisa quando ele já venceu. Cole o token gerado no card 'Gerar tokens de acesso' e o ID que aparece embaixo do @." } },
  zapi: zapiMeta,
  cloudflare_email: cloudflareEmailMeta,
  // Messenger congelado (26/10/2026): conexões existentes seguem funcionando; o painel não oferece mais conectar.
  messenger_page: { id: 'messenger_page', frozen: true, api: { base: 'https://graph.facebook.com', docs: 'docs-meta-messenger' }, kinds: ['messenger'], patch: { ...metaSurfaceProfile, media: unavailableMedia, cards: { adaptation: 'generic_template' } }, label: 'Messenger', live: true, contacts: 'managed', broadcast: false, metaObject: 'page', profile: { avatar: 'url' },
    connect: { webhook: 'manual', hook: 'shared', externalIdField: 'pageId', verifyTokenField: 'verifyToken', fields: [
      { key: 'accessToken', label: 'Token de acesso da página', secret: true },
      { key: 'pageId', label: 'ID da página do Facebook', secret: false, pattern: '^\\d+$' },
      { key: 'appSecret', label: 'Chave secreta do app', secret: true },
      { key: 'verifyToken', label: 'Token de verificação', secret: true, optional: true, help: 'Em branco: geramos um.' }] },
    options: [
      { key: 'greeting', type: 'text', max: 160, label: 'Texto de saudação', help: 'Aparece antes de a pessoa começar a conversa (separado da mensagem de boas-vindas). Use {{user_first_name}} para o nome.' },
      { key: 'composerDisabled', type: 'boolean', label: 'Bloquear digitação livre', help: 'Com o menu principal ligado, a pessoa só conversa pelos botões, menu e iniciadores.' },
    ] },
}
export const providerIds = Object.keys(providers) as ProviderId[]

/** Provider a pre-layer connection (provider 'legacy' or missing) falls back to. */
const defaults: Partial<Record<ChannelKind, ProviderId>> = {
  telegram: 'telegram_bot', whatsapp: 'meta_whatsapp_cloud', instagram: 'instagram_unified', messenger: 'messenger_page', email: 'cloudflare_email',
}

/** Resolve a channel/provider pair. Unknown or incompatible pairs fail loudly. */
export function resolveProvider(kind: ChannelKind | undefined, provider: StoredProvider | undefined): ProviderMeta {
  const id = provider && provider !== 'legacy' ? provider : kind ? defaults[kind] : undefined
  if (!id) throw new Error(`No provider registered for channel "${kind ?? 'unknown'}"`)
  if (!Object.hasOwn(providers, id)) throw new Error(`No provider "${id}" registered (channel "${kind ?? 'unknown'}")`)
  const meta = providers[id as ProviderId]
  if (kind && !meta.kinds.includes(kind)) throw new Error(`Provider "${id}" does not serve channel "${kind}"`)
  return meta
}
export function providerFor(kind: ChannelKind, provider?: StoredProvider): ProviderId { return resolveProvider(kind, provider).id }
export const hasDefaultProvider = (kind: ChannelKind) => defaults[kind] !== undefined
/** Channels that have a provider able to send a broadcast (drives the SQL filter of the option list). */
export const broadcastKinds = (): ChannelKind[] => [...new Set(providerIds.filter(id => providers[id].broadcast).flatMap(id => providers[id].kinds))]
/** Can this very connection (its stored provider, not the channel's default) be the sending connection of a broadcast? */
export const canBroadcast = (kind: ChannelKind, provider: StoredProvider | undefined): boolean => resolveProvider(kind, provider).broadcast

/** Channel a shared Meta app delivery belongs to, by its `object` (undefined when no provider claims it). */
export const kindForMetaObject = (object: unknown): ChannelKind | undefined =>
  (Object.keys(defaults) as ChannelKind[]).find(kind => providers[defaults[kind]!].metaObject === object)
