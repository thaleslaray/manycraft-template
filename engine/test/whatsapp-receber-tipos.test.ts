import { describe, expect, it } from 'vitest'
import { metaWhatsappCloud } from '../src/channels/meta-whatsapp-cloud'
import type { Connection } from '../src/channels/contract'

// Cada tipo de mensagem que o cliente manda, com o exemplo oficial da Meta (replica/contratos/meta-whatsapp/exemplos/webhooks/).
// Os exemplos trazem o telefone no lugar do BSUID e marcadores como <WAMID>: o teste troca só isso.
const examples = import.meta.glob('../../replica/contratos/meta-whatsapp/exemplos/webhooks/messages-*.json', { query: '?raw', import: 'default', eager: true })
const user = 'BR.abc123'
function sample(file: string, patch: (message: Record<string, any>) => void = () => {}) {
  const body = JSON.parse(String(examples[`../../replica/contratos/meta-whatsapp/exemplos/webhooks/${file}.json`]).replaceAll('<PHONE_NUMBER_ID>', 'phone-a')) as any
  delete body._fonte
  const value = body.entry[0].changes[0].value
  value.contacts = [{ profile: { name: 'Sheena Nelson' }, wa_id: '5511999991234', user_id: user }]
  const [message] = value.messages
  message.id = 'wamid.IN1'; message.from_user_id = user
  patch(message)
  return body
}
const connection = { id: 'wa-a', kind: 'whatsapp', provider: 'meta_whatsapp_cloud', externalId: 'phone-a', settings: {} } as Connection
const parse = (body: unknown) => metaWhatsappCloud.parseInbound(body, connection)

describe('cada tipo oficial vira evento próprio, nunca ignored', () => {
  it.each([
    ['messages-imagem', 'image', { caption: 'Taj Mahal', mime_type: 'image/jpeg' }],
    ['messages-video', 'video', { caption: 'Timelapse of growth', mime_type: 'video/mp4' }],
    ['messages-documento', 'file', { caption: 'my receipt', filename: 'receipt.pdf', mime_type: 'application/pdf' }],
  ] as const)('%s: mídia com legenda como texto e a referência para baixar depois', (file, type, media) => {
    const body = sample(file, m => { m[m.type].id = 'MEDIA1' })
    expect(parse(body)).toMatchObject([{ kind: 'message', eventKey: 'wamid.IN1', externalMessageId: 'wamid.IN1', from: { externalUserId: user },
      text: media.caption, media: { type, ref: 'MEDIA1', mime: media.mime_type, ...('filename' in media ? { filename: media.filename } : {}) } }])
  })
  it('áudio: sem legenda, voz marcada e o codec fora do tipo', () => {
    const [event] = parse(sample('messages-audio', m => { m.audio.id = 'MEDIA2' }))
    expect(event).toMatchObject({ kind: 'message', media: { type: 'audio', ref: 'MEDIA2', mime: 'audio/ogg', voice: true } })
    expect(event).not.toHaveProperty('text')
  })
  it('figurinha: mídia própria, animada', () => {
    expect(parse(sample('messages-sticker', m => { m.sticker.id = 'MEDIA3' }))).toMatchObject([{ kind: 'message', media: { type: 'sticker', ref: 'MEDIA3', mime: 'image/webp', animated: true } }])
  })
  it('localização: coordenadas, nome e endereço', () => {
    expect(parse(sample('messages-localizacao'))).toMatchObject([{ kind: 'message', location: { latitude: 37.44221496582, longitude: -122.16165924072, name: 'Philz Coffee', address: '101 Forest Ave, Palo Alto, CA 94301' } }])
  })
  it('contatos: nome, empresa e telefones, sem confundir com os perfis do webhook', () => {
    const [event] = parse(sample('messages-contatos'))
    expect(event).toMatchObject({ kind: 'message', sharedContacts: [{ name: 'Barbara J. Johnson', company: 'Social Tsunami', phones: ['<WA_USER_PHONE>'], emails: [] }],
      from: { externalUserId: user, profile: { firstName: 'Sheena', lastName: 'Nelson' } } })
  })
  it('pedido do catálogo: itens com quantidade e preço', () => {
    expect(parse(sample('messages-pedido-catalogo'))).toMatchObject([{ kind: 'message', order: { catalogId: '<CATALOG_ID>', text: 'Love these!',
      items: [{ productId: 'di9ozbzfi4', quantity: 2, price: 30, currency: 'USD' }, { productId: 'nqryix03ez', quantity: 1, price: 25, currency: 'USD' }] } }])
  })
  it('não suportada: avisa o tipo que a Meta nomeou', () => {
    expect(parse(sample('messages-nao-suportada'))).toMatchObject([{ kind: 'message', unsupported: { type: 'edit' } }])
  })
  it('reação adicionada e retirada, ligadas à mensagem reagida', () => {
    expect(parse(sample('messages-reacao-adicionada'))).toMatchObject([{ kind: 'reaction', eventKey: 'wamid.IN1', from: { externalUserId: user }, targetMessageId: '<WAMID>', emoji: '👍' }])
    const [removed] = parse(sample('messages-reacao-removida'))
    expect(removed).toMatchObject({ kind: 'reaction', targetMessageId: '<WAMID>' })
    expect(removed).not.toHaveProperty('emoji')
  })
  it('resposta de lista vira clique com o id da linha e o título', () => {
    expect(parse(sample('messages-interativo-resposta-de-lista'))).toMatchObject([{ kind: 'click', payload: 'priority_express', label: 'Priority Mail Express' }])
  })
  it('o que o produto ainda não lê segue ignorado, com o motivo', () => {
    expect(parse(sample('messages-interativo-produto'))).toMatchObject([{ kind: 'ignored', why: expect.stringContaining('interactive') }])
  })
  it('mídia sem referência é recusada em vez de enfileirada pela metade', () => {
    expect(parse(sample('messages-imagem', m => { delete m.image.id }))).toMatchObject([{ kind: 'ignored' }])
  })
})

