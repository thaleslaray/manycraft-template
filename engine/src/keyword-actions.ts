import { Hono } from 'hono'
import type { Env } from './env'
import type { AuthVariables } from './team'
import { repositoryFor } from './db'
import { keywordAutomationInputSchema } from './db/keywords'
import { assertUnlocked } from './automation-actions'

export const keywordActions = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
keywordActions.post('/keywords/automation', async c => {
  const input = keywordAutomationInputSchema.parse(await c.req.json().catch(() => null))
  // Com keyword_id a regra existente passa a disparar a automação nova: sai da que está trancada, e isso é uma edição dela.
  const current = input.keyword_id ? await c.env.DB.prepare('SELECT t.automation_id FROM keywords k JOIN triggers t ON t.workspace_id=k.workspace_id AND t.id=k.trigger_id WHERE k.workspace_id=? AND k.id=?')
    .bind(c.var.principal.workspaceId, input.keyword_id).first<string>('automation_id') : null
  if (current) await assertUnlocked(c.env.DB, c.var.principal.workspaceId, current, 'edit', c.var.principal)
  return c.json(await repositoryFor(c.env, c.var.principal.workspaceId, c.var.principal).createKeywordAutomation(input), 201)
})
