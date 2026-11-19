import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize, type Role } from './permissions'
import { roleCan } from '../../shared/permissions'
import { createAutomation, updateAutomation } from './db/automations'
import { capabilities } from './channels/capabilities'
import { channelKinds } from './channels/types'
import { isCards } from './schemas/message-cards'

export const automationActions = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
const name = z.string().trim().min(1).max(100)
export const automationCreateSchema = z.object({ name, folder_id: z.string().min(1).max(128).nullable().optional() }).strict()
export const automationPatchSchema = z.object({ name: name.optional(), status: z.enum(['live', 'stopped']).optional(), folder_id: z.string().min(1).max(128).nullable().optional() }).strict()
  .refine(p => p.name !== undefined || p.status !== undefined || p.folder_id !== undefined, 'Informe uma alteração.')

automationActions.post('/automations', async c => {
  authorize(c.var.principal, 'edit')
  const body = await c.req.json().catch(() => { throw new HTTPException(400, { message: 'JSON inválido.' }) })
  const input = automationCreateSchema.parse(body)
  return c.json(await createAutomation(c.env.DB, c.var.principal.workspaceId, input), 201)
})

automationActions.patch('/automations/:id', async c => {
  authorize(c.var.principal, 'edit')
  const id = z.string().min(1).max(128).parse(c.req.param('id'))
  const body = await c.req.json().catch(() => { throw new HTTPException(400, { message: 'JSON inválido.' }) })
  const patch = automationPatchSchema.parse(body)
  return c.json(await updateAutomation(c.env.DB, c.var.principal.workspaceId, id, patch))
})

/** Ações que a trava pode reservar a dono e administrador; sem lista, todas (somente leitura). */
export const lockableActions = ['edit', 'move', 'delete', 'restore', 'export', 'share', 'purge'] as const
export type LockableAction = typeof lockableActions[number]
export const automationLockSchema = z.object({ locked: z.boolean(), actions: z.array(z.enum(lockableActions)).min(1).optional() }).strict()
export const automationCopyToSchema = z.object({ workspace_id: z.string().min(1).max(128) }).strict()
export const automationShareSchema = z.object({ allow_copy: z.boolean().default(true) }).strict()
export const automationImportSharedSchema = z.object({ token: z.string().regex(/^[a-f0-9]{36}$/) }).strict()
export const automationConvertSchema = z.object({ channel: z.enum(channelKinds) }).strict()
/** GET /automations (não estrito: parâmetro desconhecido é ignorado). `folder_id=null` = sem pasta. */
export const automationListQuerySchema = z.object({
  status: z.enum(['draft', 'live', 'stopped']).optional(),
  folder_id: z.string().optional(),
  search: z.string().optional(),
})
export const automationAnswersQuerySchema = z.object({ node: z.string().max(128).optional(), format: z.enum(['json', 'csv']).default('json') }).strict()
export const automationStatsQuerySchema = z.object({ period_days: z.coerce.number().int().min(1).max(365).default(30) }).strict()
/** PUT /automations/:id/draft: o `graph` é conferido ao salvar (validateGraph, engine/src/schemas/graph.ts). */
export const automationDraftSchema = z.object({ graph: z.unknown() })
/**
 * Única decisão da trava de automação: true quando a automação está trancada para esta ação e quem pede não é dono nem administrador.
 * Sem lista de ações (`locked_actions` vazio) toda ação está trancada. Toda rota que altera uma automação chama esta função (ou `assertUnlocked`).
 */
export async function lockDenies(db: D1Database, workspaceId: string, automationId: string, action: LockableAction, principal: { role: Role }): Promise<boolean> {
  if (roleCan(principal.role, 'team')) return false
  const row = await db.prepare('SELECT locked,locked_actions FROM automations WHERE workspace_id=? AND id=?').bind(workspaceId, automationId).first<{ locked: number; locked_actions: string | null }>()
  if (!row?.locked) return false
  const denied = row.locked_actions ? (JSON.parse(row.locked_actions) as string[]) : null
  return !denied || denied.includes(action)
}
export async function assertUnlocked(db: D1Database, workspaceId: string, automationId: string, action: LockableAction, principal: { role: Role }): Promise<void> {
  if (await lockDenies(db, workspaceId, automationId, action, principal)) throw new HTTPException(403, { message: 'Esta ação está travada nesta automação. Peça ao dono ou a um administrador.' })
}
/** Trava ou destrava a automação: só dono e administrador. */
automationActions.post('/automations/:id/lock', async c => {
  authorize(c.var.principal, 'team')
  const id = z.string().min(1).max(128).parse(c.req.param('id'))
  const { locked, actions } = automationLockSchema
    .parse(await c.req.json().catch(() => { throw new HTTPException(400, { message: 'JSON inválido.' }) }))
  const stored = locked && actions && actions.length < lockableActions.length ? JSON.stringify([...new Set(actions)]) : null
  const result = await c.env.DB.prepare('UPDATE automations SET locked=?,locked_actions=? WHERE workspace_id=? AND id=?').bind(locked ? 1 : 0, stored, c.var.principal.workspaceId, id).run()
  if (!result.meta.changes) throw new HTTPException(404, { message: 'Automação não encontrada.' })
  return c.json({ id, locked, actions: locked ? actions ?? [...lockableActions] : [] })
})

