#!/usr/bin/env node
// Migração única: lê as credenciais de canal que viviam em variáveis de ambiente (arquivo .dev.vars antigo ou um
// arquivo no mesmo formato), cifra cada uma com a chave mestra e grava na linha da conexão correspondente.
// Nunca imprime valores. Sem --apply só mostra o plano.
//
//   node scripts/migrate-env-credentials.mjs [--vars .dev.vars.antigo] [--kek-file .dev.vars] [--remote] [--apply]
//
// A chave mestra (CONNECTIONS_KEK_V<n> e CONNECTIONS_KEK_ACTIVE) vem do --kek-file (padrão .dev.vars) ou do ambiente.
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encryptCredentials } from '../src/channels/core/crypto.ts'

const engineDir = resolve(fileURLToPath(import.meta.url), '../..')
const args = process.argv.slice(2)
const flag = name => args.includes(`--${name}`)
const option = (name, fallback) => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback

export function parseVars(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (match && !line.trim().startsWith('#')) out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}
const load = file => existsSync(file) ? parseVars(readFileSync(file, 'utf8')) : {}

/** Which stored connection each old variable group belongs to, and the credentials it becomes. */
export function plan(old) {
  const random = () => randomBytes(32).toString('base64url')
  const items = []
  if (old.TELEGRAM_BOT_TOKEN && old.TELEGRAM_CHANNEL_ID) items.push({ label: 'telegram', where: { id: old.TELEGRAM_CHANNEL_ID, type: 'telegram' },
    credentials: { botToken: old.TELEGRAM_BOT_TOKEN, webhookSecret: old.TELEGRAM_WEBHOOK_SECRET || random() } })
  if (old.WHATSAPP_ACCESS_TOKEN && old.WHATSAPP_PHONE_NUMBER_ID) items.push({ label: 'whatsapp', where: { externalId: old.WHATSAPP_PHONE_NUMBER_ID, type: 'whatsapp' },
    credentials: { accessToken: old.WHATSAPP_ACCESS_TOKEN, phoneNumberId: old.WHATSAPP_PHONE_NUMBER_ID, ...(old.META_APP_SECRET ? { appSecret: old.META_APP_SECRET } : {}),
      ...(old.META_VERIFY_TOKEN ? { verifyToken: old.META_VERIFY_TOKEN } : {}), webhookSecret: old.META_VERIFY_TOKEN || random() } })
  if (old.IG_ACCESS_TOKEN && old.IG_ACCOUNT_ID) items.push({ label: 'instagram', where: { externalId: old.IG_ACCOUNT_ID, type: 'instagram' },
    credentials: { accessToken: old.IG_ACCESS_TOKEN, accountId: old.IG_ACCOUNT_ID, ...(old.IG_APP_SECRET ? { appSecret: old.IG_APP_SECRET } : {}),
      ...(old.META_VERIFY_TOKEN ? { verifyToken: old.META_VERIFY_TOKEN } : {}), webhookSecret: old.META_VERIFY_TOKEN || random() } })
  return items
}

/** UPDATE that stores the sealed credentials. It does not mark the webhook as registered: this script registers nothing. */
export function updateSql(row, sealed, hash, label, now) {
  return `UPDATE channels SET credentials_ciphertext=${q(sealed.ciphertext)}, credentials_iv=${q(sealed.iv)}, credentials_key_version=${sealed.keyVersion},
      credentials_rotated_at=${now}, webhook_secret_hash=${q(hash)}, webhook_mode=${q(label === 'telegram' ? 'auto' : 'manual')}
      WHERE id=${q(row.id)} AND credentials_ciphertext IS NULL`
}

const wrangler = (...extra) => {
  const target = flag('remote') ? ['--remote'] : ['--local']
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', ...target, ...(flag('remote') ? [] : ['--env', 'dev']), '--json', ...extra],
    { cwd: engineDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } }).toString()
  return JSON.parse(out)[0].results
}
const q = value => `'${String(value).replaceAll("'", "''")}'`

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const old = { ...load(resolve(engineDir, option('vars', '.dev.vars'))), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(TELEGRAM|META|IG|WHATSAPP)_/.test(k))) }
  const kek = { ...load(resolve(engineDir, option('kek-file', '.dev.vars'))), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^CONNECTIONS_KEK_/.test(k))) }
  const items = plan(old)
  if (!items.length) { console.log('Nada para migrar: nenhuma credencial de canal encontrada nas variáveis.'); process.exit(0) }
  for (const item of items) {
    const rows = wrangler('--command', `SELECT id, workspace_id, credentials_ciphertext IS NOT NULL AS done FROM channels WHERE type=${q(item.where.type)} AND ${item.where.id ? `id=${q(item.where.id)}` : `external_id=${q(item.where.externalId)}`} AND archived_at IS NULL`)
    const row = rows[0]
    if (!row) { console.log(`- ${item.label}: nenhuma conexão correspondente no banco (crie a conexão pela tela ou rode o seed).`); continue }
    if (row.done) { console.log(`- ${item.label}: conexão ${row.id} já tem credenciais cifradas; mantida.`); continue }
    if (!flag('apply')) { console.log(`- ${item.label}: conexão ${row.id} receberia ${Object.keys(item.credentials).length} credenciais (use --apply).`); continue }
    const sealed = await encryptCredentials(kek, { workspaceId: row.workspace_id, connectionId: row.id }, item.credentials)
    const hash = createHash('sha256').update(item.credentials.webhookSecret).digest('hex')
    wrangler('--command', updateSql(row, sealed, hash, item.label, Date.now()))
    console.log(`- ${item.label}: conexão ${row.id} migrada (chave v${sealed.keyVersion}).`)
  }
  if (!flag('apply')) console.log('\nSó o plano foi mostrado. Rode de novo com --apply para gravar. Depois remova as variáveis antigas do .dev.vars.')
}
