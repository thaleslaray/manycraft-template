import { importEmail, importPhone } from './contact-imports'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize } from './permissions'
import { bucketOf } from './media-blocks'
import { boundedBody, json } from './security'
import { inboundEventOwnerSql } from './channels/core/erasure'
import { getContact, listContacts, withTagsAndFields } from './db/contacts'
import { contactQueryFilterSchema, queryFilteredContacts } from './db/contact-filter'
import { contactsCsv } from './contacts-csv'
import { channelKinds } from './channels/types'
import type { Contact } from './contracts'
import { decode, type Row } from './db/shared'
import { tagContacts } from './db/tags'
import { activeRunStatusSql } from './flow/run-status'

export const contactActions = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const identifier = z.string().min(1).max(128)

async function activeContact(c: { env: Env; var: AuthVariables }, id: string) {
  const row = await c.env.DB.prepare("SELECT id FROM contacts WHERE workspace_id=? AND id=? AND status<>'deleted'")
    .bind(c.var.principal.workspaceId, id).first()
  if (!row) throw new HTTPException(404, { message: 'Contato não encontrado neste espaço.' })
}

const emailFilters = ['defined','undefined','opened','clicked','opened_clicked', 'opened_not_clicked','not_opened','subscribed','unsubscribed'] as const
/** Filtros rápidos da lista de contatos (query de GET /api/contacts, sem o cursor; também em `query` da exportação). */
const contactListFilter = {
  search: z.string().optional(),
  tag_id: z.string().optional(),
  status: z.enum(['subscribed', 'unsubscribed', 'deleted']).optional(),
  channel_type: z.enum(channelKinds).optional(),
  connection_id: z.string().min(1).max(128).optional(),
  trigger_id: z.string().optional(),
  sequence_id: z.string().max(128).optional(),
  email_filter: z.enum(emailFilters).optional(),
  segment_id: z.string().optional(),
  contact_filter: z.string().max(16000).optional(),
}
export const contactListQuerySchema = z.object({ cursor: z.string().optional(), ...contactListFilter })
export const contactPatchSchema = z.object({
  first_name: z.string().trim().max(60).nullable().optional(),
  last_name: z.string().trim().max(60).nullable().optional(),
  gender: z.string().max(30).nullable().optional(),
  locale: z.string().max(35).nullable().optional(),
  timezone: z.string().max(80).nullable().optional(),
  status: z.enum(['subscribed', 'unsubscribed']).optional(),
}).strict().refine(v => Object.keys(v).length > 0)
export const contactPauseSchema = z.object({ until: z.iso.datetime({ offset: true }).nullable() }).strict()
export const contactTagSchema = z.object({ tag_id: identifier, op: z.enum(['add','remove']) }).strict()
export const contactBulkTagSchema = z.object({ ids: z.array(identifier).min(1).max(100), tag_id: identifier, op: z.enum(['add', 'remove']) }).strict()
export const contactBulkCopyFieldSchema = z.object({ ids: z.array(identifier).min(1).max(100), field_id: identifier, target: z.enum(['email', 'phone']), overwrite: z.boolean().default(false) }).strict()
export const contactBulkDeleteSchema = z.object({ ids: z.array(identifier).min(1).max(100) }).strict()

contactActions.patch('/contacts/:id', async c => {
  authorize(c.var.principal, 'edit')
  const id = identifier.parse(c.req.param('id'))
  const patch = contactPatchSchema.parse(await json(c.req.raw))
  await activeContact(c, id)
  const entries = Object.entries(patch)
  // Account subscription never grants or erases the independent consent of a connection.
  await c.env.DB.prepare(`UPDATE contacts SET ${entries.map(([key]) => `${key}=?`).join(',')},updated_at=? WHERE workspace_id=? AND id=?`)
    .bind(...entries.map(([, value]) => value), Date.now(), c.var.principal.workspaceId, id).run()
  return c.json((await getContact(c.env.DB, c.var.principal.workspaceId, id))!.contact)
})

