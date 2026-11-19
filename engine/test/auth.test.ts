import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import { graph } from './fixtures'
import { authenticatedRequest, authRequest, emailLink, fixtureCookie, origin, password, responseCookie, seedAuth } from './auth-helpers'

beforeEach(seedAuth)

async function register(email = 'nova@example.test') {
  const response = await authRequest('sign-up/email', { name: 'Pessoa de teste', email, password })
  expect(response.status).toBe(200)
  return await response.json() as { user: { id: string; emailVerified: boolean } }
}
async function verifiedLogin(email = 'nova@example.test') {
  const user = await register(email)
  const link = await emailLink(email, 'verification')
  const verification = await app.request(link.href, {}, env)
  expect(verification.status).toBeLessThan(400)
  const login = await authRequest('sign-in/email', { email, password })
  expect(login.status).toBe(200)
  return { ...user, login, cookie: responseCookie(login) }
}

it('cadastro envia verificação no D1 e login só libera e-mail confirmado com cookie seguro', async () => {
  const email = 'verificar@example.test'
  const registered = await register(email)
  expect(registered.user.emailVerified).toBe(false)
  const refused = await authRequest('sign-in/email', { email, password })
  expect(refused.status).toBe(403)
  expect(refused.headers.get('set-cookie') ?? '').not.toContain('session_token=')
  const row = await env.DB.prepare('SELECT subject,html,text FROM email_outbox WHERE recipient=? AND kind=?').bind(email, 'verification').first<{ subject: string; html: string; text: string }>()
  expect(row?.subject).toBe('Confirme seu endereço de e-mail')
  expect(row?.html).toContain('Continuar')
  const verification = await app.request((await emailLink(email, 'verification')).href, {}, env)
  expect(verification.status).toBeLessThan(400)
  const login = await authRequest('sign-in/email', { email, password })
  expect(login.status).toBe(200)
  const setCookie = login.headers.get('set-cookie')!
  expect(setCookie).toMatch(/HttpOnly/i)
  expect(setCookie).toMatch(/Secure/i)
  expect(setCookie).toMatch(/SameSite=Lax/i)
  const session = await authRequest('get-session', undefined, responseCookie(login))
  expect(session.status).toBe(200)
  expect(await session.json()).toMatchObject({ user: { id: registered.user.id, email, emailVerified: true } })
})

it('reset de senha revoga todas as sessões e exige a nova credencial', async () => {
  const email = 'reset@example.test'
  const { cookie } = await verifiedLogin(email)
  const second = await authRequest('sign-in/email', { email, password })
  expect(second.status).toBe(200)
  expect((await authRequest('request-password-reset', { email, redirectTo: `${origin}/reset` })).status).toBe(200)
  const token = (await emailLink(email, 'reset')).pathname.split('/').at(-1)!
  const nextPassword = 'Outra-senha-ficticia-segura-2026!'
  expect((await authRequest('reset-password', { token, newPassword: nextPassword })).status).toBe(200)
  for (const oldCookie of [cookie, responseCookie(second)]) {
    expect(await (await authRequest('get-session', undefined, oldCookie)).json()).toBeNull()
  }
  expect((await authRequest('sign-in/email', { email, password })).status).toBe(401)
  expect((await authRequest('sign-in/email', { email, password: nextPassword })).status).toBe(200)
  expect((await authRequest('reset-password', { token, newPassword: nextPassword })).status).toBe(400)
})

it('sair de todos os lugares invalida sessões independentes', async () => {
  const first = await fixtureCookie()
  const second = await fixtureCookie()
  const response = await authenticatedRequest('account/sign-out-everywhere', 'a', { method: 'POST', body: '{}' }, first)
  expect(response.status).toBe(200)
  for (const cookie of [first, second]) {
    expect(await (await authRequest('get-session', undefined, cookie)).json()).toBeNull()
    expect((await authenticatedRequest('contacts', 'a', {}, cookie)).status).toBe(401)
  }
})

it('excluir conta revoga as chaves de API que ela criou em outro espaço e avisa o dono', async () => {
  const { cookie, user } = await verifiedLogin('chave-excluir@example.test')
  await env.DB.prepare("INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES ('guest-admin','b',?,'administrator')").bind(user.id).run()
  const key = await (await authenticatedRequest('api-keys', 'b', { method: 'POST' }, cookie)).json() as { token: string }
  const call = () => app.request(`${origin}/api/public/v1/page/getInfo`, { headers: { authorization: `Bearer ${key.token}` } }, env)
  expect((await call()).status).toBe(200)
  expect((await authRequest('delete-user', { password }, cookie)).status).toBe(200)
  expect((await call()).status).toBe(401)
  const notices = await env.DB.prepare("SELECT message FROM workspace_notices WHERE workspace_id='b' AND message LIKE '%chave de API%'").all<{ message: string }>()
  expect(notices.results).toHaveLength(1)
  expect(notices.results[0]!.message).toContain('Gere outra em Configurações')
})

