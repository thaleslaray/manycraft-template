import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { authenticatedRequest as req, seedAuth } from './auth-helpers'
import { giveCredentials } from './credentials'
import { dispatchInbound } from '../src/flow/dispatch'
const item = { id: 'item-a', title: 'Quero conhecer', automation_id: 'auto-a' }
const path = (kind = 'main_menu', connection = 'ch-a') => `basic/${connection}/surfaces/${kind}`
const put = (body: unknown, kind = 'main_menu', connection = 'ch-a') => req(path(kind, connection), 'a', { method: 'PUT', body: JSON.stringify(body) })
const publish = () => req(`${path()}/publish`, 'a', { method: 'POST' })
let calls: { method: string; body: Record<string, unknown> }[]
beforeEach(async () => {
  await seedAuth()
  await env.DB.prepare("UPDATE channels SET type='messenger',external_id='999',status='connected',connection_state='connected' WHERE id='ch-a'").run()
  await giveCredentials(env, 'ch-a', { pageId: '999', accessToken: 'TESTONLY', appSecret: 'TESTONLY' })
  calls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (init?.body) calls.push({ method: init.method!, body: JSON.parse(String(init.body)) })
    return Response.json({ success: true, first_name: 'Pessoa' })
  })
})
afterEach(() => vi.restoreAllMocks())
it('rascunho ordenado, publicação pelo contrato e falha preservando configuração anterior', async () => {
  const body = { enabled: true, items: [item, { ...item, id: 'item-b', title: 'Ver horários' }] }
  expect((await put(body)).status).toBe(200)
  expect(calls).toHaveLength(0)
  expect((await publish()).status).toBe(409)
  await req('automations/auto-a/publish', 'a', { method: 'POST' })
  expect((await publish()).status).toBe(200)
  expect(calls.at(-1)?.body).toMatchObject({ persistent_menu: [{ call_to_actions: [{ title: item.title }, { title: 'Ver horários' }] }] })
  await put({ enabled: false, items: [...body.items].reverse() })
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { message: 'TESTONLY' } }, { status: 500 }))
  expect((await publish()).status).toBe(502)
  const state = await (await req(path())).json() as any
  expect(state.draft.items[0].id).toBe('item-b')
  expect(state.published.items[0].id).toBe('item-a')
  expect(state.published.enabled).toBe(true)
  expect(JSON.stringify(state)).not.toContain('TESTONLY')
  expect((await publish()).status).toBe(200)
  expect(calls.at(-1)).toMatchObject({ method: 'DELETE', body: { fields: ['persistent_menu'] } })
})
it('limites 4/20, IDs únicos, títulos, isolamento e permissões', async () => {
  for (const [kind, limit] of [['conversation_starters', 4], ['main_menu', 20]] as const) {
    const items = Array.from({ length: limit + 1 }, (_, n) => ({ ...item, id: `item-${n}` }))
    expect((await put({ enabled: true, items }, kind)).status).toBe(400)
    expect((await put({ enabled: true, items: items.slice(0, limit) }, kind)).status).toBe(200)
  }
  expect((await put({ enabled: true, items: [item, item] })).status).toBe(400)
  expect((await put({ enabled: true, items: [{ ...item, title: ' ' }] })).status).toBe(400)
  expect((await put({ enabled: true, items: [{ ...item, automation_id: 'auto-b' }] })).status).toBe(404)
  expect((await put({ enabled: true, items: [item] }, 'main_menu', 'ch-b')).status).toBe(404)
  await env.DB.prepare(`UPDATE channels SET capabilities_override='{"mainMenu":null}' WHERE id='ch-a'`).run()
  expect((await put({ enabled: true, items: [item] })).status).toBe(400)
  await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE user_id='user-a'").run()
  expect((await put({ enabled: true, items: [item] })).status).toBe(403)
})
it('clique publicado cria contato e execução, deduplica e ignora payload desconhecido/desativado', async () => {
  await req('automations/auto-a/publish', 'a', { method: 'POST' })
  await put({ enabled: true, items: [item] }); await publish()
  const state = await (await req(path())).json() as any
  const payload = state.published.items[0].payload
  const create = vi.fn().mockResolvedValue({})
  const bindings = { ...env, FLOW_RUN: { create } } as unknown as typeof env
  async function click(id: string, value = payload) {
    const inboundId = `inbound-${id}`
    const event = { version: 1 as const, provider: 'meta' as const, workspaceId: 'a', channelId: 'ch-a', eventId: `postback:${id}`, receivedAt: Date.now(),
      payload: { sender: { id: '123' }, recipient: { id: '999' }, timestamp: Date.now(), postback: { mid: id, payload: value } } }
    await env.DB.prepare("INSERT OR IGNORE INTO inbound_events(id,workspace_id,channel_id,payload) VALUES (?,'a','ch-a',?)").bind(inboundId, JSON.stringify(event.payload)).run()
    await dispatchInbound(event, inboundId, bindings)
  }
  await click('one'); await click('one')
  expect(create).toHaveBeenCalledTimes(1)
  expect(await env.DB.prepare("SELECT count(*) n FROM flow_runs WHERE channel_id='ch-a'").first('n')).toBe(1)
  expect(await env.DB.prepare("SELECT count(*) n FROM contact_channels WHERE channel_id='ch-a' AND external_user_id='123'").first('n')).toBe(1)
  await click('forged', 's:unknown')
  await put({ enabled: false, items: [item] })
  await click('still-published'); expect(create).toHaveBeenCalledTimes(2)
  await publish(); await click('disabled'); expect(create).toHaveBeenCalledTimes(2)
})
it('publicação serializa edições e recupera trava expirada; desativa mesmo após exclusão da automação', async () => {
  await req('automations/auto-a/publish', 'a', { method: 'POST' })
  await put({ enabled: true, items: [item] })
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  vi.mocked(fetch).mockImplementationOnce(async () => { entered(); await pending; return Response.json({ success: true }) })
  const publishing = publish()
  await started
  expect((await put({ enabled: false, items: [item] })).status).toBe(409)
  expect((await publish()).status).toBe(409)
  release(); expect((await publishing).status).toBe(200)
  await env.DB.prepare("UPDATE automations SET deleted_at=? WHERE id='auto-a'").bind(Date.now()).run()
  await env.DB.prepare("UPDATE conversation_surfaces SET publishing=? WHERE connection_id='ch-a'").bind(Date.now() - 180_000).run()
  expect((await put({ enabled: false, items: [item] })).status).toBe(200)
  expect((await publish()).status).toBe(200)
  expect(calls.at(-1)).toMatchObject({ method: 'DELETE', body: { fields: ['persistent_menu'] } })
})
it('pausa da automação durante sincronização do primeiro clique impede criar execução', async () => {
  await req('automations/auto-a/publish', 'a', { method: 'POST' })
  await put({ enabled: true, items: [item] }); await publish()
  const state = await (await req(path())).json() as any
  vi.mocked(fetch).mockImplementationOnce(async () => {
    await env.DB.prepare("UPDATE automations SET status='stopped' WHERE id='auto-a'").run()
    return Response.json({ first_name: 'Pessoa' })
  })
  const inboundId = 'race-click'
  const event = { version: 1 as const, provider: 'meta' as const, workspaceId: 'a', channelId: 'ch-a', eventId: 'postback:race', receivedAt: Date.now(),
    payload: { sender: { id: '123' }, recipient: { id: '999' }, timestamp: Date.now(), postback: { mid: 'race', payload: state.published.items[0].payload } } }
  await env.DB.prepare("INSERT INTO inbound_events(id,workspace_id,channel_id,payload) VALUES (?,'a','ch-a',?)").bind(inboundId, JSON.stringify(event.payload)).run()
  const create = vi.fn()
  await dispatchInbound(event, inboundId, { ...env, FLOW_RUN: { create } } as unknown as typeof env)
  expect(create).not.toHaveBeenCalled()
  expect(await env.DB.prepare("SELECT count(*) n FROM surface_firings WHERE connection_id='ch-a'").first('n')).toBe(0)
})

