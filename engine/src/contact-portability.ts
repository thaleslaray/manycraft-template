import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize } from './permissions'
import { boundedBody, json } from './security'
import { getContact, type ContactIdentityDetail } from './db/contacts'
import { decode, type Row } from './db/shared'
import { inboundEventOwnerSql } from './channels/core/erasure'
import { reparentIdentityIndexes } from './channels/core/contact-reparent'
import { contactOwnedTables, deleteContacts } from './contacts'
import { activeRunStatusSql } from './flow/run-status'
import { changeConsent } from './channels/core/consent'

export const contactPortability = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const id = z.string().min(1).max(128)
const pair = { primary_id: id, secondary_id: id }
const selection = 'SELECT value FROM json_each(?)'
const pausedIndefinitely = 253402300799000
export const contactCleanupSchema = z.object({ inactive_days: z.number().int().min(7).max(3650), action: z.enum(['tag', 'unsubscribe', 'delete']), tag_id: id.optional(), apply: z.boolean().default(false) })
  .strict().refine(b => b.action !== 'tag' || b.tag_id, 'Escolha a tag.')
export const contactBulkUnsubscribeSchema = z.object({ ids: z.array(id).min(1).max(100), confirmation: z.literal('DESCADASTRAR') }).strict()
export const contactBulkPauseSchema = z.object({ ids: z.array(id).min(1).max(100), confirmation: z.literal('PAUSAR') }).strict()
const requestKinds = ['access', 'export', 'correction', 'deletion', 'unsubscribe', 'other'] as const
export const contactDataRequestSchema = z.object({ kind: z.enum(requestKinds), note: z.string().trim().max(1000).optional(), requested_at: z.iso.datetime({ offset: true }).optional() }).strict()
export const contactMergePreviewSchema = z.object(pair).strict()
export const contactMergeSchema = z.object({ ...pair, confirmation: z.literal('MESCLAR') }).strict()

async function activeContact(db: D1Database, workspace: string, contactId: string) {
  const detail = await getContact(db, workspace, contactId)
  if (!detail || detail.contact.status === 'deleted') throw new HTTPException(404, { message: 'Contato não encontrado neste espaço.' })
  return detail
}
// Evaluate the complete selection in the same transaction as the writes: no deleted
// tombstone can be revived if an erasure wins the race before the batch commits.
const activeBatchGuard = `(SELECT count(*) FROM contacts c WHERE c.workspace_id=? AND c.status<>'deleted' AND c.id IN (${selection}))=?`
function selectedContacts(ids: string[]) {
  const unique = [...new Set(ids)]
  return { selected: JSON.stringify(unique), count: unique.length }
}
function assertBatchCount(actual: number, expected: number) {
  if (actual !== expected) throw new HTTPException(404, { message: 'Um dos contatos não está disponível neste espaço.' })
}

/** Limpeza da lista: contatos sem interação há N dias. Sem `apply` só conta; com `apply` age em todos os que casam (exclusão em levas de 500). */
contactPortability.post('/contacts/cleanup', async c => {
  authorize(c.var.principal, 'edit')
  await boundedBody(c.req.raw.clone(), 8 * 1024)
  const body = contactCleanupSchema.parse(await json(c.req.raw))
  const workspace = c.var.principal.workspaceId, cutoff = Date.now() - body.inactive_days * 86400_000
  const match = `workspace_id=? AND status<>'deleted' AND coalesce(last_interaction_at,subscribed_at)<?${body.action === 'unsubscribe' ? " AND status='subscribed'" : ''}`
  const count = (await c.env.DB.prepare(`SELECT count(*) AS n FROM contacts WHERE ${match}`).bind(workspace, cutoff).first<number>('n')) ?? 0
  if (!body.apply) return c.json({ count })
  if (body.action === 'tag') {
    if (!await c.env.DB.prepare('SELECT 1 FROM tags WHERE workspace_id=? AND id=?').bind(workspace, body.tag_id!).first()) throw new HTTPException(404, { message: 'Tag não encontrada.' })
    await c.env.DB.prepare(`INSERT INTO contact_tags (workspace_id,contact_id,tag_id) SELECT workspace_id,id,? FROM contacts WHERE ${match} ON CONFLICT DO NOTHING`).bind(body.tag_id!, workspace, cutoff).run()
    return c.json({ count, done: count, remaining: 0 })
  }
  if (body.action === 'unsubscribe') {
    const now = Date.now()
    await c.env.DB.batch([
      changeConsent(c.env.DB, { optedIn: false, at: now, where: { sql: `workspace_id=? AND contact_id IN (SELECT id FROM contacts WHERE ${match})`, binds: [workspace, workspace, cutoff] } }),
      c.env.DB.prepare(`UPDATE contacts SET status='unsubscribed',updated_at=? WHERE ${match}`).bind(now, workspace, cutoff),
    ])
    return c.json({ count, done: count, remaining: 0 })
  }
  const ids = (await c.env.DB.prepare(`SELECT id FROM contacts WHERE ${match} LIMIT 500`).bind(workspace, cutoff).all<{ id: string }>()).results.map(r => r.id)
  for (let i = 0; i < ids.length; i += 100) await deleteContacts(c.env, workspace, ids.slice(i, i + 100))
  return c.json({ count, done: ids.length, remaining: count - ids.length })
})

