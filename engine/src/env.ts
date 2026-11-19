import type { KeyringEnv } from './channels/core/crypto'

/** No channel credential lives here: connections hold theirs encrypted in the database; only the master keys are secrets. */
export type Env = KeyringEnv & {
  PUBLIC_BASE_URL?: string
  DEV_PROVIDER_API_BASE?: string
  DB: D1Database
  APP_ENV: 'development' | 'production'
  /** "1" fecha o cadastro: só entra quem tem convite válido, e ninguém abre espaço novo. */
  SIGNUP_CLOSED?: string
  DEV_AUTO_LOGIN?: string
  DEV_WORKSPACE_ID?: string
  /** Papel do auto-login de desenvolvimento (padrão owner). */
  DEV_ROLE?: string
  FLOW_RUN?: Workflow<{ runId: string }>
  /** "off" desliga o caminho rápido do webhook (processar na hora, em waitUntil); padrão ligado. */
  FAST_INBOUND?: string
  INBOX_HUB?: DurableObjectNamespace<import('./inbox/hub').InboxHub>
  CHANNEL_LIMITER?: DurableObjectNamespace<import('./flow/limiter').ChannelLimiter>
  BETTER_AUTH_SECRET?: string
  BETTER_AUTH_URL?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  EMAIL?: SendEmail
  EMAIL_FROM?: string
  EMAIL_DEFAULT_DOMAIN?: string
  MEDIA?: R2Bucket
  /** Bucket privado, sem domínio público: só os arquivos que os contatos enviam. */
  INBOUND_MEDIA?: R2Bucket
  MEDIA_PUBLIC_URL?: string
  INBOUND?: Queue
  RL_AUTH?: RateLimit
  /** Pedidos por minuto de cada chave de perfil nas rotas do painel (padrão 600). */
  API_KEY_RATE_LIMIT?: string
}