contactActions.put('/contacts/:id/pause', async c => {
  authorize(c.var.principal, 'contact:pause')
  const id = identifier.parse(c.req.param('id'))
  const { until } = contactPauseSchema.parse(await json(c.req.raw))
  await activeContact(c, id)
  await c.env.DB.prepare('UPDATE contacts SET automation_paused_until=?,updated_at=? WHERE workspace_id=? AND id=?')
    .bind(until === null ? null : Date.parse(until), Date.now(), c.var.principal.workspaceId, id).run()
  return c.json((await getContact(c.env.DB, c.var.principal.workspaceId, id))!.contact)
})

contactActions.post('/contacts/:id/tags', async c => {
  authorize(c.var.principal, 'edit')
  const id = identifier.parse(c.req.param('id'))
  const body = contactTagSchema.parse(await json(c.req.raw))
  await activeContact(c,id)
  return c.json(await tagContacts(c.env.DB,c.var.principal.workspaceId,[id],body.tag_id,body.op,false))
})

contactActions.post('/contacts/bulk-tag', async c => {
  authorize(c.var.principal, 'edit')
  await boundedBody(c.req.raw.clone(), 64 * 1024)
  const body = contactBulkTagSchema.parse(await json(c.req.raw))
  for (const id of new Set(body.ids)) await activeContact(c, id)
  return c.json(await tagContacts(c.env.DB, c.var.principal.workspaceId, body.ids, body.tag_id, body.op))
})

/** Tabelas ligadas ao contato por (workspace_id, contact_id). A exclusão apaga as linhas e a fusão leva as do secundário para o principal: as duas leem esta lista para não divergirem.
 * Fora dela, por não terem workspace_id e seguirem a linha-mãe: flow_question_answers (por flow_questions) e email_message_links (por email_messages). */
export const contactOwnedTables = ['sequence_subscriptions', 'flow_random_assignments', 'contact_field_values', 'contact_tags', 'rule_events', 'rule_executions', 'team_notifications',
  'flow_questions', 'email_messages', 'email_events', 'external_request_logs', 'message_callbacks', 'topic_subscriptions', 'trigger_follow_ups'] as const
/** As que a exclusão apaga numa só consulta; as três restantes têm filhas ou condição própria e são apagadas à parte, nesta ordem. */
const erasedPlainly = contactOwnedTables.filter(table => !['flow_questions', 'email_messages', 'email_events'].includes(table))

