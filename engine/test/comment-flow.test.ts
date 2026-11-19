import { env } from 'cloudflare:workers'
import { createExecutionContext, createMessageBatch, getQueueResult, introspectWorkflow, type WorkflowIntrospector } from 'cloudflare:test'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { seed, graph } from './fixtures'
import { giveCredentials } from './credentials'
import { consumeInbound } from '../src/jobs'
import { deleteContacts } from '../src/contacts'
import { editorActionStatements } from '../src/flow/editor-actions'
import type { FlowAction } from '../src/schemas/actions'
import { deliverCommentOpening } from '../src/channels/core/comment-delivery'
import type { Env } from '../src/env'
import type { Run } from '../src/flow/types'
import { assertPublishable } from '../src/channels/core/publish-check'
import { ChannelLimiter } from '../src/flow/limiter'

let workflow: WorkflowIntrospector | undefined
const sent: { path: string; body: Record<string, any> }[] = []
beforeEach(async () => {
  await seed()
  sent.length = 0
  await env.DB.prepare("UPDATE channels SET external_id='17840001',provider='instagram_unified' WHERE id='ch-a'").run()
  await giveCredentials(env, 'ch-a', { accessToken: 'TESTONLY', accountId: '17840001' })
  await env.DB.prepare(`UPDATE triggers SET kind='widget',widget_type='feed_comment',post_scope='specific',target_post_id='post-1',
    repeat_mode='every_time',public_replies='["Veja seu privado!","Material enviado!"]',like_comment=1,
    config='{"node_id":"t","include":["quero"],"exclude":["spam"]}' WHERE id='trg-a'`).run()
  const opening = structuredClone(graph)
  opening.nodes[1].config = { blocks: [{ kind: 'text', text: 'Olá, {{primeiro_nome}}! Seu guia está aqui.' }, { kind: 'button', id: 'link', label: 'Abrir guia', action: { type: 'url', url: 'https://example.com/guia' } }] }
  await env.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('v-comment','a','auto-a',1,?)").bind(JSON.stringify(opening)).run()
  await env.DB.prepare("UPDATE automations SET published_version_id='v-comment',status='live',draft_graph=? WHERE id='auto-a'").bind(JSON.stringify(opening)).run()
  vi.spyOn(ChannelLimiter.prototype, 'acquire').mockResolvedValue({ allowed: true, retryAfter: 0 })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init)
    expect(req.url).toMatch(/^https:\/\/graph.facebook.com\/v26.0\//)
    const path = new URL(req.url).pathname
    if (req.method === 'GET') return Response.json({ data: [{ id: 'post-1', caption: 'Guia de estudos', timestamp: new Date().toISOString() }] })
    sent.push({ path, body: await req.json() })
    return Response.json(path.endsWith('/messages') ? { message_id: `private-${sent.length}` } : { id: `public-${sent.length}`, success: true })
  })
})
afterEach(async () => { await workflow?.dispose(); workflow = undefined; vi.restoreAllMocks() })
async function deliver(id: string, text = 'Eu quero', post = 'post-1', bindings: Env = env) {
  const batch = createMessageBatch('inbound', [{ id: `q-${id}`, timestamp: new Date(), attempts: 1, body: {
    version: 1, provider: 'meta', workspaceId: 'a', channelId: 'ch-a', eventId: `comments:${id}`, receivedAt: Date.now(),
    payload: { field: 'comments', value: { id, from: { id: '190001' }, media: { id: post }, text, timestamp: new Date().toISOString() } },
  } }])
  await consumeInbound(batch, bindings)
  expect((await getQueueResult(batch, createExecutionContext())).retryMessages).toEqual([])
}
it('comentário dispara resposta privada de link e pública alternada, curte, não abre janela nem duplica no replay', async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO contacts(id,workspace_id,first_name) VALUES ('comment-person','a','Ana')"),
    env.DB.prepare("INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('comment-person-cc','a','comment-person','ch-a','190001',0)"),
  ])
  workflow = await introspectWorkflow(env.FLOW_RUN!)
  await workflow.modifyAll(async m => { await m.disableRetryDelays() })
  await deliver('comment-1')
  await expect.poll(async () => (await env.DB.prepare("SELECT count(*) n FROM flow_runs WHERE trigger_id='trg-a' AND status='done'").first<{ n: number }>())?.n).toBe(1)
  // Família comentário: origem de entrada gravada.
  expect(await env.DB.prepare("SELECT optin_source FROM contacts WHERE id='comment-person'").first('optin_source')).toBe('trigger:trg-a')
  expect(sent.find(s => s.path.endsWith('/messages'))?.body).toMatchObject({ recipient: { comment_id: 'comment-1' }, message: { attachment: { payload: { text: 'Olá, Ana! Seu guia está aqui.', buttons: [{ type: 'web_url', url: 'https://example.com/guia' }] } } } })
  expect(sent.find(s => s.path.endsWith('/replies'))?.body).toEqual({ message: 'Veja seu privado!' })
  expect(sent.filter(s => s.path.endsWith('/likes'))).toHaveLength(0)   // gatilho antigo com curtida ligada: ignorada, sem erro
  expect(await env.DB.prepare("SELECT opted_in,window_expires_at,first_inbound_id FROM contact_channels WHERE channel_id='ch-a' AND external_user_id='190001'").first()).toMatchObject({ opted_in: 0, window_expires_at: null, first_inbound_id: null })
  await deliver('comment-1')
  expect(sent).toHaveLength(2)
  await deliver('comment-2')
  await expect.poll(() => sent.filter(s => s.path.endsWith('/messages')).length).toBe(2)
  expect(sent.filter(s => s.path.endsWith('/replies')).map(s => s.body.message)).toEqual(['Veja seu privado!', 'Material enviado!'])
  await deliver('excluded', 'quero spam')
  await deliver('wrong-post', 'quero', 'post-2')
  expect(sent.filter(s => s.path.endsWith('/messages'))).toHaveLength(2)
})
it('leitura (read com mid) da resposta privada de comentário marca a mensagem como lida e conta uma leitura no passo', async () => {
  workflow = await introspectWorkflow(env.FLOW_RUN!)
  await workflow.modifyAll(async m => { await m.disableRetryDelays() })
  await deliver('comment-read')
  await expect.poll(async () => (await env.DB.prepare("SELECT count(*) n FROM flow_runs WHERE trigger_id='trg-a' AND status='done'").first<{ n: number }>())?.n).toBe(1)
  const privateId = `private-${sent.findIndex(s => s.path.endsWith('/messages')) + 1}`
  expect(await env.DB.prepare("SELECT delivery_status,json_extract(content,'$.status') s FROM messages WHERE source='automation'").first()).toMatchObject({ delivery_status: 'sent', s: 'sent' })
  const batch = createMessageBatch('inbound', [{ id: 'q-read', timestamp: new Date(), attempts: 1, body: {
    version: 1, provider: 'meta', workspaceId: 'a', channelId: 'ch-a', eventId: `read:${privateId}`, receivedAt: Date.now(),
    payload: { sender: { id: '190001' }, recipient: { id: '17840001' }, timestamp: Date.now(), read: { mid: privateId } },
  } }])
  await consumeInbound(batch, env)
  expect((await getQueueResult(batch, createExecutionContext())).retryMessages).toEqual([])
  expect(await env.DB.prepare("SELECT delivery_status,json_extract(content,'$.status') s FROM messages WHERE source='automation'").first()).toMatchObject({ delivery_status: 'read', s: 'delivered' })
  expect((await env.DB.prepare("SELECT type,node_id FROM node_events WHERE type='read'").all()).results).toEqual([{ type: 'read', node_id: 'm' }])
})
// Decisão (bug 4 do teste real): a resposta privada aceita 1 texto + 1 botão, de link ou de toque (postback).
// Fontes: docs-meta-messenger, discovery/private-replies.md ("All messaging types available for the Send API are available for private replies"; o exemplo
// de comment/post_id usa template de botão com postback) e a Send API do Instagram (messaging-api.md) aceita button template com postback e web_url.
// A página de private replies do Instagram só mostra `message.text`, mas nenhuma página proíbe botão de toque. Se a Meta recusar, o erro volta em delivery_error.
const withPostback = (extra: Record<string, unknown> = {}) => {
  const g = structuredClone(graph)
  g.nodes[1].config = { blocks: [{ kind: 'text', text: 'Quer o guia?' }, { kind: 'button', id: 'quero', label: 'Quero', action: { type: 'go_to_node' } }], ...extra }
  g.nodes.push({ id: 'm2', type: 'message', position: { x: 400, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Aqui está o guia!' }] } })
  g.edges.push({ from: 'm', port: 'btn:quero', to: 'm2' })
  return g
}
let versions = 1
const useGraph = async (g: typeof graph) => {
  const id = `v-comment-${++versions}`
  await env.DB.batch([
    env.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES (?,'a','auto-a',?,?)").bind(id, versions, JSON.stringify(g)),
    env.DB.prepare("UPDATE automations SET published_version_id=?,draft_graph=? WHERE id='auto-a'").bind(id, JSON.stringify(g)),
  ])
}
it('resposta privada com botão de toque espera o toque, vale como consentimento e só então segue o fluxo', async () => {
  await useGraph(withPostback())
  await assertPublishable(env, 'a', 'auto-a')
  workflow = await introspectWorkflow(env.FLOW_RUN!)
  await workflow.modifyAll(async m => { await m.disableRetryDelays() })
  await deliver('comment-postback')
  await expect.poll(async () => (await env.DB.prepare("SELECT status FROM flow_runs WHERE trigger_id='trg-a'").first<{ status: string }>())?.status).toBe('waiting_click')
  const opening = sent.find(s => s.path.endsWith('/messages'))!
  expect(opening.body).toMatchObject({ recipient: { comment_id: 'comment-postback' }, message: { attachment: { payload: { template_type: 'button', text: 'Quer o guia?',
    buttons: [{ type: 'postback', title: 'Quero', payload: expect.stringMatching(/^b:[a-f0-9]{24}$/) }] } } } })
  expect(sent.filter(s => s.path.endsWith('/messages'))).toHaveLength(1)   // nada encadeado antes do toque
  // Nasceu de um comentário: sem consentimento nem janela até a pessoa tocar.
  expect(await env.DB.prepare("SELECT opted_in,window_expires_at FROM contact_channels WHERE channel_id='ch-a' AND external_user_id='190001'").first()).toMatchObject({ opted_in: 0, window_expires_at: null })
  const payload = (opening.body.message.attachment.payload.buttons[0] as { payload: string }).payload
  const tap = createMessageBatch('inbound', [{ id: 'q-tap', timestamp: new Date(), attempts: 1, body: {
    version: 1, provider: 'meta', workspaceId: 'a', channelId: 'ch-a', eventId: 'postback:pb-1', receivedAt: Date.now(),
    payload: { sender: { id: '190001' }, recipient: { id: '17840001' }, timestamp: Date.now(), postback: { mid: 'pb-1', title: 'Quero', payload } },
  } }])
  await consumeInbound(tap, env)
  expect((await getQueueResult(tap, createExecutionContext())).retryMessages).toEqual([])
  await expect.poll(() => sent.filter(s => s.path.endsWith('/messages')).length).toBe(2)
  expect(sent.filter(s => s.path.endsWith('/messages'))[1].body).toMatchObject({ recipient: { id: '190001' }, message: { text: 'Aqui está o guia!' } })
  expect(await env.DB.prepare("SELECT opted_in FROM contact_channels WHERE channel_id='ch-a' AND external_user_id='190001'").first('opted_in')).toBe(1)
})
it('publicação da resposta privada: botão de toque só aceita saída depois do toque e continua sendo uma mensagem', async () => {
  await useGraph(withPostback())
  await expect(assertPublishable(env, 'a', 'auto-a')).resolves.not.toThrow()
  const timeout = withPostback(); timeout.edges.push({ from: 'm', port: 'timeout', to: 'm2' })
  await useGraph(timeout)
  await expect(assertPublishable(env, 'a', 'auto-a')).rejects.toThrow(/depois do toque|responder/i)
  const chained = withPostback(); chained.edges.push({ from: 'm', port: 'next', to: 'm2' })
  await useGraph(chained)
  await expect(assertPublishable(env, 'a', 'auto-a')).rejects.toThrow(/depois do toque|responder/i)
  const two = withPostback(); two.nodes[1].config = { blocks: [{ kind: 'text', text: 'Quer?' }, { kind: 'button', id: 'a', label: 'A', action: { type: 'go_to_node' } }, { kind: 'button', id: 'b', label: 'B', action: { type: 'go_to_node' } }] }
  await useGraph(two)
  await expect(assertPublishable(env, 'a', 'auto-a')).rejects.toThrow(/um botão/i)
  const other = withPostback(); other.nodes[1].config = { blocks: [{ kind: 'text', text: 'Quer?' }, { kind: 'button', id: 'a', label: 'A', action: { type: 'start_automation', automation_id: 'x' } }] }
  await useGraph(other)
  await expect(assertPublishable(env, 'a', 'auto-a')).rejects.toThrow(/link ou de toque|botão/i)
})
it('resposta pública recusada pela Meta não impede a resposta privada, e a curtida nem é tentada', async () => {
  workflow = await introspectWorkflow(env.FLOW_RUN!)
  await workflow.modifyAll(async m => { await m.disableRetryDelays() })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname
    sent.push({ path, body: JSON.parse(String(init?.body)) })
    if (path.endsWith('/replies')) return Response.json({ error: { message: 'Permissão negada', code: 200 } }, { status: 403 })
    return Response.json({ message_id: 'private-ok' })
  })
  await deliver('comment-like-refused')
  await expect.poll(async () => (await env.DB.prepare("SELECT status FROM flow_runs WHERE trigger_id='trg-a'").first<{ status: string }>())?.status, { timeout: 10_000 }).toBe('done')
  expect(sent.filter(s => s.path.endsWith('/messages'))).toHaveLength(1)
  expect(sent.some(s => s.path.endsWith('/likes'))).toBe(false)
  expect(warn.mock.calls.map(c => String(c[0])).some(line => line.includes('comment_extra_failed') && line.includes('"action":"public"'))).toBe(true)
})
it('publicação recusa espera anterior à primeira mensagem de comentário, inclusive após ação', async () => {
  const g = structuredClone(graph)
  g.nodes.push({ id: 'delay', type: 'smart_delay', position: { x: 0, y: 0 }, config: { duration: { value: 1, unit: 'minutes' } } })
  g.edges = [{ from: 't', port: 'next', to: 'delay' }, { from: 'delay', port: 'next', to: 'm' }]
  await env.DB.prepare("UPDATE automations SET draft_graph=? WHERE id='auto-a'").bind(JSON.stringify(g)).run()
  await expect(assertPublishable(env, 'a', 'auto-a')).rejects.toThrow(/espera|interação/i)
})
it('desinscrição durante limite de taxa impede novas respostas na tentativa seguinte', async () => {
  workflow = await introspectWorkflow(env.FLOW_RUN!)
  await workflow.modifyAll(async m => { await m.disableRetryDelays() })
  vi.mocked(fetch).mockImplementation(async (input) => {
    expect(String(input)).toContain('/comment-unsubscribe/replies')
    sent.push({ path: '/replies', body: {} })
    await env.DB.prepare("UPDATE contacts SET status='unsubscribed' WHERE id IN (SELECT contact_id FROM contact_channels WHERE external_user_id='190001' AND channel_id='ch-a')").run()
    return Response.json({ error: { code: 4 } }, { status: 429, headers: { 'Retry-After': '1' } })
  })
  await deliver('comment-unsubscribe')
  await expect.poll(async () => (await env.DB.prepare("SELECT status FROM flow_runs WHERE trigger_id='trg-a'").first<{ status: string }>())?.status, { timeout: 10_000 }).toBe('failed')
  expect(sent).toHaveLength(1)
})
it('resultado privado incerto não é reenviado no replay do webhook', async () => {
  workflow = await introspectWorkflow(env.FLOW_RUN!)
  await workflow.modifyAll(async m => { await m.disableRetryDelays() })
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname
    sent.push({ path, body: JSON.parse(String(init?.body)) })
    if (path.endsWith('/messages')) throw new Error('Fake connection interrupted')
    return Response.json({ id: 'public-confirmed', success: true })
  })
  await deliver('comment-uncertain')
  await expect.poll(async () => (await env.DB.prepare("SELECT status FROM flow_runs WHERE trigger_id='trg-a'").first<{ status: string }>())?.status, { timeout: 10_000 }).toBe('failed')
  expect(sent).toHaveLength(2)
  await deliver('comment-uncertain')
  expect(sent).toHaveLength(2)
  expect(await env.DB.prepare("SELECT status FROM comment_effects WHERE comment_id='comment-uncertain' AND effect='private'").first<string>('status')).toBe('uncertain')
})


