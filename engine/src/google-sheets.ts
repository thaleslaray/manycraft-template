import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize } from './permissions'
import { json } from './security'
import { decryptCredentials, encryptCredentials, type KeyringEnv } from './channels/core/crypto'

/**
 * Google Sheets por conta de serviço: o espaço cola o JSON da conta, compartilha a planilha com o e-mail dela e as automações
 * inserem, buscam e atualizam linhas. A chave privada fica cifrada e só sai daqui para assinar o pedido de token (RS256).
 */
const scope = (workspaceId: string) => ({ workspaceId, connectionId: 'integration:google_sheets' })
const account = z.object({ client_email: z.email(), private_key: z.string().includes('PRIVATE KEY'), token_uri: z.url().optional() })
type Account = z.infer<typeof account>
type SheetsEnv = KeyringEnv & { DB: D1Database }

export async function sheetsAccount(env: SheetsEnv, ws: string): Promise<Account | null> {
  const row = await env.DB.prepare("SELECT ciphertext,iv,key_version FROM workspace_integrations WHERE workspace_id=? AND kind='google_sheets'").bind(ws).first<{ ciphertext: string; iv: string; key_version: number }>()
  if (!row) return null
  return account.parse(await decryptCredentials(env, scope(ws), { ciphertext: row.ciphertext, iv: row.iv, keyVersion: row.key_version }))
}

const b64url = (bytes: Uint8Array | string) => btoa(typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes)).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]!))
export async function sheetsToken(acc: Account, fetcher: typeof fetch = fetch, now = Date.now()): Promise<string> {
  const pem = acc.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const aud = acc.token_uri ?? 'https://oauth2.googleapis.com/token', iat = Math.floor(now / 1000)
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: acc.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud, iat, exp: iat + 3600 }))}`
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)))
  const response = await fetcher(aud, { method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(signature)}` }) })
  const token = z.object({ access_token: z.string().min(1) }).safeParse(await response.json().catch(() => null))
  if (!response.ok || !token.success) throw new Error('O Google não aceitou a conta de serviço.')
  return token.data.access_token
}

export const sheetsOperation = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('insert_row'), spreadsheet_id: z.string().min(10).max(200), sheet: z.string().min(1).max(100), values: z.array(z.string().max(2000)).min(1).max(50) }),
  z.object({ operation: z.literal('get_row'), spreadsheet_id: z.string().min(10).max(200), sheet: z.string().min(1).max(100), lookup_column: z.string().regex(/^[A-Z]{1,3}$/), lookup_value: z.string().max(2000),
    mappings: z.array(z.object({ column: z.string().regex(/^[A-Z]{1,3}$/), field_id: z.string().min(1).max(128) })).max(20) }),
  z.object({ operation: z.literal('update_row'), spreadsheet_id: z.string().min(10).max(200), sheet: z.string().min(1).max(100), lookup_column: z.string().regex(/^[A-Z]{1,3}$/), lookup_value: z.string().max(2000),
    values: z.array(z.object({ column: z.string().regex(/^[A-Z]{1,3}$/), value: z.string().max(2000) })).min(1).max(20) }),
])
export type SheetsOperation = z.infer<typeof sheetsOperation>
const colIndex = (col: string) => [...col].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1