/** D1 batch is a transaction: keep the anonymous statistical record and remove its operational data. */
export async function deleteContacts(env: Pick<Env, 'DB' | 'FLOW_RUN' | 'INBOX_HUB'> & { MEDIA?: R2Bucket; INBOUND_MEDIA?: R2Bucket }, workspaceId: string, ids: string[],
  options: { beforeErase?: D1PreparedStatement[]; afterErase?: D1PreparedStatement[]; skipTerminationRunId?: string } = {}) {
  const selection = JSON.stringify([...new Set(ids)])
  const selected = 'SELECT value FROM json_each(?)'
  const contacts = await env.DB.prepare(`SELECT id FROM contacts WHERE workspace_id=? AND id IN (${selected})`)
    .bind(workspaceId, selection).all<{ id: string }>()
  if (contacts.results.length !== JSON.parse(selection).length) throw new HTTPException(404, { message: 'Contato não encontrado neste workspace.' })
  const conversations = await env.DB.prepare(`SELECT v.id,cc.contact_id FROM conversations v
    JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id
    WHERE cc.workspace_id=? AND cc.contact_id IN (${selected})`).bind(workspaceId, selection).all<{ id: string; contact_id: string }>()
  const runs = await env.DB.prepare(`SELECT id FROM flow_runs WHERE workspace_id=? AND contact_id IN (${selected})
    AND status IN (${activeRunStatusSql})`).bind(workspaceId, selection).all<{ id: string }>()
  const runSelection = `SELECT id FROM flow_runs WHERE workspace_id=? AND contact_id IN (${selected})`
  // Files the contact sent live in the media store, linked from their messages: they go with the conversation.
  const files = `SELECT json_extract(m.content,'$.media.id') FROM messages m WHERE m.workspace_id=? AND json_extract(m.content,'$.media.id') IS NOT NULL AND m.conversation_id IN
    (SELECT v.id FROM conversations v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id WHERE cc.workspace_id=? AND cc.contact_id IN (${selected}))`
  const fileRows = (await env.DB.prepare(`SELECT object_key,bucket FROM media_objects WHERE workspace_id=? AND id IN (${files})`).bind(workspaceId, workspaceId, workspaceId, selection).all<{ object_key: string; bucket: string }>()).results
  await env.DB.batch([
    ...options.beforeErase ?? [],
    env.DB.prepare(`UPDATE flow_runs SET status='cancelled',wait_until=NULL,error=NULL,updated_at=?
      WHERE workspace_id=? AND contact_id IN (${selected}) AND status IN (${activeRunStatusSql})`)
      .bind(Date.now(), workspaceId, selection),
    // Keep ingestion receipts so replay of an old update cannot recreate erased data.
    env.DB.prepare(`UPDATE inbound_events SET payload='{}',processed_at=coalesce(processed_at,?),planned_at=coalesce(planned_at,?)
      WHERE workspace_id=? AND (id IN (SELECT inbound_event_id FROM flow_runs WHERE workspace_id=? AND contact_id IN (${selected}))
      OR EXISTS (SELECT 1 FROM contact_channels cc JOIN channels ch ON ch.workspace_id=cc.workspace_id AND ch.id=cc.channel_id
        WHERE cc.workspace_id=inbound_events.workspace_id AND cc.channel_id=inbound_events.channel_id
        AND cc.contact_id IN (${selected}) AND ${inboundEventOwnerSql()}))`)
      .bind(Date.now(), Date.now(), workspaceId, workspaceId, selection, selection),
    env.DB.prepare(`DELETE FROM button_tokens WHERE workspace_id=? AND run_id IN (${runSelection})`).bind(workspaceId, workspaceId, selection),
    env.DB.prepare(`DELETE FROM flow_clicks WHERE run_id IN (${runSelection})`).bind(workspaceId, selection),
    env.DB.prepare(`DELETE FROM flow_outbound WHERE run_id IN (${runSelection})`).bind(workspaceId, selection),
    env.DB.prepare(`DELETE FROM comment_effects WHERE workspace_id=? AND run_id IN (${runSelection})`).bind(workspaceId, workspaceId, selection),
    env.DB.prepare(`UPDATE flow_runs SET comment_context=NULL,story_context=NULL WHERE workspace_id=? AND contact_id IN (${selected})`).bind(workspaceId, selection),
    // Field/tag removal emits events (rule_events, rule_executions): their retained values and execution snapshots go too.
    ...erasedPlainly.map(table =>
      env.DB.prepare(`DELETE FROM ${table} WHERE workspace_id=? AND contact_id IN (${selected})`).bind(workspaceId, selection)),
    // What the contact answered or received goes too. Consent records (contact_consents) and anonymous pixel statistics stay on purpose.
    env.DB.prepare(`DELETE FROM flow_question_answers WHERE (run_id,step_index) IN
      (SELECT run_id,step_index FROM flow_questions WHERE workspace_id=? AND contact_id IN (${selected}))`).bind(workspaceId, selection),
    env.DB.prepare(`DELETE FROM flow_questions WHERE workspace_id=? AND contact_id IN (${selected})`).bind(workspaceId, selection),
    env.DB.prepare(`DELETE FROM email_message_links WHERE message_id IN
      (SELECT id FROM email_messages WHERE workspace_id=? AND contact_id IN (${selected}))`).bind(workspaceId, selection),
    env.DB.prepare(`DELETE FROM email_events WHERE workspace_id=? AND (contact_id IN (${selected})
      OR message_id IN (SELECT id FROM email_messages WHERE workspace_id=? AND contact_id IN (${selected})))`).bind(workspaceId, selection, workspaceId, selection),
    env.DB.prepare(`DELETE FROM email_messages WHERE workspace_id=? AND contact_id IN (${selected})`).bind(workspaceId, selection),
    env.DB.prepare(`DELETE FROM inbound_media WHERE workspace_id=? AND media_id IN (${files})`).bind(workspaceId, workspaceId, workspaceId, selection),
    env.DB.prepare(`DELETE FROM media_objects WHERE workspace_id=? AND id IN (${files})`).bind(workspaceId, workspaceId, workspaceId, selection),
    // W4 tag/field DELETE triggers can create system items above; erase the entire timeline afterwards.
    env.DB.prepare(`DELETE FROM messages WHERE workspace_id=? AND conversation_id IN
      (SELECT v.id FROM conversations v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id
        WHERE cc.workspace_id=? AND cc.contact_id IN (${selected}))`).bind(workspaceId, workspaceId, selection),
    // What the person wrote in groups goes too (the group keeps the automation's answers).
    env.DB.prepare(`DELETE FROM group_messages WHERE workspace_id=? AND author_contact_id IN (${selected})`).bind(workspaceId, selection),
    env.DB.prepare(`DELETE FROM conversations WHERE workspace_id=? AND contact_channel_id IN
      (SELECT id FROM contact_channels WHERE workspace_id=? AND contact_id IN (${selected}))`).bind(workspaceId, workspaceId, selection),
    // W7 contact_identity_aliases cascade from each channel identity, including historical phones.
    env.DB.prepare(`DELETE FROM contact_channels WHERE workspace_id=? AND contact_id IN (${selected})`).bind(workspaceId, selection),
    env.DB.prepare(`UPDATE contacts SET status='deleted',first_name=NULL,last_name=NULL,gender=NULL,locale=NULL,timezone=NULL,
      profile_pic_url=NULL,optin_source=NULL,last_input_text=NULL,last_interaction_at=NULL,ad_source_id=NULL,ad_source_type=NULL,ad_headline=NULL,ad_click_id=NULL,ad_source_url=NULL,ad_referred_at=NULL,last_cart=NULL,automation_paused_until=NULL,updated_at=?
      WHERE workspace_id=? AND id IN (${selected})`).bind(Date.now(), workspaceId, selection),
    ...options.afterErase ?? [],
  ])
  // The database is authoritative; a stored file that fails to go here is an orphan nobody can reach (the key was only in the erased messages).
  for (const bucket of ['media', 'inbound']) {
    const keys = fileRows.filter(r => r.bucket === bucket).map(r => r.object_key)
    if (keys.length) await bucketOf(env, bucket)?.delete(keys).catch(() => {})
  }
  // A failed termination cannot undo committed erasure. Live guards also stop cancelled runs on wake/retry.
  await Promise.all(runs.results.map(async run => {
    if (run.id === options.skipTerminationRunId) return
    try { await (await env.FLOW_RUN?.get(run.id))?.terminate() } catch { /* D1 cancellation remains authoritative. */ }
  }))
  for (const contact of contacts.results) {
    await env.INBOX_HUB?.get(env.INBOX_HUB.idFromName(workspaceId)).notify({ type: 'contact_deleted', contact_id: contact.id,
      conversation_ids: conversations.results.filter(v => v.contact_id === contact.id).map(v => v.id) })
  }
  return { deleted_ids: contacts.results.map(row => row.id), conversation_ids: conversations.results.map(row => row.id) }
}

