import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize } from './permissions'
import { json } from './security'
import { stateInSql } from './channels/core/connection-state'
import { enrollmentConnectionReadySql, enrollmentStateSql } from './flow/sequence-state'

export const contactSequences = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const id = z.string().min(1).max(128)
export const contactBulkSequenceSchema = z.object({ ids: z.array(id).min(1).max(100), sequence_id: id }).strict()

contactSequences.get('/contacts/:id/sequences', async c => {
  const workspace = c.var.principal.workspaceId
  const contact = id.parse(c.req.param('id'))
  // A existência do contato e as inscrições saem juntas; sem contato, a resposta é 404 e as linhas lidas não vão a lugar nenhum.
  const [found, rows] = await Promise.all([
    c.env.DB.prepare("SELECT id FROM contacts WHERE workspace_id=? AND id=? AND status<>'deleted'").bind(workspace, contact).first(),
    // state: agendada, passo em andamento ou terminada (flow/sequence-state.ts); connection_ready diz se a agendada sai na hora ou espera a conexão.
    c.env.DB.prepare(`SELECT s.sequence_id,s.enrollment_id,q.name,s.next_step,s.next_at,
    s.pending_run_id,s.created_at,ch.display_name AS connection_name,${enrollmentStateSql('s')} AS state,
    CASE WHEN ch.id IS NOT NULL AND ${enrollmentConnectionReadySql('ch')} THEN 1 ELSE 0 END AS connection_ready
    FROM sequence_subscriptions s JOIN sequences q ON q.workspace_id=s.workspace_id AND q.id=s.sequence_id
    LEFT JOIN channels ch ON ch.workspace_id=s.workspace_id AND ch.id=s.channel_id
    WHERE s.workspace_id=? AND s.contact_id=? ORDER BY q.name,q.id`).bind(workspace, contact).all(),
  ])
  if (!found) throw new HTTPException(404)
  return c.json(rows.results)
})

contactSequences.post('/contacts/bulk-sequence', async c => {
  authorize(c.var.principal, 'edit')
  const body = contactBulkSequenceSchema.parse(await json(c.req.raw))
  const workspace = c.var.principal.workspaceId
  if (!await c.env.DB.prepare('SELECT id FROM sequences WHERE workspace_id=? AND id=?').bind(workspace, body.sequence_id).first()) throw new HTTPException(404)
  const first = await c.env.DB.prepare(`SELECT position,delay_seconds FROM sequence_steps WHERE workspace_id=? AND sequence_id=? AND status='live' ORDER BY position LIMIT 1`)
    .bind(workspace, body.sequence_id).first<{ position: number; delay_seconds: number }>()
  const ids = [...new Set(body.ids)]
  const contacts = await c.env.DB.prepare(`SELECT c.id,
    (SELECT cc.channel_id FROM contact_channels cc JOIN channels ch ON ch.workspace_id=cc.workspace_id AND ch.id=cc.channel_id
      WHERE cc.workspace_id=c.workspace_id AND cc.contact_id=c.id AND cc.opted_in=1
      AND ch.archived_at IS NULL AND ${stateInSql(['connected'], 'ch')}
      ORDER BY coalesce((SELECT max(m.created_at) FROM messages m JOIN conversations v
        ON v.workspace_id=m.workspace_id AND v.id=m.conversation_id
        WHERE v.workspace_id=cc.workspace_id AND v.contact_channel_id=cc.id AND m.direction='in'),
        cc.last_inbound_at,cc.created_at) DESC,cc.id LIMIT 1) AS channel_id
    FROM contacts c WHERE c.workspace_id=? AND c.status='subscribed' AND c.id IN (SELECT value FROM json_each(?))`)
    .bind(workspace, JSON.stringify(ids)).all<{ id: string; channel_id: string | null }>()
  if (contacts.results.length !== ids.length || contacts.results.some(row => !row.channel_id)) {
    throw new HTTPException(409, { message: 'Todos os contatos devem estar inscritos e ter uma conexão ativa com recebimento autorizado.' })
  }
  const now = Date.now()
  // Uma nova inscrição começa no primeiro passo; repetir a ação mantém a inscrição atual.
  // O lote não dispara regras nem altera o consentimento dos contatos.
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO rule_event_suppressions(workspace_id,contact_id,type) SELECT ?,value,'sequences' FROM json_each(?)").bind(workspace,JSON.stringify(ids)),
    ...contacts.results.map(contact => c.env.DB.prepare(`INSERT INTO sequence_subscriptions
    (workspace_id,sequence_id,contact_id,channel_id,enrollment_id,next_step,next_at,created_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(sequence_id,contact_id) DO NOTHING`)
    .bind(workspace, body.sequence_id, contact.id, contact.channel_id, crypto.randomUUID(), first?.position ?? 0,
      first ? now + first.delay_seconds * 1000 : null, now)),
    c.env.DB.prepare("DELETE FROM rule_event_suppressions WHERE workspace_id=? AND type='sequences' AND contact_id IN(SELECT value FROM json_each(?))").bind(workspace,JSON.stringify(ids)),
  ])
  return c.json({ count: ids.length })
})

contactSequences.delete('/contacts/:id/sequences/:sequence', async c => {
  authorize(c.var.principal, 'edit')
  await c.env.DB.prepare('DELETE FROM sequence_subscriptions WHERE workspace_id=? AND contact_id=? AND sequence_id=?')
    .bind(c.var.principal.workspaceId, id.parse(c.req.param('id')), id.parse(c.req.param('sequence'))).run()
  return c.json({ ok: true })
})
