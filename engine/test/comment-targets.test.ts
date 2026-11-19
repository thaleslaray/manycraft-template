import { env } from 'cloudflare:workers'
import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/env'
import { consumeInbound } from '../src/jobs'
import { graph } from './fixtures'
import { seedAuth, origin } from './auth-helpers'
import { giveCredentials } from './credentials'

const workflowCreate = vi.fn(async () => ({}))
const runtime = () => ({ ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: 'a',
  FLOW_RUN: { create: workflowCreate, get: async () => ({ status: async () => ({ status: 'running' }) }) } } as unknown as Env)
const call = (method: string, path: string, body?: unknown) => app.request(`${origin}/api/${path}`, {
  method, headers: { origin, 'x-workspace': 'a', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}, runtime())
const create = (target: 'all' | 'next' = 'all', enabled = false) => call('POST', 'automations/auto-a/triggers', {
  type: 'ig_comment', name: 'Comentário de teste', connection_id: 'ch-a', node_id: 't', enabled,
  config: { target, include: [], exclude: [], public_replies: [], like_comment: false },
})
const publish = () => call('POST', 'automations/auto-a/publish')
async function comment(id: string, post: string) {
  const batch = createMessageBatch('inbound', [{ id: `q-${id}`, timestamp: new Date(), attempts: 1, body: {
    version: 1, provider: 'meta', workspaceId: 'a', channelId: 'ch-a', eventId: `comments:${id}`, receivedAt: Date.now(),
    payload: { field: 'comments', value: { id, from: { id: '190001' }, media: { id: post }, text: 'Quero', timestamp: new Date().toISOString() } },
  } }])
  await consumeInbound(batch, runtime())
  expect((await getQueueResult(batch, createExecutionContext())).retryMessages).toEqual([])
}

beforeEach(async () => {
  await seedAuth()
  workflowCreate.mockClear()
  await env.DB.prepare("UPDATE channels SET provider='instagram_unified',external_id='17840001',connection_state='connected' WHERE id='ch-a'").run()
  await giveCredentials(env, 'ch-a', { accountId: '17840001', accessToken: 'TESTONLY' })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected provider request in local test') })
})
afterEach(() => vi.restoreAllMocks())

it('próxima publicação escolhe só post posterior à configuração, reserva alvo e não muda com comentários posteriores ou replay', async () => {
  expect((await publish()).status).toBe(201)
  const response = await create('next', true)
  expect(response.status).toBe(201)
  const { id } = await response.json() as { id: string }
  const trigger = await env.DB.prepare('SELECT config FROM triggers WHERE id=?').bind(id).first<{ config: string }>()
  const after = (JSON.parse(trigger!.config) as { next_after: number }).next_after
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    expect(url.pathname).toBe('/v26.0/17840001/media')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer TESTONLY' })
    if (!url.searchParams.has('after')) return Response.json({ data: [{ id: 'newer', caption: 'Mais recente', timestamp: new Date(after + 2000).toISOString() }],
      paging: { next: 'https://unused.test/never-follow-this', cursors: { after: 'older-page' } } })
    expect(url.searchParams.get('after')).toBe('older-page')
    return Response.json({ data: [
      { id: 'target-next', caption: 'Primeira após configurar', timestamp: new Date(after + 1000).toISOString() },
      { id: 'old', caption: 'Anterior', timestamp: new Date(after - 1000).toISOString() },
    ] })
  })
  expect((await publish()).status).toBe(201)
  await comment('old-comment', 'old')
  expect(await env.DB.prepare('SELECT target_post_id FROM triggers WHERE id=?').bind(id).first<string>('target_post_id')).toBe('target-next')
  expect(await env.DB.prepare("SELECT json_extract(config,'$.last_post_snapshot.id') FROM triggers WHERE id=?").bind(id).first("json_extract(config,'$.last_post_snapshot.id')")).toBe('old')
  await comment('newer-comment', 'newer')
  expect(await env.DB.prepare('SELECT count(*) n FROM flow_runs WHERE trigger_id=?').bind(id).first<number>('n')).toBe(0)
  await comment('target-comment', 'target-next')
  await comment('target-comment', 'target-next')
  const runs = await env.DB.prepare('SELECT comment_context FROM flow_runs WHERE trigger_id=?').bind(id).all<{ comment_context: string }>()
  expect(runs.results).toHaveLength(1)
  expect(JSON.parse(runs.results[0].comment_context)).toMatchObject({ postId: 'target-next', postSnapshot: { id: 'target-next', caption: 'Primeira após configurar', publishedAt: after + 1000 } })
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(workflowCreate).toHaveBeenCalledOnce()
  // Depois de prender a publicação, o gatilho continua podendo ser desligado e salvo de volta pelo painel (achado da rodada 4o3ynx no publicado).
  const off = await call('PATCH', `automations/auto-a/triggers/${id}`, { enabled: false })
  expect(off.status).toBe(200)
  const saved = await off.json() as { enabled: boolean; config: Record<string, unknown> }
  expect(saved.enabled).toBe(false)
  expect((await call('PATCH', `automations/auto-a/triggers/${id}`, { config: saved.config })).status).toBe(200)
  expect(await env.DB.prepare('SELECT target_post_id FROM triggers WHERE id=?').bind(id).first<string>('target_post_id')).toBe('target-next')
})