// ───────── Media API: GET /{media-id}, depois o link com o mesmo token ─────────
import { graphMidiaFalsa, pngFalso } from './graph-midia-falsa'
import type { InboundMedia } from '../src/channels/types'
import type { MediaDownload, ProviderCtx } from '../src/channels/contract'

const imagem: InboundMedia = { type: 'image', ref: 'MEDIA1', mime: 'image/jpeg' }
function download(graph: ReturnType<typeof graphMidiaFalsa>, media: InboundMedia = imagem, max = 5e6) {
  const ctx = { connection, credentials: { accessToken: 'TESTONLY', phoneNumberId: 'phone-a' }, fetch: graph.fetch } as unknown as ProviderCtx
  return metaWhatsappCloud.downloadMedia!(ctx, media, max)
}
const bytesOf = async (result: MediaDownload) => result.ok ? new Uint8Array(await new Response(result.body).arrayBuffer()) : undefined

describe('downloadMedia: Media API', () => {
  it('pede o link, baixa com o token e devolve os bytes com o tipo e o tamanho', async () => {
    const graph = graphMidiaFalsa(); graph.midias.set('MEDIA1', { mime: 'image/png', bytes: pngFalso() })
    const result = await download(graph)
    expect(result).toMatchObject({ ok: true, mime: 'image/png', size: pngFalso().byteLength })
    expect(await bytesOf(result)).toEqual(pngFalso())
    expect(graph.consultas).toEqual(['MEDIA1'])
    expect(graph.downloads).toEqual([{ url: expect.stringContaining('https://lookaside.fbsbx.com/'), autorizacao: 'Bearer TESTONLY' }])
  })
  it('cada tentativa pede um link novo (o link vale 5 minutos, o id vale 7 dias)', async () => {
    const graph = graphMidiaFalsa(); graph.midias.set('MEDIA1', { mime: 'image/png', bytes: pngFalso() })
    await download(graph); await download(graph)
    expect(graph.consultas).toEqual(['MEDIA1', 'MEDIA1'])
    expect(new Set(graph.downloads.map(d => d.url)).size).toBe(2)
  })
  it.each([
    ['id desconhecido ou vencido (100)', (g: ReturnType<typeof graphMidiaFalsa>) => g.midias.delete('MEDIA1'), { ok: false, transient: false, code: 'not_found' }],
    ['token recusado (190)', (g: ReturnType<typeof graphMidiaFalsa>) => g.falhar(u => u.host === 'graph.facebook.com', () => Response.json({ error: { code: 190, message: 'x' } }, { status: 400 })), { ok: false, transient: false, code: 'auth' }],
    ['limite de chamadas (613)', (g: ReturnType<typeof graphMidiaFalsa>) => g.falhar(u => u.host === 'graph.facebook.com', () => Response.json({ error: { code: 613, message: 'x' } }, { status: 400 })), { ok: false, transient: true, code: 'rate_limited' }],
    ['429 sem corpo da Graph', (g: ReturnType<typeof graphMidiaFalsa>) => g.falhar(u => u.host === 'graph.facebook.com', () => new Response('{}', { status: 429 })), { ok: false, transient: true, code: 'rate_limited' }],
    ['5xx da Graph', (g: ReturnType<typeof graphMidiaFalsa>) => g.falhar(u => u.host === 'graph.facebook.com', () => new Response('{}', { status: 503 })), { ok: false, transient: true, code: 'server' }],
    ['rede cai na consulta', (g: ReturnType<typeof graphMidiaFalsa>) => g.falhar(u => u.host === 'graph.facebook.com', () => { throw new TypeError('network') }), { ok: false, transient: true, code: 'network' }],
    ['link vencido no download (404)', (g: ReturnType<typeof graphMidiaFalsa>) => g.falhar(u => u.host === 'lookaside.fbsbx.com', () => new Response('x', { status: 404 })), { ok: false, transient: true, code: 'expired' }],
    ['rede cai no download', (g: ReturnType<typeof graphMidiaFalsa>) => g.falhar(u => u.host === 'lookaside.fbsbx.com', () => { throw new TypeError('network') }), { ok: false, transient: true, code: 'network' }],
  ])('%s', async (_nome, preparar, esperado) => {
    const graph = graphMidiaFalsa(); graph.midias.set('MEDIA1', { mime: 'image/png', bytes: pngFalso() })
    preparar(graph)
    expect(await download(graph)).toEqual(esperado)
  })
  it('arquivo maior que o limite é recusado antes de baixar', async () => {
    const graph = graphMidiaFalsa(); graph.midias.set('MEDIA1', { mime: 'image/png', bytes: pngFalso() })
    expect(await download(graph, imagem, 10)).toEqual({ ok: false, transient: false, code: 'too_large' })
    expect(graph.downloads).toEqual([])
  })
  it('resposta sem file_size ainda baixa, contando os bytes na leitura', async () => {
    const graph = graphMidiaFalsa(); graph.midias.set('MEDIA1', { mime: 'image/png', bytes: pngFalso() })
    const semTamanho = () => Response.json({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=MEDIA1&exp=0', mime_type: 'image/png', id: 'MEDIA1' })
    graph.falhar(u => u.host === 'graph.facebook.com', semTamanho)
    const result = await download(graph)
    expect(result).toMatchObject({ ok: true, mime: 'image/png', size: pngFalso().byteLength })
    expect(await bytesOf(result)).toEqual(pngFalso())
    graph.falhar(u => u.host === 'graph.facebook.com', semTamanho)
    expect(await download(graph, imagem, 10)).toEqual({ ok: false, transient: false, code: 'too_large' })
  })
  it('o token só vai a um link https', async () => {
    const graph = graphMidiaFalsa()
    graph.falhar(u => u.host === 'graph.facebook.com', () => Response.json({ url: 'http://evil.test/arquivo', mime_type: 'image/png', file_size: 10, id: 'MEDIA1' }))
    expect(await download(graph)).toEqual({ ok: false, transient: false, code: 'invalid' })
  })
})

// ───────── Da entrega do webhook à caixa de entrada (fila, download, tentativas) ─────────
import { env as runtime } from 'cloudflare:workers'
import { afterEach, beforeEach, vi } from 'vitest'
import { consumeInbound } from '../src/jobs'
import { webhooks, type InboundEvent, type IntegrationEnv } from '../src/integrations'
import { upsertWhatsappIdentity } from '../src/db/contacts'
import { app } from '../src/index'
import { fixtureCookie, seedAuth } from './auth-helpers'
import { giveCredentials, testKeyring } from './credentials'
import { seed } from './fixtures'
import { pdfFalso } from './graph-midia-falsa'

const secret = 'TEST-APP-SECRET', phoneId = '123456789'
let queue: IntegrationEnv, accepted: InboundEvent[], sendEvent: ReturnType<typeof vi.fn>, create: ReturnType<typeof vi.fn>, graph: ReturnType<typeof graphMidiaFalsa>
const nowSeconds = () => String(Math.floor(Date.now() / 1000))
const incoming = (id: string, overrides: Record<string, unknown>) => ({ id, timestamp: nowSeconds(), from_user_id: user, ...overrides })
const envelope = (messages: unknown[]) => ({ object: 'whatsapp_business_account', entry: [{ id: 'test-waba', changes: [{ field: 'messages',
  value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneId }, messages, contacts: [{ profile: { name: 'Sheena Nelson' }, wa_id: '5511999991234', user_id: user }] } }] }] })
