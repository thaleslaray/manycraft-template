import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { IntegrationEnv } from '../../integrations'
import { threadRoles, type ThreadControlInput, type ThreadRole } from '../contract'
import { bsuid, upsertThreadOwner } from '../meta-whatsapp-cloud'
import { failureNotice, noteConnectionFailure } from './failure'
import { runtimeFromRow } from './runtime'
import { connectionColumns, type ConnectionRow } from './connection'

/** Conversation Routing of the official WhatsApp API (several partners on one number). */
export type RoutingView = { active: boolean; roles: string[]; standby: boolean }
const none: RoutingView = { active: false, roles: [], standby: false }
const where = 'No Gerenciador de Negócios, abra Contas do WhatsApp, escolha o número e vá em Conversation routing.'
const tokenRefused = { ok: false as const, reason: 'rejected' as const, code: '190', detail: 'token' }

async function open(env: IntegrationEnv, workspaceId: string, id: string) {
  // Uma ida só: a linha da conexão (não arquivada) serve de checagem e de base do runtime.
  const row = await env.DB.prepare(`SELECT ${connectionColumns} FROM channels WHERE workspace_id=? AND id=? AND archived_at IS NULL`).bind(workspaceId, id).first<ConnectionRow>()
  if (!row) throw new HTTPException(404, { message: 'Conexão não encontrada.' })
  const rt = await runtimeFromRow(env, row)
  return { rt, ctx: { connection: rt.connection, credentials: await rt.credentials(), fetch: rt.fetch, env } }
}

/** Our roles on the number. A connection without Conversation Routing (or another provider) simply has none. */
export async function connectionRouting(env: IntegrationEnv, workspaceId: string, id: string): Promise<RoutingView> {
  const { rt, ctx } = await open(env, workspaceId, id)
  if (!rt.provider?.routing) return none
  const result = await rt.provider.routing.roles(ctx)
  if (result.ok) return { active: result.active, roles: result.roles, standby: result.standby }
  if (result.code === 190) {
    await noteConnectionFailure(env, workspaceId, id, tokenRefused)
    throw new HTTPException(409, { message: failureNotice(tokenRefused) })
  }
  throw new HTTPException(503, { message: 'Não foi possível consultar os papéis na Meta. Tente novamente.' })
}

/** pass / release / take one conversation. `take` is only for the escalation partner: without that role the Meta is not even called. */
export async function controlThread(env: IntegrationEnv, workspaceId: string, id: string, input: ThreadControlInput): Promise<{ request_id: string; owner_role: string | null }> {
  const { rt, ctx } = await open(env, workspaceId, id)
  const routing = rt.provider?.routing
  if (!routing) throw new HTTPException(409, { message: 'Só a API oficial do WhatsApp tem Conversation routing.' })
  if (input.action === 'take') {
    const roles = await routing.roles(ctx)
    if (roles.ok && !roles.roles.includes('escalation'))
      throw new HTTPException(409, { message: `Só o parceiro de escalonamento pode assumir uma conversa, e este app não tem esse papel. ${where}` })
  }
  const result = await routing.control(ctx, input)
  if (!result.ok) {
    if (result.code === 190) { await noteConnectionFailure(env, workspaceId, id, tokenRefused); throw new HTTPException(409, { message: failureNotice(tokenRefused) }) }
    if (result.transient) throw new HTTPException(503, { message: 'A Meta não confirmou a troca de controle. Confira a conversa antes de tentar de novo.' })
    if (result.code === 2494191) throw new HTTPException(409, { message: `Só o parceiro de escalonamento pode assumir uma conversa. ${where}` })
    throw new HTTPException(409, { message: `A Meta recusou a troca de controle: este app precisa ser o dono da conversa (e o número precisa usar Conversation routing). ${where}` })
  }
  const owner: ThreadRole | null = input.action === 'release' ? null : input.action === 'take' ? 'escalation' : input.targetRole ?? 'escalation'
  const previous = await env.DB.prepare('SELECT owner_role FROM whatsapp_thread_owners WHERE workspace_id=? AND channel_id=? AND external_user_id=?')
    .bind(workspaceId, id, input.externalUserId.replace(/^\+/, '')).first<{ owner_role: string | null }>()
  await upsertThreadOwner(env.DB, workspaceId, id, input.externalUserId.replace(/^\+/, ''), owner, previous?.owner_role ?? null, Date.now())
  return { request_id: result.requestId, owner_role: owner }
}

/** Body of POST /connections/:id/thread-control. The contact is named by its business-scoped id or by a phone number. */
export const threadControlSchema = z.object({
  external_user_id: z.string().min(1).max(160).refine(v => bsuid.safeParse(v).success || /^\+?[1-9]\d{6,14}$/.test(v), 'Identificação do contato inválida.'),
  action: z.enum(['pass', 'release', 'take']), target_role: z.enum(threadRoles).optional(), metadata: z.string().max(2000).optional(),
}).strict().refine(b => b.action === 'pass' || !b.target_role, { message: 'target_role só vale para pass.' })