it('excluir contato apaga contexto e permite nova entrada sem ressuscitar o registro apagado', async () => {
  workflow = await introspectWorkflow(env.FLOW_RUN!)
  await workflow.modifyAll(async m => { await m.disableRetryDelays() })
  await deliver('before-delete')
  await expect.poll(async () => (await env.DB.prepare("SELECT status FROM flow_runs WHERE trigger_id='trg-a'").first<string>('status'))).toBe('done')
  const oldId = (await env.DB.prepare("SELECT contact_id FROM flow_runs WHERE trigger_id='trg-a'").first<string>('contact_id'))!
  await deleteContacts(env, 'a', [oldId])
  expect.soft(await env.DB.prepare("SELECT comment_context FROM flow_runs WHERE contact_id=?").bind(oldId).first('comment_context')).toBeNull()
  expect.soft(await env.DB.prepare("SELECT count(*) n FROM comment_effects WHERE run_id IN (SELECT id FROM flow_runs WHERE contact_id=?)").bind(oldId).first('n')).toBe(0)
  await deliver('after-delete')
  await expect.poll(() => sent.filter(s => s.path.endsWith('/messages')).length).toBe(2)
  expect(await env.DB.prepare("SELECT contact_id FROM contact_channels WHERE channel_id='ch-a' AND external_user_id='190001'").first('contact_id')).not.toBe(oldId)
  expect(await env.DB.prepare("SELECT status FROM contacts WHERE id=?").bind(oldId).first('status')).toBe('deleted')
})

