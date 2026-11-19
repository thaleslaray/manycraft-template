import { HTTPException } from 'hono/http-exception'
import { SHARE_TO_DM_WIDGET } from './db/automations'
import { AD_WIDGET_BY_KIND } from './channels/ad-origin'
import { Hono } from 'hono'
import { z } from 'zod'
import { hotmartConfig } from './hotmart'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { createCommentSchema, patchCommentSchema, saveCommentTrigger } from './db/comment-triggers'
import { createStorySchema, patchStoryMentionSchema, patchStoryReplySchema, saveStoryTrigger } from './db/story-triggers'
import { createRefSchema, deleteRefTrigger, patchRefSchema, saveRefTrigger } from './db/ref-links'
import { patchExternalSchema } from './db/external-triggers'
import { authorize } from './permissions'
import { repositoryFor, triggerCreateSchema, triggerPatchSchema } from './db'

const triggerName = z.string().trim().min(1).max(100), triggerNode = z.string().min(1).max(128)
export const adTriggerCreateSchema = z.object({ type: z.literal('ad'), name: triggerName, node_id: triggerNode, connection_id: z.string().min(1).max(128),
  ad_ids: z.array(z.string().regex(/^\d{1,64}$/)).max(50).default([]), enabled: z.boolean().default(true) }).strict()
export const shareToDmTriggerCreateSchema = z.object({ type: z.literal('ig_share_to_dm'), name: triggerName, node_id: triggerNode, connection_id: z.string().min(1).max(128), enabled: z.boolean().default(true) }).strict()
export const cartReplyTriggerCreateSchema = z.object({ type: z.literal('cart_reply'), name: triggerName, node_id: triggerNode, connection_id: z.string().min(1).max(128), enabled: z.boolean().default(true) }).strict()
export const hotmartTriggerCreateSchema = z.object({ type: z.literal('hotmart'), name: triggerName, node_id: triggerNode, config: hotmartConfig, enabled: z.boolean().default(true) }).strict()
export const apiTriggerCreateSchema = z.object({ type: z.literal('api'), name: z.string().trim().regex(/^[a-z0-9_]{1,64}$/, 'Use letras minúsculas, números e _.'), node_id: triggerNode, enabled: z.boolean().default(true) }).strict()
/** Só para a documentação: os formatos aceitos por POST /automations/:id/triggers, escolhidos por `type` (sem `type`, palavra-chave). Cada membro é o schema que o handler usa. */
export const automationTriggerCreateBodySchema = z.union([createCommentSchema, createStorySchema, adTriggerCreateSchema, shareToDmTriggerCreateSchema,
  cartReplyTriggerCreateSchema, hotmartTriggerCreateSchema, apiTriggerCreateSchema, createRefSchema, triggerCreateSchema])
/** Só para a documentação: PATCH /automations/:id/triggers/:triggerId escolhe o formato pelo tipo do gatilho guardado. Cada membro é o schema que o handler usa. */
export const automationTriggerPatchBodySchema = z.union([patchCommentSchema, patchStoryReplySchema, patchStoryMentionSchema, patchRefSchema, patchExternalSchema, triggerPatchSchema])

/** Um gatilho só nasce ativo se a automação já tem versão publicada com o passo dele; rascunho nunca fica ativo antes de publicar. */
async function startStatus(db: D1Database, ws: string, automation: string, nodeId: string, enabled: boolean): Promise<'active' | 'initial'> {
  if (!enabled) return 'initial'
  const published = await db.prepare(`SELECT v.graph FROM automations a JOIN automation_versions v ON v.workspace_id=a.workspace_id AND v.automation_id=a.id AND v.id=a.published_version_id
    WHERE a.workspace_id=? AND a.id=? AND a.deleted_at IS NULL`).bind(ws, automation).first<string>('graph')
  return published && (JSON.parse(published) as { nodes: { id: string }[] }).nodes.some(node => node.id === nodeId) ? 'active' : 'initial'
}