contactPortability.post('/contacts/bulk-unsubscribe', async c => {
  authorize(c.var.principal, 'edit')
  await boundedBody(c.req.raw.clone(), 64 * 1024)
  const body = contactBulkUnsubscribeSchema.parse(await json(c.req.raw))
  const workspace = c.var.principal.workspaceId
  const { selected, count } = selectedContacts(body.ids)
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE contacts SET status='unsubscribed',updated_at=? WHERE workspace_id=? AND status<>'deleted' AND id IN (${selection}) AND ${activeBatchGuard} RETURNING id`)
      .bind(Date.now(), workspace, selected, workspace, selected, count),
    changeConsent(c.env.DB, { optedIn: false, where: { sql: `workspace_id=? AND contact_id IN (${selection}) AND ${activeBatchGuard}`, binds: [workspace, selected, workspace, selected, count] } }),
  ])
  assertBatchCount(results[0]!.results.length, count)
  return c.json({ count })
})
contactPortability.post('/contacts/bulk-pause', async c => {
  authorize(c.var.principal, 'edit')
  await boundedBody(c.req.raw.clone(), 64 * 1024)
  const body = contactBulkPauseSchema.parse(await json(c.req.raw))
  const workspace = c.var.principal.workspaceId
  const { selected, count } = selectedContacts(body.ids)
  const result = await c.env.DB.prepare(`UPDATE contacts SET automation_paused_until=?,updated_at=? WHERE workspace_id=? AND status<>'deleted' AND id IN (${selection}) AND ${activeBatchGuard} RETURNING id`)
    .bind(pausedIndefinitely, Date.now(), workspace, selected, workspace, selected, count).all()
  assertBatchCount(result.results.length, count)
  return c.json({ count })
})

/** Pedidos do titular: registrar com data e autor (quem estava logado) e listar, inclusive de contato já excluído. */
contactPortability.get('/contacts/:id/data-requests', async c => {
  authorize(c.var.principal, 'read')
  const rows = await c.env.DB.prepare(`SELECT r.id,r.kind,r.note,r.requested_at,r.contact_label,coalesce(u.name,u.email,r.recorded_by) AS recorded_by FROM data_subject_requests r
    LEFT JOIN "user" u ON u.id=r.recorded_by WHERE r.workspace_id=? AND r.contact_id=? ORDER BY r.requested_at DESC,r.id`).bind(c.var.principal.workspaceId, id.parse(c.req.param('id')))
    .all<{ id: string; kind: string; note: string | null; requested_at: number; contact_label: string; recorded_by: string }>()
  return c.json(rows.results.map(r => ({ ...r, requested_at: new Date(r.requested_at).toISOString() })))
})
contactPortability.post('/contacts/:id/data-requests', async c => {
  authorize(c.var.principal, 'edit')
  await boundedBody(c.req.raw.clone(), 8 * 1024)
  const body = contactDataRequestSchema.parse(await json(c.req.raw))
  const workspace = c.var.principal.workspaceId, contactId = id.parse(c.req.param('id'))
  const contact = await c.env.DB.prepare("SELECT first_name,last_name,email FROM contacts WHERE workspace_id=? AND id=? AND status<>'deleted'").bind(workspace, contactId)
    .first<{ first_name: string | null; last_name: string | null; email: string | null }>()
  if (!contact) throw new HTTPException(404, { message: 'Contato não encontrado.' })
  const label = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email || contactId
  const requestedAt = body.requested_at ? Date.parse(body.requested_at) : Date.now()
  if (requestedAt > Date.now() + 60_000) throw new HTTPException(400, { message: 'A data do pedido não pode estar no futuro.' })
  const requestId = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO data_subject_requests (id,workspace_id,contact_id,contact_label,kind,note,requested_at,recorded_by) VALUES (?,?,?,?,?,?,?,?)')
    .bind(requestId, workspace, contactId, label, body.kind, body.note || null, requestedAt, c.var.principal.userId).run()
  return c.json({ id: requestId }, 201)
})

contactPortability.get('/contacts/:id/export', async c => {
  authorize(c.var.principal, 'read')
  const workspace = c.var.principal.workspaceId
  const contactId = id.parse(c.req.param('id'))
  // O contato (que dá 404 se não existe) e as três leituras de dados saem na mesma onda.
  const [detail, fields, conversations, messages] = await Promise.all([
    activeContact(c.env.DB, workspace, contactId),
    c.env.DB.prepare(`SELECT f.id,f.name,f.type,v.value FROM contact_field_values v JOIN custom_fields f
      ON f.workspace_id=v.workspace_id AND f.id=v.field_id WHERE v.workspace_id=? AND v.contact_id=? ORDER BY f.name,f.id`)
      .bind(workspace, contactId).all<Row>(),
    c.env.DB.prepare(`SELECT v.id,v.status,v.assignee_id,v.unread_count,v.last_message_at,v.created_at,v.updated_at,cc.channel_id
      FROM conversations v JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id
      WHERE cc.workspace_id=? AND cc.contact_id=? ORDER BY v.created_at,v.id`).bind(workspace, contactId).all<Row>(),
    c.env.DB.prepare(`SELECT m.id,m.conversation_id,m.direction,m.source,m.content,m.created_at FROM messages m
      JOIN conversations v ON v.workspace_id=m.workspace_id AND v.id=m.conversation_id
      JOIN contact_channels cc ON cc.workspace_id=v.workspace_id AND cc.id=v.contact_channel_id
      WHERE cc.workspace_id=? AND cc.contact_id=? ORDER BY m.created_at,m.id`).bind(workspace, contactId).all<Row>(),
  ])
  c.header('Content-Disposition', 'attachment; filename="dados-contato.json"')
  c.header('Cache-Control', 'no-store')
  return c.json({ contact: detail.contact, channels: detail.channels, tags: detail.tags,
    fields: fields.results.map(row => decode(row)), conversations: conversations.results.map(row => ({ ...decode<Row>(row),
      messages: messages.results.filter(m => m.conversation_id === row.id).map(m => ({ ...decode<Row>(m), content: JSON.parse(String(m.content)) })),
    })) })
})

async function compare(db: D1Database, workspace: string, primaryId: string, secondaryId: string) {
  if (primaryId === secondaryId) throw new HTTPException(400, { message: 'Escolha dois contatos diferentes.' })
  const [primary, secondary] = await Promise.all([activeContact(db, workspace, primaryId), activeContact(db, workspace, secondaryId)])
  const channels = [...primary.channels, ...secondary.channels]
  const duplicated = [...new Set(channels.map(channel => channel.channel_type))].filter(type => channels.filter(channel => channel.channel_type === type).length > 1)
  const name = (detail: ContactIdentityDetail, type: string) => detail.channels.find(channel => channel.channel_type === type)?.connection_name ?? null
  return { primary, secondary, can_merge: duplicated.length === 0,
    conflicts: duplicated.map(channel_type => ({ channel_type, primary_connection_name: name(primary, channel_type), secondary_connection_name: name(secondary, channel_type) })) }
}
contactPortability.post('/contacts/merge-preview', async c => {
  authorize(c.var.principal, 'edit')
  const body = contactMergePreviewSchema.parse(await json(c.req.raw))
  return c.json(await compare(c.env.DB, c.var.principal.workspaceId, body.primary_id, body.secondary_id))
})
contactPortability.post('/contacts/merge', async c => {
  authorize(c.var.principal, 'edit')
  const body = contactMergeSchema.parse(await json(c.req.raw))
  const workspace = c.var.principal.workspaceId, primaryId = body.primary_id, secondaryId = body.secondary_id
  const preview = await compare(c.env.DB, workspace, primaryId, secondaryId)
  if (!preview.can_merge) throw new HTTPException(409, { message: 'A mescla criaria duas identidades do mesmo canal. Escolha outros contatos.' })
  const db = c.env.DB, now = Date.now()
  const secondary = await db.prepare('SELECT * FROM contacts WHERE workspace_id=? AND id=?').bind(workspace, secondaryId).first<Row>()
  const runs = await db.prepare(`SELECT id FROM flow_runs WHERE workspace_id=? AND contact_id=? AND status IN (${activeRunStatusSql})`)
    .bind(workspace, secondaryId).all<{ id: string }>()
  const runSelection = 'SELECT id FROM flow_runs WHERE workspace_id=? AND contact_id=?'
  const fillable = ['first_name', 'last_name', 'gender', 'locale', 'timezone', 'profile_pic_url', 'email', 'phone']
  try {
    await db.batch([
      // Trigger checks live availability and channel uniqueness inside the transaction, closing preview/confirm races.
      db.prepare('INSERT INTO contact_merges(workspace_id,secondary_id,primary_id,created_at) VALUES (?,?,?,?)').bind(workspace, secondaryId, primaryId, now),
      db.prepare(`UPDATE flow_runs SET status='cancelled',wait_until=NULL,error=NULL,updated_at=? WHERE workspace_id=? AND contact_id=?
        AND status IN (${activeRunStatusSql})`).bind(now, workspace, secondaryId),
      db.prepare(`DELETE FROM button_tokens WHERE workspace_id=? AND run_id IN (${runSelection})`).bind(workspace, workspace, secondaryId),
      db.prepare('DELETE FROM sequence_subscriptions WHERE workspace_id=? AND contact_id=?').bind(workspace, secondaryId),
      db.prepare(`UPDATE broadcast_recipients SET status=CASE WHEN status='sending' THEN 'uncertain' ELSE 'skipped' END,
        reason='contact_merged',updated_at=? WHERE workspace_id=? AND status IN ('queued','sending') AND contact_channel_id IN
        (SELECT id FROM contact_channels WHERE workspace_id=? AND contact_id=?)`).bind(now, workspace, workspace, secondaryId),
      db.prepare(`UPDATE inbound_events SET processed_at=coalesce(processed_at,?),planned_at=coalesce(planned_at,?) WHERE workspace_id=?
        AND EXISTS (SELECT 1 FROM contact_channels cc JOIN channels ch ON ch.workspace_id=cc.workspace_id AND ch.id=cc.channel_id
          WHERE cc.workspace_id=inbound_events.workspace_id AND cc.channel_id=inbound_events.channel_id
          AND cc.contact_id=? AND ${inboundEventOwnerSql()})`).bind(now, now, workspace, secondaryId),
      db.prepare(`INSERT INTO contact_tags(workspace_id,contact_id,tag_id,created_at) SELECT workspace_id,?,tag_id,created_at
        FROM contact_tags WHERE workspace_id=? AND contact_id=? ON CONFLICT(contact_id,tag_id) DO NOTHING`).bind(primaryId, workspace, secondaryId),
      db.prepare(`INSERT INTO contact_field_values(workspace_id,contact_id,field_id,value,updated_at) SELECT workspace_id,?,field_id,value,updated_at
        FROM contact_field_values WHERE workspace_id=? AND contact_id=? ON CONFLICT(contact_id,field_id) DO NOTHING`).bind(primaryId, workspace, secondaryId),
      // Release the unique addresses before filling primary gaps; rollback restores both if anything fails.
      db.prepare('UPDATE contacts SET email=NULL,phone=NULL WHERE workspace_id=? AND id=?').bind(workspace, secondaryId),
      db.prepare(`UPDATE contacts SET ${fillable.map(field => `${field}=coalesce(nullif(${field},''),?)`).join(',')},
        status=CASE WHEN status='unsubscribed' OR (SELECT status FROM contacts WHERE workspace_id=? AND id=?)='unsubscribed' THEN 'unsubscribed' ELSE status END,
        automation_paused_until=nullif(max(coalesce(automation_paused_until,0),coalesce((SELECT automation_paused_until FROM contacts WHERE workspace_id=? AND id=?),0)),0),updated_at=? WHERE workspace_id=? AND id=?`)
        .bind(...fillable.map(field => secondary![field] as string | null), workspace, secondaryId, workspace, secondaryId, now, workspace, primaryId),
      // The first ad origin stays with the person: the secondary's is taken over only when the primary has none.
      db.prepare(`UPDATE contacts SET ad_source_id=?,ad_source_type=?,ad_headline=?,ad_click_id=?,ad_source_url=?,ad_referred_at=? WHERE workspace_id=? AND id=? AND ad_referred_at IS NULL AND ? IS NOT NULL`)
        .bind(secondary!.ad_source_id ?? null, secondary!.ad_source_type ?? null, secondary!.ad_headline ?? null, secondary!.ad_click_id ?? null, secondary!.ad_source_url ?? null,
          secondary!.ad_referred_at ?? null, workspace, primaryId, secondary!.ad_referred_at ?? null),
      // Move identities, not conversations: every conversation, message and alias retains its stable key.
      db.prepare('UPDATE contact_channels SET contact_id=?,updated_at=? WHERE workspace_id=? AND contact_id=?').bind(primaryId, now, workspace, secondaryId),
      db.prepare('UPDATE group_messages SET author_contact_id=? WHERE workspace_id=? AND author_contact_id=?').bind(primaryId, workspace, secondaryId),
      ...reparentIdentityIndexes(db, workspace, primaryId, secondaryId),
      ...['contact_tags', 'contact_field_values'].map(table => db.prepare(`DELETE FROM ${table} WHERE workspace_id=? AND contact_id=?`).bind(workspace, secondaryId)),
      // Everything else the secondary owned goes to the primary, so a later erasure of the primary reaches it. A row that would collide with one of the primary's
      // (same key) is dropped: the primary's stays. Tags, fields and sequences were handled above; the secondary's open question is closed first (one open per contact and channel).
      db.prepare(`UPDATE flow_questions SET status='stopped' WHERE workspace_id=? AND contact_id=? AND status='open'`).bind(workspace, secondaryId),
      db.prepare('UPDATE flow_runs SET contact_id=? WHERE workspace_id=? AND contact_id=?').bind(primaryId, workspace, secondaryId),
      ...contactOwnedTables.filter(table => !['sequence_subscriptions', 'contact_field_values', 'contact_tags'].includes(table)).flatMap(table => [
        db.prepare(`UPDATE OR IGNORE ${table} SET contact_id=? WHERE workspace_id=? AND contact_id=?`).bind(primaryId, workspace, secondaryId),
        db.prepare(`DELETE FROM ${table} WHERE workspace_id=? AND contact_id=?`).bind(workspace, secondaryId),
      ]),
      db.prepare(`UPDATE contacts SET status='deleted',first_name=NULL,last_name=NULL,gender=NULL,locale=NULL,timezone=NULL,profile_pic_url=NULL,
        optin_source=NULL,last_input_text=NULL,last_interaction_at=NULL,ad_source_id=NULL,ad_source_type=NULL,ad_headline=NULL,ad_click_id=NULL,ad_source_url=NULL,ad_referred_at=NULL,last_cart=NULL,automation_paused_until=NULL,updated_at=? WHERE workspace_id=? AND id=?`).bind(now, workspace, secondaryId),
    ])
  } catch (error) {
    if (String(error).includes('merge_channel_conflict') || String(error).includes('merge_contact_unavailable') || String(error).includes('UNIQUE constraint failed')) {
      throw new HTTPException(409, { message: 'Os contatos mudaram desde a comparação. Compare novamente antes de mesclar.' })
    }
    throw error
  }
  await Promise.all(runs.results.map(async run => {
    try { await (await c.env.FLOW_RUN?.get(run.id))?.terminate() } catch { /* Durable cancellation blocks retries even if the workflow is unavailable. */ }
  }))
  return c.json({ primary_id: primaryId, secondary_id: secondaryId, merged: true })
})
