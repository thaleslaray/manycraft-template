import { env } from 'cloudflare:workers'
import { createExecutionContext, createMessageBatch, getQueueResult, introspectWorkflow, type WorkflowIntrospector } from 'cloudflare:test'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { seed, graph } from './fixtures'
import { giveCredentials } from './credentials'
import { consumeInbound } from '../src/jobs'
import { assertPublishable } from '../src/channels/core/publish-check'
import { instagramUnified } from '../src/channels/instagram-unified'
import { ChannelLimiter } from '../src/flow/limiter'
import { saveStoryTrigger } from '../src/db/story-triggers'

const ACCOUNT = '17840001', PERSON = '190001'
let workflow: WorkflowIntrospector | undefined
const sent: { path: string; body: Record<string, any> }[] = []

async function setTrigger(columns: string, bind: unknown[] = []) {
  await env.DB.prepare(`UPDATE triggers SET ${columns} WHERE id='trg-a'`).bind(...bind).run()
}
const asReply = (scope: 'all' | 'specific', target: string | null, config: Record<string, unknown>) =>
  setTrigger("kind='widget',widget_type='instagram_story_reply',post_scope=?,target_post_id=?,repeat_mode='every_time',config=?", [scope, target, JSON.stringify({ node_id: 't', ...config })])
const asMention = (delay: number, heart: boolean, mode = 'every_time') =>
  setTrigger("kind='story_mention_reply',widget_type=NULL,post_scope=NULL,target_post_id=NULL,repeat_mode=?,delay_seconds=?,story_auto_like=?,config=?", [mode, delay, heart ? 1 : 0, JSON.stringify({ node_id: 't' })])

beforeEach(async () => {
  await seed()
  sent.length = 0
  await env.DB.prepare("UPDATE channels SET external_id=?,provider='instagram_unified' WHERE id='ch-a'").bind(ACCOUNT).run()
  await giveCredentials(env, 'ch-a', { accessToken: 'TESTONLY', accountId: ACCOUNT })
  const published = structuredClone(graph)
  published.nodes[1].config = { blocks: [{ kind: 'text', text: 'Oi, {{primeiro_nome}}! Obrigado pelo story.' }] }
  await env.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('v-story','a','auto-a',1,?)").bind(JSON.stringify(published)).run()
  await env.DB.prepare("UPDATE automations SET published_version_id='v-story',status='live',draft_graph=? WHERE id='auto-a'").bind(JSON.stringify(published)).run()
  vi.spyOn(ChannelLimiter.prototype, 'acquire').mockResolvedValue({ allowed: true, retryAfter: 0 })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init)
    const path = new URL(req.url).pathname
    if (req.method === 'GET') return Response.json({ name: 'Ana', username: 'ana_local' })
    sent.push({ path, body: await req.json() })
    return Response.json({ recipient_id: PERSON, message_id: `out-${sent.length}` })
  })
  workflow = await introspectWorkflow(env.FLOW_RUN!)
  await workflow.modifyAll(async m => { await m.disableRetryDelays(); await m.disableSleeps() })
})
afterEach(async () => { await workflow?.dispose(); workflow = undefined; vi.restoreAllMocks() })

async function deliver(mid: string, message: Record<string, unknown>) {
  const batch = createMessageBatch('inbound', [{ id: `q-${mid}`, timestamp: new Date(), attempts: 1, body: {
    version: 1, provider: 'meta', workspaceId: 'a', channelId: 'ch-a', eventId: mid, receivedAt: Date.now(),
    payload: { sender: { id: PERSON }, recipient: { id: ACCOUNT }, timestamp: Date.now(), message: { mid, ...message } },
  } }])
  await consumeInbound(batch, env)
  expect((await getQueueResult(batch, createExecutionContext())).retryMessages).toEqual([])
}
const reply = (mid: string, text: string, story = 'story-1') => deliver(mid, { text, reply_to: { story: { id: story, url: 'https://cdn.example/story.jpg' } } })
const mention = (mid: string) => deliver(mid, { attachments: [{ type: 'story_mention', payload: { url: 'https://cdn.example/mention.jpg' } }] })
const messages = () => sent.filter(s => s.path.endsWith('/messages') && s.body.message)
const runs = async () => (await env.DB.prepare("SELECT count(*) n FROM flow_runs WHERE trigger_id='trg-a'").first<number>('n'))!
const done = () => expect.poll(async () => (await env.DB.prepare("SELECT count(*) n FROM flow_runs WHERE trigger_id='trg-a' AND status='done'").first<number>('n'))!)

