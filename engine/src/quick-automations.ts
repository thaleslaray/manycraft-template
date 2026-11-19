import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { authorize } from './permissions'
import { json } from './security'
import { createAutomation, publishAutomation, saveDraft } from './db/automations'
import { createTag } from './db/tags'
import { createAutomationTrigger } from './db/automation-triggers'
import { saveCommentTrigger } from './db/comment-triggers'
import { saveStoryTrigger } from './db/story-triggers'

/**
 * Automações rápidas: o assistente pergunta o objetivo (palavra-chave na DM ou comentário que vira DM), as palavras, a conexão e a
 * mensagem, e já entrega a automação montada, publicada e com o gatilho ligado. Depois ela se edita como qualquer outra.
 */
export const quickAutomations = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
export const quickAutomationSchema = z.object({
  goal: z.enum(['keyword', 'comment', 'story_mention']), name: z.string().trim().min(1).max(100), connection_id: z.string().min(1).max(128),
  words: z.array(z.string().trim().min(1).max(500)).max(10).default([]), message: z.string().trim().min(1).max(1000),
  button: z.object({ label: z.string().trim().min(1).max(20), url: z.url({ protocol: /^https?$/ }) }).optional(),
  /** Menção em story: além da frequência do gatilho, uma etiqueta no fluxo garante resposta única por contato (segunda camada). */
  dedupe_tag: z.string().trim().min(1).max(190).optional(),
  /** Falso deixa a automação como rascunho (gatilho desligado): o caso de uso pronto pode ser revisado antes de ir ao ar. */
  publish: z.boolean().default(true),
}).strict().refine(b => b.goal === 'story_mention' || b.words.length > 0, { path: ['words'], message: 'Informe ao menos uma palavra.' })

quickAutomations.post('/quick-automations', async c => {
  authorize(c.var.principal, 'edit')
  const body = quickAutomationSchema.parse(await json(c.req.raw))
  const ws = c.var.principal.workspaceId
  const automation = await createAutomation(c.env.DB, ws, { name: body.name })
  const blocks = [{ kind: 'text', text: body.message }, ...(body.button ? [{ kind: 'button', id: 'b1', label: body.button.label, action: { type: 'url', url: body.button.url } }] : [])]
  const message = { id: 'm1', type: 'message', position: { x: 720, y: 80 }, config: { blocks } }
  const tag = body.goal === 'story_mention' && body.dedupe_tag ? await ensureTag(c.env.DB, ws, body.dedupe_tag) : null
  await saveDraft(c.env.DB, ws, automation.id, tag
    ? { nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 80 }, config: {} },
      { id: 'c1', type: 'condition', position: { x: 360, y: 80 }, config: { match: 'all', rules: [{ type: 'tag', tag_id: tag, operator: 'not_has' }] } },
      { id: 'a1', type: 'action', position: { x: 540, y: 80 }, config: { actions: [{ type: 'add_tag', tag_id: tag }] } }, message],
      edges: [{ from: 'trigger', port: 'next', to: 'c1' }, { from: 'c1', port: 'true', to: 'a1' }, { from: 'a1', port: 'next', to: 'm1' }] }
    : { nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 80 }, config: {} }, { ...message, position: { x: 360, y: 80 } }], edges: [{ from: 'trigger', port: 'next', to: 'm1' }] })
  const trigger = body.goal === 'keyword'
    ? await createAutomationTrigger(c.env.DB, ws, automation.id, { name: 'Palavra-chave', connection_id: body.connection_id, node_id: 'trigger', rule: 'contains', words: body.words })
    : body.goal === 'comment' ? await saveCommentTrigger(c.env.DB, ws, automation.id, { type: 'ig_comment', name: 'Comentário', connection_id: body.connection_id, node_id: 'trigger',
      config: { target: 'all', include: body.words, exclude: [], public_replies: [] } })
    : await saveStoryTrigger(c.env.DB, ws, automation.id, { type: 'ig_story_mention', name: 'Menção em story', connection_id: body.connection_id, node_id: 'trigger' }) as { id: string }
  if (body.publish) {
    await publishAutomation(c.env.DB, ws, automation.id)
    await c.env.DB.prepare("UPDATE triggers SET status='active' WHERE workspace_id=? AND id=?").bind(ws, trigger.id).run()
  }
  return c.json({ automation_id: automation.id, trigger_id: trigger.id }, 201)
})

async function ensureTag(db: D1Database, ws: string, name: string) {
  const found = await db.prepare('SELECT id FROM tags WHERE workspace_id=? AND name=? AND archived=0').bind(ws, name).first<string>('id')
  return found ?? (await createTag(db, ws, name)).id
}
