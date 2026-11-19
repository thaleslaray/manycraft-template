import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'

beforeEach(seedAuth)

const total = async (query: string, workspace = 'a') => {
  const r = await authenticatedRequest(`contacts?${query}`, workspace)
  expect(r.status).toBe(200)
  return (await r.json() as { total: number }).total
}

it('duas conexões do mesmo tipo devolvem totais diferentes pelo filtro connection_id', async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('ig-1','a','instagram','ig-1'),('ig-2','a','instagram','ig-2')"),
    env.DB.prepare("INSERT INTO contacts (id,workspace_id) VALUES ('k1','a'),('k2','a'),('k3','a')"),
    env.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('p1','a','k1','ig-1','u1',1),('p2','a','k2','ig-1','u2',1),('p3','a','k3','ig-1','u3',1),('p4','a','k1','ig-2','u4',1)"),
  ])
  expect(await total('connection_id=ig-1')).toBe(3)
  expect(await total('connection_id=ig-2')).toBe(1)
  expect(await total('connection_id=inexistente')).toBe(0)
})

it('o filtro por conexão é isolado por espaço de trabalho', async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('ig-1','a','instagram','ig-1')"),
    env.DB.prepare("INSERT INTO contacts (id,workspace_id) VALUES ('k1','a')"),
    env.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('p1','a','k1','ig-1','u1',1)"),
  ])
  expect(await total('connection_id=ig-1', 'a')).toBe(1)
  expect(await total('connection_id=ig-1', 'b')).toBe(0)
})