it('o provedor lê resposta a story com o id do story e menção em story como evento próprio', () => {
  const connection = { externalId: ACCOUNT } as Parameters<typeof instagramUnified.parseInbound>[1]
  const item = (message: Record<string, unknown>) => ({ sender: { id: PERSON }, recipient: { id: ACCOUNT }, timestamp: 1_700_000_000_000, message })
  expect(instagramUnified.parseInbound(item({ mid: 'm1', text: 'amei', reply_to: { story: { id: 'story-9' } } }), connection)[0]).toMatchObject({ kind: 'message', storyReply: true, storyId: 'story-9', text: 'amei' })
  expect(instagramUnified.parseInbound(item({ mid: 'm2', attachments: [{ type: 'story_mention', payload: { url: 'https://cdn.example/s.jpg' } }] }), connection)[0])
    .toMatchObject({ kind: 'story_mention', eventKey: 'm2', externalMessageId: 'm2', storyUrl: 'https://cdn.example/s.jpg', from: { externalUserId: PERSON } })
  expect(instagramUnified.parseInbound(item({ mid: 'm3', attachments: [{ type: 'image', payload: { url: 'https://cdn.example/i.jpg' } }] }), connection)[0]).toMatchObject({ kind: 'message', unsupported: { type: 'image' } })   // chega na caixa de entrada, sem disparar fluxo
})

it('resposta a um story específico respeita o story e a condição e responde no privado', async () => {
  await asReply('specific', 'story-1', { rule: 'contains', words: ['Preço'] })
  await reply('r-1', 'qual o preco?', 'story-2')
  await reply('r-2', 'bom dia', 'story-1')
  expect(await runs()).toBe(0)
  await reply('r-3', 'qual o preco?', 'story-1')
  await done().toBe(1)
  expect(messages()).toHaveLength(1)
  expect(messages()[0].body).toMatchObject({ recipient: { id: PERSON }, message: { text: 'Oi, Ana! Obrigado pelo story.' } })
  expect(await env.DB.prepare("SELECT opted_in FROM contact_channels WHERE channel_id='ch-a' AND external_user_id=?").bind(PERSON).first('opted_in')).toBe(1)
  // Família story: origem de entrada gravada uma vez.
  expect(await env.DB.prepare("SELECT c.optin_source FROM contacts c JOIN contact_channels cc ON cc.contact_id=c.id WHERE cc.external_user_id=?").bind(PERSON).first('optin_source')).toBe('trigger:trg-a')
  await reply('r-3', 'qual o preco?', 'story-1')
  expect(messages()).toHaveLength(1)
})

