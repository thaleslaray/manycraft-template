import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import { createAuth } from '../src/auth'
import { authenticatedRequest, emailLink, fixtureCookie, origin, seedAuth } from './auth-helpers'

beforeEach(seedAuth)

async function addMember(role = 'editor') {
  await env.DB.prepare('INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES (?,?,?,?)')
    .bind('new-member', 'a', 'user-b', role).run()
}

const transfer = (member_id: string, confirmation = 'TRANSFERIR') => authenticatedRequest('team/transfer-ownership', 'a', {
  method: 'POST', body: JSON.stringify({ member_id, confirmation }),
})

it('convite vence em 24 horas e não cria membro depois do prazo', async () => {
  const now = Date.now()
  const issued = await authenticatedRequest('team/invites', 'a', { method: 'POST', body: JSON.stringify({ email: 'b@example.test', role: 'livechat_agent' }) })
  expect(issued.status).toBe(201)
  const token = (await emailLink('b@example.test', 'invite')).hash.slice(1)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 24 * 3600_000 + 1000)
  try {
    const accepted = await authenticatedRequest('invites/accept', 'b', { method: 'POST', body: JSON.stringify({ token }) })
    expect(accepted.status).toBe(400)
  } finally { clock.mockRestore() }
})

it('proprietário transfere com confirmação e se torna administrador, mantendo um único dono', async () => {
  await addMember()
  expect((await transfer('new-member', 'incorreta')).status).toBe(400)
  expect((await transfer('member-a')).status).toBe(400)
  expect((await transfer('inexistente')).status).toBe(404)
  expect((await transfer('member-b')).status).toBe(404)
  expect((await transfer('new-member')).status).toBe(200)
  const members = await (await authenticatedRequest('team')).json() as { id: string; role: string }[]
  expect(members.find(m => m.id === 'member-a')?.role).toBe('administrator')
  expect(members.find(m => m.id === 'new-member')?.role).toBe('owner')
  expect(members.filter(m => m.role === 'owner')).toHaveLength(1)
  expect((await transfer('new-member')).status).toBe(403)
})

it('administrador mantém a gestão de convites, mas não transfere a propriedade nem promove diretamente a proprietário', async () => {
  await addMember('administrator')
  const cookie = await fixtureCookie('b')
  const denied = await authenticatedRequest('team/transfer-ownership', 'a', { method: 'POST', body: JSON.stringify({ member_id: 'member-a', confirmation: 'TRANSFERIR' }) }, cookie)
  expect(denied.status).toBe(403)
  expect((await authenticatedRequest('team/invites', 'a', { method: 'POST', body: JSON.stringify({ email: 'outra@example.test', role: 'administrator' }) }, cookie)).status).toBe(201)
  expect((await authenticatedRequest('team/new-member', 'a', { method: 'PATCH', body: JSON.stringify({ role: 'owner' }) })).status).toBe(400)
})

it('assento persiste sem alterar papel e torna o membro elegível para receber conversas', async () => {
  await addMember('livechat_agent')
  const assignees = async () => await (await authenticatedRequest('team/assignees')).json() as { id: string }[]
  expect((await assignees()).some(m => m.id === 'new-member')).toBe(false)
  const change = (member: string, body: object) => authenticatedRequest(`team/${member}`, 'a', { method: 'PATCH', body: JSON.stringify(body) })
  expect((await change('new-member', { inbox_seat: true })).status).toBe(200)
  const members = await (await authenticatedRequest('team')).json() as { id: string; name: string; email: string; role: string; inbox_seat: boolean; is_current: boolean }[]
  expect(members.find(m => m.id === 'new-member')).toMatchObject({ name: 'Pessoa b', email: 'b@example.test', role: 'livechat_agent', inbox_seat: true, is_current: false })
  expect((await assignees()).some(m => m.id === 'new-member')).toBe(true)
  expect((await change('member-b', { inbox_seat: true })).status).toBe(404)
  expect((await change('member-a', { role: 'viewer' })).status).toBe(409)   // o dono não muda de papel por aqui
  expect((await change('new-member', { inbox_seat: false })).status).toBe(200)
  expect((await assignees()).some(m => m.id === 'new-member')).toBe(false)
})

it('aceitar seleciona o espaço convidado mesmo quando a pessoa já possui outro espaço', async () => {
  const issued = await authenticatedRequest('team/invites', 'a', { method: 'POST', body: JSON.stringify({ email: 'b@example.test', role: 'editor' }) })
  expect(issued.status).toBe(201)
  expect((await (await authenticatedRequest('team/invites')).json() as { email: string }[]).map(row => row.email)).toEqual(['b@example.test'])
  const token = (await emailLink('b@example.test', 'invite')).hash.slice(1)
  const cookie = await fixtureCookie('b')
  const accepted = await authenticatedRequest('invites/accept', 'b', { method: 'POST', body: JSON.stringify({ token }) }, cookie)
  expect(accepted.status).toBe(200)
  expect(await accepted.json()).toMatchObject({ workspace_id: 'a' })
  const contextCookie = accepted.headers.get('set-cookie')?.split(';')[0] ?? ''
  const selected = await app.request(`${origin}/api/session/workspace`, { headers: { cookie: `${cookie}; ${contextCookie}` } }, env)
  expect(await selected.json()).toMatchObject({ workspace_id: 'a' })
})