it('permite só um próximo post ativo por conexão e permite transferir a ativação após desativar o anterior', async () => {
  expect((await publish()).status).toBe(201)
  const first = await create('next', true)
  expect(first.status).toBe(201)
  const firstId = (await first.json() as { id: string }).id
  expect((await create('next', true)).status).toBe(409)
  const draft = await create('next')
  expect(draft.status).toBe(201)
  const draftId = (await draft.json() as { id: string }).id
  const patch = (id: string, enabled: boolean) => call('PATCH', `automations/auto-a/triggers/${id}`, { enabled })
  expect((await patch(draftId, true)).status).toBe(409)
  expect((await patch(firstId, false)).status).toBe(200)
  expect((await patch(draftId, true)).status).toBe(200)
  expect(await env.DB.prepare("SELECT count(*) n FROM triggers WHERE channel_id='ch-a' AND post_scope='next' AND status='active'").first<number>('n')).toBe(1)
  expect(fetch).not.toHaveBeenCalled()
})

it('sobrescrita da ficha efetiva bloqueia criar e publicar comentário sem tocar o provedor', async () => {
  expect((await create()).status).toBe(201)
  await env.DB.prepare(`UPDATE channels SET capabilities_override='{"comments":{"privateReply":null}}' WHERE id='ch-a'`).run()
  expect((await create()).status).toBe(400)
  expect((await publish()).status).toBe(409)
  expect(await env.DB.prepare("SELECT count(*) n FROM automation_versions WHERE automation_id='auto-a'").first<number>('n')).toBe(0)
  expect(fetch).not.toHaveBeenCalled()
})

it.each(['multiple-texts', 'two-buttons', 'typing', 'delay-after-action', 'question-before-opening'] as const)('publicação rejeita primeira interação inválida: %s', async kind => {
  expect((await create()).status).toBe(201)
  const next = structuredClone(graph)
  const blocks = next.nodes[1].config.blocks as unknown as Record<string, unknown>[]
  if (kind === 'multiple-texts') blocks.push({ kind: 'text', text: 'Segundo texto' })
  // Um botão de toque sozinho vale (bug 4); dois botões, não: a resposta privada é um texto e até um botão.
  if (kind === 'two-buttons') blocks.push({ kind: 'button', id: 'continue', label: 'Continuar', action: { type: 'go_to_node' } }, { kind: 'button', id: 'link', label: 'Abrir', action: { type: 'url', url: 'https://example.com' } })
  if (kind === 'typing') blocks.unshift({ kind: 'typing', seconds: 2 })
  if (kind === 'delay-after-action') {
    next.nodes.push({ id: 'tag', type: 'action', position: { x: 0, y: 0 }, config: { actions: [{ type: 'add_tag', tag_id: 'tag-a' }] } },
      { id: 'wait', type: 'smart_delay', position: { x: 0, y: 0 }, config: { duration: { value: 1, unit: 'minutes' } } })
    next.edges = [{ from: 't', port: 'next', to: 'tag' }, { from: 'tag', port: 'next', to: 'wait' }, { from: 'wait', port: 'next', to: 'm' }]
  }
  if (kind === 'question-before-opening') {
    next.nodes.push({ id: 'q', type: 'question', position: { x: 100, y: 0 }, config: {
      text: 'Qual seu nome?', answer_type: 'text', field_id: 'field-a', retry_message: 'Responda seu nome.',
      max_attempts: 1, skip: false, timeout: { value: 1, unit: 'minutes' }, choices: [],
    } })
    next.edges = [{ from: 't', port: 'next', to: 'q' }, { from: 'q', port: 'success', to: 'm' }]
  }
  expect((await call('PUT', 'automations/auto-a/draft', { graph: next })).status).toBe(200)
  expect((await publish()).status).toBe(409)
  expect(await env.DB.prepare("SELECT count(*) n FROM automation_versions WHERE automation_id='auto-a'").first<number>('n')).toBe(0)
  expect(fetch).not.toHaveBeenCalled()
})

