import { Hono } from 'hono'
import { setCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from './env'
import { createAuth } from './auth'
import { authorize, type Principal } from './permissions'
import { sendEmail } from './email'
import { hash, json, limit } from './security'
import { disconnectMember, revokeMemberKeys } from './member-access'
export type AuthVariables = { userId: string; email: string; principal: Principal; /** Id do membro do usuário neste workspace, lido uma vez no middleware (o papel também). */ memberId: string; sessionId?: string; /** 'api' quando o pedido veio pela chave de perfil; 'painel' pelo cookie de sessão. */ via?: 'api' | 'painel'; /** Chave de perfil usada no pedido (log de atividade). */ apiKeyId?: string }
export const team = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const id = z.string().min(1).max(128)
const role = z.enum(['administrator', 'editor', 'livechat_agent', 'viewer'])
export const teamInviteSchema = z.object({ email: z.email().max(254).transform(s => s.toLowerCase()), role }).strict()
export const teamMemberPatchSchema = z.object({ role: role.optional(), inbox_seat: z.boolean().optional() }).strict()
  .refine(value => value.role !== undefined || value.inbox_seat !== undefined)
export const teamAccessApproveSchema = z.object({ role }).strict()
export const agencyProfileSchema = z.object({ name: z.string().trim().min(1).max(120), website: z.url({ protocol: /^https?$/ }).max(300).nullable().default(null) }).strict()
team.post('/workspaces', async c => {
  if (c.env.SIGNUP_CLOSED === '1') throw new HTTPException(403, { message: 'Criar novos espaços está desativado.' })
  const input = z.object({ name: z.string().trim().min(1).max(120), timezone: z.string().refine(s => {
    try { new Intl.DateTimeFormat('pt-BR', { timeZone: s }); return true } catch { return false }
  }).default('America/Sao_Paulo') }).strict().parse(await json(c.req.raw))
  await limit(c.env, `workspace:${c.var.userId}`, 5, 3600_000)
  const ws = crypto.randomUUID()
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO workspaces(id,name,timezone) VALUES (?,?,?)').bind(ws, input.name, input.timezone),
    c.env.DB.prepare("INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES (?,?,?,'owner')").bind(crypto.randomUUID(), ws, c.var.userId),
  ])
  return c.json({ id: ws, ...input }, 201)
})
/** Sem sessão: quem abre o link do convite vê para qual e-mail ele vale, para criar a conta com o mesmo endereço. Só o e-mail sai; o token já é o segredo. */
export const invitePublic = new Hono<{ Bindings: Env }>()
invitePublic.post('/invite-preview', async c => {
  const { token } = z.object({ token: z.string().min(32).max(128) }).strict().parse(await json(c.req.raw))
  await limit(c.env, `invite-preview:${c.req.header('cf-connecting-ip') ?? 'local'}`, 30, 60_000)
  const row = await c.env.DB.prepare('SELECT email FROM invites WHERE token_hash=? AND expires_at>?').bind(await hash(token), Date.now()).first<{ email: string }>()
  if (!row) throw new HTTPException(404, { message: 'Convite inválido ou vencido.' })
  return c.json({ email: row.email })
})
team.post('/invites/accept', async c => {
  const { token } = z.object({ token: z.string().min(32).max(128) }).strict().parse(await json(c.req.raw))
  const digest = await hash(token)
  const now = Date.now()
  // INSERT and DELETE are atomic. A token can create at most one membership, for its verified email.
  const results = await c.env.DB.batch<{ id: string; workspace_id: string }>([
    c.env.DB.prepare(`INSERT INTO workspace_members(id,workspace_id,user_id,role)
      SELECT ?,workspace_id,?,role FROM invites WHERE token_hash=? AND email=? AND expires_at>?
      ON CONFLICT(workspace_id,user_id) DO NOTHING RETURNING id,workspace_id`).bind(crypto.randomUUID(), c.var.userId, digest, c.var.email.toLowerCase(), now),
    c.env.DB.prepare('DELETE FROM invites WHERE token_hash=? AND email=? AND expires_at>?').bind(digest, c.var.email.toLowerCase(), now),
  ])
  if (!results[0]?.results.length) throw new HTTPException(400, { message: 'Convite inválido ou já utilizado.' })
  const workspace_id = String(results[0].results[0]!.workspace_id)
  setCookie(c, 'workspace_context', workspace_id, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/' })
  return c.json({ accepted: true, workspace_id })
})
team.get('/team/invites', async c => {
  authorize(c.var.principal, 'team')
  z.object({}).strict().parse(c.req.query())
  const rows = await c.env.DB.prepare('SELECT id,email,role,expires_at FROM invites WHERE workspace_id=? AND expires_at>? ORDER BY created_at,id')
    .bind(c.var.principal.workspaceId, Date.now()).all()
  return c.json(rows.results)
})
team.post('/team/invites', async c => {
  authorize(c.var.principal, 'team')
  const input = teamInviteSchema.parse(await json(c.req.raw))
  await limit(c.env, `invite:${c.var.userId}`, 10, 3600_000)
  const token = crypto.randomUUID() + crypto.randomUUID()
  const inviteId = crypto.randomUUID()
  const now = Date.now(), expires = now + 86400_000, workspaceId = c.var.principal.workspaceId
  const inserted = await c.env.DB.prepare(`INSERT INTO invites SELECT ?,?,?,?,?,?,?
    WHERE NOT EXISTS (SELECT 1 FROM invites WHERE workspace_id=? AND email=? AND expires_at>?)
    AND NOT EXISTS (SELECT 1 FROM workspace_members m JOIN "user" u ON u.id=m.user_id WHERE m.workspace_id=? AND lower(u.email)=?) RETURNING id`)
    .bind(inviteId, workspaceId, input.email, input.role, await hash(token), expires, now, workspaceId, input.email, now, workspaceId, input.email).all()
  if (!inserted.results.length) throw new HTTPException(409, { message: 'Este e-mail já está na equipe ou tem um convite válido.' })
  const url = `${c.env.BETTER_AUTH_URL}/invite#${token}`
  try { await sendEmail(c.env, input.email, 'invite', url) }
  catch (error) { await c.env.DB.prepare('DELETE FROM invites WHERE id=? AND workspace_id=?').bind(inviteId, c.var.principal.workspaceId).run(); throw error }
  return c.json({ id: inviteId, url, expires_at: expires }, 201)
})
/** Cancelar um convite pendente: o link deixa de valer na hora. */
team.delete('/team/invites/:id', async c => {
  authorize(c.var.principal, 'team')
  const removed = await c.env.DB.prepare('DELETE FROM invites WHERE id=? AND workspace_id=? RETURNING id').bind(id.parse(c.req.param('id')), c.var.principal.workspaceId).all()
  if (!removed.results.length) throw new HTTPException(404, { message: 'Convite não encontrado.' })
  return c.json({ cancelled: true })
})
/** O token só existe em hash: para copiar o link de novo, emitimos um token novo para o mesmo convite (o link anterior para de valer). */
team.post('/team/invites/:id/link', async c => {
  authorize(c.var.principal, 'team')
  // A documentação não pede corpo: sem corpo vale como `{}` (o painel manda `{}`).
  const raw = c.req.raw.body ? await c.req.raw.clone().text() : ''
  z.object({}).strict().parse(raw.trim() ? await json(c.req.raw) : {})
  const token = crypto.randomUUID() + crypto.randomUUID()
  const updated = await c.env.DB.prepare('UPDATE invites SET token_hash=? WHERE id=? AND workspace_id=? AND expires_at>? RETURNING id,expires_at')
    .bind(await hash(token), id.parse(c.req.param('id')), c.var.principal.workspaceId, Date.now()).all<{ id: string; expires_at: number }>()
  const invite = updated.results[0]
  if (!invite) throw new HTTPException(404, { message: 'Convite não encontrado ou vencido.' })
  return c.json({ id: invite.id, url: `${c.env.BETTER_AUTH_URL}/invite#${token}`, expires_at: invite.expires_at })
})
team.get('/team', async c => {
  authorize(c.var.principal, 'team')
  z.object({}).strict().parse(c.req.query())
  const members = await c.env.DB.prepare(`SELECT m.id,m.role,m.inbox_seat,u.name,u.email,u.image,m.user_id=? AS is_current
    FROM workspace_members m JOIN "user" u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY m.created_at,m.id`)
    .bind(c.var.userId, c.var.principal.workspaceId).all<{ id: string; role: string; inbox_seat: number; name: string; email: string; image: string | null; is_current: number }>()
  return c.json(members.results.map(m => ({ ...m, inbox_seat: !!m.inbox_seat, is_current: !!m.is_current })))
})
team.get('/team/assignees', async c => {
  authorize(c.var.principal, 'automation:read')
  z.object({}).strict().parse(c.req.query())
  const members = await c.env.DB.prepare("SELECT id,role FROM workspace_members WHERE workspace_id=? AND (inbox_seat=1 OR role='owner') ORDER BY id")
    .bind(c.var.principal.workspaceId).all()
  return c.json(members.results)
})
team.get('/team/notifications', async c => {
  z.object({}).strict().parse(c.req.query())
  const notifications = await c.env.DB.prepare(`SELECT id,contact_id,recipient_id,message,created_at FROM team_notifications WHERE workspace_id=?
    AND (recipient_id IS NULL OR recipient_id=?)
    ORDER BY created_at DESC,id DESC LIMIT 100`)
    .bind(c.var.principal.workspaceId, c.var.memberId).all()
  return c.json(notifications.results)
})
team.post('/team/transfer-ownership', async c => {
  if (c.var.principal.role !== 'owner') throw new HTTPException(403, { message: 'Somente o proprietário pode transferir o espaço.' })
  const input = z.object({ member_id: id, confirmation: z.literal('TRANSFERIR') }).strict().parse(await json(c.req.raw))
  const { workspaceId, userId } = c.var.principal
  const target = await c.env.DB.prepare('SELECT user_id FROM workspace_members WHERE workspace_id=? AND id=?')
    .bind(workspaceId, input.member_id).first<{ user_id: string }>()
  if (!target) throw new HTTPException(404, { message: 'Membro não encontrado neste espaço.' })
  if (target.user_id === userId) throw new HTTPException(400, { message: 'Escolha outro membro para receber a propriedade.' })
  // D1 executa o batch como uma transação. A promoção só ocorre se este ator
  // ainda era dono e o destinatário existia no momento da despromoção.
  const result = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE workspace_members SET role='administrator' WHERE workspace_id=? AND user_id=? AND role='owner'
      AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id=? AND id=? AND user_id!=? AND role!='owner') RETURNING id`)
      .bind(workspaceId, userId, workspaceId, input.member_id, userId),
    c.env.DB.prepare(`UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND id=? AND role!='owner' AND changes()=1 RETURNING id`)
      .bind(workspaceId, input.member_id),
  ])
  if (!result[1]?.results.length) throw new HTTPException(409, { message: 'A propriedade mudou. Recarregue a equipe.' })
  return c.json({ transferred: true })
})
team.patch('/team/:id', async c => {
  authorize(c.var.principal, 'team')
  const memberId = id.parse(c.req.param('id'))
  const input = teamMemberPatchSchema.parse(await json(c.req.raw))
  const { workspaceId } = c.var.principal
  // Rebaixar para abaixo de administrador revoga as chaves de API que a pessoa criou, no mesmo lote da mudança de papel.
  const member = input.role && input.role !== 'administrator'
    ? await c.env.DB.prepare('SELECT user_id FROM workspace_members WHERE id=? AND workspace_id=?').bind(memberId, workspaceId).first<{ user_id: string }>() : null
  const [updated] = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE workspace_members SET role=coalesce(?,role),inbox_seat=coalesce(?,inbox_seat) WHERE id=? AND workspace_id=?
      AND role != 'owner' AND (role != 'administrator' OR ? = 'owner') RETURNING id`)
      .bind(input.role ?? null, input.inbox_seat === undefined ? null : Number(input.inbox_seat), memberId, workspaceId, c.var.principal.role),
    ...member ? revokeMemberKeys(c.env.DB, workspaceId, member.user_id, 'o papel dessa pessoa no espaço mudou', true) : [],
  ])
  if (!updated!.results.length) {
    // Sem linha mudada: o dono (e o administrador, para quem não é dono) não muda por aqui; o resto é membro que não existe neste espaço.
    const target = await c.env.DB.prepare('SELECT role FROM workspace_members WHERE id=? AND workspace_id=?').bind(memberId, workspaceId).first<{ role: string }>()
    if (target?.role === 'owner') throw new HTTPException(409, { message: 'O papel do dono não muda por aqui. Use Transferir propriedade.' })
    if (target?.role === 'administrator') throw new HTTPException(403, { message: 'Só o dono muda o papel de um administrador.' })
    throw new HTTPException(404, { message: 'Membro não encontrado neste espaço.' })
  }
  return c.json({ updated: true })
})
/** Remover um membro: o dono remove qualquer um, o administrador só quem não é administrador nem dono; ninguém se remove (para isso existe "Sair do espaço"). */
team.delete('/team/:id', async c => {
  authorize(c.var.principal, 'team')
  const target = await c.env.DB.prepare('SELECT user_id,role FROM workspace_members WHERE id=? AND workspace_id=?')
    .bind(id.parse(c.req.param('id')), c.var.principal.workspaceId).first<{ user_id: string; role: string }>()
  if (!target) throw new HTTPException(404, { message: 'Membro não encontrado neste espaço.' })
  if (target.user_id === c.var.principal.userId) throw new HTTPException(409, { message: 'Você não pode se remover da equipe. Use "Sair do espaço" em Geral.' })
  if (target.role === 'owner' || (target.role === 'administrator' && c.var.principal.role !== 'owner')) throw new HTTPException(403, { message: 'Seu papel não permite remover este membro.' })
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM workspace_members WHERE id=? AND workspace_id=? AND role<>'owner'").bind(c.req.param('id'), c.var.principal.workspaceId),
    ...revokeMemberKeys(c.env.DB, c.var.principal.workspaceId, target.user_id, 'essa pessoa foi removida do espaço', true),
  ])
  await disconnectMember(c.env, [c.var.principal.workspaceId], target.user_id)
  return c.json({ removed: true })
})
team.post('/account/sign-out-everywhere', async c => {
  z.object({}).strict().parse(await json(c.req.raw))
  const response = await createAuth(c.env).api.revokeSessions({ headers: c.req.raw.headers, asResponse: true })
  // As sessões já caíram; as conexões ao vivo do inbox (em todos os espaços da pessoa) caem junto.
  if (response.ok) {
    const spaces = await c.env.DB.prepare('SELECT workspace_id FROM workspace_members WHERE user_id=?').bind(c.var.userId).all<{ workspace_id: string }>()
    await disconnectMember(c.env, spaces.results.map(row => row.workspace_id), c.var.userId)
  }
  return response
})

