import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from '../env'
import type { AuthVariables } from '../team'
import { can, authorize } from '../permissions'
import { json } from '../security'
import { assignmentSettings } from './assignment'
import { compileContactFilter, contactQueryFilterSchema } from '../db/contact-filter'

export async function inboxSettings(env: Pick<Env, 'DB'>, workspaceId: string) {
  return await env.DB.prepare('SELECT pause_minutes,new_message_behavior FROM inbox_settings WHERE workspace_id=?')
    .bind(workspaceId).first<{ pause_minutes: number; new_message_behavior: 'any_message' | 'explicit' }>()
    ?? { pause_minutes: 30, new_message_behavior: 'any_message' as const }
}
export async function humanPauseUntil(env: Pick<Env, 'DB'>, workspaceId: string) {
  return Date.now() + (await inboxSettings(env, workspaceId)).pause_minutes * 60_000
}
export async function inboxMembers(env: Pick<Env, 'DB'>, workspaceId: string) {
  return (await env.DB.prepare(`SELECT m.id,coalesce(nullif(u.name,''),u.email) AS name,m.user_id FROM workspace_members m JOIN "user" u ON u.id=m.user_id
    WHERE m.workspace_id=? AND (m.inbox_seat=1 OR m.role='owner') ORDER BY name,m.id`).bind(workspaceId)
    .all<{ id: string; name: string; user_id: string }>()).results
}
export const inboxTeam = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const identifier = z.string().min(1).max(256)
export const inboxAssignmentSchema = z.object({ auto_assign: z.enum(['off', 'basic', 'advanced']), assign_limit: z.number().int().min(1).max(1000).nullable() }).strict()
export const inboxAssignmentRulesSchema = z.array(z.object({ name: z.string().trim().min(1).max(80), condition: contactQueryFilterSchema, target_kind: z.enum(['member', 'group']), target_id: identifier }).strict()).max(50)
export const inboxSettingsSchema = z.object({ pause_minutes: z.number().int().min(0).max(1440), new_message_behavior: z.enum(['any_message', 'explicit']) }).strict()
inboxTeam.get('/context', async c => {
  const p = c.var.principal, ws = p.workspaceId
  const current = c.var.memberId
  const [membersRows, countsRow, mentionsRow] = await c.env.DB.batch<unknown>([
    c.env.DB.prepare(`SELECT m.id,coalesce(nullif(u.name,''),u.email) AS name,m.user_id FROM workspace_members m JOIN "user" u ON u.id=m.user_id
      WHERE m.workspace_id=? AND (m.inbox_seat=1 OR m.role='owner') ORDER BY name,m.id`).bind(ws),
    c.env.DB.prepare(`SELECT count(*) AS open,coalesce(sum(assignee_id=?),0) AS mine FROM conversations WHERE workspace_id=? AND status='open'`).bind(current, ws),
    c.env.DB.prepare('SELECT count(*) AS n FROM inbox_mentions WHERE workspace_id=? AND member_id=? AND read_at IS NULL').bind(ws, current),
  ])
  const members = membersRows.results as { id: string; name: string }[]
  const counts = countsRow.results[0] as { open: number; mine: number }, mentions = (mentionsRow.results[0] as { n: number }).n
  return c.json({ current_member_id: current, can_configure: can(p, 'edit', { workspace_id: ws }),
    members: members.map(({ id, name }) => ({ id, name })), counts: { ...counts, mentions } })
})
inboxTeam.get('/settings', async c => c.json(await inboxSettings(c.env, c.var.principal.workspaceId)))

/** Atribuição automática: modo e limite por atendente. */
inboxTeam.get('/assignment', async c => c.json(await assignmentSettings(c.env, c.var.principal.workspaceId)))
inboxTeam.put('/assignment', async c => {
  authorize(c.var.principal, 'team')
  const input = inboxAssignmentSchema.parse(await json(c.req.raw))
  await c.env.DB.prepare(`INSERT INTO inbox_settings(workspace_id,auto_assign,assign_limit) VALUES (?,?,?)
    ON CONFLICT(workspace_id) DO UPDATE SET auto_assign=excluded.auto_assign,assign_limit=excluded.assign_limit`).bind(c.var.principal.workspaceId, input.auto_assign, input.assign_limit).run()
  return c.json(input)
})