it('conexão que volta a aguardar webhook antes do envio não responde ao comentário', async () => {
  const bindings = { ...env, FLOW_RUN: { create: async () => ({}) } } as unknown as Env
  await deliver('pending-connection', 'quero', 'post-1', bindings)
  // A entrada confirma o webhook; uma nova configuração pode colocá-lo em espera antes do envio.
  await env.DB.prepare("UPDATE channels SET connection_state='pending' WHERE id='ch-a'").run()
  const run = await env.DB.prepare("SELECT r.*,cc.external_user_id FROM flow_runs r JOIN contact_channels cc ON cc.contact_id=r.contact_id AND cc.channel_id=r.channel_id WHERE r.trigger_id='trg-a'").first<Run>()
  const result = await deliverCommentOpening(env, run!, 1, [{ kind: 'text', text: 'Seu guia está aqui.' }])
  expect(result).toMatchObject({ ok: false, reason: 'rejected', code: 'connection_not_ready' })
  expect(sent).toEqual([])
})

it('comentário em Live dispara só o gatilho de Live, com a regra de palavra, e comentário de publicação não o aciona', async () => {
  await env.DB.prepare(`UPDATE triggers SET widget_type='instagram_live_comment_reply',post_scope='all',target_post_id=NULL,public_replies='[]',like_comment=0,
    config='{"node_id":"t","include":[],"exclude":[],"rule":"word","words":["eu quero","cupom"]}' WHERE id='trg-a'`).run()
  workflow = await introspectWorkflow(env.FLOW_RUN!)
  await workflow.modifyAll(async m => { await m.disableRetryDelays() })
  const live = async (id: string, text: string) => {
    const batch = createMessageBatch('inbound', [{ id: `q-${id}`, timestamp: new Date(), attempts: 1, body: {
      version: 1, provider: 'meta', workspaceId: 'a', channelId: 'ch-a', eventId: `live_comments:${id}`, receivedAt: Date.now(),
      payload: { field: 'live_comments', value: { id, from: { id: '190001' }, media: { id: 'live-1', media_product_type: 'LIVE' }, text, timestamp: new Date().toISOString() } },
    } }])
    await consumeInbound(batch, env)
  }
  await live('live-a', 'quero o CUPOM agora')
  await expect.poll(async () => (await env.DB.prepare("SELECT count(*) n FROM flow_runs WHERE trigger_id='trg-a'").first<{ n: number }>())?.n).toBe(1)
  await live('live-b', 'cupomzinho')
  await deliver('post-comment', 'cupom')
  await new Promise(r => setTimeout(r, 300))
  expect(await env.DB.prepare("SELECT count(*) n FROM flow_runs WHERE trigger_id='trg-a'").first('n')).toBe(1)
})