async function signed(body: unknown) {
  const text = JSON.stringify(body)
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)))
  return { method: 'POST', body: text, headers: { 'X-Hub-Signature-256': `sha256=${[...sig].map(n => n.toString(16).padStart(2, '0')).join('')}` } }
}
/** O webhook só enfileira; o consumidor da fila faz o resto. `attempts` é o número da tentativa da fila. */
async function receive(messages: unknown[]) {
  accepted = []
  expect((await webhooks.request('/meta', await signed(envelope(messages)), queue)).status).toBe(200)
  return consume(...accepted)
}
async function consume(...events: InboundEvent[]) {
  const batch = events.map(body => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn(), id: crypto.randomUUID(), timestamp: new Date() }))
  await consumeInbound({ messages: batch } as unknown as MessageBatch<unknown>, queue)
  return batch
}
const inboxMessages = async () => (await runtime.DB.prepare("SELECT id,content FROM messages WHERE direction='in' ORDER BY created_at,rowid").all<{ id: string; content: string }>())
  .results.map(r => ({ id: r.id, ...JSON.parse(r.content) }))
const lastMessage = async () => (await inboxMessages()).at(-1)

describe('mensagens recebidas, do webhook à caixa de entrada', () => {
  beforeEach(async () => {
    await seed()
    accepted = []; sendEvent = vi.fn(async () => {}); create = vi.fn(async () => ({}))
    queue = { DB: runtime.DB, MEDIA: runtime.MEDIA, INBOUND_MEDIA: runtime.INBOUND_MEDIA, ...testKeyring,
      INBOUND: { send: async (event: InboundEvent) => { accepted.push(event) } } as unknown as Queue<InboundEvent>,
      FLOW_RUN: { create, get: async () => ({ sendEvent, status: async () => ({ status: 'running' }) }) } as unknown as NonNullable<IntegrationEnv['FLOW_RUN']> }
    await runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('wa-a','a','whatsapp',?)").bind(phoneId).run()
    await giveCredentials(runtime, 'wa-a', { accessToken: 'TESTONLY', phoneNumberId: phoneId, appSecret: secret, verifyToken: 'VERIFY-TEST' })
    await upsertWhatsappIdentity(runtime.DB, 'a', { contact_id: 'c-a', channel_id: 'wa-a', bsuid: user })
    await runtime.DB.prepare("UPDATE contact_channels SET opted_in=1,window_expires_at=? WHERE channel_id='wa-a'").bind(Date.now() + 86400000).run()
    graph = graphMidiaFalsa()
    vi.spyOn(globalThis, 'fetch').mockImplementation(graph.fetch)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('foto com legenda: baixada pela Media API, guardada e aberta pela caixa de entrada', async () => {
    graph.midias.set('MEDIA1', { mime: 'image/png', bytes: pngFalso() })
    const [message] = await receive([incoming('wamid.IMG', { type: 'image', image: { id: 'MEDIA1', mime_type: 'image/png', sha256: 'x', caption: 'Taj Mahal' } })])
    expect(message.ack).toHaveBeenCalled(); expect(message.retry).not.toHaveBeenCalled()
    const stored = await lastMessage()
    expect(stored).toMatchObject({ sender: 'contact', text: 'Taj Mahal', media: { kind: 'image', status: 'stored', mime: 'image/png', size: pngFalso().byteLength, id: expect.stringMatching(/^[a-f0-9-]{36}$/) } })
    const object = await runtime.INBOUND_MEDIA!.get(stored!.media.id)
    // O que o contato mandou fica no bucket privado; o bucket público nunca o recebe.
    expect(await runtime.MEDIA!.get(stored!.media.id)).toBeNull()
    expect(await runtime.DB.prepare('SELECT bucket FROM media_objects WHERE id=?').bind(stored!.media.id).first('bucket')).toBe('inbound')
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(pngFalso())
    expect(await runtime.DB.prepare('SELECT status,attempts FROM inbound_media').first()).toEqual({ status: 'stored', attempts: 1 })
    // A mesma entrega de novo não baixa nem grava outra vez.
    await consume(...accepted)
    expect(await inboxMessages()).toHaveLength(1)
    expect(graph.consultas).toEqual(['MEDIA1'])
  })
  it('documento sem legenda aparece com o nome do arquivo', async () => {
    graph.midias.set('MEDIA2', { mime: 'application/pdf', bytes: pdfFalso() })
    await receive([incoming('wamid.DOC', { type: 'document', document: { id: 'MEDIA2', mime_type: 'application/pdf', filename: 'recibo.pdf' } })])
    expect(await lastMessage()).toMatchObject({ text: '[Arquivo] recibo.pdf', media: { kind: 'file', status: 'stored', name: 'recibo.pdf', mime: 'application/pdf' } })
  })
  it('falha passageira: a mensagem já aparece, a fila tenta de novo e o arquivo chega', async () => {
    graph.midias.set('MEDIA1', { mime: 'image/png', bytes: pngFalso() })
    graph.falhar(u => u.host === 'graph.facebook.com', () => new Response('{}', { status: 503 }))
    const [first] = await receive([incoming('wamid.IMG', { type: 'image', image: { id: 'MEDIA1', mime_type: 'image/png' } })])
    expect(first.retry).toHaveBeenCalled(); expect(first.ack).not.toHaveBeenCalled()
    expect(await lastMessage()).toMatchObject({ text: '[Imagem]', media: { kind: 'image', status: 'pending' } })
    expect(await runtime.DB.prepare('SELECT status,attempts,error FROM inbound_media').first()).toEqual({ status: 'pending', attempts: 1, error: 'server' })
    const [second] = await consume(...accepted)
    expect(second.ack).toHaveBeenCalled()
    expect(await inboxMessages()).toHaveLength(1)
    expect(await lastMessage()).toMatchObject({ media: { status: 'stored' } })
  })
  it('falha que se repete: depois das tentativas a mensagem fica sem o arquivo, com o motivo registrado', async () => {
    graph.midias.set('MEDIA1', { mime: 'image/png', bytes: pngFalso() })
    graph.falhar(u => u.host === 'graph.facebook.com', () => new Response('{}', { status: 503 }), 100)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await receive([incoming('wamid.IMG', { type: 'image', image: { id: 'MEDIA1', mime_type: 'image/png', caption: 'olha isto' } })])
    for (let attempt = 2; attempt < 8; attempt++) expect((await consume(...accepted))[0].retry).toHaveBeenCalled()
    const [last] = await consume(...accepted)
    expect(last.ack).toHaveBeenCalled(); expect(last.retry).not.toHaveBeenCalled()
    expect(await inboxMessages()).toHaveLength(1)
    expect(await lastMessage()).toMatchObject({ text: 'olha isto', media: { status: 'failed', error: 'server' } })
    expect(await runtime.DB.prepare('SELECT status,attempts,error FROM inbound_media').first()).toEqual({ status: 'failed', attempts: 8, error: 'server' })
    expect(warn.mock.calls.map(c => String(c[0])).join('')).toContain('inbound_media_failed')
    expect(warn.mock.calls.map(c => String(c[0])).join('')).not.toContain(user)
  })
  it('arquivo que a Meta não tem mais (7 dias) não adianta tentar de novo', async () => {
    const [message] = await receive([incoming('wamid.OLD', { type: 'video', video: { id: 'VELHO', mime_type: 'video/mp4' } })])
    expect(message.ack).toHaveBeenCalled(); expect(message.retry).not.toHaveBeenCalled()
    expect(await lastMessage()).toMatchObject({ text: '[Vídeo]', media: { kind: 'video', status: 'failed', error: 'not_found' } })
    expect(graph.consultas).toEqual(['VELHO'])
  })
  it('localização, contato, pedido e tipo não suportado aparecem de forma legível', async () => {
    await receive([
      incoming('wamid.LOC', { type: 'location', location: { latitude: -23.5614, longitude: -46.6559, name: 'Avenida Paulista', address: 'São Paulo, SP' } }),
      incoming('wamid.CON', { type: 'contacts', contacts: [{ name: { formatted_name: 'Barbara Johnson' }, org: { company: 'Social Tsunami' }, phones: [{ phone: '+55 11 99999-0000' }] }] }),
      incoming('wamid.ORD', { type: 'order', order: { catalog_id: 'cat1', text: 'Quero estes', product_items: [{ product_retailer_id: 'p1', quantity: 2, item_price: 30, currency: 'BRL' }] } }),
      incoming('wamid.UNS', { type: 'unsupported', unsupported: { type: 'edit' }, errors: [{ code: 131051, title: 'Message type unknown' }] }),
    ])
    const [loc, con, ord, uns] = await inboxMessages()
    expect(loc).toMatchObject({ text: 'Localização: Avenida Paulista, São Paulo, SP (-23.56140, -46.65590)', location: { latitude: -23.5614, longitude: -46.6559, name: 'Avenida Paulista' } })
    expect(con).toMatchObject({ text: 'Contato compartilhado: Barbara Johnson (+55 11 99999-0000)', shared_contacts: [{ name: 'Barbara Johnson', company: 'Social Tsunami', phones: ['+55 11 99999-0000'] }] })
    expect(ord).toMatchObject({ text: 'Pedido do catálogo: 2 × p1. Quero estes', order: { catalogId: 'cat1', items: [{ productId: 'p1', quantity: 2, price: 30, currency: 'BRL' }] } })
    expect(uns).toMatchObject({ unsupported: { type: 'edit' } })
    expect(uns.text).toContain('não entrega')
  })
  it('a legenda da foto dispara a palavra-chave e a foto sem legenda dispara a boas-vindas, como o texto faria', async () => {
    graph.midias.set('MEDIA1', { mime: 'image/png', bytes: pngFalso() })
    const graphJson = JSON.stringify({ nodes: [{ id: 'start', type: 'trigger', position: { x: 0, y: 0 }, config: {} }], edges: [] })
    await runtime.DB.batch([
      runtime.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('wa-v','a','auto-a',1,?)").bind(graphJson),
      runtime.DB.prepare("UPDATE automations SET status='live',published_version_id='wa-v' WHERE id='auto-a'"),
      runtime.DB.prepare("UPDATE triggers SET channel_id='wa-a',repeat_mode='every_time' WHERE id='trg-a'"),
      runtime.DB.prepare("UPDATE keywords SET status='live' WHERE id='key-a'"),
    ])
    await receive([incoming('wamid.IMG', { type: 'image', image: { id: 'MEDIA1', mime_type: 'image/png', caption: 'eu quero este' } })])
    expect(create).toHaveBeenCalledTimes(1)
    expect(await runtime.DB.prepare("SELECT count(*) n FROM trigger_firings WHERE trigger_id='trg-a'").first('n')).toBe(1)
    // Sem legenda não há palavra para casar: nada dispara.
    await receive([incoming('wamid.IMG2', { type: 'image', image: { id: 'MEDIA1', mime_type: 'image/png' } })])
    expect(create).toHaveBeenCalledTimes(1)
  })
  it('mensagem de tipo não suportado só vai para a caixa de entrada: não dispara resposta padrão nem boas-vindas', async () => {
    const graphJson = JSON.stringify({ nodes: [{ id: 'start', type: 'trigger', position: { x: 0, y: 0 }, config: {} }], edges: [] })
    await runtime.DB.batch([
      runtime.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('wa-v','a','auto-a',1,?)").bind(graphJson),
      runtime.DB.prepare("UPDATE automations SET status='live',published_version_id='wa-v' WHERE id='auto-a'"),
      runtime.DB.prepare("UPDATE triggers SET channel_id='wa-a',kind='default_reply',repeat_mode='every_time' WHERE id='trg-a'"),
      runtime.DB.prepare("UPDATE keywords SET status='live' WHERE id='key-a'"),
    ])
    await receive([incoming('wamid.UNS', { type: 'unsupported', unsupported: { type: 'edit' }, errors: [{ code: 131051, title: 'Message type unknown' }] })])
    expect(await lastMessage()).toMatchObject({ unsupported: { type: 'edit' } })
    expect(create).not.toHaveBeenCalled()
    expect(await runtime.DB.prepare("SELECT count(*) n FROM trigger_firings WHERE trigger_id='trg-a'").first('n')).toBe(0)
    // Um texto comum logo depois segue disparando normalmente.
    await receive([incoming('wamid.TXT', { type: 'text', text: { body: 'eu quero este' } })])
    expect(create).toHaveBeenCalledTimes(1)
  })
  it('reação fica ligada à mensagem reagida e some quando o cliente a retira', async () => {
    await receive([incoming('wamid.TXT', { type: 'text', text: { body: 'bom dia' } })])
    await receive([incoming('wamid.R1', { type: 'reaction', reaction: { message_id: 'wamid.TXT', emoji: '👍' } })])
    expect((await inboxMessages())).toHaveLength(1)
    expect(await lastMessage()).toMatchObject({ text: 'bom dia', reaction: { emoji: '👍' } })
    await receive([incoming('wamid.R2', { type: 'reaction', reaction: { message_id: 'wamid.TXT' } })])
    expect((await lastMessage())!.reaction).toBeUndefined()
  })
  it('reação a uma mensagem que não está na conversa vira uma linha, e retirada sem mensagem não faz nada', async () => {
    await receive([incoming('wamid.TXT', { type: 'text', text: { body: 'oi' } })])
    await receive([incoming('wamid.R1', { type: 'reaction', reaction: { message_id: 'wamid.OUTRA', emoji: '❤️' } })])
    expect(await lastMessage()).toMatchObject({ sender: 'contact', text: 'Reagiu com ❤️ a uma mensagem que não está nesta conversa.' })
    await receive([incoming('wamid.R2', { type: 'reaction', reaction: { message_id: 'wamid.OUTRA' } })])
    expect(await inboxMessages()).toHaveLength(2)
  })
  it('reação de quem nunca escreveu não cria contato nem conversa', async () => {
    await runtime.DB.prepare("DELETE FROM contact_channels WHERE channel_id='wa-a'").run()
    await receive([incoming('wamid.R1', { type: 'reaction', reaction: { message_id: 'wamid.X', emoji: '👍' } })])
    expect(await inboxMessages()).toHaveLength(0)
    expect(await runtime.DB.prepare("SELECT count(*) n FROM contact_channels WHERE channel_id='wa-a'").first('n')).toBe(0)
  })
  it('resposta de lista aparece na caixa de entrada com o título da linha', async () => {
    await receive([incoming('wamid.LST', { type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'priority_express', title: 'Priority Mail Express', description: 'Next Day' } } })])
    expect(await lastMessage()).toMatchObject({ sender: 'contact', text: 'Priority Mail Express' })
  })
})

