import { Hono } from 'hono'
import { deleteContacts } from './contacts'
import { capabilities } from './channels/capabilities'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from './env'
import { archiveConnection, catalog, createConnection, getConnection, listConnectionGroups, listConnectionPosts, listConnectionStories, listConnections, refreshConnect, refreshConnection, setConnectionEnabled, connectionBusinessProfile, connectionCatalog, rotateCredentials, updateConnection, webhookStep } from './channels/core/connections'
import { connectionMarketing, refreshMarketing } from './channels/core/marketing'
import { connectionRouting, controlThread, threadControlSchema } from './channels/core/routing'
import { authorize } from './permissions'
import { json } from './security'
import { channelKinds } from './channels/types'
import type { AuthVariables } from './team'
import { enabledSchema } from './schemas/enabled'

/** Connection management. Reads are for any member; writes need the team permission. No response ever carries a credential. */
export const connections = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const id = z.string().min(1).max(128)
const credentials = z.record(z.string().max(64), z.string().max(2048))
const baseOf = (c: { env: Env; req: { url: string } }) => c.env.PUBLIC_BASE_URL ?? new URL(c.req.url).origin
/** Página de publicações/stories: chaves desconhecidas na consulta (cache buster, parâmetro de ferramenta) são ignoradas, não derrubam a lista. */
export const connectionPageQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(24), after: z.string().max(2048).optional() })
export const connectionListQuerySchema = z.object({ kind: z.enum(channelKinds).optional() }).strict()
export const connectionCreateSchema = z.object({ kind: z.enum(channelKinds), provider: z.string().max(64).optional(), displayName: z.string().max(120).optional(), credentials }).strict()
export const connectionGroupsQuerySchema = z.object({ search: z.string().trim().max(120).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }).strict()
export const connectionPatchSchema = z.object({ displayName: z.string().max(120).optional(), settings: z.record(z.string().max(64), z.union([z.boolean(), z.string().max(2000)])).optional() }).strict()
export const connectionRotateSchema = z.object({ credentials }).strict()
const workspaceOf = (c: { var: { principal: { workspaceId: string } } }) => c.var.principal.workspaceId

connections.get('/catalog', c => c.json({ channels: catalog(),
  ...(c.env.APP_ENV === 'development' && c.env.DEV_PROVIDER_API_BASE ? { development: { providerApiBase: c.env.DEV_PROVIDER_API_BASE } } : {}) }))
/** Perfil padrão de cada canal (tabela de compatibilidade de blocos no editor). */
connections.get('/capabilities', c => c.json({ channels: channelKinds.map(kind => ({ kind, profile: capabilities(kind) })) }))
connections.get('/', async c => {
  const q = connectionListQuerySchema.parse(c.req.query())
  return c.json(await listConnections(c.env, workspaceOf(c), baseOf(c), q.kind))
})
connections.post('/', async c => {
  authorize(c.var.principal, 'team')
  const body = connectionCreateSchema.parse(await json(c.req.raw))
  return c.json(await createConnection(c.env, workspaceOf(c), body, baseOf(c)), 201)
})
connections.get('/:id', async c => c.json(await getConnection(c.env, workspaceOf(c), id.parse(c.req.param('id')), baseOf(c))))
connections.get('/:id/posts', async c => {
  const q = connectionPageQuerySchema.parse(c.req.query())
  return c.json(await listConnectionPosts(c.env, workspaceOf(c), id.parse(c.req.param('id')), q))
})
connections.get('/:id/stories', async c => {
  const q = connectionPageQuerySchema.parse(c.req.query())
  return c.json(await listConnectionStories(c.env, workspaceOf(c), id.parse(c.req.param('id')), q))
})
/** Groups of the connected account (a page of summaries), to choose where a group trigger applies. */
connections.get('/:id/groups', async c => {
  const q = connectionGroupsQuerySchema.parse(c.req.query())
  return c.json(await listConnectionGroups(c.env, workspaceOf(c), id.parse(c.req.param('id')), { ...(q.search ? { search: q.search } : {}), limit: q.limit, offset: q.offset }))
})
/** Name and the provider's options (typing, mark as read, calls...). Credentials only change through /rotate. */
connections.patch('/:id', async c => {
  authorize(c.var.principal, 'team')
  const body = connectionPatchSchema.parse(await json(c.req.raw))
  return c.json(await updateConnection(c.env, workspaceOf(c), id.parse(c.req.param('id')), body, baseOf(c)))
})
/** Where the pairing stands (a fresh QR code while it waits to be read, `done` once paired). The panel asks while the QR dialog is open. */
connections.post('/:id/connect', async c => {
  authorize(c.var.principal, 'team')
  return c.json(await refreshConnect(c.env, workspaceOf(c), id.parse(c.req.param('id')), baseOf(c)))
})
/** Atualizar conexão: revalida credenciais e permissões e reassina o webhook automático. */
connections.post('/:id/refresh', async c => {
  authorize(c.var.principal, 'team')
  return c.json(await refreshConnection(c.env, workspaceOf(c), id.parse(c.req.param('id')), baseOf(c)))
})
export const connectionBusinessProfileSchema = z.object({ about: z.string().max(139).optional(), description: z.string().max(512).optional(), address: z.string().max(256).optional(),
  email: z.email().max(128).optional(), websites: z.array(z.url({ protocol: /^https?$/ }).max(256)).max(2).optional(), vertical: z.string().max(64).optional() }).strict()