it('excluir conta derruba a conexão ao vivo do inbox dessa pessoa e só dela', async () => {
  const { cookie, user } = await verifiedLogin('ao-vivo-excluir@example.test')
  await env.DB.prepare("INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES ('guest-live','b',?,'viewer')").bind(user.id).run()
  const sockets: WebSocket[] = []
  const open = async (socketCookie: string) => {
    const response = await app.request(`${origin}/api/inbox/live`, { headers: { Upgrade: 'websocket', origin, cookie: socketCookie, 'x-workspace': 'b' } }, env)
    expect(response.status).toBe(101)
    const socket = (response as Response & { webSocket: WebSocket }).webSocket
    socket.accept()
    sockets.push(socket)
    const seen = { closed: null as number | null }
    socket.addEventListener('close', event => { seen.closed = event.code })
    return seen
  }
  try {
    const control = await open(await fixtureCookie('b'))
    const member = await open(cookie)
    expect((await authRequest('delete-user', { password }, cookie)).status).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(member.closed).toBe(4001)
    expect(control.closed).toBeNull()
  } finally { for (const socket of sockets) { try { socket.close(1000) } catch { /* já fechado */ } } }
})

it('excluir conta apaga também os arquivos que contatos mandaram, no bucket privado', async () => {
  const { cookie, user } = await verifiedLogin('excluir-privado@example.test')
  const created = await authenticatedRequest('workspaces', 'a', { method: 'POST', body: JSON.stringify({ name: 'Espaço com arquivos' }) }, cookie)
  const owned = await created.json() as { id: string }
  await env.DB.prepare('INSERT INTO media_objects(id,workspace_id,object_key,content_type,size,created_at,bucket) VALUES (?,?,?,?,?,?,?)').bind('priv-media', owned.id, 'priv-object', 'image/png', 8, Date.now(), 'inbound').run()
  await env.DB.prepare('INSERT INTO media_objects(id,workspace_id,object_key,content_type,size,created_at) VALUES (?,?,?,?,?,?)').bind('pub-media', owned.id, 'pub-object', 'image/png', 8, Date.now()).run()
  const publico = vi.fn().mockResolvedValue(undefined), privado = vi.fn().mockResolvedValue(undefined)
  const bindings = { ...env, MEDIA: { delete: publico } as unknown as R2Bucket, INBOUND_MEDIA: { delete: privado } as unknown as R2Bucket }
  expect((await authRequest('delete-user', { password }, cookie, bindings)).status).toBe(200)
  expect(privado).toHaveBeenCalledExactlyOnceWith('priv-object')
  expect(publico).toHaveBeenCalledExactlyOnceWith('pub-object')
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM media_objects WHERE workspace_id=?').bind(owned.id).first('n')).toBe(0)
  expect(user.id).toBeTruthy()
})

