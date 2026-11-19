import { z } from 'zod'
import { isInternalHost } from './external-url'
import { REQUEST_TIMEOUT_MS } from './external-request'
import { dynamicResponseSchema, type DynamicResponse } from './dynamic-block'
import { sendDynamicContent } from './content-run'
import type { FlowEnv } from './types'
import { logTaskError } from '../log-error'

type Callback = NonNullable<DynamicResponse['content']['external_message_callback']>

/** Guarda o callback: substitui o anterior do mesmo contato nesta conexão. */
export function saveMessageCallback(db: D1Database, workspace: string, contactId: string, channelId: string, callback: Callback, now = Date.now()) {
  return db.prepare(`INSERT INTO message_callbacks(workspace_id,contact_id,channel_id,url,method,headers,payload,expires_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(workspace_id,contact_id,channel_id) DO UPDATE SET url=excluded.url,method=excluded.method,headers=excluded.headers,payload=excluded.payload,expires_at=excluded.expires_at`)
    .bind(workspace, contactId, channelId, callback.url, callback.method, JSON.stringify(callback.headers), callback.payload === undefined ? null : JSON.stringify(callback.payload), now + callback.timeout * 1000).run()
}

const fill = (value: unknown, vars: Record<string, string>): unknown =>
  typeof value === 'string' ? value.replace(/\{\{\s*(last_input_text|user_id)\s*\}\}/g, (_, k: string) => vars[k] ?? '')
    : Array.isArray(value) ? value.map(v => fill(v, vars))
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)])) : value

/**
 * Se há um callback válido, a mensagem de texto vai ao servidor do cliente e não dispara automações (true).
 * O registro sai antes da chamada: uma mensagem consome o callback uma única vez, mesmo com reentrega.
 */
export async function consumeMessageCallback(env: FlowEnv, workspace: string, channelId: string, contactId: string, text: string, now = Date.now(), fetcher: typeof fetch = fetch): Promise<boolean> {
  const row = await env.DB.prepare('DELETE FROM message_callbacks WHERE workspace_id=? AND contact_id=? AND channel_id=? AND expires_at>? RETURNING url,method,headers,payload')
    .bind(workspace, contactId, channelId, now).first<{ url: string; method: string; headers: string; payload: string | null }>()
  if (!row) return false
  const vars = { last_input_text: text, user_id: contactId }
  const payload = row.payload === null ? { last_input_text: text, user_id: contactId } : fill(JSON.parse(row.payload), vars)
  const target = new URL(row.url)
  if (target.protocol !== 'https:' || isInternalHost(target.hostname)) return true
  const get = row.method === 'get'
  if (get) target.searchParams.set('last_input_text', text), target.searchParams.set('user_id', contactId)
  try {
    const response = await fetcher(target, { method: row.method.toUpperCase(), headers: { 'content-type': 'application/json', ...z.record(z.string(), z.string()).parse(JSON.parse(row.headers)) },
      ...(get ? {} : { body: JSON.stringify(payload) }), redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (response.status !== 200) { await response.body?.cancel(); return true }
    const parsed = dynamicResponseSchema.safeParse(JSON.parse((await response.text()).slice(0, 1_000_000) || 'null'))
    if (!parsed.success) return true
    const next = parsed.data.content.external_message_callback
    if (next) await saveMessageCallback(env.DB, workspace, contactId, channelId, next, now)
    if (parsed.data.content.messages.length || parsed.data.content.quick_replies.length) await sendDynamicContent(env, workspace, contactId, channelId, parsed.data, 'Resposta do callback')
  } catch (error) { logTaskError('message_callback_failed', error) }
  return true
}
