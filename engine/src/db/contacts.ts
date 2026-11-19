import type { ChannelFields, Contact, ContactDetail, ContactFilter, ContactPage, Tag } from "../contracts"
import { assertWorkspace, decode, RepositoryError, type Row } from "./shared"
import { effectiveProfile } from '../channels/core/profile-merge'
import type { ChannelKind, ProfilePatch, StoredProvider } from '../channels/contract'

import { emailFilterSql, contactFilterSql } from '../email-channel/filters'

function readCursor(cursor: string, workspaceId: string): { time: number; id: string } {
  try {
    const parsed: unknown = JSON.parse(atob(cursor))
    if (typeof parsed !== "object" || parsed === null || !("workspace" in parsed) || parsed.workspace !== workspaceId ||
      !("time" in parsed) || typeof parsed.time !== "number" || !Number.isFinite(parsed.time) ||
      !("id" in parsed) || typeof parsed.id !== "string") throw new Error()
    return { time: parsed.time, id: parsed.id }
  } catch { throw new RepositoryError("Cursor inválido.", 400) }
}

export async function listContacts(db: D1Database, workspaceId: string, cursor: string | null = null,
  filter: ContactFilter = {}, pageSize = 40): Promise<ContactPage> {
  assertWorkspace(workspaceId)
  const where = ["c.workspace_id = ?"]
  const values: (string | number)[] = [workspaceId]
  const search = filter.search?.trim()
  if (search) {
    // Trigram supports interior substrings. SQLite FTS emits no token for fewer
    // than three characters; use a scoped scan for those short searches.
    if (search.split(/\s+/).every(term => Array.from(term).length >= 3)) {
      const terms = search.split(/\s+/).map(term => `"${term.replaceAll('"', '""')}"`).join(" AND ")
      where.push("c.rowid IN (SELECT rowid FROM contacts_fts WHERE contacts_fts MATCH ?)")
      values.push(terms)
    } else {
      where.push("instr(lower(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), lower(?)) > 0")
      values.push(search)
    }
  }
  // Excluded contacts leave the audience; they only show up when that status is asked for explicitly.
  if (filter.status) { where.push("c.status = ?"); values.push(filter.status) }
  else where.push("c.status <> 'deleted'")
  if (filter.tag_id) {
    where.push("EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.workspace_id = c.workspace_id AND ct.contact_id = c.id AND ct.tag_id = ?)")
    values.push(filter.tag_id)
  }
  if (filter.channel_type) {
    where.push(`EXISTS (SELECT 1 FROM contact_channels cc JOIN channels ch ON ch.id = cc.channel_id AND ch.workspace_id = cc.workspace_id
      WHERE cc.workspace_id = c.workspace_id AND cc.contact_id = c.id AND ch.type = ?)`)
    values.push(filter.channel_type)
  }
  if (filter.connection_id) {
    // IN com a conta fixa (não correlacionado): o EXISTS correlacionado varria todos os canais de contato a cada contato (quadrático, ~1,6 s com 4.200 contatos).
    where.push(`c.id IN (SELECT cc.contact_id FROM contact_channels cc WHERE cc.workspace_id = ? AND cc.channel_id = ?)`)
    values.push(workspaceId, filter.connection_id)
  }
  if (filter.trigger_id) { where.push("c.optin_source = ?"); values.push(`trigger:${filter.trigger_id}`) }
  if (filter.sequence_id) {
    where.push("EXISTS (SELECT 1 FROM sequence_subscriptions ss WHERE ss.workspace_id = c.workspace_id AND ss.contact_id = c.id AND ss.sequence_id = ?)")
    values.push(filter.sequence_id)
  }
  if (filter.email_filter) where.push(emailFilterSql(filter.email_filter))
  const conditionFilters: unknown[] = []
  if (filter.segment_id) conditionFilters.push({ match: 'all', rules: [{ type: 'segment', segment_id: filter.segment_id, operator: 'has' }] })
  if (filter.contact_filter) {
    try { conditionFilters.push(JSON.parse(filter.contact_filter)) } catch { throw new RepositoryError('Filtro de contato inválido.', 400) }
  }
  for (const input of conditionFilters) {
    const compiled = await contactFilterSql(db, workspaceId, input)
    where.push(compiled.sql)
    values.push(...compiled.values as (string | number)[])
  }
  const base = where.join(" AND ")
  const countQuery = db.prepare(`SELECT count(*) AS total FROM contacts c WHERE ${base}`).bind(...values)
  if (cursor) {
    const key = readCursor(cursor, workspaceId)
    where.push("(c.subscribed_at < ? OR (c.subscribed_at = ? AND c.id < ?))")
    values.push(key.time, key.time, key.id)
  }
  const [count, page] = await Promise.all([
    countQuery.first<{ total: number }>(),
    db.prepare(`SELECT c.* FROM contacts c WHERE ${where.join(" AND ")} ORDER BY c.subscribed_at DESC, c.id DESC LIMIT ${pageSize + 1}`)
      .bind(...values).all<Row>(),
  ])
  const rows = page.results.slice(0, pageSize)
  const last = rows.at(-1)
  return { rows: await withTagsAndFields(db, workspaceId, rows.map(row => decode<Contact>(row))), total: count?.total ?? 0,
    next_cursor: page.results.length > pageSize && last ? btoa(JSON.stringify({ workspace: workspaceId, time: last.subscribed_at, id: last.id })) : null }
}