// ───────── Perguntas do fluxo: resposta de lista, foto, arquivo e localização ─────────
import { effectiveProfile } from '../src/channels/core/profile-merge'
import { questionCapabilityError, questionSchema } from '../src/schemas/question'
import { questionMessage } from '../src/flow/questions'

const question = (over: Record<string, unknown>) => ({ text: 'Pergunta', answer_type: 'text', field_id: 'field-a', retry_message: 'De novo', max_attempts: 3, skip: false,
  timeout: { value: 5, unit: 'minutes' }, choices: [], ...over })
const token = 'a'.repeat(24)
async function openQuestion(config: Record<string, unknown>) {
  await runtime.DB.batch([
    runtime.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('wa-v','a','auto-a',1,'{\"nodes\":[],\"edges\":[]}')"),
    runtime.DB.prepare("INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,channel_id,status) VALUES ('q-run','a','c-a','wa-v','wa-a','waiting_input')"),
    runtime.DB.prepare("INSERT INTO flow_questions(run_id,step_index,workspace_id,contact_id,channel_id,node_id,config,token,expires_at) VALUES ('q-run',0,'a','c-a','wa-a','ask',?,?,?)")
      .bind(JSON.stringify(question(config)), token, Date.now() + 600000),
  ])
}
const answered = () => runtime.DB.prepare("SELECT value FROM contact_field_values WHERE contact_id='c-a' AND field_id='field-a'").first<string>('value')
const questionRow = () => runtime.DB.prepare('SELECT status,attempts FROM flow_questions').first<{ status: string; attempts: number }>()

