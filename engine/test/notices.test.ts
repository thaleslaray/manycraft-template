import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'

beforeEach(seedAuth)
const notices = async () => await (await authenticatedRequest('notices')).json() as { items: { kind: string; message: string }[]; unread: number; restriction: string | null }

it('avisos: conexão que cai avisa e pausa transmissões quando pedido; restrição também; ler zera', async () => {
  expect((await authenticatedRequest('connections/ch-a/disconnection', 'a', { method: 'PUT', body: JSON.stringify({ notify: true, pause_broadcasts: true }) })).status).toBe(200)
  await env.DB.prepare("INSERT INTO broadcasts(id,workspace_id,name,channel_id,status) VALUES ('bx','a','Promo','ch-a','scheduled')").run()
  await env.DB.prepare("UPDATE channels SET connection_state='error',status_detail='token expirado' WHERE id='ch-a'").run()
  expect(await env.DB.prepare("SELECT paused_at IS NOT NULL FROM broadcasts WHERE id='bx'").first()).toEqual({ 'paused_at IS NOT NULL': 1 })
  await env.DB.prepare("UPDATE workspaces SET restricted_reason='violação de política' WHERE id='a'").run()
  const n = await notices()
  expect(n.items.map(i => i.kind).sort()).toEqual(['connection', 'restriction'])
  expect(n.restriction).toBe('violação de política')
  expect(n.unread).toBe(2)
  await authenticatedRequest('notices/read', 'a', { method: 'POST', body: '{}' })
  expect((await notices()).unread).toBe(0)
})
