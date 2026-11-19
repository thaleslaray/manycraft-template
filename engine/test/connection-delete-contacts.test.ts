import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'

beforeEach(seedAuth)

it('arquivar com "excluir contatos": apaga só quem existe apenas nesta conexão; sem a opção, ninguém sai', async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('ch-x','a','telegram','tg-x')"),
    env.DB.prepare("INSERT INTO contacts (id,workspace_id) VALUES ('k-only','a'),('k-both','a')"),
    env.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('cc1','a','k-only','ch-a','u1',1),('cc2','a','k-both','ch-a','u2',1),('cc3','a','k-both','ch-x','u3',1)"),
  ])
  const r = await authenticatedRequest('connections/ch-a?delete_contacts=1', 'a', { method: 'DELETE' })
  expect(r.status).toBe(200)
  expect((await r.json() as { deleted_contacts: number }).deleted_contacts).toBeGreaterThanOrEqual(1)
  const status = async (id: string) => env.DB.prepare('SELECT status FROM contacts WHERE id=?').bind(id).first<string>('status')
  expect(await status('k-only')).toBe('deleted')
  expect(await status('k-both')).not.toBe('deleted')
})