// B4 (auditoria de segurança): quem mandou STOP na conexão não recebe a resposta privada, mesmo comentando depois; a resposta pública segue.
it('B4: contato que mandou STOP recebe a resposta pública do comentário, mas não a privada', async () => {
  const previous = vi.mocked(globalThis.fetch).getMockImplementation()!
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const req = new Request(input, init)
    if (req.method === 'GET' && new URL(req.url).pathname.endsWith('/190001')) return Response.json({ id: '190001', username: 'ana.teste', name: 'Ana' })
    return previous(input, init)
  })
  const dm = createMessageBatch('inbound', [{ id: 'q-stop', timestamp: new Date(), attempts: 1, body: {
    version: 1, provider: 'meta', workspaceId: 'a', channelId: 'ch-a', eventId: 'mid-stop-1', receivedAt: Date.now(),
    payload: { sender: { id: '190001' }, recipient: { id: '17840001' }, timestamp: Date.now(), message: { mid: 'mid-stop-1', text: 'parar' } },
  } }])
  await consumeInbound(dm, env)
  expect((await getQueueResult(dm, createExecutionContext())).retryMessages).toEqual([])
  expect(await env.DB.prepare("SELECT opted_in FROM contact_channels WHERE channel_id='ch-a' AND external_user_id='190001'").first('opted_in')).toBe(0)
  workflow = await introspectWorkflow(env.FLOW_RUN!)
  await workflow.modifyAll(async m => { await m.disableRetryDelays() })
  await deliver('comment-after-stop')
  await expect.poll(async () => (await env.DB.prepare("SELECT status FROM flow_runs WHERE trigger_id='trg-a'").first<{ status: string }>())?.status).toBe('failed')
  expect(sent.filter(s => s.path.endsWith('/replies')).map(s => s.body.message)).toEqual(['Veja seu privado!'])
  expect(sent.filter(s => s.path.endsWith('/messages'))).toHaveLength(0)
  expect(await env.DB.prepare("SELECT error FROM flow_runs WHERE trigger_id='trg-a'").first('error')).toMatch(/not_opted_in/)
})

