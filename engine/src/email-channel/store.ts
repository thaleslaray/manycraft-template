import type { Env } from '../env'
import { encryptCredentials, type KeyringEnv } from '../channels/core/crypto'
import { runtimeFromRow } from '../channels/core/runtime'
import { connectionColumns, type ConnectionRow } from '../channels/core/connection'
import { stateInSql } from '../channels/core/connection-state'
import { effectiveProfile } from '../channels/core/profile-merge'
import { newIdentityConsent } from '../channels/core/consent'
export type EmailEnv = KeyringEnv &
  Pick<Env, 'DB' | 'INBOX_HUB' | 'PUBLIC_BASE_URL' | 'INBOUND' | 'FLOW_RUN'> & {
    APP_ENV?: string
    EMAIL_DEFAULT_DOMAIN?: string
    EMAIL?: { send(options: any): Promise<any> }
  }
export type Sender = {
  id: string
  workspace_id: string
  address: string
  name: string
  reply_to: string
  branding: number
  is_platform: number
  status: string
  verification_token: string
  verification_expires_at: number | null
  dns: string
  warmup_accepted: number
}
export const normalizeEmail = (value: string) => value.trim().toLowerCase()
export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
function initializeStatements(env: EmailEnv, ws: string) {
  const domain = env.EMAIL_DEFAULT_DOMAIN ?? 'mail.replica.test',
    id = `email-default-${ws}`
  return [
    env.DB.prepare(
      'INSERT INTO email_settings(workspace_id,default_sender_id) VALUES (?,?) ON CONFLICT(workspace_id) DO NOTHING',
    ).bind(ws, id),
    env.DB.prepare(
      "INSERT INTO email_senders(id,workspace_id,address,name,reply_to,is_platform,status,verification_token) VALUES (?,?,?,?,?,1,'verified',?) ON CONFLICT(id) DO UPDATE SET address=excluded.address,reply_to=CASE WHEN email_senders.reply_to='reply@'||substr(email_senders.address,instr(email_senders.address,'@')+1) THEN excluded.reply_to ELSE email_senders.reply_to END WHERE email_senders.is_platform=1",
    ).bind(id, ws, `workspace-${ws}@${domain}`, 'Equipe', `reply@${domain}`, crypto.randomUUID()),
  ]
}
export async function initialize(env: EmailEnv, ws: string) {
  await env.DB.batch(initializeStatements(env, ws))
}
const monthStart = () => {
  const since = new Date()
  since.setUTCDate(1)
  since.setUTCHours(0, 0, 0, 0)
  return since.getTime()
}
export async function usage(env: EmailEnv, ws: string) {
  const since = monthStart()
  const [count, settings] = await Promise.all([
    env.DB.prepare(
      "SELECT count(*) AS n FROM email_messages WHERE workspace_id=? AND created_at>=? AND status='sent'",
    )
      .bind(ws, since)
      .first<{ n: number }>(),
    env.DB.prepare('SELECT paused FROM email_settings WHERE workspace_id=?')
      .bind(ws)
      .first<{ paused: number }>(),
  ])
  return {
    sent: count?.n ?? 0,
    paused: !!settings?.paused,
  }
}
export const publicSender = (s: Sender, defaultId: string | null) => ({
  id: s.id,
  address: s.address,
  name: s.name,
  replyTo: s.reply_to,
  branding: !!s.branding,
  isDefault: s.id === defaultId,
  status: s.status,
  domain: s.address.split('@')[1],
  verificationExpiresAt: s.verification_expires_at,
  dns: JSON.parse(s.dns),
})
export async function getSettings(env: EmailEnv, ws: string) {
  // Uma ida só: os dois inserts de inicialização e as cinco leituras vão num batch (D1 o executa em ordem, e as leituras
  // já enxergam as linhas recém-criadas). O canal conectado vem inteiro para montar o perfil sem outra ida.
  const results = await env.DB.batch<any>([
    ...initializeStatements(env, ws),
    env.DB.prepare('SELECT * FROM email_settings WHERE workspace_id=?').bind(ws),
    env.DB.prepare('SELECT * FROM email_senders WHERE workspace_id=? ORDER BY is_platform DESC,rowid').bind(ws),
    env.DB.prepare(`SELECT ${connectionColumns} FROM channels WHERE workspace_id=? AND type='email' AND ${stateInSql(['connected'])} ORDER BY created_at LIMIT 1`).bind(ws),
    env.DB.prepare("SELECT count(*) AS n FROM email_messages WHERE workspace_id=? AND created_at>=? AND status='sent'").bind(ws, monthStart()),
  ])
  const s = results[2]!.results[0], senders = results[3]!.results as Sender[], connected = results[4]!.results[0] as ConnectionRow | undefined
  const profile = connected
    ? (await runtimeFromRow(env, connected, { secrets: false })).connection.profile
    : effectiveProfile('email', 'cloudflare_email')
  return {
    profile,
    defaultSenderId: s.default_sender_id,
    senders: senders.map((v) => publicSender(v, s.default_sender_id)),
    company: { name: s.company_name, address: s.company_address },
    usage: { sent: (results[5]!.results[0] as { n: number }).n ?? 0, paused: !!s.paused, pauseReason: s.paused ? (s.pause_reason ?? null) : null },
  }
}
export async function emailConnection(env: EmailEnv, ws: string) {
  const existing = await env.DB.prepare(
    `SELECT id FROM channels WHERE workspace_id=? AND type='email' AND ${stateInSql(['connected'])} ORDER BY created_at LIMIT 1`,
  )
    .bind(ws)
    .first<{ id: string }>()
  if (existing) {
    await configureCredentials(env, ws, existing.id)
    return existing.id
  }
  const id = `email-channel-${ws}`
  // Já existe e não está conectada: foi desativada pela equipe ou arquivada. Fica como está (antes, qualquer gravação de e-mail a religava
  // sem passar pela reativação, e a arquivada voltava "conectada" ainda arquivada); reativar é pelo botão da conexão.
  await env.DB.prepare(
    "INSERT INTO channels(id,workspace_id,type,provider,external_id,display_name,status,settings) VALUES (?,?,'email','cloudflare_email',?,'E-mail','connected','{}') ON CONFLICT(id) DO NOTHING",
  )
    .bind(id, ws, `email-${ws}`)
    .run()
  await configureCredentials(env, ws, id)
  return id
}
async function configureCredentials(env: EmailEnv, ws: string, id: string) {
  await initialize(env, ws)
  const sender = await env.DB.prepare(
    'SELECT s.address FROM email_senders s JOIN email_settings t ON t.workspace_id=s.workspace_id AND t.default_sender_id=s.id WHERE s.workspace_id=?',
  )
    .bind(ws)
    .first<{ address: string }>()
  if (!sender) return
  const sealed = await encryptCredentials(
    env,
    { workspaceId: ws, connectionId: id },
    { senderAddress: sender.address },
  )
  await env.DB.prepare(
    'UPDATE channels SET credentials_ciphertext=?,credentials_iv=?,credentials_key_version=? WHERE workspace_id=? AND id=? AND credentials_ciphertext IS NULL',
  )
    .bind(sealed.ciphertext, sealed.iv, sealed.keyVersion, ws, id)
    .run()
}
/** Quem escreve de um endereço prova que o controla: junta com o vínculo de e-mail existente ou com o contato que tem esse e-mail no cadastro. */
export async function emailContact(
  env: EmailEnv,
  ws: string,
  channelId: string,
  address: string,
  consent = false,
) {
  const email = normalizeEmail(address),
    id = crypto.randomUUID()
  // Dono do endereço: quem já tem o vínculo de e-mail; senão, um contato de outro canal com esse e-mail no cadastro (unificação entre canais).
  const owner =
    "SELECT coalesce((SELECT cc.contact_id FROM contact_channels cc JOIN channels ch ON ch.id=cc.channel_id AND ch.workspace_id=cc.workspace_id JOIN contacts c ON c.id=cc.contact_id AND c.workspace_id=cc.workspace_id WHERE cc.workspace_id=?1 AND ch.type='email' AND lower(cc.external_user_id)=?2 AND c.status<>'deleted' LIMIT 1),(SELECT c.id FROM contacts c WHERE c.workspace_id=?1 AND lower(c.email)=?2 AND c.status<>'deleted' LIMIT 1))"
  const created = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO contacts(id,workspace_id,first_name,optin_source) SELECT ?3,?1,?4,'email' WHERE (${owner}) IS NULL`,
    ).bind(ws, email, id, email.split('@')[0]),
    env.DB.prepare(
      `INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in,consent_changed_at) VALUES (?3,?1,coalesce((${owner}),?4),?5,?2,?6,?7) ON CONFLICT(channel_id,external_user_id) DO NOTHING`,
    ).bind(ws, email, crypto.randomUUID(), id, channelId, ...Object.values(newIdentityConsent(consent))),
  ])
  const contactId = (await env.DB.prepare(
    'SELECT contact_id FROM contact_channels WHERE workspace_id=? AND channel_id=? AND external_user_id=?',
  )
    .bind(ws, channelId, email)
    .first<{ contact_id: string }>())!.contact_id
  if (created[0].meta.changes) {
    const { runEmailRules, runEmailFieldRules } = await import('./events')
    await runEmailRules(env, ws, contactId, channelId, 'contact_created')
    await runEmailFieldRules(env, ws, contactId, channelId, null, email)
  }
  return contactId
}
