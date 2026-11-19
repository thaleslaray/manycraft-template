import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isIP } from 'node:net'

export const expectedBotUsername = 'marina_assistente_pessoal_bot'

// Secrets stay in memory. In particular, never expose fetch errors: their URLs
// include the Telegram bot token.
export async function loadTelegramEnv() {
  let source = ''
  try { source = await readFile(new URL('../.dev.vars', import.meta.url), 'utf8') }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Não foi possível ler engine/.dev.vars.') }
  return { ...parseTelegramEnv(source), ...process.env }
}

export function parseTelegramEnv(source) {
  const vars = {}
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!match) continue
    let value = match[2]
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value) } catch { throw new Error('Aspas inválidas em engine/.dev.vars.') }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
    else value = value.replace(/\s+#.*$/, '').trim()
    vars[match[1]] = value
  }
  return vars
}

export async function telegramCall(token, method, body = {}, fetcher = fetch) {
  let response
  try {
    response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    })
  } catch { throw new Error(`Telegram ${method}: falha de conexão (detalhes omitidos para proteger o token).`) }
  let data
  try { data = await response.json() } catch { throw new Error(`Telegram ${method}: resposta inválida.`) }
  if (!response.ok || data.ok !== true) throw new Error(`Telegram ${method}: solicitação recusada (HTTP ${response.status}).`)
  return data.result
}

export function webhookUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('Informe uma URL HTTPS pública do Worker local.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || isIP(url.hostname.replace(/^\[|\]$/g, ''))
    || !url.hostname.includes('.') || /\.(?:localhost|local|test|invalid)$/.test(url.hostname)
    || !['/', '/api/webhooks/telegram'].includes(url.pathname)
    || (url.port && !['443', '80', '88', '8443'].includes(url.port))) {
    throw new Error('Use uma origem HTTPS pública ou /api/webhooks/telegram, sem credenciais ou parâmetros.')
  }
  url.pathname = '/api/webhooks/telegram'
  return url.href
}

export async function registerWebhook(env, value, fetcher = fetch) {
  const token = env.TELEGRAM_BOT_TOKEN
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token ?? '')) throw new Error('Configure TELEGRAM_BOT_TOKEN em engine/.dev.vars.')
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET ?? '')) {
    throw new Error('Configure TELEGRAM_WEBHOOK_SECRET (1–256 letras, números, _ ou -) em engine/.dev.vars.')
  }
  if (!env.TELEGRAM_CHANNEL_ID) throw new Error('Configure TELEGRAM_CHANNEL_ID em engine/.dev.vars e execute telegram:seed.')
  const url = webhookUrl(value)
  const bot = await telegramCall(token, 'getMe', {}, fetcher)
  if (bot?.is_bot !== true || bot.username !== expectedBotUsername) {
    throw new Error(`O token não pertence ao bot dedicado @${expectedBotUsername}; webhook preservado.`)
  }
  await telegramCall(token, 'setWebhook', {
    url, secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query', 'my_chat_member'], max_connections: 1,
    // Retain pending updates; the consumer deduplicates retries.
    drop_pending_updates: false,
  }, fetcher)
  const info = await telegramCall(token, 'getWebhookInfo', {}, fetcher)
  if (info?.url !== url) throw new Error('Telegram retornou um webhook diferente do solicitado.')
  return { bot: `@${bot.username}`, webhook: url, pendingUpdates: info.pending_update_count ?? 0,
    deliveryErrorReported: Boolean(info.last_error_date) }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('Uso: npm run telegram:webhook -- https://SEU-TUNEL.trycloudflare.com\n'
      + 'Ou defina TELEGRAM_WEBHOOK_URL. Leia token, secret e canal de engine/.dev.vars.\n'
      + 'Execute npm run dev e cloudflared tunnel --url http://localhost:8787 antes.\n'
      + 'Registra apenas message/callback_query no bot dedicado, sem descartar atualizações.')
    return
  }
  if (args.length > 1 || args[0]?.startsWith('-')) throw new Error('Argumentos inválidos. Consulte --help.')
  const env = await loadTelegramEnv()
  const result = await registerWebhook(env, args[0] ?? env.TELEGRAM_WEBHOOK_URL)
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
