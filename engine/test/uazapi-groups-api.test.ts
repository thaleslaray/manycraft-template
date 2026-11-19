import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'
import { giveCredentials } from './credentials'

const SERVER = 'https://loja.uazapi.com', TOKEN = 'UZ-SECRET-TOKEN'
let calls: { path: string; body: Record<string, unknown> }[]
const request = (path: string, method = 'GET', body?: unknown, workspace = 'a') => authenticatedRequest(path, workspace,
  { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, undefined, { ...env, DEV_AUTO_LOGIN: '0' })

beforeEach(async () => {
  await seedAuth()
  calls = []
  await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,connection_state) VALUES ('uz-a','a','whatsapp','uazapi','uazapi:r1','connected')").run()
  await giveCredentials(env, 'uz-a', { serverUrl: SERVER, token: TOKEN, webhookSecret: 's' })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.origin !== SERVER) throw new Error(`Unexpected request: ${url.href}`)
    calls.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : {} })
    if (url.pathname === '/group/list') {
      const offset = Number(calls.at(-1)!.body.offset)
      return Response.json({ groups: offset ? [{ JID: '120363000000000002@g.us', Name: 'Suporte' }] : [{ JID: '120363153742561022@g.us', Name: 'Clube da Loja' }, { JID: 'lixo', Name: 'x' }],
        pagination: { totalRecords: 2, limit: 1, offset, hasMore: !offset, nextOffset: 1 } })
    }
    return Response.json({}, { status: 404 })
  })
})
afterEach(() => { vi.restoreAllMocks() })

describe('GET /connections/:id/groups', () => {
  it('lista os grupos da conexão em páginas, sem participantes, e cada um já ganha seu registro', async () => {
    const first = await (await request('connections/uz-a/groups?limit=1&search=Clube')).json() as { groups: { id: string; externalGroupId: string; subject: string }[]; nextOffset: number | null }
    expect(first.groups).toMatchObject([{ externalGroupId: '120363153742561022@g.us', subject: 'Clube da Loja' }])
    expect(first.nextOffset).toBe(1)
    expect(calls[0]).toEqual({ path: '/group/list', body: { limit: 1, offset: 0, noParticipants: true, search: 'Clube' } })
    const second = await (await request('connections/uz-a/groups?limit=1&offset=1')).json() as typeof first
    expect(second).toMatchObject({ groups: [{ subject: 'Suporte' }], nextOffset: null })
    expect(await env.DB.prepare('SELECT count(*) n FROM group_threads').first('n')).toBe(2)
    // Listing again does not duplicate.
    await request('connections/uz-a/groups?limit=1')
    expect(await env.DB.prepare('SELECT count(*) n FROM group_threads').first('n')).toBe(2)
    expect(JSON.stringify(first)).not.toContain(TOKEN)
  })
  it('recusa conexão sem grupos, desligada, de outro workspace ou parâmetro desconhecido', async () => {
    expect((await request('connections/ch-a/groups')).status).toBe(400)
    expect((await request('connections/uz-a/groups', 'GET', undefined, 'b')).status).toBe(404)
    expect((await request('connections/uz-a/groups?x=1')).status).toBe(400)
    await env.DB.prepare("UPDATE channels SET connection_state='disconnected' WHERE id='uz-a'").run()
    expect((await request('connections/uz-a/groups')).status).toBe(409)
  })
})

describe('gatilho de grupo pela API de palavras-chave', () => {
  beforeEach(async () => { await request('automations/auto-a/publish', 'POST') })
  const input = { name: 'Guia no grupo', channel: 'whatsapp', automation_id: 'auto-a', active: true, connection_id: 'uz-a',
    audience: 'group', group_match: 'keyword', rules: [{ condition: 'contains', words: ['guia'] }] }

  it('cria o gatilho de grupo no modo palavra, restrito a um grupo, e o devolve na listagem', async () => {
    const group = (await (await request('connections/uz-a/groups?limit=1')).json() as { groups: { id: string }[] }).groups[0]!
    const response = await request('keywords', 'POST', { ...input, group_thread_id: group.id })
    expect(response.status).toBe(201)
    const keyword = await response.json() as Record<string, unknown>
    expect(keyword).toMatchObject({ audience: 'group', group_match: 'keyword', connection_id: 'uz-a', group_thread_id: group.id, rules: [{ condition: 'contains', words: ['guia'] }] })
    expect(await env.DB.prepare("SELECT channel_id,audience,group_match,group_thread_id FROM triggers WHERE id=(SELECT trigger_id FROM keywords WHERE id=?)").bind(keyword.id).first())
      .toEqual({ channel_id: 'uz-a', audience: 'group', group_match: 'keyword', group_thread_id: group.id })
    expect((await (await request('keywords')).json() as { id: string; audience: string }[]).find(k => k.id === keyword.id)).toMatchObject({ audience: 'group' })
  })
  it('modo "só quando mencionado" aceita ficar sem palavras e dispara por qualquer menção', async () => {
    const response = await request('keywords', 'POST', { ...input, group_match: 'mention', rules: [] })
    expect(response.status).toBe(201)
    const keyword = await response.json() as { id: string; rules: unknown[]; group_match: string }
    expect(keyword).toMatchObject({ group_match: 'mention', rules: [] })
    expect(await env.DB.prepare('SELECT rule FROM keywords WHERE id=?').bind(keyword.id).first('rule')).toBe('any')
  })
  it('recusa grupo em conexão que não tem grupos, grupo de outra conexão, e conversa privada com modo de grupo', async () => {
    expect((await request('keywords', 'POST', { ...input, channel: 'instagram', connection_id: 'ch-a' })).status).toBe(400)
    expect((await request('keywords', 'POST', { ...input, connection_id: 'uz-inexistente' })).status).toBe(404)
    expect((await request('keywords', 'POST', { ...input, group_thread_id: 'grp-de-outra' })).status).toBe(404)
    expect((await request('keywords', 'POST', { ...input, audience: 'direct' })).status).toBe(400)
    expect((await request('keywords', 'POST', { ...input, group_match: undefined })).status).toBe(400)
    expect((await request('keywords', 'POST', { ...input, group_match: 'keyword', rules: [] })).status).toBe(400)
  })
  it('a edição mantém o modo e o grupo, e a conversa privada segue como antes', async () => {
    const keyword = await (await request('keywords', 'POST', input)).json() as { id: string }
    const edited = await (await request(`keywords/${keyword.id}`, 'PATCH', { ...input, group_match: 'mention', name: 'Novo' })).json()
    expect(edited).toMatchObject({ name: 'Novo', audience: 'group', group_match: 'mention' })
    const direct = await (await request('keywords', 'POST', { name: 'DM', channel: 'instagram', automation_id: 'auto-a', active: true, rules: [{ condition: 'contains', words: ['oi'] }] })).json()
    expect(direct).toMatchObject({ audience: 'direct', group_match: null })
  })
})