/** Duplicar para outra conta: cópia em rascunho no espaço escolhido, onde o usuário precisa poder editar. Tags e campos com o mesmo nome são religados. */
automationActions.post('/automations/:id/copy-to', async c => {
  authorize(c.var.principal, 'edit')
  const id = z.string().min(1).max(128).parse(c.req.param('id'))
  const { workspace_id } = automationCopyToSchema.parse(await c.req.json().catch(() => { throw new HTTPException(400, { message: 'JSON inválido.' }) }))
  const target = await c.env.DB.prepare("SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=? AND role IN ('owner','administrator','editor')").bind(workspace_id, c.var.principal.userId).first()
  if (!target) throw new HTTPException(404, { message: 'Conta de destino não encontrada ou sem permissão de edição.' })
  const source = await c.env.DB.prepare('SELECT name,draft_graph FROM automations WHERE workspace_id=? AND id=? AND deleted_at IS NULL').bind(c.var.principal.workspaceId, id).first<{ name: string; draft_graph: string }>()
  if (!source) throw new HTTPException(404, { message: 'Automação não encontrada.' })
  let graph = source.draft_graph
  const refs = await c.env.DB.prepare(`SELECT 'tag' AS kind,s.id AS old,t.id AS new FROM tags s JOIN tags t ON t.workspace_id=? AND t.name=s.name WHERE s.workspace_id=?
    UNION ALL SELECT 'field',s.id,t.id FROM custom_fields s JOIN custom_fields t ON t.workspace_id=? AND t.name=s.name AND t.type=s.type AND t.scope=s.scope WHERE s.workspace_id=?`)
    .bind(workspace_id, c.var.principal.workspaceId, workspace_id, c.var.principal.workspaceId).all<{ old: string; new: string }>()
  for (const ref of refs.results) graph = graph.replaceAll(`"${ref.old}"`, `"${ref.new}"`)
  const copy = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO automations (id,workspace_id,name,draft_graph) VALUES (?,?,?,?)').bind(copy, workspace_id, `${source.name} (cópia)`.slice(0, 100), graph).run()
  return c.json({ id: copy, workspace_id }, 201)
})

/** Compartilhar: gera (ou devolve) o link público da automação. Referências a outras automações não vão junto. */
automationActions.post('/automations/:id/share', async c => {
  authorize(c.var.principal, 'edit')
  const id = z.string().min(1).max(128).parse(c.req.param('id'))
  const { allow_copy } = automationShareSchema.parse(await c.req.json().catch(() => ({})))
  if (!await c.env.DB.prepare('SELECT 1 FROM automations WHERE workspace_id=? AND id=? AND deleted_at IS NULL').bind(c.var.principal.workspaceId, id).first()) throw new HTTPException(404, { message: 'Automação não encontrada.' })
  const token = Array.from(crypto.getRandomValues(new Uint8Array(18)), b => b.toString(16).padStart(2, '0')).join('')
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE automation_shares SET revoked_at=? WHERE workspace_id=? AND automation_id=? AND revoked_at IS NULL').bind(Date.now(), c.var.principal.workspaceId, id),
    c.env.DB.prepare('INSERT INTO automation_shares (token,workspace_id,automation_id,allow_copy) VALUES (?,?,?,?)').bind(token, c.var.principal.workspaceId, id, allow_copy ? 1 : 0),
  ])
  return c.json({ token })
})
/** Revoga o link público da automação: a leitura e a importação por ele passam a dar 404. */
automationActions.delete('/automations/:id/share', async c => {
  authorize(c.var.principal, 'edit')
  const id = z.string().min(1).max(128).parse(c.req.param('id'))
  if (!await c.env.DB.prepare('SELECT 1 FROM automations WHERE workspace_id=? AND id=? AND deleted_at IS NULL').bind(c.var.principal.workspaceId, id).first()) throw new HTTPException(404, { message: 'Automação não encontrada.' })
  const result = await c.env.DB.prepare('UPDATE automation_shares SET revoked_at=? WHERE workspace_id=? AND automation_id=? AND revoked_at IS NULL').bind(Date.now(), c.var.principal.workspaceId, id).run()
  return c.json({ revoked: result.meta.changes })
})
/** Salvar na minha conta uma automação compartilhada (rascunho; sem ligações com outras automações). */
automationActions.post('/automations/import-shared', async c => {
  authorize(c.var.principal, 'edit')
  const { token } = automationImportSharedSchema.parse(await c.req.json().catch(() => ({})))
  const shared = await sharedAutomation(c.env.DB, token)
  if (!shared?.allow_copy) throw new HTTPException(404, { message: 'Link inválido ou sem permissão de cópia.' })
  const copy = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO automations (id,workspace_id,name,draft_graph) VALUES (?,?,?,?)').bind(copy, c.var.principal.workspaceId, shared.name, JSON.stringify(shared.graph)).run()
  return c.json({ id: copy }, 201)
})