/** Tags e valores de campo de cada contato da página, para a lista mostrar em colunas (duas consultas por página, não por linha). */
export async function withTagsAndFields(db: D1Database, workspaceId: string, contacts: Contact[]): Promise<Contact[]> {
  if (contacts.length === 0) return contacts
  const ids = JSON.stringify(contacts.map(c => c.id))
  const [tags, fields, blocked] = await Promise.all([
    db.prepare(`SELECT ct.contact_id, t.id, t.name FROM contact_tags ct JOIN tags t ON t.workspace_id = ct.workspace_id AND t.id = ct.tag_id
      WHERE ct.workspace_id = ? AND ct.contact_id IN (SELECT value FROM json_each(?)) ORDER BY ct.created_at, t.name`).bind(workspaceId, ids)
      .all<{ contact_id: string; id: string; name: string }>(),
    db.prepare(`SELECT v.contact_id, v.field_id, v.value FROM contact_field_values v
      WHERE v.workspace_id = ? AND v.contact_id IN (SELECT value FROM json_each(?))`).bind(workspaceId, ids)
      .all<{ contact_id: string; field_id: string; value: string }>(),
    db.prepare(`SELECT cc.contact_id FROM contact_channels cc WHERE cc.workspace_id = ? AND cc.contact_id IN (SELECT value FROM json_each(?))
      GROUP BY cc.contact_id HAVING count(*) = count(cc.blocked_at)`).bind(workspaceId, ids).all<{ contact_id: string }>(),
  ])
  const deleted = new Set(blocked.results.map(r => r.contact_id))
  return contacts.map(c => ({
    conversation_deleted: deleted.has(c.id),
    ...c,
    tags: tags.results.filter(t => t.contact_id === c.id).map(t => ({ id: t.id, name: t.name })),
    fields: Object.fromEntries(fields.results.filter(f => f.contact_id === c.id).map(f => [f.field_id, JSON.parse(f.value) as unknown])),
  }))
}

export async function searchContacts(db: D1Database, workspaceId: string, search: string,
  cursor: string | null = null): Promise<ContactPage> {
  return listContacts(db, workspaceId, cursor, { search })
}