/** Contas (espaços) do usuário, para o seletor do painel. */
team.get('/workspaces/mine', async c => {
  const rows = await c.env.DB.prepare(`SELECT w.id,w.name,m.role FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id
    WHERE m.user_id=? ORDER BY w.name,w.id`).bind(c.var.userId).all<{ id: string; name: string; role: string }>()
  return c.json({ current: c.var.principal.workspaceId, items: rows.results })
})
/** Trocar de conta: só para um espaço de que o usuário participa; o cookie escolhe o espaço da sessão. */
team.post('/workspaces/switch', async c => {
  const { workspace_id } = z.object({ workspace_id: id }).strict().parse(await json(c.req.raw))
  const member = await c.env.DB.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').bind(workspace_id, c.var.userId).first()
  if (!member) throw new HTTPException(404, { message: 'Espaço não encontrado.' })
  setCookie(c, 'workspace_context', workspace_id, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/' })
  return c.json({ workspace_id })
})
/** Sair do espaço: o dono não sai (transfira a posse antes). */
team.post('/team/leave', async c => {
  z.object({}).strict().parse(await json(c.req.raw))
  if (c.var.principal.role === 'owner') throw new HTTPException(409, { message: 'O dono não pode sair. Transfira a posse do espaço antes.' })
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM workspace_members WHERE workspace_id=? AND user_id=? AND role<>\'owner\'').bind(c.var.principal.workspaceId, c.var.userId),
    ...revokeMemberKeys(c.env.DB, c.var.principal.workspaceId, c.var.userId, 'essa pessoa saiu do espaço', true),
  ])
  await disconnectMember(c.env, [c.var.principal.workspaceId], c.var.userId)
  return c.json({ left: true })
})