export async function sharedAutomation(db: D1Database, token: string) {
  const row = await db.prepare(`SELECT a.name,a.draft_graph,s.allow_copy FROM automation_shares s JOIN automations a ON a.workspace_id=s.workspace_id AND a.id=s.automation_id
    WHERE s.token=? AND s.revoked_at IS NULL AND a.deleted_at IS NULL`).bind(token).first<{ name: string; draft_graph: string; allow_copy: number }>()
  if (!row) return null
  const graph = JSON.parse(row.draft_graph) as { nodes: { type: string; config: Record<string, unknown> }[]; edges: unknown[] }
  // Iniciar outra automação aponta para a conta de origem: vai sem destino.
  for (const node of graph.nodes) if (node.type === 'start_automation' || node.type === 'goto') node.config = { ...node.config, automation_id: '' }
  return { name: row.name, graph: stripSharedSecrets(graph), allow_copy: !!row.allow_copy }
}

/** Só esquema e domínio: o caminho da URL costuma ser a credencial (webhooks de terceiros, token de bot). Porta, host com variável, URL relativa ou que não dá para analisar saem em branco. */
const bareUrl = (url: string) => /^(https?:\/\/)([a-z0-9.-]+)(?=[/?#]|$)/i.exec(url.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1'))?.slice(1, 3).join('') ?? ''
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
/** Objeto que faz requisição para fora: ação external_request, bloco dinâmico ou qualquer um que carregue `headers`. */
function stripRequest(request: Record<string, unknown>) {
  if (Array.isArray(request.headers)) request.headers = request.headers.map(h => isRecord(h) ? { ...h, value: '' } : h)
  else if (isRecord(request.headers)) request.headers = Object.fromEntries(Object.keys(request.headers).map(k => [k, '']))
  if ('body' in request) request.body = ''
  if (typeof request.url === 'string') request.url = bareUrl(request.url)
}
function stripNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNode)
  if (!isRecord(value)) return value
  const copy: Record<string, unknown> = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripNode(v)]))
  if (copy.type === 'external_request' || 'headers' in copy) stripRequest(copy)
  return copy
}
/**
 * O link público serve para copiar a ESTRUTURA do fluxo, nunca credenciais: valores de cabeçalho, corpo e query/usuário da URL
 * das requisições externas e dos blocos dinâmicos saem. Único ponto de saneamento, usado pela leitura pública e pela importação.
 */
export function stripSharedSecrets<G extends { nodes: { type: string; config: Record<string, unknown> }[] }>(graph: G): G {
  return { ...graph, nodes: graph.nodes.map(node => {
    const config = stripNode(node.config) as Record<string, unknown>
    if (node.type === 'dynamic') stripRequest(config)
    return { ...node, config }
  }) }
}

/** Duplicar e converter para outro canal: cópia em rascunho sem os gatilhos (são do canal antigo) e sem os blocos que o canal de destino não oferece. */
automationActions.post('/automations/:id/convert', async c => {
  authorize(c.var.principal, 'edit')
  const id = z.string().min(1).max(128).parse(c.req.param('id'))
  const { channel } = automationConvertSchema.parse(await c.req.json().catch(() => { throw new HTTPException(400, { message: 'JSON inválido.' }) }))
  const source = await c.env.DB.prepare('SELECT name,draft_graph FROM automations WHERE workspace_id=? AND id=? AND deleted_at IS NULL').bind(c.var.principal.workspaceId, id).first<{ name: string; draft_graph: string }>()
  if (!source) throw new HTTPException(404, { message: 'Automação não encontrada.' })
  const profile = capabilities(channel)
  const graph = JSON.parse(source.draft_graph) as { nodes: { id: string; type: string; config: Record<string, unknown> }[]; edges: { from: string; to: string; port: string }[] }
  const triggers = new Set(graph.nodes.filter(n => n.type === 'trigger').map(n => n.id))
  let removed = triggers.size
  const dropped = new Set(triggers)
  graph.nodes = graph.nodes.filter(n => !triggers.has(n.id)).map(n => {
    if (!Array.isArray(n.config.blocks)) return n
    const all = n.config.blocks as { kind?: string; id?: string }[]
    const blocks = all.filter(b => (profile.cards || !isCards(b)) && (profile.quickReplies || b.kind !== 'quick_reply'))
    removed += all.length - blocks.length
    for (const b of all) if (!blocks.includes(b) && b.id) dropped.add(`${n.id}|btn:${b.id}`)
    return { ...n, config: { ...n.config, blocks } }
  })
  graph.edges = graph.edges.filter(e => !dropped.has(e.from) && !dropped.has(e.to) && !dropped.has(`${e.from}|${e.port}`))
  const copy = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO automations (id,workspace_id,name,draft_graph) VALUES (?,?,?,?)').bind(copy, c.var.principal.workspaceId, `${source.name} (${channel})`.slice(0, 100), JSON.stringify(graph)).run()
  return c.json({ id: copy, removed }, 201)
})