it('excluir conta remove workspace próprio, vínculos, sessões e credenciais por cascata', async () => {
  const { cookie, user } = await verifiedLogin('excluir@example.test')
  const created = await authenticatedRequest('workspaces', 'a', { method: 'POST', body: JSON.stringify({ name: 'Espaço descartável' }) }, cookie)
  expect(created.status).toBe(201)
  const owned = await created.json() as { id: string }
  await env.DB.prepare("INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES ('guest-membership','b',?,'viewer')").bind(user.id).run()
  await env.DB.prepare('INSERT INTO media_objects(id,workspace_id,object_key,content_type,size,created_at) VALUES (?,?,?,?,?,?)').bind('delete-media', owned.id, 'owned-object', 'image/png', 8, Date.now()).run()
  await env.DB.prepare("INSERT INTO contacts(id,workspace_id,first_name) VALUES ('owned-person',?,'Fictícia')").bind(owned.id).run()
  await env.DB.prepare("INSERT INTO activity_logs(workspace_id,actor_id,action) VALUES ('b',?,'invite')").bind(user.id).run()
  await env.DB.prepare('INSERT INTO verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?)').bind('old-magic','magic-link:old-token',JSON.stringify({email:'excluir@example.test'}),new Date(Date.now()+3600000).toISOString(),new Date().toISOString(),new Date().toISOString()).run()
  const deleteObject = vi.fn().mockResolvedValue(undefined)
  const bindings = { ...env, MEDIA: { delete: deleteObject } as unknown as R2Bucket }
  expect((await authRequest('delete-user', { password }, cookie, bindings)).status).toBe(200)
  expect(deleteObject).toHaveBeenCalledExactlyOnceWith('owned-object')
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM media_objects WHERE id='delete-media'").first('n')).toBe(0)
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM contacts WHERE id='owned-person'").first('n')).toBe(0)
  expect(await env.DB.prepare("SELECT actor_id FROM activity_logs WHERE workspace_id='b'").first('actor_id')).toBeNull()
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM verification WHERE id='old-magic'").first('n')).toBe(0)
  for (const table of ['user', 'session', 'account']) {
    const field = table === 'user' ? 'id' : 'userId'
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${field}"=?`).bind(user.id).first('n')).toBe(0)
  }
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM workspace_members WHERE user_id=?').bind(user.id).first('n')).toBe(0)
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE id=?').bind(owned.id).first('n')).toBe(0)
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE id='b'").first('n')).toBe(1)
  expect(await (await authRequest('get-session', undefined, cookie)).json()).toBeNull()
})

it('um segundo usuário não lê nem escreve dados alheios trocando x-workspace', async () => {
  const cookieB = await fixtureCookie('b')
  expect((await authenticatedRequest('contacts', 'a', {}, cookieB)).status).toBe(404)
  expect((await authenticatedRequest('automations/auto-a/draft', 'a', { method: 'PUT', body: JSON.stringify({ graph }) }, cookieB)).status).toBe(404)
  expect((await authenticatedRequest('contacts/c-a', 'b', {}, cookieB)).status).toBe(404)
  const own = await authenticatedRequest('contacts', 'b', {}, cookieB)
  expect(own.status).toBe(200)
  expect(await own.json()).toMatchObject({ rows: [{ id: 'c-b' }], total: 1 })
  const tampered = cookieB.slice(0, -3) + 'xxx'
  expect((await authenticatedRequest('contacts', 'b', {}, tampered)).status).toBe(401)
  expect((await app.request(`${origin}/api/contacts`, { headers: { 'x-workspace': 'a' } }, env)).status).toBe(401)
})

it.each(['viewer', 'livechat_agent', 'editor'] as const)('papel %s aplica permissões em leituras, edições e equipe', async role => {
  await env.DB.prepare('UPDATE workspace_members SET role=? WHERE id=?').bind(role, 'member-a').run()
  expect((await authenticatedRequest('contacts')).status).toBe(200)
  expect((await authenticatedRequest('automations')).status).toBe(role === 'livechat_agent' ? 403 : 200)
  expect((await authenticatedRequest('automations/auto-a/draft', 'a', { method: 'PUT', body: JSON.stringify({ graph }) })).status).toBe(role === 'editor' ? 200 : 403)
  expect((await authenticatedRequest('team')).status).toBe(403)
  expect((await authenticatedRequest('team/invites', 'a', { method: 'POST', body: JSON.stringify({ email: 'convidada@example.test', role: 'viewer' }) })).status).toBe(403)
  expect((await authenticatedRequest('media', 'a', { method: 'POST', headers: { 'content-type': 'image/png' }, body: new Uint8Array([137,80,78,71,13,10,26,10]) })).status).toBe(role === 'editor' ? 503 : 403)
})

it('convite pertence ao e-mail verificado e só pode ser aceito uma vez', async () => {
  const issued = await authenticatedRequest('team/invites', 'a', { method: 'POST', body: JSON.stringify({ email: 'B@example.test', role: 'editor' }) })
  expect(issued.status).toBe(201)
  const token = (await emailLink('b@example.test', 'invite')).hash.slice(1)
  const accept = { method: 'POST', body: JSON.stringify({ token }) }
  expect((await authenticatedRequest('invites/accept', 'a', accept)).status).toBe(400)
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM invites').first('n')).toBe(1)
  expect((await authenticatedRequest('invites/accept', 'b', accept)).status).toBe(200)
  expect((await authenticatedRequest('invites/accept', 'b', accept)).status).toBe(400)
  expect(await env.DB.prepare("SELECT role FROM workspace_members WHERE user_id='user-b' AND workspace_id='a'").first('role')).toBe('editor')
})