describe('perguntas do fluxo no WhatsApp oficial', () => {
  beforeEach(async () => {
    await seed()
    accepted = []; sendEvent = vi.fn(async () => {}); create = vi.fn(async () => ({}))
    queue = { DB: runtime.DB, MEDIA: runtime.MEDIA, INBOUND_MEDIA: runtime.INBOUND_MEDIA, ...testKeyring,
      INBOUND: { send: async (event: InboundEvent) => { accepted.push(event) } } as unknown as Queue<InboundEvent>,
      FLOW_RUN: { create, get: async () => ({ sendEvent, status: async () => ({ status: 'running' }) }) } as unknown as NonNullable<IntegrationEnv['FLOW_RUN']> }
    await runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('wa-a','a','whatsapp',?)").bind(phoneId).run()
    await giveCredentials(runtime, 'wa-a', { accessToken: 'TESTONLY', phoneNumberId: phoneId, appSecret: secret, verifyToken: 'VERIFY-TEST' })
    await upsertWhatsappIdentity(runtime.DB, 'a', { contact_id: 'c-a', channel_id: 'wa-a', bsuid: user })
    await runtime.DB.prepare("UPDATE contact_channels SET opted_in=1,window_expires_at=? WHERE channel_id='wa-a'").bind(Date.now() + 86400000).run()
    graph = graphMidiaFalsa()
    vi.spyOn(globalThis, 'fetch').mockImplementation(graph.fetch)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('resposta de lista responde a pergunta de múltipla escolha', async () => {
    await openQuestion({ answer_type: 'multiple_choice', choices: ['A', 'B', 'C', 'D', 'E'] })
    await receive([incoming('wamid.LST', { type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: `q:${token}:3`, title: 'D' } } })])
    expect(await answered()).toBe('"D"')
    expect(await questionRow()).toEqual({ status: 'success', attempts: 1 })
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'question_0_0' }))
    expect(await lastMessage()).toMatchObject({ text: 'D' })
  })
  it('foto responde a pergunta de imagem: o campo recebe o endereço do arquivo guardado', async () => {
    graph.midias.set('MEDIA1', { mime: 'image/png', bytes: pngFalso() })
    await openQuestion({ answer_type: 'image' })
    await receive([incoming('wamid.IMG', { type: 'image', image: { id: 'MEDIA1', mime_type: 'image/png' } })])
    const stored = await lastMessage()
    expect(JSON.parse((await answered())!)).toBe(`/api/inbox/media/${stored!.media.id}`)
    expect(await questionRow()).toEqual({ status: 'success', attempts: 1 })
  })
  it('a resposta de foto guarda o caminho autenticado, mesmo com domínio público de mídia configurado', async () => {
    Object.assign(queue, { MEDIA_PUBLIC_URL: 'https://midia.exemplo.test', BETTER_AUTH_URL: 'https://engine.test' })
    graph.midias.set('MEDIA1', { mime: 'image/png', bytes: pngFalso() })
    await openQuestion({ answer_type: 'image' })
    await receive([incoming('wamid.IMG', { type: 'image', image: { id: 'MEDIA1', mime_type: 'image/png' } })])
    const stored = await lastMessage()
    expect(JSON.parse((await answered())!)).toBe(`/api/inbox/media/${stored!.media.id}`)
  })
  it('documento responde a pergunta de arquivo, mas texto solto não responde pergunta de arquivo', async () => {
    graph.midias.set('MEDIA2', { mime: 'application/pdf', bytes: pdfFalso() })
    await openQuestion({ answer_type: 'file' })
    await receive([incoming('wamid.TXT', { type: 'text', text: { body: 'depois mando' } })])
    expect(await answered()).toBe('"Curso"')   // o valor que o contato já tinha ficou como estava
    expect(await questionRow()).toEqual({ status: 'open', attempts: 1 })
    await receive([incoming('wamid.DOC', { type: 'document', document: { id: 'MEDIA2', mime_type: 'application/pdf', filename: 'a.pdf' } })])
    expect(await questionRow()).toEqual({ status: 'success', attempts: 2 })
    expect(JSON.parse((await answered())!)).toMatch(/^\/api\/inbox\/media\//)
  })
  it('foto não responde pergunta de localização, e localização responde com o link do mapa', async () => {
    graph.midias.set('MEDIA1', { mime: 'image/png', bytes: pngFalso() })
    await openQuestion({ answer_type: 'location' })
    await receive([incoming('wamid.IMG', { type: 'image', image: { id: 'MEDIA1', mime_type: 'image/png' } })])
    expect(await questionRow()).toEqual({ status: 'open', attempts: 1 })
    await receive([incoming('wamid.LOC', { type: 'location', location: { latitude: -23.5614, longitude: -46.6559 } })])
    expect(JSON.parse((await answered())!)).toBe('https://www.google.com/maps?q=-23.5614,-46.6559')
    expect(await questionRow()).toEqual({ status: 'success', attempts: 2 })
  })
  it('pergunta de foto cuja foto não pôde ser baixada conta como resposta inválida, sem perder a mensagem', async () => {
    await openQuestion({ answer_type: 'image' })
    await receive([incoming('wamid.IMG', { type: 'image', image: { id: 'SUMIU', mime_type: 'image/png' } })])
    expect(await questionRow()).toEqual({ status: 'open', attempts: 1 })
    expect(await lastMessage()).toMatchObject({ media: { status: 'failed' } })
  })
})