/** Grupos de equipe: conjuntos de atendentes que recebem conversas pelas regras de atribuição. */
inboxTeam.get('/groups', async c => {
  const ws = c.var.principal.workspaceId
  const [groups, members] = await Promise.all([
    c.env.DB.prepare('SELECT id,name FROM inbox_groups WHERE workspace_id=? ORDER BY name,id').bind(ws).all<{ id: string; name: string }>(),
    c.env.DB.prepare('SELECT gm.group_id,gm.member_id FROM inbox_group_members gm JOIN inbox_groups g ON g.id=gm.group_id WHERE g.workspace_id=?').bind(ws).all<{ group_id: string; member_id: string }>(),
  ])
  return c.json(groups.results.map(g => ({ ...g, member_ids: members.results.filter(m => m.group_id === g.id).map(m => m.member_id) })))
})
export const inboxGroupSchema = z.object({ name: z.string().trim().min(1).max(80), member_ids: z.array(identifier).max(200) }).strict()
async function saveGroup(env: Pick<Env, 'DB'>, ws: string, id: string, input: z.infer<typeof inboxGroupSchema>, create: boolean) {
  const team = new Set((await inboxMembers(env, ws)).map(m => m.id))
  if (input.member_ids.some(m => !team.has(m))) throw new HTTPException(400, { message: 'Escolha pessoas com acesso à Caixa de entrada.' })
  if (await env.DB.prepare('SELECT 1 FROM inbox_groups WHERE workspace_id=? AND name=? AND id<>?').bind(ws, input.name, id).first()) throw new HTTPException(409, { message: 'Já existe um grupo com esse nome.' })
  await env.DB.batch([
    create ? env.DB.prepare('INSERT INTO inbox_groups (id,workspace_id,name) VALUES (?,?,?)').bind(id, ws, input.name)
      : env.DB.prepare('UPDATE inbox_groups SET name=? WHERE workspace_id=? AND id=?').bind(input.name, ws, id),
    env.DB.prepare('DELETE FROM inbox_group_members WHERE group_id=?').bind(id),
    ...[...new Set(input.member_ids)].map(m => env.DB.prepare('INSERT INTO inbox_group_members (group_id,member_id) VALUES (?,?)').bind(id, m)),
  ])
}
inboxTeam.post('/groups', async c => {
  authorize(c.var.principal, 'team')
  const input = inboxGroupSchema.parse(await json(c.req.raw)), id = crypto.randomUUID()
  await saveGroup(c.env, c.var.principal.workspaceId, id, input, true)
  return c.json({ id, ...input }, 201)
})
inboxTeam.put('/groups/:id', async c => {
  authorize(c.var.principal, 'team')
  const ws = c.var.principal.workspaceId, id = identifier.parse(c.req.param('id'))
  if (!await c.env.DB.prepare('SELECT 1 FROM inbox_groups WHERE workspace_id=? AND id=?').bind(ws, id).first()) throw new HTTPException(404, { message: 'Grupo não encontrado.' })
  const input = inboxGroupSchema.parse(await json(c.req.raw))
  await saveGroup(c.env, ws, id, input, false)
  return c.json({ id, ...input })
})
inboxTeam.delete('/groups/:id', async c => {
  authorize(c.var.principal, 'team')
  const ws = c.var.principal.workspaceId, id = identifier.parse(c.req.param('id'))
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM inbox_assignment_rules WHERE workspace_id=? AND target_kind='group' AND target_id=?").bind(ws, id),
    c.env.DB.prepare('DELETE FROM inbox_groups WHERE workspace_id=? AND id=?').bind(ws, id),
  ])
  return c.body(null, 204)
})