// Ficha 09, item 5: o toque no botão da resposta privada passa pela mesma regra de horário do START/STOP.
const profileMock = () => {
  const previous = vi.mocked(globalThis.fetch).getMockImplementation()!
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const req = new Request(input, init)
    if (req.method === 'GET' && new URL(req.url).pathname.endsWith('/190001')) return Response.json({ id: '190001', username: 'ana.teste', name: 'Ana' })
    return previous(input, init)
  })
}
const channelRow = () => env.DB.prepare("SELECT opted_in,consent_changed_at,opted_out_at FROM contact_channels WHERE channel_id='ch-a' AND external_user_id='190001'").first<{ opted_in: number; consent_changed_at: number | null; opted_out_at: number | null }>()
async function openingTapPayload(id: string) {
  await useGraph(withPostback())
  workflow = await introspectWorkflow(env.FLOW_RUN!)
  await workflow.modifyAll(async m => { await m.disableRetryDelays() })
  await deliver(id)
  await expect.poll(async () => (await env.DB.prepare("SELECT status FROM flow_runs WHERE trigger_id='trg-a'").first<{ status: string }>())?.status).toBe('waiting_click')
  return (sent.find(s => s.path.endsWith('/messages'))!.body.message.attachment.payload.buttons[0] as { payload: string }).payload
}
async function dm(id: string, at: number, content: { text: string } | { postback: { mid: string; title: string; payload: string } }) {
  const batch = createMessageBatch('inbound', [{ id: `q-${id}`, timestamp: new Date(), attempts: 1, body: {
    version: 1, provider: 'meta', workspaceId: 'a', channelId: 'ch-a', eventId: 'postback' in content ? `postback:${content.postback.mid}` : id, receivedAt: Date.now(),
    payload: { sender: { id: '190001' }, recipient: { id: '17840001' }, timestamp: at, ...('text' in content ? { message: { mid: id, text: content.text } } : content) },
  } }])
  await consumeInbound(batch, env)
  expect((await getQueueResult(batch, createExecutionContext())).retryMessages).toEqual([])
}
it('item 5: toque no botão com horário anterior ao último STOP não devolve o opt-in', async () => {
  profileMock()
  const payload = await openingTapPayload('comment-tap-old')
  const stopAt = Date.now() - 1000
  await dm('mid-stop-tap', stopAt, { text: 'parar' })
  expect(await channelRow()).toMatchObject({ opted_in: 0, consent_changed_at: stopAt, opted_out_at: stopAt })
  await dm('pb-old', stopAt - 5000, { postback: { mid: 'pb-old', title: 'Quero', payload } })
  expect(await channelRow()).toMatchObject({ opted_in: 0, consent_changed_at: stopAt, opted_out_at: stopAt })
})
it('item 5: toque novo depois do STOP vale como consentimento e grava o horário', async () => {
  profileMock()
  const payload = await openingTapPayload('comment-tap-new')
  const stopAt = Date.now() - 5000
  await dm('mid-stop-tap2', stopAt, { text: 'parar' })
  expect(await channelRow()).toMatchObject({ opted_in: 0 })
  const tapAt = Date.now() - 1000
  await dm('pb-new', tapAt, { postback: { mid: 'pb-new', title: 'Quero', payload } })
  expect(await channelRow()).toMatchObject({ opted_in: 1, consent_changed_at: tapAt, opted_out_at: null })   // o toque novo limpa a marca de "pediu para sair"
})