it('story específico vence "qualquer story", condição "igual" exige a frase inteira e sem gatilho a mensagem segue como DM', async () => {
  await asReply('all', null, { rule: 'is', words: ['quero'] })
  await env.DB.prepare(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status,repeat_mode,post_scope,target_post_id,config)
    VALUES ('trg-specific','a','auto-a','ch-a','Story 1','widget','instagram_story_reply','active','every_time','specific','story-1',?)`).bind(JSON.stringify({ node_id: 't', rule: 'any', words: [] })).run()
  await reply('s-1', 'quero muito', 'story-9')
  expect(await runs()).toBe(0)
  await reply('s-2', 'QUERO', 'story-9')
  await done().toBe(1)
  await reply('s-3', 'qualquer coisa', 'story-1')
  await expect.poll(async () => (await env.DB.prepare("SELECT count(*) n FROM flow_runs WHERE trigger_id='trg-specific'").first<number>('n'))!).toBe(1)
  // Sem gatilho de story ativo, a resposta é uma mensagem comum e cai nas palavras-chave.
  await env.DB.prepare("UPDATE triggers SET status='draft' WHERE id IN ('trg-a','trg-specific')").run()
  await env.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,config) VALUES ('trg-kw','a','auto-a','ch-a','Palavra','keyword','active',?)").bind(JSON.stringify({ include: ['quero'], exclude: [] })).run()
  await env.DB.prepare("INSERT INTO keywords(id,workspace_id,trigger_id,rule,words,status,priority) VALUES ('kw-story','a','trg-kw','contains','[\"quero\"]','live',1)").run()
  await reply('s-4', 'eu quero', 'story-9')
  await expect.poll(async () => (await env.DB.prepare("SELECT count(*) n FROM flow_runs WHERE trigger_id='trg-kw'").first<number>('n'))!).toBe(1)
})

it('menção em story abre a conversa, reage com coração, espera o atraso e responde; repetição só conforme a política', async () => {
  await asMention(300, true, 'once_per_24_hours')
  await mention('mention-1')
  await done().toBe(1)
  const react = sent.filter(s => s.body.sender_action === 'react')
  expect(react).toHaveLength(1)
  expect(react[0].body).toEqual({ recipient: { id: PERSON }, sender_action: 'react', payload: { message_id: 'mention-1', reaction: 'love' } })
  expect(messages()).toHaveLength(1)
  expect(sent.indexOf(react[0])).toBeLessThan(sent.indexOf(messages()[0]))
  const identity = await env.DB.prepare("SELECT opted_in,window_expires_at FROM contact_channels WHERE channel_id='ch-a' AND external_user_id=?").bind(PERSON).first<{ opted_in: number; window_expires_at: number }>()
  expect(identity).toMatchObject({ opted_in: 1 })
  expect(identity!.window_expires_at).toBeGreaterThan(Date.now())
  expect(await env.DB.prepare("SELECT json_extract(story_context,'$.heartResult') AS r, json_extract(story_context,'$.delaySeconds') AS d FROM flow_runs WHERE trigger_id='trg-a'").first()).toEqual({ r: 'sent', d: 300 })
  expect(await env.DB.prepare("SELECT count(*) n FROM messages WHERE content LIKE '%Mencionou você em um story%'").first('n')).toBe(1)
  await mention('mention-2')
  expect(await runs()).toBe(1)
  expect(sent.filter(s => s.body.sender_action === 'react')).toHaveLength(1)
  await env.DB.prepare("UPDATE triggers SET repeat_mode='every_time' WHERE id='trg-a'").run()
  await mention('mention-3')
  await done().toBe(2)
})

it('o coração só sai onde a ficha da conexão declara e a falta dele não derruba a resposta', async () => {
  await asMention(0, true)
  await env.DB.prepare("UPDATE channels SET capabilities_override=? WHERE id='ch-a'").bind(JSON.stringify({ stories: { heart: false } })).run()
  await mention('mention-nocaps')
  await done().toBe(1)
  expect(sent.filter(s => s.body.sender_action === 'react')).toHaveLength(0)
  expect(messages()).toHaveLength(1)
  await env.DB.prepare("UPDATE channels SET capabilities_override=NULL WHERE id='ch-a'").run()
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const body = JSON.parse(String(init?.body)); sent.push({ path: new URL(String(input)).pathname, body })
    return body.sender_action ? Response.json({ error: { code: 100 } }, { status: 400 }) : Response.json({ recipient_id: PERSON, message_id: `out-${sent.length}` })
  })
  await mention('mention-rejected')
  await done().toBe(2)
  expect(await env.DB.prepare("SELECT json_extract(story_context,'$.heartResult') AS r FROM flow_runs WHERE inbound_event_id LIKE '%mention-rejected%'").first('r')).toBe('rejected')
})

it('publicação recusa gatilho de story em conexão que não declara a entrada ou o coração', async () => {
  await asMention(0, true)
  await assertPublishable(env, 'a', 'auto-a')
  await env.DB.prepare("UPDATE channels SET capabilities_override=? WHERE id='ch-a'").bind(JSON.stringify({ stories: { heart: false } })).run()
  await expect(assertPublishable(env, 'a', 'auto-a')).rejects.toThrow(/coração/)
  await env.DB.prepare("UPDATE channels SET capabilities_override=? WHERE id='ch-a'").bind(JSON.stringify({ stories: { mention: false } })).run()
  await expect(assertPublishable(env, 'a', 'auto-a')).rejects.toThrow(/story/)
})

it('salvar valida conexão, atraso, política e um só gatilho de menção ativo por conexão', async () => {
  await env.DB.prepare("UPDATE channels SET status='connected' WHERE id='ch-a'").run()
  await env.DB.prepare('DELETE FROM triggers WHERE id=?').bind('trg-a').run()
  const mention = await saveStoryTrigger(env.DB, 'a', 'auto-a', { type: 'ig_story_mention', name: 'Menção', connection_id: 'ch-a', node_id: 't', config: { delay_seconds: 600, heart: true } })
  expect(mention).toMatchObject({ type: 'ig_story_mention', state: 'initial', config: { delay_seconds: 600, heart: true }, repeat_mode: 'every_time' })
  await expect(saveStoryTrigger(env.DB, 'a', 'auto-a', { config: { delay_seconds: 90, heart: false } }, mention.id)).rejects.toThrow()
  await expect(saveStoryTrigger(env.DB, 'a', 'auto-a', { repeat_mode: 'once' }, mention.id)).rejects.toThrow()
  const active = await saveStoryTrigger(env.DB, 'a', 'auto-a', { state: 'active', repeat_mode: 'once_per_24_hours' }, mention.id)
  expect(active).toMatchObject({ active: true, repeat_mode: 'once_per_24_hours', config: { delay_seconds: 600 } })
  const second = await saveStoryTrigger(env.DB, 'a', 'auto-a', { type: 'ig_story_mention', name: 'Outra', connection_id: 'ch-a', node_id: 't' })
  await expect(saveStoryTrigger(env.DB, 'a', 'auto-a', { state: 'active' }, second.id)).rejects.toThrow(/ativo/)
  const storyReply = await saveStoryTrigger(env.DB, 'a', 'auto-a', { type: 'ig_story_reply', name: 'Story', connection_id: 'ch-a', node_id: 't', config: { target: 'specific', post_id: 'story-1', rule: 'contains', words: ['preço'] } })
  expect(storyReply).toMatchObject({ type: 'ig_story_reply', config: { target: 'specific', post_id: 'story-1', rule: 'contains', words: ['preço'] } })
  await expect(saveStoryTrigger(env.DB, 'a', 'auto-a', { type: 'ig_story_reply', name: 'Sem story', connection_id: 'ch-a', node_id: 't', config: { target: 'specific', rule: 'any', words: [] } })).rejects.toThrow()
  await expect(saveStoryTrigger(env.DB, 'a', 'auto-a', { type: 'ig_story_reply', name: 'Sem palavra', connection_id: 'ch-a', node_id: 't', config: { target: 'all', rule: 'is', words: [] } })).rejects.toThrow()
  await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id,status) VALUES ('ch-tg','a','telegram','bot-1','connected')").run()
  await expect(saveStoryTrigger(env.DB, 'a', 'auto-a', { type: 'ig_story_mention', name: 'Outro canal', connection_id: 'ch-tg', node_id: 't' })).rejects.toThrow(/não recebe/)
})

it('resposta a story com atraso e coração reage à resposta antes de esperar e responder; sem eles, nada de prelúdio', async () => {
  await asReply('all', null, { rule: 'any', words: [] })
  await setTrigger('delay_seconds=60,story_auto_like=1')
  await reply('reply-heart', 'Lindo!')
  await done().toBe(1)
  const react = sent.filter(s => s.body.sender_action === 'react')
  expect(react.map(r => r.body.payload)).toEqual([{ message_id: 'reply-heart', reaction: 'love' }])
  expect(sent.indexOf(react[0])).toBeLessThan(sent.indexOf(messages()[0]))
  expect(await env.DB.prepare("SELECT json_extract(story_context,'$.kind') AS k, json_extract(story_context,'$.delaySeconds') AS d FROM flow_runs WHERE trigger_id='trg-a'").first()).toEqual({ k: 'reply', d: 60 })
  await setTrigger('delay_seconds=0,story_auto_like=0')
  await reply('reply-plain', 'De novo')
  await done().toBe(2)
  expect(await env.DB.prepare("SELECT story_context FROM flow_runs WHERE inbound_event_id LIKE '%reply-plain%'").first('story_context')).toBeNull()
})
