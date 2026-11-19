import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'
import { ensureConversation, recordMessage } from '../src/inbox/service'
import { autoAssign } from '../src/inbox/assignment'

beforeEach(async () => {
  await seedAuth()
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES ('user-a2','Bruno','a2@example.test',1,0,0)`),
    env.DB.prepare("INSERT INTO workspace_members(id,workspace_id,user_id,role,inbox_seat) VALUES ('member-a2','a','user-a2','editor',1)"),
  ])
  await ensureConversation(env, 'a', 'c-a', 'ch-a')
})
const call = (path: string, method = 'GET', body?: unknown) => authenticatedRequest(`inbox/${path}`, 'a', { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const assignee = () => env.DB.prepare("SELECT assignee_id FROM conversations WHERE id='inbox-cc-a'").first<string | null>('assignee_id')

it('desligada não atribui; básica escolhe o atendente com menos conversas abertas e respeita o limite', async () => {
  await recordMessage(env, { workspaceId: 'a', conversationId: 'inbox-cc-a', direction: 'in', sender: 'contact', text: 'oi' })
  expect(await assignee()).toBeNull()
  expect((await call('assignment', 'PUT', { auto_assign: 'basic', assign_limit: 1 })).status).toBe(200)
  await env.DB.prepare("INSERT INTO contacts (id,workspace_id) VALUES ('c-x','a')").run()
  await env.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id) VALUES ('cc-x','a','c-x','ch-a','x')").run()
  await env.DB.prepare("INSERT INTO conversations (id,workspace_id,contact_channel_id,assignee_id,status) VALUES ('conv-x','a','cc-x','member-a','open')").run()
  await recordMessage(env, { workspaceId: 'a', conversationId: 'inbox-cc-a', direction: 'in', sender: 'contact', text: 'de novo' })
  expect(await assignee()).toBe('member-a2')
  await env.DB.prepare("UPDATE conversations SET assignee_id=NULL WHERE id='inbox-cc-a'").run()
  await env.DB.prepare("UPDATE conversations SET assignee_id='member-a2' WHERE id='conv-x'").run()
  await env.DB.prepare("INSERT INTO conversations (id,workspace_id,contact_channel_id,assignee_id,status) SELECT 'conv-y','a','cc-x','member-a','open' WHERE 0").run()
  expect(await autoAssign(env, 'a', 'inbox-cc-a')).toBe('member-a')
})

it('avançada: regra com tag manda para o grupo; sem regra que case, cai no básico', async () => {
  const group = await (await call('groups', 'POST', { name: 'Vendas', member_ids: ['member-a2'] })).json() as { id: string }
  expect((await call('assignment-rules', 'PUT', [{ name: 'Leads', condition: { match: 'all', rules: [{ type: 'tag', tag_id: 'tag-a', operator: 'has' }] }, target_kind: 'group', target_id: group.id }])).status).toBe(200)
  await call('assignment', 'PUT', { auto_assign: 'advanced', assign_limit: null })
  expect(await autoAssign(env, 'a', 'inbox-cc-a')).toBe('member-a2')
  await env.DB.prepare("UPDATE conversations SET assignee_id=NULL WHERE id='inbox-cc-a'").run()
  await env.DB.prepare("DELETE FROM contact_tags WHERE contact_id='c-a'").run()
  await env.DB.prepare("INSERT INTO conversations (id,workspace_id,contact_channel_id,assignee_id,status) SELECT 'conv-z','a',id,'member-a2','open' FROM contact_channels WHERE id='cc-a' AND 0").run()
  expect(await autoAssign(env, 'a', 'inbox-cc-a')).toBe('member-a')
  expect((await call('assignment-rules', 'PUT', [{ name: 'X', condition: { match: 'all', rules: [] }, target_kind: 'group', target_id: 'nao-existe' }])).status).toBe(400)
})
