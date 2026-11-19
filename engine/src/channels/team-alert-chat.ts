import type { IntegrationEnv } from '../integrations'
import { connectionRuntime } from './core/runtime'
import { stateInSql } from './core/connection-state'

/** Chat de aviso dos membros (hoje o Telegram): vínculo por código de /start com um bot já conectado e envio do aviso para o chat vinculado.
 * Fica na camada de canais porque decide por tipo de canal; o resto do motor só fala em "chat". */

const CODE_PREFIX = 'al'
const CODE_TTL_MS = 15 * 60_000

export function newChatLinkCode() {
  return { code: CODE_PREFIX + [...crypto.getRandomValues(new Uint8Array(12))].map(b => (b % 36).toString(36)).join(''), expires_at: Date.now() + CODE_TTL_MS }
}
/** Bots conectados no espaço que podem mandar avisos. */
export async function linkableChats(env: IntegrationEnv, ws: string) {
  return (await env.DB.prepare(`SELECT id,coalesce(display_name,id) AS name FROM channels WHERE workspace_id=? AND type='telegram' AND archived_at IS NULL AND ${stateInSql(['connected'])} ORDER BY id`)
    .bind(ws).all<{ id: string; name: string }>()).results
}
export async function chatLinkTarget(env: IntegrationEnv, ws: string, channelId: string) {
  return await env.DB.prepare(`SELECT display_name FROM channels WHERE workspace_id=? AND id=? AND type='telegram' AND archived_at IS NULL AND ${stateInSql(['connected'])}`)
    .bind(ws, channelId).first<{ display_name: string | null }>()
}
export function chatLinkUrl(displayName: string | null, code: string): string | null {
  const username = displayName?.replace(/^@/, '')
  return username ? `https://t.me/${username}?start=${code}` : null
}
export async function sendToChat(env: IntegrationEnv, ws: string, channelId: string, chatId: string, text: string): Promise<boolean> {
  const rt = await connectionRuntime(env, ws, channelId, { requireConnected: true })
  const sent = await rt.provider!.send({ connection: rt.connection, credentials: await rt.credentials(), fetch: rt.fetch, target: { kind: 'direct', externalUserId: chatId } }, { kind: 'text', text })
  return sent.ok
}

/** `/start <código>` recebido pelo bot: vincula o chat ao membro que gerou o código. Devolve true quando a mensagem era de vínculo (não vira mensagem de contato). */
export async function handleAlertStart(env: IntegrationEnv, ws: string, channelId: string, chatId: string, text: string | undefined): Promise<boolean> {
  const match = new RegExp(`^/start\\s+(${CODE_PREFIX}[a-z0-9]{12})$`).exec((text ?? '').trim())
  if (!match) return false
  const row = await env.DB.prepare("SELECT c.member_id,c.expires_at,c.used_chat_id FROM alert_chat_codes c JOIN channels h ON h.workspace_id=c.workspace_id AND h.id=c.channel_id AND h.type='telegram' WHERE c.code=? AND c.workspace_id=? AND c.channel_id=?")
    .bind(match[1], ws, channelId).first<{ member_id: string; expires_at: number; used_chat_id: string | null }>()
  if (!row) return false
  let reply = 'Pronto: este chat está vinculado e vai receber os seus avisos.'
  if (row.used_chat_id && row.used_chat_id !== chatId) reply = 'Este código já foi usado. Gere outro no painel.'
  else if (!row.used_chat_id && row.expires_at < Date.now()) reply = 'Este código venceu. Gere outro no painel.'
  else if (!row.used_chat_id) {
    await env.DB.batch([
      env.DB.prepare('UPDATE alert_chat_codes SET used_chat_id=? WHERE code=?').bind(chatId, match[1]),
      env.DB.prepare(`INSERT INTO member_alert_settings(member_id,workspace_id,chat_id,chat_channel_id) VALUES (?,?,?,?)
        ON CONFLICT(member_id) DO UPDATE SET chat_id=excluded.chat_id,chat_channel_id=excluded.chat_channel_id`).bind(row.member_id, ws, chatId, channelId),
    ])
  }
  try { await sendToChat(env, ws, channelId, chatId, reply) } catch { /* a resposta é cortesia; o vínculo já está gravado */ }
  return true
}