/** Clonar a conta: espaço novo do usuário com tags, campos e automações (como rascunho, em pasta própria). Contatos, conexões e conversas não vão. */
team.post('/workspaces/clone', async c => {
  authorize(c.var.principal, 'team')
  const { name } = z.object({ name: z.string().trim().min(1).max(120) }).strict().parse(await json(c.req.raw))
  await limit(c.env, `workspace:${c.var.userId}`, 5, 3600_000)
  const from = c.var.principal.workspaceId, to = crypto.randomUUID(), folder = crypto.randomUUID()
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO workspaces(id,name,timezone) SELECT ?,?,timezone FROM workspaces WHERE id=?').bind(to, name, from),
    c.env.DB.prepare("INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES (?,?,?,'owner')").bind(crypto.randomUUID(), to, c.var.userId),
    // Ids novos com o mesmo sufixo: os gráficos copiados continuam apontando para a tag e o campo certos.
    c.env.DB.prepare(`INSERT INTO tags(id,workspace_id,name) SELECT id||'~'||?,?,name FROM tags WHERE workspace_id=? AND archived=0`).bind(to.slice(0, 8), to, from),
    c.env.DB.prepare(`INSERT INTO custom_fields(id,workspace_id,scope,name,type,description,bot_value) SELECT id||'~'||?,?,scope,name,type,description,bot_value FROM custom_fields WHERE workspace_id=? AND archived=0`).bind(to.slice(0, 8), to, from),
    c.env.DB.prepare("INSERT INTO folders(id,workspace_id,name) VALUES (?,?,'Copiado')").bind(folder, to),
    c.env.DB.prepare(`INSERT INTO automations(id,workspace_id,name,folder_id,draft_graph) SELECT ?||'-'||id,?,name,?,draft_graph FROM automations WHERE workspace_id=? AND deleted_at IS NULL`).bind(to.slice(0, 8), to, folder, from),
  ])
  // Os rascunhos copiados citam ids antigos: trocamos cada id de tag e campo pelo da cópia.
  const ids = await c.env.DB.prepare(`SELECT id FROM tags WHERE workspace_id=? UNION ALL SELECT id FROM custom_fields WHERE workspace_id=?`).bind(to, to).all<{ id: string }>()
  for (const { id: copy } of ids.results) {
    const original = copy.slice(0, copy.lastIndexOf('~'))
    await c.env.DB.prepare(`UPDATE automations SET draft_graph=replace(draft_graph,?,?) WHERE workspace_id=?`).bind(`"${original}"`, `"${copy}"`, to).run()
  }
  return c.json({ id: to, name }, 201)
})

