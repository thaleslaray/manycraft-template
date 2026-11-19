import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../src/index'
import { authenticatedRequest, fixtureCookie, origin, seedAuth } from './auth-helpers'

// Auditoria de segurança, grupo A (A1): o link público copia a estrutura do fluxo, nunca credenciais. Só dados fictícios.
let ownerCookie = '', userBCookie = ''
const panel = (path: string, method = 'GET', body?: unknown, cookie = ownerCookie, ws = 'a') =>
  authenticatedRequest(path, ws, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, cookie)
const view = (token: string) => app.request(`${origin}/api/automation-share/${token}`, {}, env)   // sem cookie
const graph = { nodes: [
  { id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
  { id: 'x', type: 'action', position: { x: 0, y: 0 }, config: { actions: [
    { type: 'external_request', method: 'GET', url: 'https://user:DUMMY-PASS-789@example.test/x?key=DUMMY-QUERY-KEY#DUMMY-FRAG', headers: [{ name: 'Authorization', value: 'Bearer DUMMY-SECRET-123' }], body: '{"k":"DUMMY-BODY-456"}' },
    { type: 'external_request', method: 'POST', url: 'https://{{host}}/v1/{{id}}?token=DUMMY-VAR-QUERY', headers: [], body: 'DUMMY-BODY-2' },
    { type: 'external_request', method: 'POST', url: 'https://hooks.example.test/services/DUMMY-PATH-SECRET/x', headers: [], body: '' },
    { type: 'external_request', method: 'POST', url: 'https://example.test:8443/DUMMY-PORT-PATH', headers: [], body: '' },
    { type: 'external_request', method: 'POST', url: '/relative/DUMMY-REL-PATH', headers: [], body: '' },
    { type: 'external_request', method: 'POST', url: 'nao e url DUMMY-INVALID-PATH', headers: [], body: '' },
  ] } },
  { id: 'd', type: 'dynamic', position: { x: 0, y: 0 }, config: { url: 'https://api.example.test/bot123:DUMMY-BOT/send?key=DUMMY-DYN-KEY', method: 'POST', headers: [{ name: 'X-Api-Key', value: 'DUMMY-DYN-HEADER' }], body: '{"s":"DUMMY-DYN-BODY"}' } },
], edges: [{ from: 't', port: 'next', to: 'x' }] }
const secrets = ['DUMMY-SECRET-123', 'DUMMY-BODY-456', 'DUMMY-QUERY-KEY', 'DUMMY-PASS-789', 'DUMMY-FRAG', 'DUMMY-VAR-QUERY', 'DUMMY-BODY-2', 'DUMMY-DYN-KEY', 'DUMMY-DYN-HEADER', 'DUMMY-DYN-BODY', 'DUMMY-PATH-SECRET', 'DUMMY-PORT-PATH', 'DUMMY-REL-PATH', 'DUMMY-INVALID-PATH', 'DUMMY-BOT']

async function share(allowCopy = false) {
  await env.DB.prepare("UPDATE automations SET draft_graph=? WHERE id='auto-a'").bind(JSON.stringify(graph)).run()
  const created = await panel('automations/auto-a/share', 'POST', { allow_copy: allowCopy })
  expect(created.status).toBeLessThan(300)
  return (await created.json() as { token: string }).token
}
beforeEach(async () => { await seedAuth(); ownerCookie = await fixtureCookie('a'); userBCookie = await fixtureCookie('b') })

describe('A1 link público de automação não devolve segredos do fluxo', () => {
  it('a resposta anônima não contém cabeçalho, corpo, query, usuário/senha nem âncora; a estrutura fica', async () => {
    const response = await view(await share())
    expect(response.status).toBe(200)
    const text = await response.text()
    for (const secret of secrets) expect(text, secret).not.toContain(secret)
    const { graph: shared } = JSON.parse(text) as { graph: { nodes: { id: string; config: Record<string, unknown> }[] } }
    const [first, second, slack, port, relative, invalid] = (shared.nodes.find(n => n.id === 'x')!.config.actions as Record<string, unknown>[])
    expect(first).toMatchObject({ type: 'external_request', method: 'GET', url: 'https://example.test', headers: [{ name: 'Authorization', value: '' }], body: '' })
    expect(second).toMatchObject({ url: '', body: '' })   // host que é variável: não dá para analisar
    expect(slack).toMatchObject({ url: 'https://hooks.example.test' })   // só esquema e domínio
    expect([port, relative, invalid].map(a => a.url)).toEqual(['', '', ''])   // porta, URL relativa e inválida saem em branco
    expect(shared.nodes.find(n => n.id === 'd')!.config).toMatchObject({ url: 'https://api.example.test', method: 'POST', headers: [{ name: 'X-Api-Key', value: '' }], body: '' })
  })
  it('o rascunho importado não tem os valores fictícios, e o original do dono continua intacto', async () => {
    const token = await share(true)
    const imported = await panel('automations/import-shared', 'POST', { token }, userBCookie, 'b')
    expect(imported.status).toBe(201)
    const { id } = await imported.json() as { id: string }
    const copy = await env.DB.prepare("SELECT draft_graph FROM automations WHERE id=? AND workspace_id='b'").bind(id).first<string>('draft_graph')
    for (const secret of secrets) expect(copy, secret).not.toContain(secret)
    expect(await env.DB.prepare("SELECT draft_graph FROM automations WHERE id='auto-a'").first<string>('draft_graph')).toContain('DUMMY-SECRET-123')
  })
  it('o dono revoga o link: a leitura e a importação passam a dar 404', async () => {
    const token = await share(true)
    expect((await view(token)).status).toBe(200)
    const revoked = await panel('automations/auto-a/share', 'DELETE')
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toEqual({ revoked: 1 })
    expect((await view(token)).status).toBe(404)
    expect((await panel('automations/import-shared', 'POST', { token }, userBCookie, 'b')).status).toBe(404)
    expect(await (await panel('automations/auto-a/share', 'DELETE')).json()).toEqual({ revoked: 0 })
  })
  it('revogar é só com permissão de edição e só nas automações do próprio espaço', async () => {
    await share()
    await env.DB.prepare("INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES ('m-ab','a','user-b','viewer')").run()
    expect((await panel('automations/auto-a/share', 'DELETE', undefined, userBCookie)).status).toBe(403)
    expect((await panel('automations/auto-b/share', 'DELETE')).status).toBe(404)
  })
})