export async function getContact(db: D1Database, workspaceId: string, id: string): Promise<ContactIdentityDetail | null> {
  assertWorkspace(workspaceId)
  // Contato, canais, tags e campos pedem só o id da rota: uma ida (contato inexistente = lista vazia, 404 do mesmo jeito).
  const [contacts, channels, tags, fields] = await db.batch<Row>([
    db.prepare("SELECT * FROM contacts WHERE workspace_id = ? AND id = ?").bind(workspaceId, id),
    db.prepare(`SELECT cc.id, cc.contact_id, cc.channel_id, cc.external_user_id, cc.username, cc.opted_in,
      cc.window_expires_at, cc.human_window_expires_at, cc.identity_kind, cc.phone_e164,
      cc.window_messages_sent, cc.channel_fields, ch.type AS channel_type,
      ch.display_name AS connection_name, ch.provider, ch.capabilities_override FROM contact_channels cc
      JOIN channels ch ON ch.workspace_id = cc.workspace_id AND ch.id = cc.channel_id
      WHERE cc.workspace_id = ? AND cc.contact_id = ? ORDER BY cc.id`).bind(workspaceId, id),
    db.prepare(`SELECT t.id, t.workspace_id, t.name, t.contact_count, t.created_at FROM tags t
      JOIN contact_tags ct ON ct.workspace_id = t.workspace_id AND ct.tag_id = t.id
      WHERE ct.workspace_id = ? AND ct.contact_id = ? ORDER BY t.name, t.id`).bind(workspaceId, id),
    db.prepare(`SELECT v.contact_id, v.field_id, v.value FROM contact_field_values v JOIN custom_fields f
      ON f.workspace_id = v.workspace_id AND f.id = v.field_id WHERE v.workspace_id = ? AND v.contact_id = ? ORDER BY v.field_id`)
      .bind(workspaceId, id),
  ])
  const contact = contacts!.results[0]
  if (!contact) return null
  return { contact: decode<Contact>(contact), channels: channels!.results.map(row => {
    const { provider, capabilities_override, channel_fields, ...publicRow } = row
    const profile = effectiveProfile(row.channel_type as ChannelKind, provider as StoredProvider,
      capabilities_override ? JSON.parse(String(capabilities_override)) as ProfilePatch : undefined)
    return { ...identityChannel(publicRow), channel_fields: channel_fields ? JSON.parse(String(channel_fields)) as ChannelFields : {}, connection_profile: { initiator: profile.initiator, window: profile.window, email: profile.email } }
  }),
    tags: tags!.results.map(row => decode<Tag>(row)), field_values: fields!.results.map(row => decode<ContactDetail["field_values"][number]>(row)) }
}

export type ContactIdentityChannel = ContactDetail["channels"][number] & {
  identity_kind: "provider_id" | "bsuid" | "wa_phone_legacy"
  window_messages_sent: number
}
export type ContactIdentityDetail = Omit<ContactDetail, "channels"> & { channels: ContactIdentityChannel[] }

// Preserve the complete provider value, including country prefix and optional ENT.
// Do not accept phones (with or without +) or usernames as a BSUID.
const bsuidPattern = /^[A-Z]{2}\.(?:ENT\.)?[A-Za-z0-9]{1,128}$/
const phonePattern = /^\+[1-9][0-9]{6,14}$/

function identityChannel(row: Row): ContactIdentityChannel {
  return decode<ContactIdentityChannel>(row)
}

const identityColumns = `cc.id, cc.contact_id, cc.channel_id, cc.external_user_id, cc.username, cc.opted_in,
  cc.window_expires_at, cc.human_window_expires_at, cc.identity_kind, cc.phone_e164,
  cc.window_messages_sent, ch.type AS channel_type`

/** Internal server repository: caller supplies an authorized workspace, never a phone-derived contact key. */
export async function getWhatsappIdentity(db: D1Database, workspaceId: string, channelId: string,
  bsuid: string): Promise<ContactIdentityChannel | null> {
  assertWorkspace(workspaceId)
  const row = await db.prepare(`SELECT ${identityColumns} FROM contact_channels cc JOIN channels ch
    ON ch.workspace_id = cc.workspace_id AND ch.id = cc.channel_id
    WHERE cc.workspace_id = ? AND cc.channel_id = ? AND cc.external_user_id = ?
      AND cc.identity_kind = 'bsuid' AND ch.type = 'whatsapp'`).bind(workspaceId, channelId, bsuid).first<Row>()
  return row ? identityChannel(row) : null
}

/** A conversation started from the inbox only knew the phone. When that person writes, the same row becomes their BSUID identity,
 * so the conversation, the consent and the history stay where they are. Returns whether a row was promoted. */
export async function promotePhoneIdentity(db: D1Database, workspaceId: string, channelId: string, bsuid: string, phoneE164: string): Promise<boolean> {
  assertWorkspace(workspaceId)
  if (!bsuidPattern.test(bsuid) || !phonePattern.test(phoneE164)) return false
  const result = await db.prepare(`UPDATE contact_channels SET external_user_id=?, identity_kind='bsuid', phone_e164=?
    WHERE workspace_id=? AND channel_id=? AND identity_kind='wa_phone_legacy' AND external_user_id=?
      AND NOT EXISTS (SELECT 1 FROM contact_channels WHERE channel_id=? AND external_user_id=?)`)
    .bind(bsuid, phoneE164, workspaceId, channelId, phoneE164.replace(/^\+/, ''), channelId, bsuid).run()
  return result.meta.changes > 0
}