/** Pedido de acesso: a pessoa logada (ainda sem vínculo) pede para entrar num espaço pelo id dele. Não revela se o espaço existe. */
team.post('/access-requests', async c => {
  const input = z.object({ workspace_id: id, message: z.string().trim().max(500).default('') }).strict().parse(await json(c.req.raw))
  await limit(c.env, `access-request:${c.var.userId}`, 10, 3600_000)
  await c.env.DB.prepare(`INSERT INTO access_requests(id,workspace_id,user_id,message,created_at)
    SELECT ?,w.id,?,?,? FROM workspaces w WHERE w.id=? AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id=w.id AND m.user_id=?)
    ON CONFLICT(workspace_id,user_id) DO UPDATE SET message=excluded.message,created_at=excluded.created_at`)
    .bind(crypto.randomUUID(), c.var.userId, input.message, Date.now(), input.workspace_id, c.var.userId).run()
  return c.json({ requested: true }, 202)
})
team.get('/team/access-requests', async c => {
  authorize(c.var.principal, 'team')
  const rows = await c.env.DB.prepare(`SELECT r.id,r.message,r.created_at,u.email,u.name FROM access_requests r JOIN "user" u ON u.id=r.user_id
    WHERE r.workspace_id=? ORDER BY r.created_at`).bind(c.var.principal.workspaceId).all()
  return c.json({ items: rows.results })
})
team.post('/team/access-requests/:id/approve', async c => {
  authorize(c.var.principal, 'team')
  const input = teamAccessApproveSchema.parse(await json(c.req.raw))
  const ws = c.var.principal.workspaceId, reqId = id.parse(c.req.param('id'))
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO workspace_members(id,workspace_id,user_id,role) SELECT ?,workspace_id,user_id,? FROM access_requests
      WHERE id=? AND workspace_id=? ON CONFLICT(workspace_id,user_id) DO NOTHING`).bind(crypto.randomUUID(), input.role, reqId, ws),
    c.env.DB.prepare('DELETE FROM access_requests WHERE id=? AND workspace_id=?').bind(reqId, ws),
  ])
  if (!results[1]?.meta.changes) throw new HTTPException(404, { message: 'Pedido não encontrado.' })
  return c.json({ approved: true })
})
team.delete('/team/access-requests/:id', async c => {
  authorize(c.var.principal, 'team')
  const r = await c.env.DB.prepare('DELETE FROM access_requests WHERE id=? AND workspace_id=?').bind(id.parse(c.req.param('id')), c.var.principal.workspaceId).run()
  if (!r.meta.changes) throw new HTTPException(404, { message: 'Pedido não encontrado.' })
  return c.body(null, 204)
})

/** Modo agência: perfil (agency_id) e os espaços de clientes que a pessoa administra, com contatos, automações no ar e conexões. */
team.get('/agency', async c => {
  const [profile, clients] = await c.env.DB.batch([c.env.DB.prepare('SELECT agency_id,name,website FROM agency_profiles WHERE user_id=?').bind(c.var.userId), c.env.DB.prepare(`SELECT w.id,w.name,m.role,
      (SELECT count(*) FROM contacts k WHERE k.workspace_id=w.id AND k.status='subscribed') AS contacts,
      (SELECT count(*) FROM automations a WHERE a.workspace_id=w.id AND a.status='live' AND a.deleted_at IS NULL) AS live_automations,
      (SELECT count(*) FROM channels ch WHERE ch.workspace_id=w.id AND ch.archived_at IS NULL) AS connections
    FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? AND m.role IN ('owner','administrator') ORDER BY w.name`).bind(c.var.userId)])
  return c.json({ profile: profile!.results[0] ?? null, clients: clients!.results })
})
team.put('/agency', async c => {
  const input = agencyProfileSchema.parse(await json(c.req.raw))
  await c.env.DB.prepare(`INSERT INTO agency_profiles (user_id,agency_id,name,website,created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,website=excluded.website`).bind(c.var.userId, crypto.randomUUID(), input.name, input.website, Date.now()).run()
  return c.json(await c.env.DB.prepare('SELECT agency_id,name,website FROM agency_profiles WHERE user_id=?').bind(c.var.userId).first())
})