describe('o que a conexão do WhatsApp oficial aceita como pergunta', () => {
  const whatsapp = effectiveProfile('whatsapp', 'meta_whatsapp_cloud')
  it('foto, arquivo e localização só onde a conexão recebe mídia', () => {
    for (const answer_type of ['image', 'file', 'location'] as const) {
      expect(questionCapabilityError({ answer_type, choices: [], skip: false }, whatsapp)).toBeUndefined()
      expect(questionCapabilityError({ answer_type, choices: [], skip: false }, effectiveProfile('whatsapp', 'uazapi'))).toMatch(/fotos, arquivos/)
      expect(questionCapabilityError({ answer_type, choices: [], skip: false }, effectiveProfile('telegram', 'telegram_bot'))).toMatch(/fotos, arquivos/)
    }
  })
  it('mais de três opções saem como lista, com o id de cada linha igual ao do botão', () => {
    const config = questionSchema.parse(question({ answer_type: 'multiple_choice', choices: ['A', 'B', 'C', 'D', 'E'], skip: true }))
    expect(questionCapabilityError(config, whatsapp)).toBeUndefined()
    const message = questionMessage(config, whatsapp, token, 'Qual?')
    expect(message).toMatchObject({ kind: 'list', text: 'Qual?', sections: [{ rows: [{ id: `q:${token}:0`, title: 'A' }, { id: `q:${token}:1`, title: 'B' }, { id: `q:${token}:2`, title: 'C' }, { id: `q:${token}:3`, title: 'D' }, { id: `q:${token}:4`, title: 'E' }, { id: `q:${token}:s`, title: 'Pular' }] }] })
    expect(metaWhatsappCloud.fit(message, whatsapp)).toHaveProperty('messages')
  })
  it('até três opções continuam botões; mais de dez não cabem em lista nenhuma', () => {
    const three = questionSchema.parse(question({ answer_type: 'multiple_choice', choices: ['A', 'B', 'C'] }))
    expect(questionMessage(three, whatsapp, token, 'Qual?')).toMatchObject({ kind: 'text', buttons: expect.any(Array) })
    const eleven = questionSchema.parse(question({ answer_type: 'multiple_choice', choices: Array.from({ length: 10 }, (_, i) => `O${i}`), skip: true }))
    expect(questionCapabilityError(eleven, whatsapp)).toMatch(/Múltipla escolha/)
  })
})