it('upload valida MIME, limite, bytes reais e grava R2 com domínio separado', async () => {
  const put = vi.fn(async (_key: string, body: ReadableStream) => { await new Response(body).arrayBuffer(); return {} })
  const del = vi.fn().mockResolvedValue(undefined)
  const bindings = { ...env, MEDIA: { put, delete: del } as unknown as R2Bucket, MEDIA_PUBLIC_URL: 'https://media.example.test' }
  const cookie = await fixtureCookie()
  const upload = (type: string, body: BodyInit, headers?: HeadersInit) => authenticatedRequest('media', 'a', { method: 'POST', headers: { 'content-type': type, 'content-length': String(new Blob([body as never]).size), ...headers }, body }, cookie, bindings)
  expect((await upload('text/html', '<script>1</script>')).status).toBe(400)
  expect((await upload('image/png', new Uint8Array([1,2,3]))).status).toBe(400)
  expect((await upload('image/png', new Uint8Array(5 * 1024 * 1024 + 1))).status).toBe(413)
  expect((await upload('image/png', new Uint8Array([137,80,78,71,13,10,26,10]))).status).toBe(201)
  const result = await upload('application/pdf', new TextEncoder().encode('%PDF-1.7\nfictício'))
  expect(result.status).toBe(201)
  const saved = await result.json() as { id: string; url: string }
  expect(saved.url).toBe(`https://media.example.test/${saved.id}/arquivo.pdf`)
  expect(put).toHaveBeenCalledTimes(2)
  expect(put).toHaveBeenLastCalledWith(`${saved.id}/arquivo.pdf`, expect.any(ReadableStream), { httpMetadata: { contentType: 'application/pdf', contentDisposition: 'attachment; filename="arquivo.pdf"', cacheControl: 'private, no-store' } })
  expect(await env.DB.prepare('SELECT workspace_id FROM media_objects WHERE id=?').bind(saved.id).first('workspace_id')).toBe('a')
})

it('magic link enviado pelo outbox cria sessão HTTP e só pode ser consumido uma vez', async () => {
  const email = 'magic@example.test'
  expect((await authRequest('sign-in/magic-link', { email, name: 'Pessoa por link', callbackURL: `${origin}/painel` })).status).toBe(200)
  const link = await emailLink(email, 'magic')
  const token = link.searchParams.get('token')!
  expect(token.length).toBeGreaterThanOrEqual(32)
  const stored = await env.DB.prepare("SELECT identifier FROM verification WHERE identifier LIKE 'magic-link:%'").first<{ identifier: string }>()
  expect(stored?.identifier).toBeDefined()
  expect(stored?.identifier).not.toContain(token)
  const verified = await app.request(link.href, {}, env)
  expect(verified.status).toBe(302)
  expect(verified.headers.get('location')).toBe(`${origin}/painel`)
  const cookie = responseCookie(verified)
  expect(await (await authRequest('get-session', undefined, cookie)).json()).toMatchObject({ user: { email, emailVerified: true } })
  const replay = await app.request(link.href, {}, env)
  expect(replay.status).toBe(302)
  expect(new URL(replay.headers.get('location')!).searchParams.get('error')).toBe('INVALID_TOKEN')
  expect(replay.headers.get('set-cookie') ?? '').not.toContain('session_token=')
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM session s JOIN user u ON s.userId=u.id WHERE u.email=?").bind(email).first('n')).toBe(1)
})

it('origem alheia não altera dados nem inicia auth e respostas/logs não expõem segredos', async () => {
  const cookie = await fixtureCookie()
  const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
  try {
    const foreignHeaders = { origin: 'https://alheio.example.test', cookie, 'x-workspace': 'a', 'content-type': 'application/json' }
    const changedGraph = structuredClone(graph)
    changedGraph.nodes[1]!.config = { blocks: [{ kind: 'text', text: 'Alteração recusada' }] }
    const mutation = await app.request(`${origin}/api/automations/auto-a/draft`, { method: 'PUT', headers: foreignHeaders, body: JSON.stringify({ graph: changedGraph }) }, env)
    expect(mutation.status).toBe(403)
    const persisted = await env.DB.prepare("SELECT draft_graph FROM automations WHERE id='auto-a'").first<string>('draft_graph')
    expect(JSON.parse(persisted!)).toEqual(graph)
    const signup = await app.request(`${origin}/api/auth/sign-up/email`, {
      method: 'POST', headers: foreignHeaders,
      body: JSON.stringify({ name: 'Pessoa bloqueada', email: 'csrf@example.test', password }),
    }, env)
    expect(signup.status).toBe(403)
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM user WHERE email='csrf@example.test'").first('n')).toBe(0)
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE recipient='csrf@example.test'").first('n')).toBe(0)
    const output = [await mutation.text(), await signup.text(), JSON.stringify(spies.flatMap(spy => spy.mock.calls))].join('\n')
    expect(output).not.toContain(password)
    expect(output).not.toContain(env.BETTER_AUTH_SECRET!)
    expect(output).not.toContain(cookie)
  } finally { for (const spy of spies) spy.mockRestore() }
})