it('rascunho desligado também recusa vínculo com automação de outro workspace', async () => {
  expect((await put({ enabled: false, items: [{ ...item, automation_id: 'auto-b' }] })).status).toBe(404)
  const state = await (await req(path())).json() as any
  expect(state.draft.items).toEqual([])
  expect(calls).toHaveLength(0)
})

it('publicar menu e republicar automação respeitam a ficha efetiva da conexão de entrada', async () => {
  const created = await (await req('automations', 'a', { method: 'POST', body: JSON.stringify({ name: 'Conteúdo do menu' }) })).json() as { id: string }
  const linked = { ...item, automation_id: created.id }
  await env.DB.prepare(`UPDATE channels SET capabilities_override='{"buttons":{"types":["postback"]}}' WHERE id='ch-a'`).run()
  async function draft(buttons: number) {
    const graph = { nodes: [
      { id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
      { id: 'm', type: 'message', position: { x: 200, y: 0 }, config: { blocks: [
        { kind: 'text', text: 'Escolha uma opção' },
        ...Array.from({ length: buttons }, (_, index) => ({ kind: 'button', id: `b-${index}`, label: `Opção ${index + 1}`, action: { type: 'url', url: 'https://example.test' } })),
      ] } },
    ], edges: [{ from: 't', port: 'next', to: 'm' }] }
    expect((await req(`automations/${created.id}/draft`, 'a', { method: 'PUT', body: JSON.stringify({ graph }) })).status).toBe(200)
  }
  const publishAutomation = () => req(`automations/${created.id}/publish`, 'a', { method: 'POST' })
  await draft(1)
  expect((await publishAutomation()).status).toBe(201)
  expect((await put({ enabled: true, items: [linked] })).status).toBe(200)
  expect((await publish()).status).toBe(409)
  expect(calls).toHaveLength(0)
  await draft(0)
  expect((await publishAutomation()).status).toBe(201)
  expect((await publish()).status).toBe(200)
  await draft(1)
  expect((await publishAutomation()).status).toBe(409)
  await put({ enabled: false, items: [linked] }); await publish()
  expect((await publishAutomation()).status).toBe(201)
})