contactActions.delete('/contacts/:id', async c => {
  authorize(c.var.principal, 'edit')
  return c.json(await deleteContacts(c.env, c.var.principal.workspaceId, [identifier.parse(c.req.param('id'))]))
})
/** Lote: copia um campo personalizado para o e-mail ou o telefone do contato. Valor inválido ou já usado por outro contato é pulado e contado. */
contactActions.post('/contacts/bulk-copy-field', async c => {
  authorize(c.var.principal, 'edit')
  await boundedBody(c.req.raw.clone(), 64 * 1024)
  const body = contactBulkCopyFieldSchema.parse(await json(c.req.raw))
  const ws = c.var.principal.workspaceId
  const values = await c.env.DB.prepare(`SELECT v.contact_id,json_extract(v.value,'$') AS value,c.email,c.phone FROM contact_field_values v JOIN contacts c ON c.workspace_id=v.workspace_id AND c.id=v.contact_id
    WHERE v.workspace_id=? AND v.field_id=? AND c.status<>'deleted' AND v.contact_id IN (SELECT value FROM json_each(?))`).bind(ws, body.field_id, JSON.stringify(body.ids))
    .all<{ contact_id: string; value: unknown; email: string | null; phone: string | null }>()
  let copied = 0, skipped = body.ids.length - values.results.length
  for (const row of values.results) {
    const parsed = (body.target === 'email' ? importEmail : importPhone).safeParse(String(row.value ?? ''))
    if (!parsed.success || (!body.overwrite && row[body.target] !== null)) { skipped++; continue }
    try {
      await c.env.DB.prepare(`UPDATE contacts SET ${body.target}=? WHERE workspace_id=? AND id=?`).bind(parsed.data, ws, row.contact_id).run()
      copied++
    } catch { skipped++ } // outro contato já usa esse e-mail/telefone
  }
  return c.json({ copied, skipped })
})

