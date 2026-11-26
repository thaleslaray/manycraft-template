import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../src/index'
import { ensureConversation, recordMessage } from '../src/inbox/service'
import { authenticatedRequest, authRequest, emailLink, fixtureCookie, origin, seedAuth, withPassword } from './auth-helpers'

// Auditoria de segurança, grupo A (A2): a conexão ao vivo do inbox não sobrevive à saída do membro. Só dados fictícios.
let ownerCookie = '', userBCookie = ''
const sockets: WebSocket[] = []
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const panel = (path: string, method = 'GET', body?: unknown, cookie = ownerCookie, ws = 'a') =>
  authenticatedRequest(path, ws, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, cookie)
const addMember = (role: string, id = 'm-ab') =>
  env.DB.prepare("INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES (?,'a','user-b',?)").bind(id, role).run()

beforeEach(async () => { await seedAuth(); ownerCookie = await fixtureCookie('a'); userBCookie = await fixtureCookie('b') })
afterEach(() => { for (const s of sockets.splice(0)) { try { s.close(1000) } catch { /* já fechado */ } } })

async function connectAs(cookie: string, spoof?: string) {
  const headers: Record<string, string> = { Upgrade: 'websocket', origin, cookie, 'x-workspace': 'a', ...(spoof ? { 'x-inbox-user': spoof } : {}) }
  const response = await app.request(`${origin}/api/inbox/live`, { headers }, env)
  expect(response.status).toBe(101)
  const socket = (response as Response & { webSocket: WebSocket }).webSocket
  socket.accept()
  sockets.push(socket)
  const seen = { frames: [] as string[], closed: null as number | null }
  socket.addEventListener('message', e => { seen.frames.push(String(e.data)) })
  socket.addEventListener('close', e => { seen.closed = e.code })
  return seen
}
const got = (s: { frames: string[] }) => s.frames.filter(f => f.includes('MENSAGEM-FICTICIA-DO-CLIENTE')).length
async function nextMessage() {
  await sleep(100)
  await recordMessage(env, { id: crypto.randomUUID(), workspaceId: 'a', conversationId: 'inbox-cc-a', direction: 'in', sender: 'contact', text: 'MENSAGEM-FICTICIA-DO-CLIENTE' })
  await sleep(800)
}
async function scenario(revoke: () => Promise<Response>) {
  await addMember('editor')
  await ensureConversation(env, 'a', 'c-a', 'ch-a')
  const control = await connectAs(ownerCookie)
  const member = await connectAs(userBCookie)
  const revoked = await revoke()
  expect(revoked.status).toBeLessThan(300)
  expect((await authenticatedRequest('inbox/conversations', 'a', {}, userBCookie)).status).toBeGreaterThanOrEqual(400)
  await nextMessage()
  expect(got(control)).toBe(1)   // o hub continua entregando ao autorizado
  expect(got(member)).toBe(0)
  expect(member.closed).toBe(4001)
  expect(control.closed).toBeNull()
}

describe('A2 WebSocket do inbox não sobrevive à revogação do membro', () => {
  it('membro removido (DELETE /api/team/:id) é desconectado', async () => { await scenario(() => panel('team/m-ab', 'DELETE')) })
  it('membro que sai (POST /api/team/leave) é desconectado', async () => { await scenario(() => panel('team/leave', 'POST', {}, userBCookie)) })
  it('sign-out-everywhere encerra o socket', async () => { await scenario(() => panel('account/sign-out-everywhere', 'POST', {}, userBCookie)) })
  it('rebaixar o papel não desconecta (todo papel lê o inbox)', async () => {
    await addMember('administrator')
    await ensureConversation(env, 'a', 'c-a', 'ch-a')
    const member = await connectAs(userBCookie)
    expect((await panel('team/m-ab', 'PATCH', { role: 'viewer' })).status).toBe(200)
    await nextMessage()
    expect(got(member)).toBe(1)
    expect(member.closed).toBeNull()
  })
  it('o dono do socket vem da sessão: um cabeçalho do cliente não muda de quem é a conexão', async () => {
    await addMember('editor')
    await ensureConversation(env, 'a', 'c-a', 'ch-a')
    const member = await connectAs(userBCookie, 'user-a')   // finge ser o dono
    expect((await panel('team/m-ab', 'DELETE')).status).toBe(200)
    await nextMessage()
    expect(got(member)).toBe(0)
    expect(member.closed).toBe(4001)
  })
})

// Ficha 09, item 2: sessões que acabam por fora das rotas do espaço (Better Auth nativo, redefinição de senha, expiração) também derrubam o socket.
const hub = () => env.INBOX_HUB!.get(env.INBOX_HUB!.idFromName('a'))
async function revalidate() { expect(await runDurableObjectAlarm(hub())).toBe(true); await sleep(100) }
describe('item 2 o hub revalida a sessão de cada socket em intervalos', () => {
  it('revoke-sessions nativo: o socket cai na revalidação; quem tem sessão válida continua', async () => {
    await addMember('editor')
    await ensureConversation(env, 'a', 'c-a', 'ch-a')
    const control = await connectAs(ownerCookie)
    const member = await connectAs(userBCookie)
    const revoked = await authRequest('revoke-sessions', {}, userBCookie)
    expect(revoked.status).toBe(200)
    await revalidate()
    expect(member.closed).toBe(4001)
    expect(control.closed).toBeNull()
    await nextMessage()
    expect(got(control)).toBe(1)
    expect(got(member)).toBe(0)
  })
  it('sem nenhuma sessão revogada, a revalidação não derruba ninguém e agenda a próxima', async () => {
    await addMember('editor')
    const control = await connectAs(ownerCookie)
    const member = await connectAs(userBCookie)
    await revalidate()
    expect([control.closed, member.closed]).toEqual([null, null])
    expect(await runDurableObjectAlarm(hub())).toBe(true)   // continua agendado enquanto houver socket
  })
  it('sessão expirada cai na revalidação', async () => {
    await addMember('editor')
    const member = await connectAs(userBCookie)
    await env.DB.prepare('UPDATE "session" SET "expiresAt"=? WHERE "userId"=\'user-b\'').bind(new Date(Date.now() - 1000).toISOString()).run()
    await revalidate()
    expect(member.closed).toBe(4001)
  })
  // Troca de senha só existe com PASSWORD_LOGIN=1 (padrão desligado).
  it('com PASSWORD_LOGIN=1, reset-password: o socket cai na hora, e a revalidação também o derrubaria', async () => {
    await addMember('editor')
    const member = await connectAs(userBCookie)
    expect((await authRequest('request-password-reset', { email: 'b@example.test', redirectTo: `${origin}/reset` }, undefined, withPassword)).status).toBe(200)
    const token = (await emailLink('b@example.test', 'reset')).pathname.split('/').at(-1)!
    expect((await authRequest('reset-password', { token, newPassword: 'Outra-senha-ficticia-segura-2026!' }, undefined, withPassword)).status).toBe(200)
    await sleep(100)
    expect(member.closed).toBe(4001)
  })
  it('sem sockets, o alarme não se agenda de novo (o objeto pode hibernar)', async () => {
    await addMember('editor')
    const member = await connectAs(userBCookie)
    member.closed === null && sockets.splice(0).forEach(s => s.close(1000))
    await sleep(100)
    await runDurableObjectAlarm(hub())
    expect(await runDurableObjectAlarm(hub())).toBe(false)
  })
})
