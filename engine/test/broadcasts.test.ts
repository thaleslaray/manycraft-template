import { giveCredentials } from './credentials'
import { introspectWorkflow } from 'cloudflare:test'
import { env as runtime } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/env'
import type { Principal } from '../src/permissions'
import { recordWhatsappReceipt } from '../src/channels/whatsapp'
import { broadcastOptions, createBroadcastFromAutomation, cancelBroadcast, testBroadcast, consumeBroadcast, estimateBroadcastAudience, listAudienceContacts, getBroadcast, listBroadcasts, pauseBroadcast, deleteBroadcast, processBroadcastBatch, resumeBroadcast, saveBroadcast } from '../src/db/broadcasts'
import { seed } from './fixtures'
import migracaoFluxo from '../migrations/0115_transmissao_como_fluxo.sql?raw'

const owner: Principal = { userId: 'test-owner', workspaceId: 'a', role: 'owner' }
const other: Principal = { ...owner, workspaceId: 'b' }
let env: Env
let queue: ReturnType<typeof vi.fn>
const input = (overrides: Record<string, unknown> = {}) => ({ name: 'Campanha W12', content: 'Olá, transmissão!', status: 'sending', audience: { tag: 'all', channel: 'telegram', channel_id: 'tg-a' }, ...overrides })
async function recipient(n: number, opts: { channel?: 'telegram' | 'whatsapp'; optedIn?: number; window?: number | null; workspace?: string } = {}) {
  const ws = opts.workspace ?? 'a', channel = opts.channel ?? 'telegram', id = `${ws}-${channel}-${String(n).padStart(2, '0')}`
  await env.DB.batch([
    env.DB.prepare('INSERT INTO contacts(id,workspace_id,first_name) VALUES (?,?,?)').bind(`c-${id}`, ws, `Teste ${n}`),
    env.DB.prepare('INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in,window_expires_at,identity_kind) VALUES (?,?,?,?,?,?,?,?)')
      .bind(`cc-${id}`, ws, `c-${id}`, `${channel === 'telegram' ? 'tg' : 'wa'}-${ws}`, channel === 'telegram' ? String(1000 + n) : `BR.test${n}`, opts.optedIn ?? 1, opts.window ?? null, channel === 'whatsapp' ? 'bsuid' : 'provider_id'),
  ])
  return { contact: `c-${id}`, identity: `cc-${id}` }
}
async function tag(contact: string) { await env.DB.prepare("INSERT INTO contact_tags(workspace_id,contact_id,tag_id) VALUES ('a',?,'tag-a')").bind(contact).run() }
async function dbCount(table: string) { return env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n') }
async function create(overrides: Record<string, unknown> = {}) { return saveBroadcast(env, owner, input(overrides)) }
async function consume(id: string) {
  const message = { body: { kind: 'broadcast', workspaceId: 'a', broadcastId: id }, ack: vi.fn(), retry: vi.fn() }
  await consumeBroadcast(message as unknown as Message<unknown>, env)
  expect(message.ack).toHaveBeenCalledOnce()
  expect(message.retry).not.toHaveBeenCalled()
}

beforeEach(async () => {
  await seed()
  queue = vi.fn(async () => {})
  env = { ...runtime, APP_ENV: 'development', CHANNEL_LIMITER: undefined, INBOUND: { send: queue } as unknown as Queue }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('tg-a','a','telegram','test-tg-a')"),
    env.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('tg-b','b','telegram','test-tg-b')"),
    env.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('wa-a','a','whatsapp','123456789')"),
    env.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id,provider) VALUES ('uz-a','a','whatsapp','uazapi:r183e2ef','uazapi')"),
    env.DB.prepare("INSERT INTO message_templates(id,workspace_id,channel_id,group_id,language_code,name_human,status,body) VALUES ('template-a','a','wa-a','group-a','pt_BR','oferta_aprovada','approved','Olá {{1}}')"),
  ])
  // tg-b is left without credentials: a connection that was never configured.
  await giveCredentials(env, 'tg-a', { botToken: 'TESTONLY', webhookSecret: 'broadcast-secret-a' })
  await giveCredentials(env, 'uz-a', { serverUrl: 'https://loja.uazapi.com', token: 'UZ-TOKEN' })
  await giveCredentials(env, 'wa-a', { accessToken: 'TESTONLY', phoneNumberId: '123456789', appSecret: 'x' })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).startsWith('https://api.telegram.org/botTESTONLY/')) return Response.json({ ok: true, result: { message_id: 100 + vi.mocked(fetch).mock.calls.length } })
    expect(url).toBe('https://graph.facebook.com/v26.0/123456789/messages')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer TESTONLY' })
    return Response.json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.broadcast.${vi.mocked(fetch).mock.calls.length}` }] })
  })
})
afterEach(() => { vi.restoreAllMocks() })

describe('transmissões W12 com SQLite e adaptadores reais', () => {
  it('ticket32 rastreia botão de link sem autenticação e deduplica o CTR do contato', async () => {
    await recipient(1)
    const graph = { nodes: [{ id: 'offer', type: 'message', position: { x: 0, y: 0 }, config: { blocks: [
      { kind: 'text', text: 'Conheça a oficina' },
      { kind: 'button', id: 'site', label: 'Abrir site', action: { type: 'url', url: 'https://example.test/oficina' } },
    ] } }], edges: [] }
    await env.DB.prepare('UPDATE automations SET draft_graph=? WHERE id=?').bind(JSON.stringify(graph), 'auto-a').run()
    env = { ...env, PUBLIC_BASE_URL: 'https://engine.test', FLOW_RUN: { create: vi.fn(async () => ({})) } as unknown as NonNullable<Env['FLOW_RUN']> }
    const b = await createBroadcastFromAutomation(env, owner, { automation_id: 'auto-a', channel_id: 'tg-a' })
    await saveBroadcast(env, owner, { ...input(), id: b.id, content: b.content })
    await consume(b.id)
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    const link = body.reply_markup.inline_keyboard[0][0].url
    expect(link).toMatch(/^https:\/\/engine\.test\/api\/broadcast-public\/click\/[a-f0-9]{32}$/)
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ metrics: { clicked: 0, ctr: 0 } })
    const { default: app } = await import('../src/index')
    for (const attempt of [1, 2]) {
      const response = await app.fetch(new Request(link), env)
      expect(response.status, `clique ${attempt}`).toBe(302)
      expect(response.headers.get('location')).toBe('https://example.test/oficina')
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ metrics: { sent: 1, clicked: 1, ctr: 1 } })
    expect(fetch).toHaveBeenCalledOnce()
    expect((await app.fetch(new Request('https://engine.test/api/broadcast-public/click/' + '0'.repeat(32)), env)).status).toBe(404)
  })
  it('clique em botão de site não inscreve o contato nem abre a janela de conversa', async () => {
    const r = await recipient(1)
    const graph = { nodes: [{ id: 'offer', type: 'message', position: { x: 0, y: 0 }, config: { blocks: [
      { kind: 'text', text: 'Conheça a oficina' },
      { kind: 'button', id: 'site', label: 'Abrir site', action: { type: 'url', url: 'https://example.test/oficina' } },
    ] } }], edges: [] }
    await env.DB.prepare('UPDATE automations SET draft_graph=? WHERE id=?').bind(JSON.stringify(graph), 'auto-a').run()
    env = { ...env, PUBLIC_BASE_URL: 'https://engine.test', FLOW_RUN: { create: vi.fn(async () => ({})) } as unknown as NonNullable<Env['FLOW_RUN']> }
    const b = await createBroadcastFromAutomation(env, owner, { automation_id: 'auto-a', channel_id: 'tg-a' })
    await saveBroadcast(env, owner, { ...input(), id: b.id, content: b.content })
    await consume(b.id)
    const link = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).reply_markup.inline_keyboard[0][0].url
    // Quem só abriu o site ainda não é inscrito nem tem janela aberta.
    await env.DB.batch([
      env.DB.prepare("UPDATE contacts SET status='unsubscribed' WHERE id=?").bind(r.contact),
      env.DB.prepare('UPDATE contact_channels SET opted_in=0,window_expires_at=NULL,human_window_expires_at=NULL,last_inbound_at=NULL WHERE id=?').bind(r.identity),
    ])
    const snapshot = async () => ({
      contact: await env.DB.prepare('SELECT status,subscribed_at,last_interaction_at FROM contacts WHERE id=?').bind(r.contact).first(),
      channel: await env.DB.prepare('SELECT opted_in,window_expires_at,human_window_expires_at,last_inbound_at FROM contact_channels WHERE id=?').bind(r.identity).first(),
      messages: await dbCount('messages'), conversations: await dbCount('conversations'), runs: await dbCount('flow_runs'),
    })
    const before = await snapshot()
    expect(before.contact).toMatchObject({ status: 'unsubscribed' })
    expect(before.channel).toMatchObject({ opted_in: 0, window_expires_at: null })
    const { default: app } = await import('../src/index')
    expect((await app.fetch(new Request(link), env)).status).toBe(302)
    expect(await snapshot()).toEqual(before)
  })
  it('ticket32 estima elegíveis com o mesmo modelo aprovado fora da janela usado pelo envio', async () => {
    await recipient(1, { channel: 'whatsapp', window: 1 })
    await recipient(2, { channel: 'whatsapp', window: 1, optedIn: 0 })
    const audience = { tag: 'all', channel: 'whatsapp' as const, channel_id: 'wa-a' }
    expect(await estimateBroadcastAudience(env, owner, audience)).toEqual({ count: 2, eligible: 0 })
    expect(await estimateBroadcastAudience(env, owner, audience, { id: 'template-a', params: { '1': 'Ana' } })).toEqual({ count: 2, eligible: 1 })
    expect(await estimateBroadcastAudience(env, owner, audience, { id: 'template-a', params: {} })).toEqual({ count: 2, eligible: 1 })
  })
  it('ticket32 copia grafo independente, envia botão real e conta contato único no primeiro nó', async () => {
    const person = await recipient(1)
    const graph = { nodes: [
      { id: 'start', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
      { id: 'offer', type: 'message', position: { x: 200, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Oferta independente' }, { kind: 'button', id: 'yes', label: 'Quero conhecer', action: { type: 'go_to_node' } }] } },
      { id: 'details', type: 'message', position: { x: 400, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Detalhes da oferta' }] } },
    ], edges: [{ from: 'start', port: 'next', to: 'offer' }, { from: 'offer', port: 'btn:yes', to: 'details' }] }
    await env.DB.prepare('UPDATE automations SET draft_graph=? WHERE id=?').bind(JSON.stringify(graph), 'auto-a').run()
    const b = await createBroadcastFromAutomation(env, owner, { automation_id: 'auto-a', channel_id: 'tg-a' })
    expect(b).toMatchObject({ content: 'Oferta independente', graph, source_automation_id: 'auto-a' })
    await env.DB.prepare('UPDATE automations SET draft_graph=? WHERE id=?').bind('{"nodes":[],"edges":[]}', 'auto-a').run()
    expect((await getBroadcast(env, owner, b.id)).graph).toEqual(graph)
    const workflow = { create: vi.fn(async () => ({})), get: vi.fn(async () => ({ sendEvent: vi.fn() })) }
    env = { ...env, FLOW_RUN: workflow as unknown as NonNullable<Env['FLOW_RUN']> }
    await saveBroadcast(env, owner, { ...input(), id: b.id, content: b.content })
    await consume(b.id)
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(body.reply_markup.inline_keyboard[0][0]).toMatchObject({ text: 'Quero conhecer', callback_data: expect.stringMatching(/^b:[a-f0-9]{24}$/) })
    expect(workflow.create).toHaveBeenCalledOnce()
    const token = await env.DB.prepare('SELECT * FROM button_tokens').first<{ token: string; run_id: string }>()
    expect(token).toBeTruthy()
    const { dispatchInbound } = await import('../src/flow/dispatch')
    const payload = { update_id: 780, callback_query: { id: 'click-ticket32', from: { id: 1001, is_bot: false, first_name: 'Teste' }, data: `b:${token!.token}`, message: { message_id: 101, chat: { id: 1001, type: 'private' } } } }
    const event = { version: 1 as const, provider: 'telegram' as const, eventId: '780', workspaceId: 'a', channelId: 'tg-a', receivedAt: Date.now(), payload }
    await dispatchInbound(event, 'ticket32-click', env as import('../src/flow/types').FlowEnv)
    await dispatchInbound(event, 'ticket32-click-replay', env as import('../src/flow/types').FlowEnv)
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ metrics: { sent: 1, clicked: 1, ctr: 1 } })
    expect(await env.DB.prepare('SELECT contact_id FROM flow_runs WHERE id=?').bind(token!.run_id).first()).toEqual({ contact_id: person.contact })
  })
  it('ticket32 CTR divide por contatos únicos mesmo com duas identidades na conexão', async () => {
    const person = await recipient(1)
    await env.DB.prepare(`INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in)
      VALUES ('cc-alias','a',?,'tg-a','2001',1)`).bind(person.contact).run()
    const graph = { nodes: [
      { id: 'offer', type: 'message', position: { x: 0, y: 0 }, config: { blocks: [
        { kind: 'text', text: 'Convite para uma pessoa' },
        { kind: 'button', id: 'yes', label: 'Conhecer', action: { type: 'go_to_node' } },
      ] } },
    ], edges: [] }
    await env.DB.prepare('UPDATE automations SET draft_graph=? WHERE id=?').bind(JSON.stringify(graph),'auto-a').run()
    const b = await createBroadcastFromAutomation(env,owner,{automation_id:'auto-a',channel_id:'tg-a'})
    env = { ...env, FLOW_RUN: { create: vi.fn(async () => ({})), get: vi.fn(async () => ({sendEvent:vi.fn()})) } as unknown as NonNullable<Env['FLOW_RUN']> }
    await saveBroadcast(env,owner,{...input(),id:b.id,content:b.content})
    await consume(b.id)
    expect(fetch).toHaveBeenCalledTimes(2)
    const token = await env.DB.prepare(`SELECT t.token,cc.external_user_id FROM button_tokens t
      JOIN broadcast_recipients r ON r.run_id=t.run_id JOIN contact_channels cc ON cc.id=r.contact_channel_id LIMIT 1`)
      .first<{token:string;external_user_id:string}>()
    const { dispatchInbound } = await import('../src/flow/dispatch')
    await dispatchInbound({version:1,provider:'telegram',workspaceId:'a',channelId:'tg-a',eventId:'901',receivedAt:Date.now(),payload:{
      update_id:901,callback_query:{id:'unique-person',from:{id:Number(token!.external_user_id)},data:`b:${token!.token}`,
        message:{message_id:101,chat:{id:Number(token!.external_user_id),type:'private'}}},
    }},'unique-person-click',env as import('../src/flow/types').FlowEnv)
    expect(await getBroadcast(env,owner,b.id)).toMatchObject({metrics:{sent:2,clicked:1,ctr:1}})
  })
  it('ticket32 Workflow real retoma continuação da cópia sem duplicar o primeiro envio', async () => {
    await recipient(1)
    const source = { nodes: [
      { id: 'initial', type: 'message', position: { x: 0, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Primeira mensagem' }, { kind: 'button', id: 'continue', label: 'Ver detalhes', action: { type: 'go_to_node' } }] } },
      { id: 'next', type: 'message', position: { x: 300, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Continuação independente' }] } },
    ], edges: [{ from: 'initial', port: 'btn:continue', to: 'next' }] }
    await env.DB.prepare('UPDATE automations SET draft_graph=? WHERE id=?').bind(JSON.stringify(source),'auto-a').run()
    const b=await createBroadcastFromAutomation(env,owner,{automation_id:'auto-a',channel_id:'tg-a'})
    const inspect=await introspectWorkflow(runtime.FLOW_RUN)
    try {
      await inspect.modifyAll(async modifier=>{await modifier.disableSleeps();await modifier.disableRetryDelays()})
      await saveBroadcast(env,owner,{...input(),id:b.id,content:b.content})
      await consume(b.id)
      const instances=await inspect.get()
      expect(instances).toHaveLength(1)
      await instances[0].waitForStepResult({name:'waiting:0'})
      expect(fetch).toHaveBeenCalledOnce()
      const token=await env.DB.prepare('SELECT token FROM button_tokens WHERE node_id=?').bind('initial').first<{token:string}>()
      const {dispatchInbound}=await import('../src/flow/dispatch')
      await dispatchInbound({version:1,provider:'telegram',workspaceId:'a',channelId:'tg-a',eventId:'900',receivedAt:Date.now(),payload:{update_id:900,callback_query:{id:'full-workflow-click',from:{id:1001},data:`b:${token!.token}`,message:{message_id:101,chat:{id:1001,type:'private'}}}}},'full-workflow-click',env as import('../src/flow/types').FlowEnv)
      await instances[0].waitForStatus('complete')
      expect(vi.mocked(fetch).mock.calls.map(call=>JSON.parse(String(call[1]?.body)).text)).toEqual(['Primeira mensagem','Continuação independente'])
      expect(await getBroadcast(env,owner,b.id)).toMatchObject({metrics:{sent:1,clicked:1,ctr:1}})
    } finally { await inspect.dispose() }
  })
  it('relatório separa as métricas por mensagem da cópia, em ordem do fluxo, sem mudar o total nem o CTR', async () => {
    await recipient(5)
    const source = { nodes: [
      { id: 'initial', type: 'message', position: { x: 0, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Primeira mensagem' }, { kind: 'button', id: 'continue', label: 'Ver detalhes', action: { type: 'go_to_node' } }] } },
      { id: 'next', type: 'message', position: { x: 300, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Continuação independente' }, { kind: 'button', id: 'more', label: 'Quero mais', action: { type: 'go_to_node' } }] } },
      { id: 'last', type: 'message', position: { x: 600, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Última' }] } },
    ], edges: [{ from: 'initial', port: 'btn:continue', to: 'next' }, { from: 'next', port: 'btn:more', to: 'last' }] }
    await env.DB.prepare('UPDATE automations SET draft_graph=? WHERE id=?').bind(JSON.stringify(source),'auto-a').run()
    const b=await createBroadcastFromAutomation(env,owner,{automation_id:'auto-a',channel_id:'tg-a'})
    const inspect=await introspectWorkflow(runtime.FLOW_RUN)
    try {
      await inspect.modifyAll(async modifier=>{await modifier.disableSleeps();await modifier.disableRetryDelays()})
      await saveBroadcast(env,owner,{...input(),id:b.id,content:b.content})
      await consume(b.id)
      const [instance]=await inspect.get()
      await instance.waitForStepResult({name:'waiting:0'})
      const {dispatchInbound}=await import('../src/flow/dispatch')
      const click=async (node:string,n:number)=>{
        const token=await env.DB.prepare('SELECT token FROM button_tokens WHERE node_id=?').bind(node).first<{token:string}>()
        await dispatchInbound({version:1,provider:'telegram',workspaceId:'a',channelId:'tg-a',eventId:String(n),receivedAt:Date.now(),payload:{update_id:n,callback_query:{id:`click-${n}`,from:{id:1005},data:`b:${token!.token}`,message:{message_id:101,chat:{id:1005,type:'private'}}}}},`click-${n}`,env as import('../src/flow/types').FlowEnv)
      }
      await click('initial',901)
      await instance.waitForStepResult({name:'waiting:1'})
      const report=await getBroadcast(env,owner,b.id)
      expect(report.metrics).toMatchObject({sent:1,clicked:1,ctr:1})
      expect(report.metrics.messages).toEqual([
        {node_id:'initial',summary:'Primeira mensagem',sent:1,delivered:0,read:0,clicked:1},
        {node_id:'next',summary:'Continuação independente',sent:1,delivered:0,read:0,clicked:0},
        {node_id:'last',summary:'Última',sent:0,delivered:0,read:0,clicked:0},
      ])
    } finally { await inspect.dispose() }
  })
  it('entregas e leituras de mensagens seguintes vêm dos recibos do canal por contato único', async () => {
    await recipient(1)
    const source = { nodes: [
      { id: 'initial', type: 'message', position: { x: 0, y: 0 }, config: { blocks: [{ kind: 'text', text: 'A' }] } },
      { id: 'next', type: 'message', position: { x: 300, y: 0 }, config: { blocks: [{ kind: 'media', media: 'image', url: 'https://example.com/a.png' }] } },
    ], edges: [{ from: 'initial', port: 'next', to: 'next' }] }
    await env.DB.prepare('UPDATE automations SET draft_graph=? WHERE id=?').bind(JSON.stringify(source),'auto-a').run()
    const b=await createBroadcastFromAutomation(env,owner,{automation_id:'auto-a',channel_id:'tg-a'})
    env = { ...env, FLOW_RUN: { create: vi.fn(async () => ({})), get: vi.fn(async () => ({ sendEvent: vi.fn() })) } as unknown as NonNullable<Env['FLOW_RUN']> }
    await saveBroadcast(env,owner,{...input(),id:b.id,content:b.content})
    await consume(b.id)
    const row=await env.DB.prepare('SELECT run_id FROM broadcast_recipients WHERE broadcast_id=?').bind(b.id).first<{run_id:string}>()
    await env.DB.batch(['sent','delivered','read'].map(type=>env.DB.prepare("INSERT INTO node_events(workspace_id,automation_id,node_id,contact_id,flow_run_id,type) SELECT workspace_id,?,'next',contact_id,id,? FROM flow_runs WHERE id=?").bind(b.automation_id,type,row!.run_id)))
    const report=await getBroadcast(env,owner,b.id)
    expect(report.metrics.messages).toMatchObject([{node_id:'initial',sent:1},{node_id:'next',summary:'Imagem',sent:1,delivered:1,read:1,clicked:0}])
  })
  it('transmissão de mensagem única não ganha lista por mensagem', async () => {
    await recipient(1)
    const b=await create()
    await consume(b.id)
    expect((await getBroadcast(env,owner,b.id)).metrics.messages).toBeUndefined()
  })
  it('ticket32 retoma todas as partes do primeiro nó antes de contar o envio', async () => {
    await recipient(1)
    const graph = {nodes:[{id:'offer',type:'message',position:{x:0,y:0},config:{blocks:[
      {kind:'text',text:'Primeira parte'},{kind:'text',text:'Segunda parte'},
    ]}}],edges:[]}
    await env.DB.prepare('UPDATE automations SET draft_graph=? WHERE id=?').bind(JSON.stringify(graph),'auto-a').run()
    const b=await createBroadcastFromAutomation(env,owner,{automation_id:'auto-a',channel_id:'tg-a'})
    env={...env,FLOW_RUN:{create:vi.fn(async()=>({}))} as unknown as NonNullable<Env['FLOW_RUN']>}
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ok:true,result:{message_id:100}}))
      .mockResolvedValueOnce(Response.json({ok:false,error_code:429,parameters:{retry_after:30}}))
    await saveBroadcast(env,owner,{...input(),id:b.id,content:b.content})
    await consume(b.id)
    expect(await getBroadcast(env,owner,b.id)).toMatchObject({status:'paused',metrics:{sent:0,queued:1}})
    await env.DB.prepare('UPDATE broadcasts SET retry_at=1 WHERE id=?').bind(b.id).run()
    await resumeBroadcast(env,owner,b.id)
    await consume(b.id)
    expect(vi.mocked(fetch).mock.calls.map(call=>JSON.parse(String(call[1]?.body)).text))
      .toEqual(['Primeira parte','Segunda parte','Segunda parte'])
    expect(await getBroadcast(env,owner,b.id)).toMatchObject({status:'sent',metrics:{sent:1,queued:0}})
  })
  it('ticket32 teste escolhido preserva rascunho, público, métricas e não cria destinatários', async () => {
    const person = await recipient(1)
    const b = await create({ status: 'draft' })
    const before = await getBroadcast(env, owner, b.id)
    const result = await testBroadcast(env, owner, b.id, { contact_id: person.contact })
    // O resultado do envio volta na resposta e fica consultável na conversa, marcado como teste.
    expect(result).toMatchObject({ ok: true, test: true, parts: [{ status: 'sent', external_id: expect.any(String) }] })
    expect(fetch).toHaveBeenCalledOnce()
    const recorded = await env.DB.prepare('SELECT conversation_id,external_message_id,content FROM messages WHERE workspace_id=? AND id=?').bind('a', result.message_id)
      .first<{ conversation_id: string; external_message_id: string; content: string }>()
    expect(recorded?.conversation_id).toBe(result.conversation_id)
    expect(recorded?.external_message_id).toContain(result.parts[0].external_id)
    expect(JSON.parse(recorded!.content)).toMatchObject({ text: `[Teste da transmissão] ${b.content}`, status: 'sent', broadcast: { id: b.id, test: true } })
    expect(await getBroadcast(env, owner, b.id)).toEqual(before)
    expect(await dbCount('broadcast_recipients')).toBe(0)
    expect(queue).not.toHaveBeenCalled()
    await expect(testBroadcast(env, other, b.id, { contact_id: person.contact })).rejects.toMatchObject({ status: 404 })
  })
  it('excluir: rascunho e agendado somem com a cópia do fluxo; enviada e outro espaço são recusados', async () => {
    await recipient(1)
    const draft = await create({ status: 'draft', name: 'Rascunho a apagar' })
    await deleteBroadcast(env, owner, draft.id)
    await expect(getBroadcast(env, owner, draft.id)).rejects.toMatchObject({ status: 404 })
    const scheduled = await create({ status: 'scheduled', scheduled_at: new Date(Date.now() + 3_600_000).toISOString() })
    await pauseBroadcast(env, owner, scheduled.id)
    await deleteBroadcast(env, owner, scheduled.id)
    expect(await dbCount('broadcasts')).toBe(0)
    const sent = await create()
    await consume(sent.id)
    await expect(deleteBroadcast(env, owner, sent.id)).rejects.toMatchObject({ status: 409 })
    const mine = await create({ status: 'draft' })
    await expect(deleteBroadcast(env, other, mine.id)).rejects.toMatchObject({ status: 404 })
  })
  it('condições abertas no público voltam como foram salvas, mesmo no valor padrão', async () => {
    const b = await create({ status: 'draft', audience: { tag: 'all', channel: 'telegram', channel_id: 'tg-a', conditions: ['tag'] } })
    expect((await getBroadcast(env, owner, b.id)).audience).toMatchObject({ tag: 'all', conditions: ['tag'] })
  })
  it('relatório de destinatários traz o nome do contato e a transmissão agendada pausada não começou', async () => {
    const person = await recipient(1)
    const b = await create()
    await consume(b.id)
    const report = await getBroadcast(env, owner, b.id)
    expect(report.recipients).toEqual([expect.objectContaining({ contact_id: person.contact, name: 'Teste 1', status: 'sent' })])
    const later = await create({ status: 'scheduled', scheduled_at: new Date(Date.now() + 3_600_000).toISOString() })
    expect(await pauseBroadcast(env, owner, later.id)).toMatchObject({ status: 'paused', started: false })
  })
  it('ticket32 cancelar agendada impede fila atrasada e rejeita envio já iniciado', async () => {
    await recipient(1)
    const b = await create({ status: 'scheduled', scheduled_at: new Date(Date.now() + 60000).toISOString() })
    expect(await cancelBroadcast(env, owner, b.id)).toMatchObject({ status: 'cancelled' })
    await consume(b.id)
    expect(fetch).not.toHaveBeenCalled()
    const sending = await create()
    await consume(sending.id)
    await expect(cancelBroadcast(env, owner, sending.id)).rejects.toMatchObject({ status: 409 })
  })
  it('a conexão escolhida decide: WhatsApp não oficial não é oferecido nem aceito, o oficial segue normal', async () => {
    const offered = (await broadcastOptions(env, owner)).channels.map(row => (row as { id: string }).id)
    expect(offered).toEqual(expect.arrayContaining(['tg-a', 'wa-a']))
    expect(offered).not.toContain('uz-a')
    await expect(create({ audience: { tag: 'all', channel: 'whatsapp', channel_id: 'uz-a' } })).rejects.toMatchObject({ status: 409 })
    await expect(create({ status: 'draft', audience: { tag: 'all', channel: 'whatsapp', channel_id: 'uz-a' } })).rejects.toMatchObject({ status: 409 })
    expect(await create({ audience: { tag: 'all', channel: 'whatsapp', channel_id: 'wa-a' } })).toMatchObject({ audience: { channel_id: 'wa-a' } })
  })
  it('envio imediato enfileira, envia Telegram e persiste source=broadcast sem inventar receipts', async () => {
    const { identity } = await recipient(1), b = await create()
    expect(queue).toHaveBeenCalledWith({ kind: 'broadcast', workspaceId: 'a', broadcastId: b.id }, { delaySeconds: 0 })
    expect(fetch).not.toHaveBeenCalled()
    await consume(b.id)
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({ chat_id: '1001', text: 'Olá, transmissão!' })
    const message = await env.DB.prepare('SELECT source,content FROM messages').first<{ source: string; content: string }>()
    expect(message?.source).toBe('broadcast')
    expect(JSON.parse(message!.content)).toMatchObject({ status: 'sent', broadcast: { id: b.id, recipient: identity } })
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ status: 'sent', metrics: { total: 1, sent: 1, delivered: 0, read: 0, clicked: 0 } })
  })
  it('segmenta por etiqueta ao enviar, preserva fuso/data e não congela no agendamento', async () => {
    const removed = await recipient(1), added = await recipient(2)
    await tag(removed.contact)
    const future = new Date(Date.now() + 600000).toISOString()
    const b = await create({ status: 'scheduled', scheduled_at: future, scheduled_local: '2026-10-24T14:00', timezone: 'Europe/Lisbon', audience: { tag: 'tag-a', channel: 'telegram', channel_id: 'tg-a' } })
    expect(b).toMatchObject({ scheduled_at: future, scheduled_local: '2026-10-24T14:00', timezone: 'Europe/Lisbon' })
    expect(await dbCount('broadcast_recipients')).toBe(0)
    expect(await processBroadcastBatch(env, 'a', b.id)).toMatchObject({ delaySeconds: expect.any(Number) })
    expect(fetch).not.toHaveBeenCalled()
    await env.DB.prepare('DELETE FROM contact_tags WHERE contact_id=?').bind(removed.contact).run()
    await tag(added.contact)
    await env.DB.prepare('UPDATE broadcasts SET scheduled_at=1 WHERE id=?').bind(b.id).run()
    await consume(b.id)
    expect((await getBroadcast(env, owner, b.id)).recipients).toEqual([expect.objectContaining({ contact_channel_id: added.identity, status: 'sent' })])
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).chat_id).toBe('1002')
  })
  it('respeita consentimento e assinatura na hora do envio', async () => {
    await recipient(1, { optedIn: 0 })
    const unsubscribed = await recipient(2)
    await env.DB.prepare("UPDATE contacts SET status='unsubscribed' WHERE id=?").bind(unsubscribed.contact).run()
    const b = await create()
    await consume(b.id)
    expect(fetch).not.toHaveBeenCalled()
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ status: 'sent', metrics: { skipped: 2, sent: 0 } })
  })
  it('quem bloqueou a conta fica fora dos elegíveis da prévia e da lista de quem receberia', async () => {
    await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id,provider) VALUES ('ig-b','a','instagram','124','instagram_unified')").run()
    await giveCredentials(env, 'ig-b', { accessToken: 'TESTONLY', accountId: '124', appSecret: 'x', verifyToken: 'VERIFY-TEST' })
    for (const [n, blocked] of [[1, null], [2, Date.now() - 60_000]] as const) {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO contacts(id,workspace_id,first_name) VALUES (?,?,?)').bind(`c-bl${n}`, 'a', `Bloqueio ${n}`),
        env.DB.prepare("INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in,window_expires_at,blocked_at,identity_kind) VALUES (?,?,?,?,?,1,?,?,'provider_id')")
          .bind(`cc-bl${n}`, 'a', `c-bl${n}`, 'ig-b', `1784150000000${n}`, Date.now() + 3600_000, blocked),
      ])
    }
    const audience = { tag: 'all', channel: 'instagram' as const, channel_id: 'ig-b' }
    expect(await estimateBroadcastAudience(env, owner, audience)).toEqual({ count: 2, eligible: 1 })
    expect(await listAudienceContacts(env, owner, audience)).toMatchObject({ total: 1, contacts: [{ id: 'c-bl1' }] })
  })
  it('Instagram: entrega a quem está na janela de 24 h e pula os demais com motivo próprio, mesmo com janela humana de 7 dias', async () => {
    await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id,provider) VALUES ('ig-a','a','instagram','123','instagram_unified')").run()
    await giveCredentials(env, 'ig-a', { accessToken: 'TESTONLY', accountId: '123', appSecret: 'x', verifyToken: 'VERIFY-TEST' })
    const person = async (n: number, window: number | null, human: number | null) => {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO contacts(id,workspace_id,first_name) VALUES (?,?,?)').bind(`c-ig${n}`, 'a', `IG ${n}`),
        env.DB.prepare("INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in,window_expires_at,human_window_expires_at,last_inbound_at,identity_kind) VALUES (?,?,?,?,?,1,?,?,?,'provider_id')")
          .bind(`cc-ig${n}`, 'a', `c-ig${n}`, 'ig-a', `1784140000000${n}`, window, human, Date.now() - 3600_000),
      ])
    }
    await person(1, Date.now() + 3600_000, Date.now() + 6 * 86400_000)
    await person(2, Date.now() - 3600_000, Date.now() + 5 * 86400_000)
    await person(3, null, null)
    const audience = { tag: 'all', channel: 'instagram' as const, channel_id: 'ig-a' }
    expect(await estimateBroadcastAudience(env, owner, audience)).toEqual({ count: 3, eligible: 1 })
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      expect(String(url)).toContain('graph.facebook.com')
      const body = JSON.parse(String(init?.body))
      expect(body).not.toHaveProperty('tag')
      expect(body).not.toHaveProperty('messaging_type')
      return Response.json({ message_id: 'mid.ig.1', recipient_id: body.recipient.id })
    })
    const b = await create({ audience })
    await consume(b.id)
    expect(fetch).toHaveBeenCalledTimes(1)
    const done = await getBroadcast(env, owner, b.id)
    expect(done).toMatchObject({ status: 'sent', metrics: { sent: 1, skipped: 2, outside_window: 2 } })
    expect(done.recipients.filter(r => r.status === 'skipped').map(r => r.reason)).toEqual(['outside_window', 'outside_window'])
  })
  it('texto WhatsApp fora da janela é pulado mesmo com janela humana estendida', async () => {
    const r = await recipient(1, { channel: 'whatsapp', window: 1 })
    await env.DB.prepare('UPDATE contact_channels SET human_window_expires_at=? WHERE id=?').bind(Date.now() + 86400000, r.identity).run()
    const b = await create({ audience: { tag: 'all', channel: 'whatsapp', channel_id: 'wa-a' } })
    await consume(b.id)
    expect(fetch).not.toHaveBeenCalled()
    expect((await getBroadcast(env, owner, b.id)).recipients).toEqual([expect.objectContaining({ status: 'skipped', reason: 'outside_window' })])
  })
  it('prévia do público: lista paginada coerente com a contagem e isolada por espaço', async () => {
    for (const n of [1, 2, 3]) await recipient(n)
    await recipient(4, { optedIn: 0 })
    await recipient(1, { workspace: 'b' })
    await env.DB.prepare("UPDATE contacts SET last_name='Silva',profile_pic_url='https://x.test/1.png' WHERE id='c-a-telegram-01'").run()
    const audience = { tag: 'all', channel: 'telegram' as const, channel_id: 'tg-a' }
    const { eligible } = await estimateBroadcastAudience(env, owner, audience)
    const first = await listAudienceContacts(env, owner, audience, undefined, 'automatic', 1, 2)
    const second = await listAudienceContacts(env, owner, audience, undefined, 'automatic', 2, 2)
    expect(first).toMatchObject({ total: eligible, page: 1, limit: 2 })
    expect(first.contacts).toHaveLength(2)
    expect(first.contacts[0]).toEqual({ id: 'c-a-telegram-01', name: 'Teste 1 Silva', photo: 'https://x.test/1.png' })
    expect(first.contacts[1]).toMatchObject({ photo: null })
    expect(first.contacts.length + second.contacts.length).toBe(eligible)
    expect(new Set([...first.contacts, ...second.contacts].map(c => c.id)).size).toBe(eligible)
    expect(JSON.stringify([first, second])).not.toContain('c-b-')
    await expect(listAudienceContacts(env, other, audience)).rejects.toMatchObject({ status: 404 })
  })
  it('prévia do público: contato com duas linhas no mesmo canal conta uma vez, igual à lista', async () => {
    const pessoa = await recipient(1)
    await recipient(2)
    await env.DB.prepare('INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in,identity_kind) VALUES (?,?,?,?,?,?,?)')
      .bind('cc-segunda-linha', 'a', pessoa.contact, 'tg-a', '2999', 1, 'provider_id').run()
    const audience = { tag: 'all', channel: 'telegram' as const, channel_id: 'tg-a' }
    expect(await estimateBroadcastAudience(env, owner, audience)).toEqual({ count: 2, eligible: 2 })
    expect(await listAudienceContacts(env, owner, audience)).toMatchObject({ total: 2 })
  })
  it('tipo da transmissão: dentro da janela conta e envia só quem está com a janela aberta', async () => {
    await recipient(1, { channel: 'whatsapp', window: Date.now() + 3600000 })
    await recipient(2, { channel: 'whatsapp', window: 1 })
    const audience = { tag: 'all', channel: 'whatsapp' as const, channel_id: 'wa-a' }
    expect(await estimateBroadcastAudience(env, owner, audience, undefined, 'in_window')).toEqual({ count: 2, eligible: 1 })
    const b = await create({ window_kind: 'in_window', audience })
    expect(b).toMatchObject({ window_kind: 'in_window' })
    await consume(b.id)
    expect(fetch).toHaveBeenCalledOnce()
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ window_kind: 'in_window', metrics: { sent: 1, skipped: 1 } })
  })
  it('tipo da transmissão: promocional exige modelo aprovado e alcança quem está fora da janela', async () => {
    await recipient(1, { channel: 'whatsapp', window: Date.now() + 3600000 })
    await recipient(2, { channel: 'whatsapp', window: 1 })
    const audience = { tag: 'all', channel: 'whatsapp' as const, channel_id: 'wa-a' }
    const template = { id: 'template-a', params: { '1': 'Ana' } }
    expect(await estimateBroadcastAudience(env, owner, audience, undefined, 'promotional')).toEqual({ count: 2, eligible: 0 })
    expect(await estimateBroadcastAudience(env, owner, audience, template, 'promotional')).toEqual({ count: 2, eligible: 2 })
    await expect(create({ window_kind: 'promotional', audience })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('modelo aprovado') })
    const b = await create({ window_kind: 'promotional', content: '', audience, template })
    await consume(b.id)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ window_kind: 'promotional', metrics: { sent: 2 } })
  })
  it('tipo da transmissão: dentro da janela recusa modelo, canal sem janela recusa o tipo e o antigo segue automático', async () => {
    const audience = { tag: 'all', channel: 'whatsapp' as const, channel_id: 'wa-a' }
    await expect(create({ window_kind: 'in_window', audience, template: { id: 'template-a', params: { '1': 'Ana' } } })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('texto livre') })
    await expect(create({ window_kind: 'in_window' })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('janela') })
    expect(await create({ status: 'draft' })).toMatchObject({ window_kind: 'automatic' })
  })
  it('tipo da transmissão: o motor pausa se o tipo gravado não combina com o conteúdo', async () => {
    await recipient(1, { channel: 'whatsapp', window: Date.now() + 3600000 })
    const b = await create({ audience: { tag: 'all', channel: 'whatsapp', channel_id: 'wa-a' } })
    await env.DB.prepare("UPDATE broadcasts SET window_kind='promotional' WHERE id=?").bind(b.id).run()
    await consume(b.id)
    expect(fetch).not.toHaveBeenCalled()
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ status: 'paused', pause_reason: 'channel_or_template_unavailable' })
  })
  it('template aprovado envia fora da janela sem contornar consentimento', async () => {
    await recipient(1, { channel: 'whatsapp', window: 1 })
    await recipient(2, { channel: 'whatsapp', optedIn: 0, window: 1 })
    const b = await create({ content: '', audience: { tag: 'all', channel: 'whatsapp', channel_id: 'wa-a' }, template: { id: 'template-a', params: { '1': 'Ana' } } })
    await consume(b.id)
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toMatchObject({ recipient: 'BR.test1', type: 'template', template: { name: 'oferta_aprovada', language: { code: 'pt_BR' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ana' }] }] } })
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ metrics: { sent: 1, skipped: 1 } })
    await env.DB.prepare("UPDATE message_templates SET status='pending' WHERE id='template-a'").run()
    await expect(create({ audience: { tag: 'all', channel: 'whatsapp', channel_id: 'wa-a' }, template: { id: 'template-a', params: { '1': 'Ana' } } })).rejects.toMatchObject({ status: 409 })
  })
  it('transmissão aceita modelo com cabeçalho de mídia e botões de resposta e de link, enviando os componentes', async () => {
    await env.DB.prepare(`INSERT INTO message_templates(id,workspace_id,channel_id,group_id,language_code,name_human,status,header_type,header_media_url,header_example,body,buttons)
      VALUES ('template-rico','a','wa-a','group-rico','pt_BR','oferta_rica','approved','image','https://exemplo.test/capa.png','https://exemplo.test/capa.png','Olá {{1}}',?)`)
      .bind(JSON.stringify([{ type: 'reply', text: 'Quero' }, { type: 'url', text: 'Ver', url: 'https://exemplo.test/p/{{1}}', example: 'https://exemplo.test/p/1' }])).run()
    await recipient(1, { channel: 'whatsapp', window: 1 })
    const template = { id: 'template-rico', params: { '1': 'Ana', 'button:1:1': 'abc' } }
    expect(await estimateBroadcastAudience(env, owner, { tag: 'all', channel: 'whatsapp', channel_id: 'wa-a' }, template)).toEqual({ count: 1, eligible: 1 })
    expect((await broadcastOptions(env, owner)).templates).toContainEqual(expect.objectContaining({ id: 'template-rico', header_type: 'image' }))
    const b = await create({ content: '', audience: { tag: 'all', channel: 'whatsapp', channel_id: 'wa-a' }, template })
    await consume(b.id)
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toMatchObject({ type: 'template', template: { name: 'oferta_rica', components: [
      { type: 'header', parameters: [{ type: 'image', image: { link: 'https://exemplo.test/capa.png' } }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Ana' }] },
      { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'abc' }] }] } })
    await expect(create({ audience: { tag: 'all', channel: 'whatsapp', channel_id: 'wa-a' }, template: { id: 'template-rico', params: { '1': 'Ana' } } })).rejects.toMatchObject({ status: 400 })
  })
  it('modelo marcado como indisponível é recusado na transmissão com o motivo e some das opções', async () => {
    await env.DB.prepare("UPDATE message_templates SET unavailable_reason='Botão Copiar código ainda não é suportado no envio.' WHERE id='template-a'").run()
    await expect(create({ audience: { tag: 'all', channel: 'whatsapp', channel_id: 'wa-a' }, template: { id: 'template-a', params: { '1': 'Ana' } } }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('Copiar código') })
    expect((await broadcastOptions(env, owner)).templates).toEqual([])
  })
  it('primeiro rate limit pausa antes do próximo e só retoma após cooldown', async () => {
    const first = await recipient(1), second = await recipient(2)
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: false, error_code: 429, parameters: { retry_after: 30 } }))
    const b = await create()
    await consume(b.id)
    expect(fetch).toHaveBeenCalledOnce()
    const paused = await getBroadcast(env, owner, b.id)
    expect(paused).toMatchObject({ status: 'paused', pause_reason: 'rate_limited', metrics: { sent: 0, queued: 2 } })
    expect(paused.recipients).toEqual([expect.objectContaining({ contact_channel_id: first.identity, status: 'queued', reason: 'rate_limited' }), expect.objectContaining({ contact_channel_id: second.identity, status: 'queued', reason: null })])
    expect(await dbCount('flow_runs')).toBe(1)
    await expect(resumeBroadcast(env, owner, b.id)).rejects.toMatchObject({ status: 409 })
    await consume(b.id)
    expect(fetch).toHaveBeenCalledOnce()
    await env.DB.prepare('UPDATE broadcasts SET retry_at=1 WHERE id=?').bind(b.id).run()
    expect(await resumeBroadcast(env, owner, b.id)).toMatchObject({ status: 'sending', retry_at: null })
    await consume(b.id)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ status: 'sent', metrics: { sent: 2 } })
  })
  it('limita lotes a cinco e replay da fila não duplica mensagem confirmada', async () => {
    for (let i = 1; i <= 7; i++) await recipient(i)
    const b = await create()
    await consume(b.id)
    expect(fetch).toHaveBeenCalledTimes(5)
    expect(queue).toHaveBeenLastCalledWith({ kind: 'broadcast', workspaceId: 'a', broadcastId: b.id }, { delaySeconds: 1 })
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ status: 'sending', metrics: { sent: 5, queued: 2 } })
    await env.DB.prepare("UPDATE broadcast_recipients SET status='sending' WHERE broadcast_id=? AND contact_channel_id='cc-a-telegram-01'").bind(b.id).run()
    // Crash after durable confirmation but before the inbox/recipient projection: recover without sending again,
    // even if the contact withdrew consent in the meantime.
    await env.DB.prepare("DELETE FROM messages WHERE json_extract(content,'$.broadcast.recipient')='cc-a-telegram-01'").run()
    await env.DB.prepare("UPDATE contact_channels SET opted_in=0 WHERE id='cc-a-telegram-01'").run()
    await consume(b.id)
    expect(fetch).toHaveBeenCalledTimes(7)
    await consume(b.id)
    expect(fetch).toHaveBeenCalledTimes(7)
    expect(await dbCount('messages')).toBe(7)
    expect(await dbCount('flow_outbound')).toBe(7)
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ status: 'sent', metrics: { total: 7, sent: 7, queued: 0 } })
  })
  it('pausa manual impede consumo até retomada', async () => {
    await recipient(1)
    const b = await create()
    expect(await pauseBroadcast(env, owner, b.id)).toMatchObject({ status: 'paused', pause_reason: 'manual' })
    await consume(b.id)
    expect(fetch).not.toHaveBeenCalled()
    await resumeBroadcast(env, owner, b.id)
    await consume(b.id)
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('isola workspace e bloqueia escrita de viewer e agente', async () => {
    await recipient(1)
    await recipient(2, { workspace: 'b' })
    const b = await create({ status: 'draft' })
    expect(await listBroadcasts(env, other)).toEqual([])
    for (const action of [() => getBroadcast(env, other, b.id), () => pauseBroadcast(env, other, b.id), () => resumeBroadcast(env, other, b.id), () => saveBroadcast(env, other, input({ id: b.id, status: 'draft', audience: { tag: 'all', channel: 'telegram', channel_id: 'tg-b' } }))]) await expect(action()).rejects.toMatchObject({ status: 404 })
    expect(await processBroadcastBatch(env, 'b', b.id)).toEqual({})
    for (const role of ['viewer', 'livechat_agent'] as const) {
      const principal = { ...owner, role }
      for (const action of [() => saveBroadcast(env, principal, input()), () => pauseBroadcast(env, principal, b.id), () => resumeBroadcast(env, principal, b.id)]) await expect(action()).rejects.toMatchObject({ status: 403 })
    }
    expect(await listBroadcasts(env, { ...owner, role: 'viewer' })).toHaveLength(1)
    await expect(listBroadcasts(env, { ...owner, role: 'livechat_agent' })).rejects.toMatchObject({ status: 403 })
    expect(await estimateBroadcastAudience(env, owner, { tag: 'all', channel: 'telegram', channel_id: 'tg-a' })).toEqual({ count: 1, eligible: 1 })
    await expect(estimateBroadcastAudience(env, owner, { tag: 'all', channel: 'telegram', channel_id: 'tg-b' })).rejects.toMatchObject({ status: 404 })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('receipt WhatsApp real em JSON mantém correlação e read implica entregue', async () => {
    await recipient(1, { channel: 'whatsapp', window: Date.now() + 60000 })
    const b = await create({ audience: { tag: 'all', channel: 'whatsapp', channel_id: 'wa-a' } })
    await consume(b.id)
    await recordWhatsappReceipt({ version: 1, provider: 'meta', eventId: 'test-read', workspaceId: 'a', channelId: 'wa-a', receivedAt: Date.now(), payload: {} }, { kind: 'receipt', externalMessageId: 'wamid.broadcast.1', status: 'read', occurredAt: Date.now() }, env)
    const m = await env.DB.prepare("SELECT source,content FROM messages WHERE source='broadcast'").first<{ source: string; content: string }>()
    expect(JSON.parse(m!.content)).toMatchObject({ whatsappStatus: 'read', broadcast: { id: b.id } })
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ metrics: { sent: 1, delivered: 1, read: 1 } })
  })
  it('rede incerta permanece uncertain; replay não reenvia nem duplica falhas', async () => {
    await recipient(1)
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Timeout TESTONLY'))
    const b = await create()
    await consume(b.id)
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ status: 'sent', metrics: { total: 1, sent: 0, uncertain: 1, failed: 0, delivered: 0, read: 0 } })
    expect(await env.DB.prepare('SELECT status FROM flow_outbound').first()).toMatchObject({ status: 'uncertain' })
    expect(JSON.parse((await env.DB.prepare('SELECT content FROM messages').first<{content: string}>())!.content)).toMatchObject({ status: 'failed', broadcast: { id: b.id } })
    await consume(b.id)
    expect(fetch).toHaveBeenCalledOnce()
    expect(await dbCount('messages')).toBe(1)
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ metrics: { uncertain: 1, failed: 0 } })
  })
  it('Telegram403 conta uma única falha local; replay não reenvia', async () => {
    await recipient(1)
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: false, error_code: 403 }))
    const b = await create()
    await consume(b.id)
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ status: 'sent', metrics: { sent: 0, failed: 1, uncertain: 0, delivered: 0, read: 0 }, recipients: [expect.objectContaining({ status: 'failed', reason: 'blocked' })] })
    await consume(b.id)
    expect(fetch).toHaveBeenCalledOnce()
    expect(await dbCount('messages')).toBe(1)
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ metrics: { failed: 1 } })
  })
  it('público por segmento sem tag (tag vira all) e Telegram "chat not found" marca o destinatário como falha', async () => {
    const { contact } = await recipient(1)
    await recipient(2)
    await tag(contact)
    await env.DB.prepare("INSERT INTO segments(id,workspace_id,name,filter) VALUES ('seg-tg','a','Quentes',?)").bind(JSON.stringify({ match: 'all', rules: [{ type: 'tag', tag_id: 'tag-a', operator: 'has' }] })).run()
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, { status: 400 }))
    const b = await create({ audience: { channel: 'telegram', channel_id: 'tg-a', segment_id: 'seg-tg', conditions: ['segment'] } })
    await consume(b.id)
    const done = await getBroadcast(env, owner, b.id)
    expect(done).toMatchObject({ status: 'sent', metrics: { total: 1, queued: 0, failed: 1 } })
    expect(done.recipients).toEqual([expect.objectContaining({ status: 'failed' })])
  })
  it('modelo desativado depois de agendar pausa antes da rede', async () => {
    await recipient(1, { channel: 'whatsapp', window: 1 })
    const b = await create({ status: 'scheduled', scheduled_at: new Date(Date.now() + 60000).toISOString(), content: '', audience: { tag: 'all', channel: 'whatsapp', channel_id: 'wa-a' }, template: { id: 'template-a', params: { '1': 'Ana' } } })
    await env.DB.prepare("UPDATE message_templates SET status='disabled' WHERE id='template-a'").run()
    await env.DB.prepare('UPDATE broadcasts SET scheduled_at=1 WHERE id=?').bind(b.id).run()
    await consume(b.id)
    expect(fetch).not.toHaveBeenCalled()
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ status: 'paused', pause_reason: 'channel_or_template_unavailable', metrics: { total: 0, sent: 0 } })
    await expect(resumeBroadcast(env, owner, b.id)).rejects.toMatchObject({ status: 409 })
    expect(queue).toHaveBeenCalledTimes(1)
  })
  // Ficha wa-03: cada erro da Meta tem um tratamento (pausar a transmissão, pular só o contato, seguir).
  it.each([
    ['131050', 'skipped'], ['131049', 'skipped'], ['131026', 'failed'], ['131065', 'failed'], ['131070', 'failed'],
  ])('Meta%s recusa um contato: ele é pulado (%s) com o código e a transmissão segue', async (code, status) => {
    await recipient(1, { channel: 'whatsapp', window: 1 })
    await recipient(2, { channel: 'whatsapp', window: 1 })
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { code: Number(code) } }, { status: 400 }))
    const b = await create({ content: '', audience: { tag: 'all', channel: 'whatsapp', channel_id: 'wa-a' }, template: { id: 'template-a', params: { '1': 'Ana' } } })
    await consume(b.id)
    const done = await getBroadcast(env, owner, b.id)
    expect(done).toMatchObject({ status: 'sent', pause_reason: null })
    expect(done.recipients).toEqual([expect.objectContaining({ status, reason: code }), expect.objectContaining({ status: 'sent', reason: null })])
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  // 131063: o adaptador tenta uma vez por /marketing_messages (route-template-messages, passo 5); pausa só se essa também recusar.
  it.each([['131063', 2], ['131064', 1]] as const)('Meta%s pausa a transmissão inteira e devolve o contato à fila', async (code, calls) => {
    await recipient(1, { channel: 'whatsapp', window: 1 })
    await recipient(2, { channel: 'whatsapp', window: 1 })
    for (let i = 0; i < calls; i++) vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { code: Number(code) } }, { status: 400 }))
    const b = await create({ content: '', audience: { tag: 'all', channel: 'whatsapp', channel_id: 'wa-a' }, template: { id: 'template-a', params: { '1': 'Ana' } } })
    await consume(b.id)
    expect(fetch).toHaveBeenCalledTimes(calls)
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ status: 'paused', pause_reason: code, metrics: { queued: 2, failed: 0 } })
  })
  it('Meta131047 fora da janela falha só aquele contato, com o código, e a transmissão segue', async () => {
    await recipient(1, { channel: 'whatsapp', window: 1 })
    await recipient(2, { channel: 'whatsapp', window: 1 })
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { code: 131047 } }, { status: 400 }))
    const b = await create({ content: '', audience: { tag: 'all', channel: 'whatsapp', channel_id: 'wa-a' }, template: { id: 'template-a', params: { '1': 'Ana' } } })
    await consume(b.id)
    const done = await getBroadcast(env, owner, b.id)
    expect(done).toMatchObject({ status: 'sent', pause_reason: null })
    expect(done.recipients).toEqual([expect.objectContaining({ status: 'failed', reason: '131047' }), expect.objectContaining({ status: 'sent' })])
  })
  it('recibo failed da Meta depois do envio aparece no histórico do contato com o código', async () => {
    await recipient(1, { channel: 'whatsapp', window: 1 })
    const b = await create({ content: '', audience: { tag: 'all', channel: 'whatsapp', channel_id: 'wa-a' }, template: { id: 'template-a', params: { '1': 'Ana' } } })
    await consume(b.id)
    expect((await getBroadcast(env, owner, b.id)).recipients).toEqual([expect.objectContaining({ status: 'sent', reason: null })])
    await recordWhatsappReceipt({ version: 1, provider: 'meta', workspaceId: 'a', channelId: 'wa-a', eventId: 'f', receivedAt: Date.now(), payload: {} },
      { kind: 'receipt', externalMessageId: 'wamid.broadcast.1', status: 'failed', errors: [{ code: '131050', title: 'opt out' }] }, env as never)
    const after = await getBroadcast(env, owner, b.id)
    expect(after.recipients).toEqual([expect.objectContaining({ status: 'failed', reason: '131050' })])
    expect(after.metrics.failed).toBe(1)
  })
  it('a ficha efetiva da conexão decide se há template: sem templates na ficha, o modelo é recusado', async () => {
    const template = { id: 'template-a', params: { '1': 'Ana' } }
    await expect(create({ status: 'draft', audience: { tag: 'all', channel: 'whatsapp', channel_id: 'wa-a' }, template })).resolves.toMatchObject({ status: 'draft' })
    await env.DB.prepare(`UPDATE channels SET capabilities_override='{"remove":["templates"]}' WHERE id='wa-a'`).run()
    await expect(create({ status: 'draft', audience: { tag: 'all', channel: 'whatsapp', channel_id: 'wa-a' }, template })).rejects.toMatchObject({ status: 409 })
  })
  it('sem templates na ficha, quem está fora da janela é pulado mesmo com texto livre; com templates, só o modelo passa', async () => {
    await recipient(1, { channel: 'whatsapp', window: 1 })
    await env.DB.prepare(`UPDATE channels SET capabilities_override='{"remove":["templates"]}' WHERE id='wa-a'`).run()
    const b = await create({ audience: { tag: 'all', channel: 'whatsapp', channel_id: 'wa-a' } })
    await consume(b.id)
    expect(fetch).not.toHaveBeenCalled()
    expect((await getBroadcast(env, owner, b.id)).recipients).toEqual([expect.objectContaining({ status: 'skipped', reason: 'outside_window' })])
  })
  it('as métricas de entrega leem o estado de entrega da mensagem, não uma chave de canal', async () => {
    await recipient(1, { channel: 'whatsapp', window: Date.now() + 60000 })
    const b = await create({ audience: { tag: 'all', channel: 'whatsapp', channel_id: 'wa-a' } })
    await consume(b.id)
    await env.DB.prepare("UPDATE messages SET delivery_status='read' WHERE source='broadcast'").run()
    expect(await getBroadcast(env, owner, b.id)).toMatchObject({ metrics: { sent: 1, delivered: 1, read: 1 } })
  })
  it('a checagem da ficha não decifra credenciais: credencial ilegível ainda dá a recusa 409 do modelo', async () => {
    await env.DB.prepare(`UPDATE channels SET capabilities_override='{"remove":["templates"]}', credentials_ciphertext='corrompido' WHERE id='wa-a'`).run()
    await expect(create({ status: 'draft', audience: { tag: 'all', channel: 'whatsapp', channel_id: 'wa-a' }, template: { id: 'template-a', params: { '1': 'Ana' } } }))
      .rejects.toMatchObject({ status: 409 })
  })
})

it('transmissão personaliza por destinatário com campo, zero, false, reserva e marcador antigo', async () => {
  const one = await recipient(1), two = await recipient(2)
  await env.DB.batch([
    env.DB.prepare("UPDATE contacts SET first_name='Marina' WHERE id=?").bind(one.contact),
    env.DB.prepare("UPDATE contacts SET first_name='',last_name='  ' WHERE id=?").bind(two.contact),
    env.DB.prepare("INSERT INTO custom_fields(id,workspace_id,name,type) VALUES ('zero','a','Pontos','number')"),
    env.DB.prepare("INSERT INTO custom_fields(id,workspace_id,name,type) VALUES ('false','a','Aceita','boolean')"),
    env.DB.prepare("INSERT INTO contact_field_values(workspace_id,contact_id,field_id,value) VALUES ('a',?,'field-a','\"Curso\"')").bind(one.contact),
    env.DB.prepare("INSERT INTO contact_field_values(workspace_id,contact_id,field_id,value) VALUES ('a',?,'zero','0')").bind(one.contact),
    env.DB.prepare("INSERT INTO contact_field_values(workspace_id,contact_id,field_id,value) VALUES ('a',?,'false','false')").bind(one.contact),
  ])
  const b = await create({ content: 'Oi {primeiro_nome}/{{primeiro_nome|cliente}} {{sobrenome|amigo}}: {{campo:field-a|sem%20interesse}} {{campo:zero|vazio}} {{campo:false|vazio}}' })
  await consume(b.id)
  const sent = vi.mocked(fetch).mock.calls.map(call => JSON.parse(String(call[1]?.body)))
  expect(sent).toEqual([
    { chat_id: '1001', text: 'Oi Marina/Marina amigo: Curso 0 false' },
    { chat_id: '1002', text: 'Oi /cliente amigo: sem interesse vazio vazio' },
  ])
  const report = await env.DB.prepare("SELECT content FROM messages WHERE source='broadcast' ORDER BY created_at,id").all<{ content: string }>()
  expect(report.results.map(row => JSON.parse(row.content).text).sort()).toEqual(sent.map(row => row.text).sort())
  await expect(create({ content: '{{campo:field-b|reserva}}' })).rejects.toThrow(/Variável.*inexistente/)
})

it('recupera histórico com o conteúdo entregue mesmo após alteração e exclusão de campos', async () => {
  const one = await recipient(1)
  await env.DB.prepare("INSERT INTO contact_field_values(workspace_id,contact_id,field_id,value) VALUES ('a',?,'field-a','\"Curso\"')").bind(one.contact).run()
  const b = await create({ content: 'Oi {{primeiro_nome|cliente}}: {{campo:field-a|vazio}}' })
  await consume(b.id)
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).text).toBe('Oi Teste 1: Curso')
  // Simulate confirmed transport + missing history, then a mutable profile change before queue recovery.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM messages'),
    env.DB.prepare("UPDATE contacts SET first_name='Ana' WHERE id=?").bind(one.contact),
    env.DB.prepare("DELETE FROM custom_fields WHERE id='field-a'"),
    env.DB.prepare("UPDATE broadcast_recipients SET status='sending' WHERE broadcast_id=?").bind(b.id),
    env.DB.prepare("UPDATE broadcasts SET status='sending' WHERE id=?").bind(b.id),
  ])
  await consume(b.id)
  expect(fetch).toHaveBeenCalledOnce()
  const row = await env.DB.prepare("SELECT content FROM messages WHERE source='broadcast'").first<{ content: string }>()
  expect(JSON.parse(row!.content).text).toBe('Oi Teste 1: Curso')
})

it('transmissão em envio sem progresso há mais de 10 minutos avisa em que porcentagem parou', async () => {
  await recipient(1); await recipient(2)
  const b = await saveBroadcast(env, owner, input())
  await env.DB.prepare("UPDATE broadcasts SET status='sending' WHERE id=?").bind(b.id).run()
  const channels = await env.DB.prepare("SELECT id FROM contact_channels WHERE channel_id='tg-a' ORDER BY id LIMIT 2").all<{ id: string }>()
  const old = Date.now() - 20 * 60_000
  await env.DB.batch(channels.results.map((cc, i) => env.DB.prepare('INSERT INTO broadcast_recipients(workspace_id,broadcast_id,contact_channel_id,run_id,status,updated_at) VALUES (?,?,?,?,?,?)')
    .bind('a', b.id, cc.id, `run-stall-${i}`, i === 0 ? 'sent' : 'queued', old)))
  expect(await getBroadcast(env, owner, b.id)).toMatchObject({ stalled: { percent: 50 } })
  await env.DB.prepare("UPDATE broadcast_recipients SET updated_at=? WHERE broadcast_id=?").bind(Date.now(), b.id).run()
  expect(await getBroadcast(env, owner, b.id)).toMatchObject({ stalled: null })
})

describe('ticket 07: conteúdo da transmissão como fluxo', () => {
  const passo = (flow: string) => JSON.parse(flow).nodes[0]
  it('guarda o conteúdo como fluxo de um passo e o envio sai do fluxo', async () => {
    await recipient(1)
    const saved = await create({ status: 'draft' })
    const row = await env.DB.prepare('SELECT flow FROM broadcasts WHERE id=?').bind(saved.id).first<{ flow: string }>()
    expect(passo(row!.flow)).toMatchObject({ id: 'broadcast-message', type: 'message', config: { blocks: [{ kind: 'text', text: 'Olá, transmissão!' }] } })
    expect((saved as any).flow.nodes).toHaveLength(1)
    // O fluxo é a fonte: trocar o texto só nele muda o que sai.
    const novo = JSON.parse(row!.flow); novo.nodes[0].config.blocks[0].text = 'Texto vindo do fluxo'
    await env.DB.prepare('UPDATE broadcasts SET flow=? WHERE id=?').bind(JSON.stringify(novo), saved.id).run()
    expect((await getBroadcast(env, owner, saved.id)).content).toBe('Texto vindo do fluxo')
    await testBroadcast(env, owner, saved.id, { contact_id: 'c-a-telegram-01' })
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).toContain('Texto vindo do fluxo')
  })
  it('a migração converte transmissões antigas (texto, e-mail e modelo) sem perder conteúdo', async () => {
    const email = JSON.stringify({ subject: 'Assunto', preheader: '', html: '<p>oi</p>' })
    const modelo = JSON.stringify({ id: 'template-a', params: {} })
    await env.DB.batch([
      env.DB.prepare("INSERT INTO broadcasts(id,workspace_id,name,channel_id,content) VALUES ('old-t','a','Antiga','tg-a','Mensagem \"antiga\"')"),
      env.DB.prepare("INSERT INTO broadcasts(id,workspace_id,name,channel_id,content,email_content) VALUES ('old-e','a','Mail','tg-a','corpo',?)").bind(email),
      env.DB.prepare("INSERT INTO broadcasts(id,workspace_id,name,channel_id,content,template) VALUES ('old-m','a','Modelo','wa-a','',?)").bind(modelo),
      env.DB.prepare("INSERT INTO broadcasts(id,workspace_id,name,channel_id,content,copied_graph) VALUES ('old-c','a','Cópia','tg-a','x','{\"nodes\":[],\"edges\":[]}')"),
    ])
    await env.DB.prepare('UPDATE broadcasts SET flow=NULL').run()
    const update = (migracaoFluxo as string).slice((migracaoFluxo as string).indexOf('UPDATE broadcasts')).replace(/\n/g, ' ')
    await env.DB.prepare(update).run()
    const flows = Object.fromEntries((await env.DB.prepare("SELECT id,flow FROM broadcasts WHERE id LIKE 'old-%'").all<{ id: string; flow: string }>()).results.map(r => [r.id, JSON.parse(r.flow)]))
    expect(flows['old-t'].nodes[0].config).toEqual({ blocks: [{ kind: 'text', text: 'Mensagem "antiga"' }] })
    expect(flows['old-e'].nodes[0].config.email).toEqual(JSON.parse(email))
    expect(flows['old-m'].nodes[0].config.template).toEqual(JSON.parse(modelo))
    expect(flows['old-c']).toEqual({ nodes: [], edges: [] })
    expect((await getBroadcast(env, owner, 'old-e')).email).toEqual(JSON.parse(email))
    expect((await getBroadcast(env, owner, 'old-m')).template).toEqual(JSON.parse(modelo))
  })
  it('transmissão com flow nulo (inserida fora da migração) volta da leitura com o fluxo de um passo', async () => {
    const email = JSON.stringify({ subject: 'Assunto', preheader: '', html: '<p>oi</p>' })
    await env.DB.batch([
      env.DB.prepare("INSERT INTO broadcasts(id,workspace_id,name,channel_id,content) VALUES ('nulo-t','a','Sem fluxo','tg-a','Rascunho')"),
      env.DB.prepare("INSERT INTO broadcasts(id,workspace_id,name,channel_id,content,email_content) VALUES ('nulo-e','a','Mail sem fluxo','tg-a','corpo',?)").bind(email),
    ])
    await env.DB.prepare("UPDATE broadcasts SET flow=NULL WHERE id LIKE 'nulo-%'").run()
    const um: any = await getBroadcast(env, owner, 'nulo-t')
    expect(um.flow.nodes).toHaveLength(1)
    expect(um.flow.nodes[0]).toMatchObject({ id: 'broadcast-message', type: 'message', config: { blocks: [{ kind: 'text', text: 'Rascunho' }] } })
    expect((await getBroadcast(env, owner, 'nulo-e') as any).flow.nodes[0].config.email).toEqual(JSON.parse(email))
    const lista: any[] = await listBroadcasts(env, owner)
    expect(lista.find(b => b.id === 'nulo-t').flow.nodes[0].id).toBe('broadcast-message')
  })
})

describe('ticket 08: conteúdo montado no mapa de fluxo', () => {
  const passo = (id: string, text: string, x = 0) => ({ id, type: 'message', position: { x, y: 0 }, config: { blocks: [{ kind: 'text', text }] } })
  it('transmissão de vários passos é guardada como fluxo e entregue passo a passo', async () => {
    await recipient(1)
    const flow = { nodes: [passo('a1', 'Primeiro passo'), passo('a2', 'Segundo passo', 300)], edges: [{ from: 'a1', port: 'next', to: 'a2' }] }
    const inspect = await introspectWorkflow(runtime.FLOW_RUN)
    try {
      await inspect.modifyAll(async modifier => { await modifier.disableSleeps(); await modifier.disableRetryDelays() })
      const saved: any = await create({ flow })
      expect(saved).toMatchObject({ content: 'Primeiro passo', first_node_id: 'a1', flow: { nodes: [{ id: 'a1' }, { id: 'a2' }] } })
      await consume(saved.id)
      const instances = await inspect.get()
      expect(instances).toHaveLength(1)
      await instances[0].waitForStatus('complete')
      expect(vi.mocked(fetch).mock.calls.map(call => JSON.parse(String(call[1]?.body)).text)).toEqual(['Primeiro passo', 'Segundo passo'])
      expect(await getBroadcast(env, owner, saved.id)).toMatchObject({ metrics: { sent: 1 } })
    } finally { await inspect.dispose() }
  })
  it('e-mail ou modelo com fluxo de vários passos é recusado com 400, não descartado', async () => {
    const duas = { nodes: [passo('a1', 'Um'), passo('a2', 'Dois', 300)], edges: [{ from: 'a1', port: 'next', to: 'a2' }] }
    await expect(create({ status: 'draft', flow: duas, template: { id: 'template-a', params: { '1': 'Ana' } }, audience: { tag: 'all', channel: 'whatsapp', channel_id: 'wa-a' } }))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining('um passo') })
    await expect(create({ status: 'draft', flow: duas, email: { subject: 'Assunto', preheader: '', html: '<p>oi</p>' } }))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining('um passo') })
  })
  it('editar o rascunho troca o fluxo guardado e o primeiro passo', async () => {
    const saved: any = await create({ status: 'draft', flow: { nodes: [passo('a1', 'Um'), passo('a2', 'Dois', 300)], edges: [{ from: 'a1', port: 'next', to: 'a2' }] } })
    const again: any = await saveBroadcast(env, owner, input({ id: saved.id, status: 'draft', flow: { nodes: [passo('b1', 'Novo início')], edges: [] } }))
    expect(again).toMatchObject({ content: 'Novo início', first_node_id: 'b1' })
    expect(again.flow.nodes.map((n: { id: string }) => n.id)).toEqual(['b1'])
  })
  it('um passo só de texto segue como envio direto, sem virar cópia', async () => {
    const saved: any = await create({ status: 'draft', flow: { nodes: [passo('broadcast-message', 'Só texto')], edges: [] } })
    expect(saved).toMatchObject({ content: 'Só texto', first_node_id: null })
    expect(saved.copied_graph).toBeUndefined()
  })
  it('cópia de automação reaberta no mapa devolve o fluxo inteiro e o gatilho não vira início', async () => {
    const source = { nodes: [{ id: 'gatilho', type: 'trigger', position: { x: 0, y: 0 }, config: {} }, passo('a1', 'Um', 300), passo('a2', 'Dois', 600)],
      edges: [{ from: 'gatilho', port: 'next', to: 'a1' }, { from: 'a1', port: 'next', to: 'a2' }] }
    await env.DB.prepare('UPDATE automations SET draft_graph=? WHERE id=?').bind(JSON.stringify(source), 'auto-a').run()
    const copy: any = await createBroadcastFromAutomation(env, owner, { automation_id: 'auto-a', channel_id: 'tg-a' })
    expect(copy.flow.nodes.map((n: { id: string }) => n.id)).toEqual(['gatilho', 'a1', 'a2'])
    const edited = { nodes: [passo('a1', 'Um editado', 300), passo('a2', 'Dois', 600)], edges: [{ from: 'a1', port: 'next', to: 'a2' }] }
    const saved: any = await saveBroadcast(env, owner, input({ id: copy.id, status: 'draft', flow: edited }))
    expect(saved).toMatchObject({ content: 'Um editado', first_node_id: 'a1', source_automation_id: 'auto-a' })
    expect(saved.flow.nodes.map((n: { id: string }) => n.id)).toEqual(['a1', 'a2'])
    const withTrigger: any = await saveBroadcast(env, owner, input({ id: copy.id, status: 'draft', flow: source }))
    expect(withTrigger).toMatchObject({ content: 'Um', first_node_id: 'a1' })
    expect(withTrigger.flow.nodes.map((n: { id: string }) => n.id)).toEqual(['a1', 'a2'])
  })
  it('recusa fluxo sem um início único ou que não começa por mensagem', async () => {
    const solto = { nodes: [passo('a1', 'Um'), passo('a2', 'Dois', 300)], edges: [] }
    await expect(create({ status: 'draft', flow: solto })).rejects.toMatchObject({ status: 400 })
    const espera = { nodes: [{ id: 'w', type: 'smart_delay', position: { x: 0, y: 0 }, config: { duration: { value: 5, unit: 'minutes' } } }, passo('a2', 'Dois', 300)], edges: [{ from: 'w', port: 'next', to: 'a2' }] }
    await expect(create({ status: 'draft', flow: espera })).rejects.toMatchObject({ status: 400 })
  })
})