// Cadastro fechado (ManyCraft de um dono só): só entra quem tem convite válido.
const closed = { ...env, SIGNUP_CLOSED: '1' } as typeof env
async function invite(email: string, expiresAt = Date.now() + 3600_000) {
  await env.DB.prepare("INSERT INTO invites(id,workspace_id,email,role,token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), 'a', email, 'editor', crypto.randomUUID(), expiresAt, Date.now()).run()
}
const userCount = async (email: string) => await env.DB.prepare('SELECT COUNT(*) AS n FROM "user" WHERE email=?').bind(email).first<number>('n')

it('cadastro fechado recusa e-mail sem convite com mensagem clara e não cria a conta', async () => {
  const email = 'semconvite@example.test'
  const response = await authRequest('sign-up/email', { name: 'Intruso', email, password }, undefined, closed)
  expect(response.status).toBeGreaterThanOrEqual(400)
  expect(JSON.stringify(await response.json())).toContain('O cadastro está fechado. Peça um convite a quem administra o espaço.')
  expect(await userCount(email)).toBe(0)
})

it('cadastro fechado recusa convite vencido', async () => {
  const email = 'vencido@example.test'
  await invite(email, Date.now() - 1000)
  expect((await authRequest('sign-up/email', { name: 'Pessoa', email, password }, undefined, closed)).status).toBeGreaterThanOrEqual(400)
  expect(await userCount(email)).toBe(0)
})

it('cadastro fechado aceita e-mail com convite válido, sem diferenciar maiúsculas', async () => {
  await invite('convidada@example.test')
  const response = await authRequest('sign-up/email', { name: 'Convidada', email: 'Convidada@Example.test', password }, undefined, closed)
  expect(response.status).toBe(200)
  expect(await userCount('convidada@example.test')).toBe(1)
})

it('sem SIGNUP_CLOSED o cadastro continua aberto', async () => {
  expect((await authRequest('sign-up/email', { name: 'Aberta', email: 'aberta@example.test', password })).status).toBe(200)
  expect((await authRequest('sign-up/email', { name: 'Zero', email: 'zero@example.test', password }, undefined, { ...env, SIGNUP_CLOSED: '0' } as typeof env)).status).toBe(200)
})

it('cadastro fechado: link mágico para e-mail novo sem convite não cria usuário', async () => {
  const email = 'magicnovo@example.test'
  expect((await authRequest('sign-in/magic-link', { email, name: 'Nova', callbackURL: `${origin}/painel` }, undefined, closed)).status).toBe(200)
  const link = await emailLink(email, 'magic')
  const verified = await app.request(link.href, { redirect: 'manual' }, closed)
  expect(verified.headers.get('set-cookie') ?? '').not.toContain('session_token=')
  expect(await userCount(email)).toBe(0)
})

it('cadastro fechado: link mágico para e-mail com convite cria o usuário', async () => {
  const email = 'magicconvite@example.test'
  await invite(email)
  expect((await authRequest('sign-in/magic-link', { email, name: 'Nova', callbackURL: `${origin}/painel` }, undefined, closed)).status).toBe(200)
  const verified = await app.request((await emailLink(email, 'magic')).href, { redirect: 'manual' }, closed)
  expect(verified.headers.get('set-cookie') ?? '').toContain('session_token=')
  expect(await userCount(email)).toBe(1)
})

it('cadastro fechado: POST /workspaces responde 403; aberto responde 201', async () => {
  const body = JSON.stringify({ name: 'Segundo espaço' })
  const refused = await authenticatedRequest('workspaces', 'a', { method: 'POST', body }, undefined, closed)
  expect(refused.status).toBe(403)
  expect(JSON.stringify(await refused.json())).toContain('Criar novos espaços está desativado.')
  expect((await authenticatedRequest('workspaces', 'a', { method: 'POST', body })).status).toBe(201)
})
