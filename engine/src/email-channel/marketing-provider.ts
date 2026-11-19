import { decryptCredentials, encryptCredentials, type KeyringEnv } from '../channels/core/crypto'

/** Provedor de marketing (Resend, API HTTP): envio de e-mails de marketing e verificação de domínio do remetente. */
const scope = (ws: string) => ({ workspaceId: ws, connectionId: 'email:marketing' })
export const RESEND_API = 'https://api.resend.com'

export async function marketingKey(env: KeyringEnv & { DB: D1Database }, ws: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT marketing_key_ciphertext AS c,marketing_key_iv AS i,marketing_key_version AS v FROM email_settings WHERE workspace_id=?').bind(ws).first<{ c: string | null; i: string | null; v: number | null }>()
  if (!row?.c) return null
  return (await decryptCredentials(env, scope(ws), { ciphertext: row.c, iv: row.i!, keyVersion: row.v! }) as { key: string }).key
}
export async function saveMarketingKey(env: KeyringEnv & { DB: D1Database }, ws: string, key: string | null) {
  const sealed = key ? await encryptCredentials(env, scope(ws), { key }) : null
  await env.DB.prepare(`INSERT INTO email_settings (workspace_id,marketing_key_ciphertext,marketing_key_iv,marketing_key_version) VALUES (?,?,?,?)
    ON CONFLICT(workspace_id) DO UPDATE SET marketing_key_ciphertext=excluded.marketing_key_ciphertext,marketing_key_iv=excluded.marketing_key_iv,marketing_key_version=excluded.marketing_key_version`)
    .bind(ws, sealed?.ciphertext ?? null, sealed?.iv ?? null, sealed?.keyVersion ?? null).run()
}
export async function sendViaResend(key: string, mail: { from: { email: string; name?: string }; to: string; replyTo?: string; subject: string; text: string; html?: string; headers?: Record<string, string> }, fetcher: typeof fetch = fetch): Promise<{ ok: true; id: string } | { ok: false; code: string; uncertain: boolean }> {
  try {
    const r = await fetcher(`${RESEND_API}/emails`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ from: mail.from.name ? `${mail.from.name} <${mail.from.email}>` : mail.from.email, to: [mail.to], subject: mail.subject, text: mail.text, ...(mail.html ? { html: mail.html } : {}),
        ...(mail.replyTo ? { reply_to: mail.replyTo } : {}), ...(mail.headers ? { headers: mail.headers } : {}) }) })
    const data = await r.json().catch(() => null) as { id?: string; name?: string } | null
    if (r.ok && data?.id) return { ok: true, id: data.id }
    return { ok: false, code: data?.name ?? `http_${r.status}`, uncertain: r.status >= 500 }
  } catch { return { ok: false, code: 'network', uncertain: true } }
}
/** Domínio no provedor: cria (se preciso) e devolve os registros DNS e se já está verificado. */
export async function resendDomain(key: string, domain: string, fetcher: typeof fetch = fetch): Promise<{ verified: boolean; records: { type: string; name: string; value: string }[] }> {
  const headers = { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }
  const list = await (await fetcher(`${RESEND_API}/domains`, { headers })).json() as { data?: { id: string; name: string; status: string }[] }
  let found = list.data?.find(d => d.name === domain)
  if (!found) found = await (await fetcher(`${RESEND_API}/domains`, { method: 'POST', headers, body: JSON.stringify({ name: domain }) })).json() as { id: string; name: string; status: string }
  else await fetcher(`${RESEND_API}/domains/${found.id}/verify`, { method: 'POST', headers })
  const detail = await (await fetcher(`${RESEND_API}/domains/${found.id}`, { headers })).json() as { status?: string; records?: { type: string; name: string; value: string }[] }
  return { verified: detail.status === 'verified', records: (detail.records ?? []).map(r => ({ type: r.type, name: r.name, value: r.value })) }
}