it('pedido de acesso: quem não é membro pede, o dono aprova com papel e a pessoa vira membro', async () => {
  const b = await fixtureCookie('b')
  expect((await authenticatedRequest('access-requests', 'b', { method: 'POST', body: JSON.stringify({ workspace_id: 'a', message: 'oi' }) }, b)).status).toBe(202)
  expect((await authenticatedRequest('access-requests', 'b', { method: 'POST', body: JSON.stringify({ workspace_id: 'nao-existe' }) }, b)).status).toBe(202)
  const { items } = await (await authenticatedRequest('team/access-requests')).json() as { items: { id: string; email: string; message: string }[] }
  expect(items).toEqual([expect.objectContaining({ email: 'b@example.test', message: 'oi' })])
  expect((await authenticatedRequest(`team/access-requests/${items[0]!.id}/approve`, 'a', { method: 'POST', body: JSON.stringify({ role: 'viewer' }) })).status).toBe(200)
  const members = await (await authenticatedRequest('team')).json() as { email: string; role: string }[]
  expect(members.find(m => m.email === 'b@example.test')?.role).toBe('viewer')
  expect((await authenticatedRequest(`team/access-requests/${items[0]!.id}`, 'a', { method: 'DELETE' })).status).toBe(404)
})

async function addUser(id: string, memberId: string, role: string) {
  const ctx = await createAuth(env).$context
  await ctx.internalAdapter.createUser({ id, name: `Pessoa ${id}`, email: `${id}@example.test`, emailVerified: true }, { method: 'test-fixture' })
  await env.DB.prepare('INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES (?,?,?,?)').bind(memberId, 'a', id, role).run()
}

it('remover da equipe: dono remove editor; não remove a si; o removido perde o acesso', async () => {
  await addMember('editor')
  const remove = (member: string) => authenticatedRequest(`team/${member}`, 'a', { method: 'DELETE' })
  expect((await remove('member-a')).status).toBe(409)
  expect((await remove('inexistente')).status).toBe(404)
  expect((await remove('new-member')).status).toBe(200)
  const members = await (await authenticatedRequest('team')).json() as { id: string }[]
  expect(members.map(m => m.id)).toEqual(['member-a'])
  expect((await authenticatedRequest('team', 'a', {}, await fixtureCookie('b'))).status).toBe(404)
})

it('remover da equipe: administrador remove editor, mas não outro administrador nem o dono', async () => {
  await addMember('administrator')
  await addUser('user-c', 'adm-2', 'administrator')
  await addUser('user-d', 'ed-1', 'editor')
  const cookie = await fixtureCookie('b')
  const remove = (member: string) => authenticatedRequest(`team/${member}`, 'a', { method: 'DELETE' }, cookie)
  expect((await remove('member-a')).status).toBe(403)
  expect((await remove('adm-2')).status).toBe(403)
  expect((await remove('new-member')).status).toBe(409)
  expect((await remove('ed-1')).status).toBe(200)
  expect((await authenticatedRequest('team/adm-2', 'a', { method: 'DELETE' })).status).toBe(200)
})

it('convite pendente: reemitir o link troca o token, cancelar apaga e o antigo deixa de valer', async () => {
  const issued = await (await authenticatedRequest('team/invites', 'a', { method: 'POST', body: JSON.stringify({ email: 'b@example.test', role: 'editor' }) })).json() as { id: string }
  const first = (await emailLink('b@example.test', 'invite')).hash.slice(1)
  const again = await authenticatedRequest(`team/invites/${issued.id}/link`, 'a', { method: 'POST', body: '{}' })
  expect(again.status).toBe(200)
  const second = new URL((await again.json() as { url: string }).url).hash.slice(1)
  expect(second).not.toBe(first)
  const cookie = await fixtureCookie('b')
  expect((await authenticatedRequest('invites/accept', 'b', { method: 'POST', body: JSON.stringify({ token: first }) }, cookie)).status).toBe(400)
  expect((await authenticatedRequest(`team/invites/${issued.id}`, 'a', { method: 'DELETE' })).status).toBe(200)
  expect(await (await authenticatedRequest('team/invites')).json()).toEqual([])
  expect((await authenticatedRequest(`team/invites/${issued.id}`, 'a', { method: 'DELETE' })).status).toBe(404)
  expect((await authenticatedRequest('invites/accept', 'b', { method: 'POST', body: JSON.stringify({ token: second }) }, cookie)).status).toBe(400)
  expect((await authenticatedRequest(`team/invites/${issued.id}/link`, 'a', { method: 'POST', body: '{}' })).status).toBe(404)
})

it('prévia do convite sem sessão devolve só o e-mail do convite e recusa token inválido', async () => {
  await authenticatedRequest('team/invites', 'a', { method: 'POST', body: JSON.stringify({ email: 'Nova@Example.test', role: 'viewer' }) })
  const token = (await emailLink('nova@example.test', 'invite')).hash.slice(1)
  const preview = (body: unknown) => app.request(`${origin}/api/invite-preview`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }, env)
  const ok = await preview({ token })
  expect(ok.status).toBe(200)
  expect(await ok.json()).toEqual({ email: 'nova@example.test' })
  expect((await preview({ token: 'x'.repeat(40) })).status).toBe(404)
  expect((await preview({ token: 'curto' })).status).toBe(400)
})

it('modo agência: perfil com agency_id e espaços de clientes administrados com contadores', async () => {
  expect((await (await authenticatedRequest('agency')).json() as { profile: unknown }).profile).toBeNull()
  const saved = await (await authenticatedRequest('agency', 'a', { method: 'PUT', body: JSON.stringify({ name: 'Agência X', website: 'https://agencia.example' }) })).json() as { agency_id: string }
  expect(saved.agency_id).toBeTruthy()
  const data = await (await authenticatedRequest('agency')).json() as { clients: { id: string; contacts: number }[] }
  expect(data.clients.map(c => c.id)).toContain('a')
})
