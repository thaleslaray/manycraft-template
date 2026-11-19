import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { seed } from './fixtures'
import { createConnection, rotateCredentials } from '../src/channels/core/connections'
import type { Env } from '../src/env'

beforeEach(seed)
afterEach(() => vi.restoreAllMocks())

const base = 'https://engine.test'
const conta = (id: string) => (async (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url.includes('?fields=id,username')) return Response.json({ id, username: 'oficina' })
  return Response.json({ success: true })
}) as typeof fetch

it('migrar a conexão do Instagram: trocar as credenciais coladas mantém a mesma conexão, os contatos e as conversas', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(conta('17841400000000002'))
  const e = env as unknown as Env
  const { connection } = await createConnection(e, 'a', { kind: 'instagram', provider: 'instagram_unified', credentials: { accessToken: 'token-antigo', accountId: '17841400000000002', appSecret: 'segredo' } }, base)
  await env.DB.prepare("INSERT INTO contacts (id,workspace_id) VALUES ('mig-c','a')").run()
  await env.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('mig-cc','a','mig-c',?,'99',1)").bind(connection.id).run()
  const result = await rotateCredentials(e, 'a', connection.id, { accessToken: 'token-novo', accountId: '17841400000000002', appSecret: 'segredo-novo' }, base)
  expect(typeof result.rotatedAt).toBe('number')
  expect(await env.DB.prepare("SELECT count(*) FROM channels WHERE external_id='17841400000000002'").first('count(*)')).toBe(1)
  expect(await env.DB.prepare('SELECT count(*) FROM contact_channels WHERE channel_id=?').bind(connection.id).first('count(*)')).toBe(1)
  expect(await env.DB.prepare('SELECT credentials_rotated_at IS NOT NULL AS r FROM channels WHERE id=?').bind(connection.id).first('r')).toBe(1)
  const { connectionRuntime } = await import('../src/channels/core/runtime')
  expect((await (await connectionRuntime(e, 'a', connection.id)).credentials()).accessToken).toBe('token-novo')
})

it('migrar a conexão do Instagram: credencial de outra conta é recusada e a antiga continua valendo', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(conta('17841400000000002'))
  const e = env as unknown as Env
  const { connection } = await createConnection(e, 'a', { kind: 'instagram', provider: 'instagram_unified', credentials: { accessToken: 'token-antigo', accountId: '17841400000000002', appSecret: 'segredo' } }, base)
  await expect(rotateCredentials(e, 'a', connection.id, { accessToken: 'token-outro', accountId: '17841499999999999', appSecret: 'segredo' }, base)).rejects.toThrow()
  const { connectionRuntime } = await import('../src/channels/core/runtime')
  expect((await (await connectionRuntime(e, 'a', connection.id)).credentials()).accessToken).toBe('token-antigo')
})