/** Alias lookup is explicitly scoped to one WA channel; matching numbers on other channels never merge contacts. */
export async function getWhatsappIdentityByPhone(db: D1Database, workspaceId: string, channelId: string,
  phoneE164: string): Promise<ContactIdentityChannel | null> {
  assertWorkspace(workspaceId)
  const row = await db.prepare(`SELECT ${identityColumns} FROM contact_identity_aliases a
    JOIN contact_channels cc ON cc.workspace_id = a.workspace_id AND cc.id = a.contact_channel_id AND cc.channel_id = a.channel_id
    JOIN channels ch ON ch.workspace_id = cc.workspace_id AND ch.id = cc.channel_id
    WHERE a.workspace_id = ? AND a.channel_id = ? AND a.alias_kind = 'phone_e164' AND a.alias_value = ?
      AND cc.identity_kind = 'bsuid' AND ch.type = 'whatsapp'`).bind(workspaceId, channelId, phoneE164).first<Row>()
  return row ? identityChannel(row) : null
}

export type WhatsappIdentityInput = {
  contact_id: string
  channel_id: string
  bsuid: string
  phone_e164?: string | null
  username?: string | null
}

/** Atomic upsert + alias triggers. Existing identity/alias ownership may never be overwritten. */
export async function upsertWhatsappIdentity(db: D1Database, workspaceId: string,
  input: WhatsappIdentityInput, initialContact?: { firstName: string | null }): Promise<ContactIdentityChannel> {
  assertWorkspace(workspaceId)
  if (typeof input.bsuid !== "string" || !bsuidPattern.test(input.bsuid)) {
    throw new RepositoryError("Identidade WhatsApp exige o BSUID completo fornecido pela Meta.", 400)
  }
  if (input.phone_e164 != null && !phonePattern.test(input.phone_e164)) {
    throw new RepositoryError("Telefone deve estar no formato E.164.", 400)
  }
  let changes: number
  try {
    const contactKey = initialContact
      ? 'coalesce((SELECT contact_id FROM contact_channels WHERE workspace_id=c.workspace_id AND channel_id=ch.id AND external_user_id=?),?)'
      : '?'
    const upsert = db.prepare(`INSERT INTO contact_channels
      (id, workspace_id, contact_id, channel_id, external_user_id, identity_kind, phone_e164, username)
      SELECT ?, ?, c.id, ch.id, ?, 'bsuid', ?, ? FROM contacts c JOIN channels ch ON ch.workspace_id = c.workspace_id
      WHERE c.workspace_id = ? AND c.id = ${contactKey} AND c.status <> 'deleted' AND ch.id = ? AND ch.type = 'whatsapp'
      ON CONFLICT(channel_id, external_user_id) DO UPDATE SET contact_id = excluded.contact_id,
        identity_kind = excluded.identity_kind,
        phone_e164 = CASE WHEN ? THEN excluded.phone_e164 ELSE contact_channels.phone_e164 END,
        username = CASE WHEN ? THEN excluded.username ELSE contact_channels.username END`)
      .bind(crypto.randomUUID(), workspaceId, input.bsuid, input.phone_e164 ?? null, input.username ?? null,
        workspaceId, ...(initialContact ? [input.bsuid, input.contact_id] : [input.contact_id]), input.channel_id,
        input.phone_e164 !== undefined ? 1 : 0, input.username !== undefined ? 1 : 0)
    // Concurrent first messages converge before either can leave an orphan contact or move an identity.
    const result = initialContact ? (await db.batch([
      db.prepare(`INSERT INTO contacts(id,workspace_id,first_name,optin_source)
        SELECT ?,?,?,'whatsapp' WHERE NOT EXISTS (SELECT 1 FROM contact_channels
          WHERE workspace_id=? AND channel_id=? AND external_user_id=?) ON CONFLICT(id) DO NOTHING`)
        .bind(input.contact_id, workspaceId, initialContact.firstName, workspaceId, input.channel_id, input.bsuid),
      upsert,
    ]))[1] : await upsert.run()
    changes = result.meta.changes
  } catch (error) {
    if (error instanceof Error && /whatsapp_identity_immutable|UNIQUE constraint failed: contact_identity_aliases/.test(error.message)) {
      throw new RepositoryError("Identidade ou telefone já vinculado; conciliação explícita necessária.", 409)
    }
    throw error
  }
  if (!changes) throw new RepositoryError()
  const identity = await getWhatsappIdentity(db, workspaceId, input.channel_id, input.bsuid)
  if (!identity) throw new RepositoryError()
  return identity
}
