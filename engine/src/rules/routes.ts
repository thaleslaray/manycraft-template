import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../env'
import type { AuthVariables } from '../team'
import { authorize } from '../permissions'
import { json } from '../security'
import { RepositoryError } from '../db/shared'
import { ruleConfigSchema, ruleInputSchema } from './schema'
import { getRule, listRules, saveRule, validateReferences } from './repository'

export const ruleActiveSchema = z.object({ active: z.boolean() }).strict()
export const rules = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
rules.use('*', async (c,next) => {
  authorize(c.var.principal,['GET','HEAD'].includes(c.req.method) ? 'automation:read' : 'edit')
  await next()
})
const id = z.string().min(1).max(128)
rules.get('/', async c => c.json(await listRules(c.env.DB,c.var.principal.workspaceId)))
rules.post('/', async c => c.json(await saveRule(c.env.DB,c.var.principal.workspaceId,ruleInputSchema.parse(await json(c.req.raw))),201))
rules.get('/:id', async c => c.json(await getRule(c.env.DB,c.var.principal.workspaceId,id.parse(c.req.param('id')))))
// Regra ativa editada: a resposta pede need_activate e o painel publica e reativa na hora (a versão no ar não fica velha).
rules.put('/:id', async c => {
  const saved = await saveRule(c.env.DB,c.var.principal.workspaceId,ruleInputSchema.parse(await json(c.req.raw)),id.parse(c.req.param('id')))
  return c.json({ ...saved, need_activate: !!(saved as { active?: unknown }).active })
})
rules.post('/:id/publish', async c => {
  const workspace = c.var.principal.workspaceId, rule = await getRule(c.env.DB,workspace,id.parse(c.req.param('id')))
  const config = ruleConfigSchema.parse(rule.draft)
  await validateReferences(c.env.DB,workspace,config)
  await c.env.DB.prepare('UPDATE rules SET published=?,published_at=?,active=1,updated_at=? WHERE workspace_id=? AND id=?').bind(JSON.stringify(config),Date.now(),Date.now(),workspace,rule.id).run()
  return c.json(await getRule(c.env.DB,workspace,rule.id))
})
rules.patch('/:id', async c => {
  const { active } = ruleActiveSchema.parse(await json(c.req.raw))
  const workspace = c.var.principal.workspaceId, rule = await getRule(c.env.DB,workspace,id.parse(c.req.param('id')))
  if (active && !rule.published) throw new RepositoryError('Publique o rascunho antes de ativar.',400)
  if (active) await validateReferences(c.env.DB,workspace,ruleConfigSchema.parse(rule.published))
  await c.env.DB.prepare('UPDATE rules SET active=?,updated_at=? WHERE workspace_id=? AND id=?').bind(Number(active),Date.now(),workspace,rule.id).run()
  return c.json(await getRule(c.env.DB,workspace,rule.id))
})
rules.post('/:id/duplicate', async c => {
  const workspace = c.var.principal.workspaceId, rule = await getRule(c.env.DB,workspace,id.parse(c.req.param('id')))
  return c.json(await saveRule(c.env.DB,workspace,ruleInputSchema.parse({ ...rule.draft,name: `${rule.name.slice(0,150)} (cópia)` })),201)
})
rules.delete('/:id', async c => {
  const workspace = c.var.principal.workspaceId, rule = await getRule(c.env.DB,workspace,id.parse(c.req.param('id')))
  await c.env.DB.prepare('DELETE FROM rules WHERE workspace_id=? AND id=?').bind(workspace,rule.id).run()
  return c.json({ ok: true })
})