/** Regras de atribuição (modo avançado): condição sobre o contato, destino atendente ou grupo, em ordem. */
inboxTeam.get('/assignment-rules', async c => {
  const rows = await c.env.DB.prepare('SELECT id,name,condition,target_kind,target_id FROM inbox_assignment_rules WHERE workspace_id=? ORDER BY position,id').bind(c.var.principal.workspaceId)
    .all<{ id: string; name: string; condition: string; target_kind: string; target_id: string }>()
  return c.json(rows.results.map(r => ({ ...r, condition: JSON.parse(r.condition) })))
})
inboxTeam.put('/assignment-rules', async c => {
  authorize(c.var.principal, 'team')
  const ws = c.var.principal.workspaceId
  const rules = inboxAssignmentRulesSchema.parse(await json(c.req.raw))
  const team = new Set((await inboxMembers(c.env, ws)).map(m => m.id))
  const groups = new Set((await c.env.DB.prepare('SELECT id FROM inbox_groups WHERE workspace_id=?').bind(ws).all<{ id: string }>()).results.map(g => g.id))
  for (const rule of rules) {
    if (rule.target_kind === 'member' ? !team.has(rule.target_id) : !groups.has(rule.target_id)) throw new HTTPException(400, { message: `Destino inválido na regra "${rule.name}".` })
    await compileContactFilter(c.env.DB, ws, rule.condition)
  }
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM inbox_assignment_rules WHERE workspace_id=?').bind(ws),
    ...rules.map((r, i) => c.env.DB.prepare('INSERT INTO inbox_assignment_rules (id,workspace_id,position,name,condition,target_kind,target_id) VALUES (?,?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), ws, i, r.name, JSON.stringify(r.condition), r.target_kind, r.target_id)),
  ])
  return c.json({ count: rules.length })
})
inboxTeam.put('/settings', async c => {
  authorize(c.var.principal, 'edit')
  const input = inboxSettingsSchema.parse(await json(c.req.raw))
  await c.env.DB.prepare(`INSERT INTO inbox_settings(workspace_id,pause_minutes,new_message_behavior) VALUES (?,?,?)
    ON CONFLICT(workspace_id) DO UPDATE SET pause_minutes=excluded.pause_minutes,new_message_behavior=excluded.new_message_behavior`)
    .bind(c.var.principal.workspaceId, input.pause_minutes, input.new_message_behavior).run()
  return c.json(input)
})
export const inboxSavedReplySchema = z.object({ shortcut: z.string().trim().min(1).max(80).regex(/^[\p{L}\p{N}_-]+$/u, 'Use letras, números, hífen ou sublinhado no atalho.'), body: z.string().trim().min(1).max(4000) }).strict()
inboxTeam.get('/saved-replies', async c => c.json((await c.env.DB.prepare('SELECT id,shortcut,body FROM inbox_saved_replies WHERE workspace_id=? ORDER BY shortcut').bind(c.var.principal.workspaceId).all()).results))
async function assertUnique(env: Pick<Env, 'DB'>, ws: string, shortcut: string, id: string) {
  if (await env.DB.prepare('SELECT id FROM inbox_saved_replies WHERE workspace_id=? AND shortcut=? AND id<>?').bind(ws, shortcut, id).first())
    throw new HTTPException(409, { message: 'Este atalho já existe.' })
}
inboxTeam.post('/saved-replies', async c => {
  authorize(c.var.principal, 'edit')
  const input = inboxSavedReplySchema.parse(await json(c.req.raw)), id = crypto.randomUUID(), ws = c.var.principal.workspaceId
  await assertUnique(c.env, ws, input.shortcut, id)
  await c.env.DB.prepare('INSERT INTO inbox_saved_replies(id,workspace_id,shortcut,body) VALUES (?,?,?,?)').bind(id, ws, input.shortcut, input.body).run()
  return c.json({ id, ...input }, 201)
})
inboxTeam.put('/saved-replies/:id', async c => {
  authorize(c.var.principal, 'edit')
  const input = inboxSavedReplySchema.parse(await json(c.req.raw)), id = identifier.parse(c.req.param('id')), ws = c.var.principal.workspaceId
  if (!await c.env.DB.prepare('SELECT id FROM inbox_saved_replies WHERE workspace_id=? AND id=?').bind(ws, id).first()) throw new HTTPException(404)
  await assertUnique(c.env, ws, input.shortcut, id)
  await c.env.DB.prepare('UPDATE inbox_saved_replies SET shortcut=?,body=? WHERE workspace_id=? AND id=?').bind(input.shortcut, input.body, ws, id).run()
  return c.json({ id, ...input })
})
inboxTeam.delete('/saved-replies/:id', async c => {
  authorize(c.var.principal, 'edit')
  const deleted = await c.env.DB.prepare('DELETE FROM inbox_saved_replies WHERE workspace_id=? AND id=? RETURNING id').bind(c.var.principal.workspaceId, identifier.parse(c.req.param('id'))).first()
  if (!deleted) throw new HTTPException(404)
  return c.json({ deleted: true })
})
inboxTeam.get('/mentions', async c => {
  const ws = c.var.principal.workspaceId, member = c.var.memberId
  return c.json((await c.env.DB.prepare(`SELECT n.id,m.conversation_id,m.id AS message_id,json_extract(m.content,'$.text') AS text
    FROM inbox_mentions n JOIN messages m ON m.workspace_id=n.workspace_id AND m.id=n.message_id
    WHERE n.workspace_id=? AND n.member_id=? AND n.read_at IS NULL ORDER BY m.created_at DESC,n.id`)
    .bind(ws, member).all()).results)
})
inboxTeam.post('/mentions/:id/read', async c => {
  const ws = c.var.principal.workspaceId, member = c.var.memberId
  const changed = await c.env.DB.prepare('UPDATE inbox_mentions SET read_at=? WHERE workspace_id=? AND member_id=? AND id=? RETURNING id')
    .bind(Date.now(), ws, member, identifier.parse(c.req.param('id'))).first()
  if (!changed) throw new HTTPException(404)
  return c.json({ read: true })
})