it('exige republicação antes de ativar comentário em um passo novo de uma automação já publicada', async () => {
  expect((await publish()).status).toBe(201)
  const draft = structuredClone(graph)
  draft.nodes.push({ id: 'new-trigger', type: 'trigger', position: { x: 0, y: 200 }, config: {} })
  draft.edges.push({ from: 'new-trigger', port: 'next', to: 'm' })
  expect((await call('PUT', 'automations/auto-a/draft', { graph: draft })).status).toBe(200)
  const response = await call('POST', 'automations/auto-a/triggers', {
    type: 'ig_comment', name: 'Comentário em passo novo', connection_id: 'ch-a', node_id: 'new-trigger',
    config: { target: 'all', include: [], exclude: [], public_replies: [] },
  })
  expect(response.status).toBe(201)
  const { id } = await response.json() as { id: string }
  const activate = () => call('PATCH', `automations/auto-a/triggers/${id}`, { enabled: true })
  expect((await activate()).status).toBe(409)
  expect((await publish()).status).toBe(201)
  expect((await activate()).status).toBe(200)
  expect(fetch).not.toHaveBeenCalled()
})


it('publicação recusa comentário de conexão aguardando confirmação do webhook', async () => {
  expect((await create()).status).toBe(201)
  await env.DB.prepare("UPDATE channels SET connection_state='pending' WHERE id='ch-a'").run()
  expect((await publish()).status).toBe(409)
  expect(fetch).not.toHaveBeenCalled()
})

it('gatilho de comentário em Live é criado com regra de palavras e volta como ig_live_comment', async () => {
  const response = await call('POST', 'automations/auto-a/triggers', { type: 'ig_live_comment', name: 'Live', connection_id: 'ch-a', node_id: 't', enabled: false,
    config: { target: 'all', include: [], exclude: [], public_replies: [], rule: 'begins', words: ['quero'] } })
  expect(response.status).toBe(201)
  expect(await response.json()).toMatchObject({ type: 'ig_live_comment', config: { target: 'live', rule: 'begins', words: ['quero'] } })
  expect(await env.DB.prepare("SELECT widget_type,post_scope FROM triggers WHERE name='Live'").first()).toEqual({ widget_type: 'instagram_live_comment_reply', post_scope: 'all' })
  expect((await call('POST', 'automations/auto-a/triggers', { type: 'ig_live_comment', name: 'Live2', connection_id: 'ch-a', node_id: 't',
    config: { target: 'all', include: [], exclude: [], public_replies: [], rule: 'is', words: [] } })).status).toBe(400)
})

it('resposta pública digitada no painel é gravada no PATCH do gatilho e volta na lista', async () => {
  const { id } = await (await create('all', false)).json() as { id: string }
  const config = { target: 'all', include: [], exclude: [], public_replies: ['Veja seu privado!'], like_comment: false }
  const patched = await call('PATCH', `automations/auto-a/triggers/${id}`, { config, connection_id: 'ch-a', enabled: false, repeat_mode: 'every_time' })
  expect(patched.status).toBe(200)
  expect((await patched.json() as { config: { public_replies: string[] } }).config.public_replies).toEqual(['Veja seu privado!'])
  const listed = await (await call('GET', 'automations/auto-a/triggers')).json() as { rows: { id: string; config: { public_replies: string[] } }[] }
  expect(listed.rows.find(row => row.id === id)!.config.public_replies).toEqual(['Veja seu privado!'])
})

it('gatilho de comentário em Live salva pelo PATCH do painel e continua Live', async () => {
  const created = await call('POST', 'automations/auto-a/triggers', { type: 'ig_live_comment', name: 'Live', connection_id: 'ch-a', node_id: 't', enabled: false,
    config: { target: 'live', include: [], exclude: [], public_replies: [], like_comment: false, rule: 'any', words: [] } })
  expect(created.status).toBe(201)
  const { id } = await created.json() as { id: string }
  const config = { target: 'live', include: [], exclude: [], public_replies: [], like_comment: false, rule: 'contains', words: ['eu quero'] }
  const patched = await call('PATCH', `automations/auto-a/triggers/${id}`, { config, connection_id: 'ch-a', enabled: false, repeat_mode: 'every_time' })
  expect(patched.status).toBe(200)
  expect(await patched.json()).toMatchObject({ id, type: 'ig_live_comment', config: { target: 'live', rule: 'contains', words: ['eu quero'] } })
  expect(await env.DB.prepare('SELECT widget_type,post_scope FROM triggers WHERE id=?').bind(id).first()).toEqual({ widget_type: 'instagram_live_comment_reply', post_scope: 'all' })
})
