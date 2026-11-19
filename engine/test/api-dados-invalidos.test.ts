import { env } from 'cloudflare:workers'
import { expect, it, vi } from 'vitest'
import { app } from '../src/index'

// Bug 6 do teste real do Instagram: GET /connections/:id/posts e POST /automations/:id/triggers respondiam
// "Dados inválidos" com path [] em 2 ms. Sem o cabeçalho x-workspace a falha era o parse do cabeçalho (path []),
// sem dizer o que faltava; e chave desconhecida na query da lista de publicações derrubava a lista.
async function conexao() {
  const { seedAuth, origin } = await import('./auth-helpers')
  const { giveCredentials } = await import('./credentials')
  await seedAuth()
  await env.DB.prepare(`INSERT INTO channels(id,workspace_id,type,provider,external_id,connection_state,settings) VALUES ('posts-ig','a','instagram','instagram_unified','12345','connected','{}')`).run()
  await giveCredentials(env, 'posts-ig', { accountId: '12345', accessToken: 'TESTONLY' })
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [{ id: 'post-1' }] }))
  const call = (path: string, headers: Record<string, string> = { 'x-workspace': 'a' }, init: RequestInit = {}) =>
    app.request(`${origin}${path}`, { ...init, headers: { origin, ...headers } }, { ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: 'a' })
  return call
}

it('sem x-workspace a API diz qual cabeçalho falta, em vez de "Dados inválidos" sem path', async () => {
  const call = await conexao()
  const response = await call('/api/connections/posts-ig/posts', {})
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'Informe o espaço de trabalho no cabeçalho x-workspace.' })
  const post = await call('/api/automations/auto-a/triggers', {}, { method: 'POST', body: '{}' })
  expect(post.status).toBe(400)
  expect((await post.json() as { error: string }).error).toMatch(/x-workspace/)
})

it('a lista de publicações ignora chaves desconhecidas na consulta', async () => {
  const call = await conexao()
  const response = await call('/api/connections/posts-ig/posts?limit=12&_=1760000000')
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ posts: [{ id: 'post-1' }], nextCursor: null })
  expect((await call('/api/connections/posts-ig/stories?_=1')).status).not.toBe(400)
})

it('campo desconhecido no corpo diz quais chaves o motor não reconhece', async () => {
  const call = await conexao()
  const response = await call('/api/automations/auto-a/triggers', { 'x-workspace': 'a', 'content-type': 'application/json' },
    { method: 'POST', body: JSON.stringify({ type: 'ig_comment', name: 'x', connection_id: 'posts-ig', node_id: 't', config: { target: 'all', include: [], exclude: [], public_replies: [] }, extra: 1 }) })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: 'Dados inválidos.', issues: [{ code: 'unrecognized_keys', path: [], keys: ['extra'] }] })
})