connections.get('/:id/catalog', async c => c.json(await connectionCatalog(c.env, workspaceOf(c), id.parse(c.req.param('id')))))
connections.get('/:id/business-profile', async c => c.json(await connectionBusinessProfile(c.env, workspaceOf(c), id.parse(c.req.param('id')))))
connections.put('/:id/business-profile', async c => {
  authorize(c.var.principal, 'team')
  return c.json(await connectionBusinessProfile(c.env, workspaceOf(c), id.parse(c.req.param('id')), connectionBusinessProfileSchema.parse(await json(c.req.raw))))
})
connections.post('/:id/enabled', async c => {
  authorize(c.var.principal, 'team')
  const { enabled } = enabledSchema.parse(await json(c.req.raw))
  return c.json(await setConnectionEnabled(c.env, workspaceOf(c), id.parse(c.req.param('id')), enabled, baseOf(c)))
})
connections.post('/:id/webhook', async c => {
  authorize(c.var.principal, 'team')
  return c.json({ step: await webhookStep(c.env, workspaceOf(c), id.parse(c.req.param('id')), baseOf(c)) })
})
connections.post('/:id/rotate', async c => {
  authorize(c.var.principal, 'team')
  const body = connectionRotateSchema.parse(await json(c.req.raw))
  if (!Object.keys(body.credentials).length) throw new HTTPException(400, { message: 'Informe a nova credencial.' })
  return c.json(await rotateCredentials(c.env, workspaceOf(c), id.parse(c.req.param('id')), body.credentials, baseOf(c)))
})
/** Our roles under Conversation Routing (several partners on one number). */
connections.get('/:id/routing', async c => c.json(await connectionRouting(c.env, workspaceOf(c), id.parse(c.req.param('id')))))
/** Is the account enabled for the Marketing Messages API? GET answers from the stored check (asking again when old); POST checks again now. */
connections.get('/:id/marketing', async c => c.json(await connectionMarketing(c.env, workspaceOf(c), id.parse(c.req.param('id')))))
connections.post('/:id/marketing', async c => {
  authorize(c.var.principal, 'team')
  return c.json(await refreshMarketing(c.env, workspaceOf(c), id.parse(c.req.param('id'))))
})
/** pass / release / take of one conversation. `take` only works for the escalation partner. */
connections.post('/:id/thread-control', async c => {
  authorize(c.var.principal, 'edit')
  const body = threadControlSchema.parse(await json(c.req.raw))
  return c.json(await controlThread(c.env, workspaceOf(c), id.parse(c.req.param('id')), { action: body.action, externalUserId: body.external_user_id,
    ...(body.target_role ? { targetRole: body.target_role } : {}), ...(body.metadata ? { metadata: body.metadata } : {}) }))
})
connections.delete('/:id', async c => {
  authorize(c.var.principal, 'team')
  const ws = workspaceOf(c), connectionId = id.parse(c.req.param('id'))
  // Opcional e explícito: apagar também quem só existe por esta conexão (quem tem outro canal fica).
  const purge = c.req.query('delete_contacts') === '1'
  const only = purge ? (await c.env.DB.prepare(`SELECT DISTINCT cc.contact_id AS id FROM contact_channels cc JOIN contacts k ON k.workspace_id=cc.workspace_id AND k.id=cc.contact_id AND k.status<>'deleted'
    WHERE cc.workspace_id=? AND cc.channel_id=? AND NOT EXISTS (SELECT 1 FROM contact_channels o WHERE o.workspace_id=cc.workspace_id AND o.contact_id=cc.contact_id AND o.channel_id<>cc.channel_id)
    LIMIT 5000`).bind(ws, connectionId).all<{ id: string }>()).results.map(r => r.id) : []
  await archiveConnection(c.env, ws, connectionId, baseOf(c))
  for (let i = 0; i < only.length; i += 100) await deleteContacts(c.env, ws, only.slice(i, i + 100))
  return purge ? c.json({ deleted_contacts: only.length }) : c.body(null, 204)
})
