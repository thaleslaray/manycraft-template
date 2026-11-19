import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { seed } from './fixtures'
import { matchesFlowCondition, validateLogicReferences } from '../src/flow/conditions'

beforeEach(async () => { await seed(); await env.DB.prepare("INSERT INTO tags (id,workspace_id,name) VALUES ('tag-x','a','X')").run() })
const ctx = { workspace_id: 'a', contact_id: 'c-a' }

it('condição inteligente: qualquer uma das etiquetas', async () => {
  expect(await matchesFlowCondition(env.DB, ctx, { match: 'all', rules: [{ type: 'any_tag', tag_ids: ['tag-x', 'tag-a'], operator: 'has' }] })).toBe(true)
  expect(await matchesFlowCondition(env.DB, ctx, { match: 'all', rules: [{ type: 'any_tag', tag_ids: ['tag-x'], operator: 'has' }] })).toBe(false)
  expect(await matchesFlowCondition(env.DB, ctx, { match: 'all', rules: [{ type: 'any_tag', tag_ids: ['tag-x'], operator: 'not_has' }] })).toBe(true)
  await expect(validateLogicReferences(env.DB, 'a', 'condition', { match: 'all', rules: [{ type: 'any_tag', tag_ids: ['tag-b'], operator: 'has' }] })).rejects.toThrow()
})
