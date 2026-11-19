import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { listAutomations, listContacts, searchContacts } from '../src/db'
import { seed } from './fixtures'

it('lista com carga do plano: 50 mil contatos e 1.151 automações, usando índices', async () => {
  await seed()
  await env.DB.batch([
    env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 50000)
      INSERT INTO contacts (id,workspace_id,first_name,last_name,subscribed_at)
      SELECT 'load-' || x, 'a', 'Contato', 'Teste ' || x, 1000 + x FROM n`),
    env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 1151)
      INSERT INTO automations (id,workspace_id,name)
      SELECT 'load-' || x, 'a', 'Automação ' || x FROM n`),
  ])
  const contacts = await listContacts(env.DB, 'a')
  expect(contacts.rows).toHaveLength(40)
  expect(contacts.total).toBe(50001)
  expect((await listAutomations(env.DB, 'a')).length).toBe(1152)
  expect((await searchContacts(env.DB, 'b', 'Contato')).rows).toEqual([])
  const contactPlan = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT c.* FROM contacts c
    WHERE c.workspace_id = ? ORDER BY c.subscribed_at DESC, c.id DESC LIMIT 41`).bind('a').all<{ detail: string }>()
  const automationPlan = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT * FROM automations
    WHERE workspace_id = ? AND deleted_at IS NULL AND folder_id IS ?`).bind('a', null).all<{ detail: string }>()
  expect(contactPlan.results.map(row => row.detail).join(' ')).toContain('contacts_cursor')
  expect(automationPlan.results.map(row => row.detail).join(' ')).toContain('USING INDEX')
}, 15000)