// Ficha 09, item 4: quem pediu para sair por qualquer caminho tem a marca opted_out_at e não recebe a resposta privada; quem nasceu do comentário e nunca saiu recebe.
const leaving: [string, (at: number) => Promise<void>][] = [
  ['palavra STOP', at => dm(`mid-stop-${at}`, at, { text: 'parar' })],
  ...(['unsubscribe_to_account', 'set_instagram_opt_out'] as const).map(type => [`ação de fluxo ${type}`, async () => {
    const run = (await env.DB.prepare("SELECT * FROM flow_runs WHERE trigger_id='trg-a'").first<Run>())!
    const action = (type === 'unsubscribe_to_account' ? { type, connection_id: 'ch-a' } : { type }) as FlowAction
    await env.DB.batch((await editorActionStatements(env as never, run, action, 90, 0))!)
  }] as [string, (at: number) => Promise<void>]),
]
for (const [name, leave] of leaving) it(`item 4: ${name} depois de tocar no botão bloqueia a próxima resposta privada, mesmo sem nunca ter escrito`, async () => {
  profileMock()
  const payload = await openingTapPayload(`comment-leave-${name.length}`)
  const tapAt = Date.now() - 4000
  await dm('pb-leave', tapAt, { postback: { mid: 'pb-leave', title: 'Quero', payload } })
  // Workflow de verdade: com a máquina ocupada passa de 1 s (o padrão do poll); o mesmo limite das outras esperas deste arquivo.
  await expect.poll(() => sent.filter(s => s.path.endsWith('/messages')).length, { timeout: 10_000 }).toBe(2)   // abertura + o passo seguinte
  expect(await channelRow()).toMatchObject({ opted_in: 1, opted_out_at: null })
  await leave(Date.now() - 2000)
  expect(await channelRow()).toMatchObject({ opted_in: 0, opted_out_at: expect.any(Number) })
  await deliver('comment-after-leave')
  await expect.poll(async () => (await env.DB.prepare("SELECT count(*) n FROM flow_runs WHERE trigger_id='trg-a' AND status='failed'").first<{ n: number }>())?.n, { timeout: 10_000 }).toBe(1)
  expect(await env.DB.prepare("SELECT error FROM flow_runs WHERE status='failed'").first('error')).toMatch(/not_opted_in/)
  expect(sent.filter(s => s.path.endsWith('/messages'))).toHaveLength(2)
}, 30_000)