export const automationTriggerActions = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
automationTriggerActions.post('/automations/:id/triggers', async c => {
  const id = z.string().min(1).max(128).parse(c.req.param('id'))
  const raw = await c.req.json().catch(() => null)
  if (raw?.type === 'ig_comment' || raw?.type === 'ig_live_comment') {
    authorize(c.var.principal, 'edit')
    return c.json(await saveCommentTrigger(c.env.DB, c.var.principal.workspaceId, id, createCommentSchema.parse(raw)), 201)
  }
  if (raw?.type === 'ig_story_reply' || raw?.type === 'ig_story_mention') {
    authorize(c.var.principal, 'edit')
    return c.json(await saveStoryTrigger(c.env.DB, c.var.principal.workspaceId, id, raw), 201)
  }
  if (raw?.type === 'ad') {
    // Anúncio que abre conversa: o tipo do gatilho sai do canal da conexão; sem ids, vale para qualquer anúncio.
    authorize(c.var.principal, 'edit')
    const input = adTriggerCreateSchema.parse(raw)
    const kind = await c.env.DB.prepare('SELECT type FROM channels WHERE workspace_id=? AND id=? AND archived_at IS NULL').bind(c.var.principal.workspaceId, input.connection_id).first<string>('type')
    const widget = kind ? AD_WIDGET_BY_KIND[kind] : undefined
    if (!widget) throw new HTTPException(400, { message: 'Esta conexão não recebe conversas de anúncio.' })
    const key = crypto.randomUUID()
    await c.env.DB.prepare(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status,repeat_mode,config) VALUES (?,?,?,?,?,'widget',?,?,'every_time',?)`)
      .bind(key, c.var.principal.workspaceId, id, input.connection_id, input.name, widget, await startStatus(c.env.DB, c.var.principal.workspaceId, id, input.node_id, input.enabled), JSON.stringify({ node_id: input.node_id, ad_ids: input.ad_ids })).run()
    return c.json({ id: key, type: 'ad', name: input.name }, 201)
  }
  if (raw?.type === 'ig_share_to_dm') {
    // Share to DM: o contato compartilha um post ou reel no direct; dispara uma vez por contato nesta automação.
    authorize(c.var.principal, 'edit')
    const input = shareToDmTriggerCreateSchema.parse(raw)
    if (!await c.env.DB.prepare('SELECT 1 FROM channels WHERE workspace_id=? AND id=? AND archived_at IS NULL').bind(c.var.principal.workspaceId, input.connection_id).first()) throw new HTTPException(404, { message: 'Conexão não encontrada.' })
    const key = crypto.randomUUID()
    await c.env.DB.prepare(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status,repeat_mode,config) VALUES (?,?,?,?,?,'widget',?,?,'once',?)`)
      .bind(key, c.var.principal.workspaceId, id, input.connection_id, input.name, SHARE_TO_DM_WIDGET, await startStatus(c.env.DB, c.var.principal.workspaceId, id, input.node_id, input.enabled), JSON.stringify({ node_id: input.node_id })).run()
    return c.json({ id: key, type: 'ig_share_to_dm', name: input.name }, 201)
  }
  if (raw?.type === 'cart_reply') {
    // Carrinho: o contato manda um pedido do catálogo pela conexão escolhida.
    authorize(c.var.principal, 'edit')
    const input = cartReplyTriggerCreateSchema.parse(raw)
    if (!await c.env.DB.prepare('SELECT 1 FROM channels WHERE workspace_id=? AND id=? AND archived_at IS NULL').bind(c.var.principal.workspaceId, input.connection_id).first()) throw new HTTPException(404, { message: 'Conexão não encontrada.' })
    const key = crypto.randomUUID()
    await c.env.DB.prepare(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES (?,?,?,?,?,'cart_reply',?,'every_time',?)`)
      .bind(key, c.var.principal.workspaceId, id, input.connection_id, input.name, await startStatus(c.env.DB, c.var.principal.workspaceId, id, input.node_id, input.enabled), JSON.stringify({ node_id: input.node_id })).run()
    return c.json({ id: key, type: 'cart_reply', name: input.name }, 201)
  }
  if (raw?.type === 'hotmart') {
    authorize(c.var.principal, 'edit')
    const input = hotmartTriggerCreateSchema.parse(raw)
    const key = crypto.randomUUID()
    await c.env.DB.prepare(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES (?,?,?,NULL,?,'external_trigger',?,'every_time',?)`)
      .bind(key, c.var.principal.workspaceId, id, input.name, await startStatus(c.env.DB, c.var.principal.workspaceId, id, input.node_id, input.enabled), JSON.stringify({ node_id: input.node_id, source: 'hotmart', ...input.config })).run()
    return c.json({ id: key, type: 'hotmart', name: input.name }, 201)
  }
  if (raw?.type === 'api') {
    // Entrada externa: a API pública dispara pelo nome (trigger_name); o contexto vira campos do contato com o mesmo nome.
    authorize(c.var.principal, 'edit')
    const input = apiTriggerCreateSchema.parse(raw)
    const ws = c.var.principal.workspaceId
    if (await c.env.DB.prepare("SELECT 1 FROM triggers WHERE workspace_id=? AND kind='external_trigger' AND json_extract(config,'$.trigger_name')=? AND status<>'disabled'").bind(ws, input.name).first())
      throw new HTTPException(409, { message: 'Já existe uma entrada externa com este nome.' })
    const key = crypto.randomUUID()
    await c.env.DB.prepare(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES (?,?,?,NULL,?,'external_trigger',?,'every_time',?)`)
      .bind(key, ws, id, input.name, await startStatus(c.env.DB, c.var.principal.workspaceId, id, input.node_id, input.enabled), JSON.stringify({ node_id: input.node_id, trigger_name: input.name })).run()
    return c.json({ id: key, type: 'api', name: input.name }, 201)
  }
  if (raw?.type === 'ref_url') {
    authorize(c.var.principal, 'edit')
    return c.json(await saveRefTrigger(c.env.DB, c.var.principal.workspaceId, id, raw), 201)
  }
  const body = triggerCreateSchema.parse(raw)
  return c.json(await repositoryFor(c.env, c.var.principal.workspaceId, c.var.principal).createAutomationTrigger(id, body), 201)
})
automationTriggerActions.delete('/automations/:id/triggers/:triggerId', async c => {
  authorize(c.var.principal, 'edit')
  const params = z.object({ id: z.string().min(1).max(128), triggerId: z.string().min(1).max(128) }).parse(c.req.param())
  return c.json(await deleteRefTrigger(c.env.DB, c.var.principal.workspaceId, params.id, params.triggerId))
})