contactActions.post('/contacts/bulk-delete', async c => {
  authorize(c.var.principal, 'edit')
  await boundedBody(c.req.raw.clone(), 64 * 1024)
  let raw: unknown
  try { raw = await c.req.json() } catch { throw new HTTPException(400, { message: 'JSON inválido.' }) }
  const { ids } = contactBulkDeleteSchema.parse(raw)
  return c.json(await deleteContacts(c.env, c.var.principal.workspaceId, ids))
})

const EXPORT_LIMIT = 50000
export const contactExportSchema = z.object({
  ids: z.array(identifier).min(1).max(EXPORT_LIMIT).optional(),
  filter: contactQueryFilterSchema.optional(),
  search: z.string().max(200).optional(),
  query: z.object(contactListFilter).strict().optional(),
}).strict()
/** Exportar para CSV: os contatos selecionados (`ids`), os de um filtro avançado (`filter`) ou os da lista com os filtros rápidos (`query`). Excluídos ficam de fora. */
contactActions.post('/contacts/export', async c => {
  authorize(c.var.principal, 'read')
  const ws = c.var.principal.workspaceId
  const data = contactExportSchema.parse(await json(c.req.raw))
  if (data.ids && (data.filter || data.query)) throw new HTTPException(400, { message: 'Informe os contatos escolhidos ou um filtro, não os dois.' })
  const rows: Contact[] = []
  if (data.ids) {
    for (let at = 0; at < data.ids.length; at += 500) {
      const chunk = data.ids.slice(at, at + 500)
      const found = await c.env.DB.prepare(`SELECT * FROM contacts WHERE workspace_id=? AND status<>'deleted' AND id IN (SELECT value FROM json_each(?)) ORDER BY subscribed_at DESC,id DESC`)
        .bind(ws, JSON.stringify(chunk)).all<Row>()
      rows.push(...await withTagsAndFields(c.env.DB, ws, found.results.map(row => decode<Contact>(row))))
    }
  } else {
    let cursor: string | null = null
    do {
      const page: { rows: Contact[]; next_cursor: string | null } = data.filter
        ? await queryFilteredContacts(c.env.DB, ws, data.filter, cursor, data.search, 500)
        : await listContacts(c.env.DB, ws, cursor, data.query ?? {}, 500)
      rows.push(...page.rows)
      cursor = page.next_cursor
    } while (cursor && rows.length < EXPORT_LIMIT)
  }
  return c.json({ csv: contactsCsv(rows), count: rows.length, file_name: `contatos-${new Date().toISOString().slice(0, 10)}.csv` })
})