/** Executa uma operação já com as variáveis preenchidas. get_row devolve os valores das colunas mapeadas da primeira linha encontrada. */
export async function runSheets(acc: Account, op: SheetsOperation, fetcher: typeof fetch = fetch): Promise<{ found?: Record<string, string> }> {
  const token = await sheetsToken(acc, fetcher)
  const api = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(op.spreadsheet_id)}/values`
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const sheet = `'${op.sheet.replace(/'/g, "''")}'`
  const check = async (r: Response) => { if (!r.ok) throw new Error(r.status === 403 ? 'Compartilhe a planilha com o e-mail da conta de serviço.' : `O Google Sheets respondeu ${r.status}.`); return r }
  if (op.operation === 'insert_row') {
    await check(await fetcher(`${api}/${encodeURIComponent(sheet)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { method: 'POST', headers, body: JSON.stringify({ values: [op.values] }) }))
    return {}
  }
  const read = await (await check(await fetcher(`${api}/${encodeURIComponent(sheet)}`, { headers }))).json() as { values?: string[][] }
  const rows = read.values ?? [], i = rows.findIndex(row => (row[colIndex(op.lookup_column)] ?? '') === op.lookup_value)
  if (i < 0) return {}
  if (op.operation === 'get_row') return { found: Object.fromEntries(op.mappings.map(m => [m.field_id, rows[i][colIndex(m.column)] ?? ''])) }
  for (const v of op.values) {
    await check(await fetcher(`${api}/${encodeURIComponent(`${sheet}!${v.column}${i + 1}`)}?valueInputOption=USER_ENTERED`, { method: 'PUT', headers, body: JSON.stringify({ values: [[v.value]] }) }))
  }
  return { found: {} }
}

export const googleSheetsConnectSchema = z.object({ service_account: z.string().min(10).max(10_000) }).strict()
export const googleSheetsExportSchema = z.object({ spreadsheet_id: z.string().min(10).max(200), sheet: z.string().trim().min(1).max(100).default('Contatos') }).strict()
export const googleSheetsRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
googleSheetsRoutes.get('/integrations/google-sheets', async c => {
  authorize(c.var.principal, 'read')
  const row = await c.env.DB.prepare("SELECT label,updated_at FROM workspace_integrations WHERE workspace_id=? AND kind='google_sheets'").bind(c.var.principal.workspaceId).first<{ label: string; updated_at: number }>()
  return c.json(row ? { connected: true, client_email: row.label, updated_at: row.updated_at } : { connected: false })
})
googleSheetsRoutes.put('/integrations/google-sheets', async c => {
  authorize(c.var.principal, 'team')
  const { service_account } = googleSheetsConnectSchema.parse(await json(c.req.raw))
  let parsed: Account
  try { parsed = account.parse(JSON.parse(service_account)) } catch { throw new HTTPException(400, { message: 'Cole o JSON da conta de serviço do Google (com client_email e private_key).' }) }
  try { await sheetsToken(parsed) } catch (error) { throw new HTTPException(422, { message: error instanceof Error ? error.message : 'O Google não aceitou a conta de serviço.' }) }
  const sealed = await encryptCredentials(c.env, scope(c.var.principal.workspaceId), { client_email: parsed.client_email, private_key: parsed.private_key, ...(parsed.token_uri ? { token_uri: parsed.token_uri } : {}) })
  await c.env.DB.prepare(`INSERT INTO workspace_integrations (workspace_id,kind,label,ciphertext,iv,key_version,updated_at) VALUES (?,'google_sheets',?,?,?,?,?)
    ON CONFLICT(workspace_id,kind) DO UPDATE SET label=excluded.label,ciphertext=excluded.ciphertext,iv=excluded.iv,key_version=excluded.key_version,updated_at=excluded.updated_at`)
    .bind(c.var.principal.workspaceId, parsed.client_email, sealed.ciphertext, sealed.iv, sealed.keyVersion, Date.now()).run()
  return c.json({ connected: true, client_email: parsed.client_email })
})
googleSheetsRoutes.delete('/integrations/google-sheets', async c => {
  authorize(c.var.principal, 'team')
  await c.env.DB.prepare("DELETE FROM workspace_integrations WHERE workspace_id=? AND kind='google_sheets'").bind(c.var.principal.workspaceId).run()
  return c.body(null, 204)
})

/** Exporta os contatos do espaço para uma aba (cabeçalho + uma linha por contato, até 5.000), como no original: sem CSV, pela planilha. */
export async function exportContactsToSheet(db: D1Database, ws: string, acc: Account, target: { spreadsheet_id: string; sheet: string }, fetcher: typeof fetch = fetch) {
  const rows = await db.prepare(`SELECT c.id,coalesce(c.first_name,''),coalesce(c.last_name,''),coalesce(c.email,''),coalesce(c.phone,''),c.status,
      coalesce(strftime('%Y-%m-%d %H:%M',c.subscribed_at/1000,'unixepoch'),''),
      coalesce((SELECT group_concat(t.name,', ') FROM contact_tags ct JOIN tags t ON t.workspace_id=ct.workspace_id AND t.id=ct.tag_id WHERE ct.workspace_id=c.workspace_id AND ct.contact_id=c.id),'')
    FROM contacts c WHERE c.workspace_id=? AND c.status<>'deleted' ORDER BY c.created_at,c.id LIMIT 5000`).bind(ws).raw<string[]>()
  const token = await sheetsToken(acc, fetcher)
  const sheet = `'${target.sheet.replace(/'/g, "''")}'`
  const r = await fetcher(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(target.spreadsheet_id)}/values/${encodeURIComponent(sheet)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [['id', 'nome', 'sobrenome', 'email', 'telefone', 'situação', 'inscrito em', 'etiquetas'], ...rows.map(r => r.map(String))] }) })
  if (!r.ok) throw new Error(r.status === 403 ? 'Compartilhe a planilha com o e-mail da conta de serviço.' : `O Google Sheets respondeu ${r.status}.`)
  return rows.length
}
googleSheetsRoutes.post('/integrations/google-sheets/export-contacts', async c => {
  authorize(c.var.principal, 'team')
  const input = googleSheetsExportSchema.parse(await json(c.req.raw))
  const acc = await sheetsAccount(c.env, c.var.principal.workspaceId)
  if (!acc) throw new HTTPException(409, { message: 'Conecte o Google Sheets em Configurações › Integrações.' })
  try { return c.json({ exported: await exportContactsToSheet(c.env.DB, c.var.principal.workspaceId, acc, input) }) }
  catch (e) { throw new HTTPException(502, { message: e instanceof Error ? e.message : 'Falha ao exportar.' }) }
})