// ───────── Caixa de entrada: lista, arquivo e apagamento ─────────
import { authenticatedRequest } from './auth-helpers'
import { deleteContacts } from '../src/contacts'

describe('caixa de entrada com o que o cliente mandou', () => {
  beforeEach(async () => {
    await seedAuth()
    accepted = []; sendEvent = vi.fn(async () => {}); create = vi.fn(async () => ({}))
    queue = { DB: runtime.DB, MEDIA: runtime.MEDIA, INBOUND_MEDIA: runtime.INBOUND_MEDIA, ...testKeyring,
      INBOUND: { send: async (event: InboundEvent) => { accepted.push(event) } } as unknown as Queue<InboundEvent>,
      FLOW_RUN: { create, get: async () => ({ sendEvent, status: async () => ({ status: 'running' }) }) } as unknown as NonNullable<IntegrationEnv['FLOW_RUN']> }
    await runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('wa-a','a','whatsapp',?)").bind(phoneId).run()
    await giveCredentials(runtime, 'wa-a', { accessToken: 'TESTONLY', phoneNumberId: phoneId, appSecret: secret, verifyToken: 'VERIFY-TEST' })
    await upsertWhatsappIdentity(runtime.DB, 'a', { contact_id: 'c-a', channel_id: 'wa-a', bsuid: user })
    await runtime.DB.prepare("UPDATE contact_channels SET opted_in=1,window_expires_at=? WHERE channel_id='wa-a'").bind(Date.now() + 86400000).run()
    graph = graphMidiaFalsa()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      return url.host === 'graph.facebook.com' || url.host === 'lookaside.fbsbx.com' ? graph.fetch(input, init) : (await import('./graph-midia-falsa')).realFetchNotAllowed()
    })
  })
  afterEach(() => { vi.restoreAllMocks() })
  const mediaOf = async () => (await lastMessage())!.media.id as string
  const conversationMessages = async () => (await (await authenticatedRequest('inbox/conversations?status=all')).json() as { rows: { id: string }[] }).rows
    .map(r => r.id)
  async function wire() {
    const [conversation] = await conversationMessages()
    return (await (await authenticatedRequest(`inbox/conversations/${conversation}/messages`)).json() as { rows: any[] }).rows
  }

  it('a lista de mensagens leva o endereço do arquivo, sem expor a chave do armazenamento', async () => {
    graph.midias.set('MEDIA1', { mime: 'image/png', bytes: pngFalso() })
    await receive([incoming('wamid.IMG', { type: 'image', image: { id: 'MEDIA1', mime_type: 'image/png', caption: 'foto' } })])
    const [message] = await wire()
    expect(message).toMatchObject({ sender: 'contact', text: 'foto', media: { kind: 'image', status: 'stored', mime: 'image/png', url: `/api/inbox/media/${await mediaOf()}` } })
    expect(JSON.stringify(message)).not.toContain('"id":"' + await mediaOf())
  })
  it('arquivo que falhou chega com a frase em português', async () => {
    await receive([incoming('wamid.OLD', { type: 'image', image: { id: 'VELHO', mime_type: 'image/png' } })])
    const [message] = await wire()
    expect(message.media).toMatchObject({ status: 'failed', error: expect.stringContaining('não está mais disponível') })
    expect(message.media).not.toHaveProperty('url')
  })
  it('o arquivo abre para quem é do espaço: foto no navegador, documento como download, com cabeçalhos de segurança', async () => {
    graph.midias.set('MEDIA1', { mime: 'image/png', bytes: pngFalso() }); graph.midias.set('MEDIA2', { mime: 'application/pdf', bytes: pdfFalso() })
    await receive([incoming('wamid.IMG', { type: 'image', image: { id: 'MEDIA1', mime_type: 'image/png' } })])
    const photo = await authenticatedRequest(`inbox/media/${await mediaOf()}`)
    expect(photo.status).toBe(200)
    expect(photo.headers.get('content-type')).toBe('image/png')
    expect(photo.headers.get('content-disposition')).toBe('inline')
    expect(photo.headers.get('x-content-type-options')).toBe('nosniff')
    expect(photo.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(pngFalso())
    await receive([incoming('wamid.DOC', { type: 'document', document: { id: 'MEDIA2', mime_type: 'application/pdf', filename: 'a.pdf' } })])
    expect((await authenticatedRequest(`inbox/media/${await mediaOf()}`)).headers.get('content-disposition')).toBe('attachment')
  })
  it('tipo que o navegador interpretaria (HTML, SVG, script) não é guardado: a mensagem fica sem o arquivo, com o motivo', async () => {
    const guardados = async () => (await runtime.INBOUND_MEDIA!.list()).objects.length
    const antes = await guardados()
    for (const [i, mime] of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/javascript'].entries()) {
      graph.midias.set(`ATIVO${i}`, { mime, bytes: new TextEncoder().encode('<script>alert(1)</script>') })
      await receive([incoming(`wamid.ATIVO${i}`, { type: 'document', document: { id: `ATIVO${i}`, mime_type: mime, filename: 'a.html' } })])
      expect(await lastMessage()).toMatchObject({ media: { kind: 'file', status: 'failed', error: 'blocked' } })
    }
    expect((await wire()).at(-1).media).toMatchObject({ status: 'failed', error: expect.stringContaining('tipo de arquivo') })
    expect(await runtime.DB.prepare('SELECT count(*) n FROM media_objects').first('n')).toBe(0)
    expect(await guardados()).toBe(antes)
  })
  it('um documento de tipo comum abre só como download, isolado do navegador', async () => {
    graph.midias.set('MEDIA3', { mime: 'application/zip', bytes: new Uint8Array([80, 75, 3, 4, 1, 2]) })
    await receive([incoming('wamid.DOC', { type: 'document', document: { id: 'MEDIA3', mime_type: 'application/zip' } })])
    const response = await authenticatedRequest(`inbox/media/${await mediaOf()}`)
    expect(response.headers.get('content-disposition')).toBe('attachment')
    expect(response.headers.get('content-security-policy')).toContain('sandbox')
  })
  it('áudio e vídeo aceitam pedido de trecho (o navegador precisa para tocar e avançar)', async () => {
    const bytes = new Uint8Array(100).map((_, i) => i)
    graph.midias.set('MEDIA4', { mime: 'audio/ogg', bytes })
    await receive([incoming('wamid.AUD', { type: 'audio', audio: { id: 'MEDIA4', mime_type: 'audio/ogg; codecs=opus', voice: true } })])
    const id = await mediaOf()
    const part = await authenticatedRequest(`inbox/media/${id}`, 'a', { headers: { range: 'bytes=10-19' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 10-19/100')
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.slice(10, 20))
    expect((await authenticatedRequest(`inbox/media/${id}`, 'a', { headers: { range: 'bytes=500-' } })).status).toBe(416)
  })
  it('o <img> não manda cabeçalho: o espaço vai na consulta, e a sessão continua valendo', async () => {
    graph.midias.set('MEDIA1', { mime: 'image/png', bytes: pngFalso() })
    await receive([incoming('wamid.IMG', { type: 'image', image: { id: 'MEDIA1', mime_type: 'image/png' } })])
    const id = await mediaOf()
    const noHeader = (cookie: string | undefined, workspace = 'a') => app.request(`https://engine.test/api/inbox/media/${id}?workspace=${workspace}`, { headers: { ...(cookie ? { cookie } : {}) } }, runtime)
    expect((await noHeader(await fixtureCookie('a'))).status).toBe(200)
    expect((await noHeader(undefined)).status).toBe(401)
    expect((await noHeader(await fixtureCookie('b'), 'b')).status).toBe(404)
  })
  it('arquivo de outro espaço ou que não existe é 404', async () => {
    graph.midias.set('MEDIA1', { mime: 'image/png', bytes: pngFalso() })
    await receive([incoming('wamid.IMG', { type: 'image', image: { id: 'MEDIA1', mime_type: 'image/png' } })])
    const id = await mediaOf()
    expect((await authenticatedRequest(`inbox/media/${id}`, 'b')).status).toBe(404)
    expect((await authenticatedRequest(`inbox/media/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`)).status).toBe(404)
    expect((await authenticatedRequest('inbox/media/nao-e-id')).status).toBe(400)
  })
  it('apagar o contato apaga o arquivo que ele mandou, no armazenamento e no banco', async () => {
    graph.midias.set('MEDIA1', { mime: 'image/png', bytes: pngFalso() })
    await receive([incoming('wamid.IMG', { type: 'image', image: { id: 'MEDIA1', mime_type: 'image/png' } })])
    const id = await mediaOf()
    expect(await runtime.INBOUND_MEDIA!.head(id)).not.toBeNull()
    await deleteContacts(queue as never, 'a', ['c-a'])
    expect(await runtime.INBOUND_MEDIA!.head(id)).toBeNull()
    expect(await runtime.DB.prepare('SELECT count(*) n FROM media_objects WHERE id=?').bind(id).first('n')).toBe(0)
    expect(await runtime.DB.prepare('SELECT count(*) n FROM inbound_media').first('n')).toBe(0)
  })
})
