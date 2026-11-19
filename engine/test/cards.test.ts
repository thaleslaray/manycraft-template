import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { app } from '../src/index'
import { fixtureCookie, seedAuth } from './auth-helpers'
import { instagramUnified } from '../src/channels/instagram-unified'
import { messengerPage } from '../src/channels/messenger-page'
import { connectionFromRow, liteRow } from '../src/channels/core/connection'
import type { OutboundMessage } from '../src/channels/types'

const message: Extract<OutboundMessage, { kind: 'cards' }> = { kind: 'cards', aspectRatio: 'square', cards: [{ title: 'Curso', subtitle: 'Aprenda no seu ritmo', imageUrl: 'https://media.test/curso.png', actionUrl: 'https://example.test/curso', buttons: [{ type: 'url', title: 'Conhecer', url: 'https://example.test/curso' }] }] }

it.each([instagramUnified, messengerPage])('adapta card e galeria pelo provedor $id sem rede real', async provider => {
  const connection = connectionFromRow(liteRow(provider.kinds[0], 'test', 'a'))
  expect(provider.fit(message, connection.profile)).toEqual({ messages: [message], degraded: [] })
  const bodies: unknown[] = []
  const result = await provider.send({ connection, credentials: { accessToken: 'TESTONLY', accountId: '123', pageId: '123' }, target: { kind: 'direct', externalUserId: '42' }, fetch: (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body))); return Response.json({ message_id: '77', recipient_id: '42' })
  }) as typeof fetch }, message)
  expect(result).toMatchObject({ ok: true, externalId: '77' })
  expect(bodies).toEqual([expect.objectContaining({ message: { attachment: { type: 'template', payload: { template_type: 'generic', image_aspect_ratio: 'square', elements: [{ title: 'Curso', subtitle: 'Aprenda no seu ritmo', image_url: 'https://media.test/curso.png', default_action: { type: 'web_url', url: 'https://example.test/curso' }, buttons: [{ type: 'web_url', title: 'Conhecer', url: 'https://example.test/curso' }] }] } } } })])
  connection.profile.cards = null
  let calls = 0
  expect(await provider.send({ connection, credentials: {}, target: { kind: 'direct', externalUserId: '42' }, fetch: (async () => { calls++; throw Error('rede proibida') }) as typeof fetch }, message)).toMatchObject({ ok: false, reason: 'unsupported' })
  expect(calls).toBe(0)
})

let cookie = ''
beforeEach(async () => { await seedAuth(); cookie = await fixtureCookie() })
const request = (path: string, init: RequestInit) => app.request(`/api/${path}`, { ...init, headers: { cookie, 'x-workspace': 'a', 'content-type': 'application/json', origin: 'https://engine.test' } }, env)
const graph = (block: unknown) => ({ nodes: [{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} }, { id: 'm', type: 'message', position: { x: 300, y: 0 }, config: { blocks: [block] } }], edges: [{ from: 't', port: 'next', to: 'm' }] })
it('persiste galeria e bloqueia publicação pela conexão sem suporte, informando o nome', async () => {
  await env.DB.prepare("UPDATE channels SET display_name='Vitrine principal',type='instagram',provider='instagram_unified',status='connected' WHERE id='ch-a'").run()
  const block = { kind: 'gallery', aspectRatio: 'horizontal', cards: message.cards }
  expect((await request('automations/auto-a/draft', { method: 'PUT', body: JSON.stringify({ graph: graph(block) }) })).status).toBe(200)
  expect((await request('automations/auto-a/publish', { method: 'POST' })).status).toBe(201)
  await env.DB.prepare("UPDATE channels SET capabilities_override='{}',type='telegram',provider='telegram_bot',display_name='Atendimento sem vitrine' WHERE id='ch-a'").run()
  const refused = await request('automations/auto-a/publish', { method: 'POST' })
  expect(refused.status).toBe(409)
  expect(await refused.text()).toContain('Atendimento sem vitrine')
})
it.each([
  { kind: 'gallery', aspectRatio: 'horizontal', cards: Array(11).fill(message.cards[0]) },
  { kind: 'card', aspectRatio: 'square', cards: [{ ...message.cards[0], buttons: Array(4).fill(message.cards[0].buttons![0]) }] },
  { kind: 'card', aspectRatio: 'square', cards: [{ ...message.cards[0], actionUrl: 'javascript:alert(1)' }] },
])('publicação recusa limites e links inválidos: %#', async block => {
  await env.DB.prepare("UPDATE channels SET type='instagram',provider='instagram_unified',status='connected' WHERE id='ch-a'").run()
  const save = await request('automations/auto-a/draft', { method: 'PUT', body: JSON.stringify({ graph: graph(block) }) })
  if (save.status === 200) expect((await request('automations/auto-a/publish', { method: 'POST' })).status).toBeGreaterThanOrEqual(400)
  else expect(save.status).toBe(400)
})

it('publicação recusa protocolo inseguro no link do card mesmo com variável válida', async () => {
  await env.DB.prepare("UPDATE channels SET type='instagram',provider='instagram_unified',status='connected' WHERE id='ch-a'").run()
  const block = { kind: 'card', aspectRatio: 'horizontal', cards: [{ title: 'Oficina', actionUrl: 'javascript:{{primeiro_nome}}' }] }
  expect((await request('automations/auto-a/draft', { method: 'PUT', body: JSON.stringify({ graph: graph(block) }) })).status).toBe(200)
  const publish = await request('automations/auto-a/publish', { method: 'POST' })
  expect(publish.status).toBe(409)
  expect(await publish.text()).toContain('URL completa')
})
