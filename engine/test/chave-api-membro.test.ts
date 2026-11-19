import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../src/index'
import { authenticatedRequest, fixtureCookie, origin, seedAuth } from './auth-helpers'

// Auditoria de segurança, grupo A (A5): a chave de API do espaço não sobrevive a quem a criou. Só dados fictícios.
let ownerCookie = '', userBCookie = ''
const panel = (path: string, method = 'GET', body?: unknown, cookie = ownerCookie) =>
  authenticatedRequest(path, 'a', { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, cookie)
const addMember = (role: string) => env.DB.prepare("INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES ('m-ab','a','user-b',?)").bind(role).run()
const callKey = (token: string) => app.request(`${origin}/api/public/v1/page/getInfo`, { headers: { authorization: `Bearer ${token}` } }, env)
const notices = () => env.DB.prepare("SELECT message FROM workspace_notices WHERE workspace_id='a' AND message LIKE '%chave de API%'").all<{ message: string }>().then(r => r.results)
async function keyBy(cookie: string) {
  const created = await panel('api-keys', 'POST', undefined, cookie)
  expect(created.status).toBe(201)
  return (await created.json() as { token: string }).token
}
beforeEach(async () => { await seedAuth(); ownerCookie = await fixtureCookie('a'); userBCookie = await fixtureCookie('b') })

describe('A5 chave de API do espaço é revogada quando quem a criou perde o acesso', () => {
  it('remover o administrador que criou a chave: 401 e um aviso ao dono', async () => {
    await addMember('administrator')
    const token = await keyBy(userBCookie)
    expect((await callKey(token)).status).toBe(200)
    expect((await panel('team/m-ab', 'DELETE')).status).toBe(200)
    expect((await callKey(token)).status).toBe(401)
    const found = await notices()
    expect(found).toHaveLength(1)
    expect(found[0]!.message).toContain('Pessoa b')
    expect(found[0]!.message).toContain('Gere outra em Configurações')
  })
  it('sair do espaço revoga a chave', async () => {
    await addMember('administrator')
    const token = await keyBy(userBCookie)
    expect((await panel('team/leave', 'POST', {}, userBCookie)).status).toBe(200)
    expect((await callKey(token)).status).toBe(401)
    expect(await notices()).toHaveLength(1)
  })
  it('rebaixar para editor revoga a chave', async () => {
    await addMember('administrator')
    const token = await keyBy(userBCookie)
    expect((await panel('team/m-ab', 'PATCH', { role: 'editor' })).status).toBe(200)
    expect((await callKey(token)).status).toBe(401)
    expect(await notices()).toHaveLength(1)
  })
  it('rebaixar de dono para administrador não revoga', async () => {
    await env.DB.prepare("INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES ('m-ab','a','user-b','administrator')").run()
    const ownerToken = await keyBy(ownerCookie)
    expect((await panel('team/transfer-ownership', 'POST', { member_id: 'm-ab', confirmation: 'TRANSFERIR' })).status).toBe(200)
    expect((await callKey(ownerToken)).status).toBe(200)
    expect(await notices()).toHaveLength(0)
  })
  it('mudar só a vaga da caixa de entrada não revoga', async () => {
    await addMember('administrator')
    const token = await keyBy(userBCookie)
    expect((await panel('team/m-ab', 'PATCH', { inbox_seat: true })).status).toBe(200)
    expect((await callKey(token)).status).toBe(200)
  })
  it('a chave criada por outra pessoa e a de criador nulo continuam valendo', async () => {
    await addMember('administrator')
    const ownerToken = await keyBy(ownerCookie)
    expect((await panel('team/m-ab', 'DELETE')).status).toBe(200)
    expect((await callKey(ownerToken)).status).toBe(200)
    expect(await notices()).toHaveLength(0)
    await env.DB.prepare("UPDATE api_keys SET created_by=NULL WHERE workspace_id='a'").run()
    await addMember('administrator')
    expect((await panel('team/m-ab', 'DELETE')).status).toBe(200)
    expect((await callKey(ownerToken)).status).toBe(200)
  })
  it('sem chave do membro, nenhum aviso', async () => {
    await addMember('editor')
    expect((await panel('team/m-ab', 'DELETE')).status).toBe(200)
    expect(await notices()).toHaveLength(0)
  })
  it('a chave dele em outro espaço não é tocada', async () => {
    await addMember('administrator')
    const tokenB = await (await authenticatedRequest('api-keys', 'b', { method: 'POST' }, userBCookie)).json() as { token: string }
    expect((await panel('team/m-ab', 'DELETE')).status).toBe(200)
    expect((await callKey(tokenB.token)).status).toBe(200)
  })
})
