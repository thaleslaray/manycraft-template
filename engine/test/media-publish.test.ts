import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { app } from '../src/index'
import { fixtureCookie, seedAuth } from './auth-helpers'

let cookie = ''
beforeEach(async () => { await seedAuth(); cookie = await fixtureCookie() })
const request = (path: string, init: RequestInit) => app.request(`/api/${path}`, { ...init, headers: { cookie, 'x-workspace': 'a', 'content-type': 'application/json', origin: 'https://engine.test', ...init.headers } }, { ...env, APP_ENV: 'development', PUBLIC_BASE_URL: 'http://localhost:5822' })

it('publicação recusa anexo ausente mesmo sem gatilho conectado', async () => {
  await env.DB.prepare("DELETE FROM triggers WHERE workspace_id='a'").run()
  const graph = { nodes: [
    { id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'm', type: 'message', position: { x: 200, y: 0 }, config: { blocks: [{ kind: 'media', media: 'image', url: '' }] } },
  ], edges: [{ from: 't', port: 'next', to: 'm' }] }
  expect((await request('automations/auto-a/draft', { method: 'PUT', body: JSON.stringify({ graph }) })).status).toBe(200)
  const refused = await request('automations/auto-a/publish', { method: 'POST' })
  expect(refused.status).toBe(409)
  expect(await refused.text()).toContain('anexo')
})

it('upload valida conteúdo e limites da conexão e mantém metadados no armazenamento', async () => {
  await env.DB.prepare("UPDATE channels SET type='telegram',provider='telegram_bot',capabilities_override=? WHERE id='ch-a'")
    .bind(JSON.stringify({ media: { image: { maxBytes: 32 } } })).run()
  const upload = (body: Uint8Array, type = 'image/png') => request('media?connection_id=ch-a&media=image', { method: 'POST', headers: { 'content-type': type, 'content-length': String(body.byteLength) }, body })
  const good = new Uint8Array([137,80,78,71,13,10,26,10])
  expect((await upload(new Uint8Array(64))).status).toBe(413)
  expect((await upload(new Uint8Array(8))).status).toBe(400)
  const saved = await upload(good)
  expect(saved.status).toBe(201)
  expect(await saved.json()).toMatchObject({ id: expect.any(String), mime: 'image/png', size: 8, url: expect.stringContaining('/api/media/public/') })
})

it.each([
  ['ficha sem imagem', { media: { image: { maxBytes: 0, mime: [] } } }, { kind: 'media', media: 'image', url: 'https://media.test/a.png' }],
  ['variável desconhecida', {}, { kind: 'media', media: 'image', url: '{{campo:inexistente|https%3A%2F%2Fmedia.test%2Fa.png}}' }],
  ['upload de outro espaço', {}, { kind: 'media', media: 'image', url: 'https://media.test/a.png', mediaId: 'other-media' }],
] as const)('publicação bloqueia %s', async (_name, override, block) => {
  await env.DB.prepare("UPDATE channels SET type='telegram',provider='telegram_bot',capabilities_override=? WHERE id='ch-a'").bind(JSON.stringify(override)).run()
  await env.DB.prepare("INSERT INTO media_objects(id,workspace_id,object_key,content_type,size,created_at) VALUES ('other-media','b','other-media','image/png',8,0)").run()
  const graph = { nodes: [
    { id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'm', type: 'message', position: { x: 200, y: 0 }, config: { blocks: [block] } },
  ], edges: [{ from: 't', port: 'next', to: 'm' }] }
  expect((await request('automations/auto-a/draft', { method: 'PUT', body: JSON.stringify({ graph }) })).status).toBe(200)
  expect((await request('automations/auto-a/publish', { method: 'POST' })).status).toBeGreaterThanOrEqual(400)
})

it.each([
  ['audio', 'audio/mpeg', 'ID3\u0004\u0000\u0000'],
  ['video', 'video/mp4', '\u0000\u0000\u0000\u0018ftypmp42'],
  ['file', 'application/pdf', '%PDF-1.7\nexemplo'],
] as const)('upload de %s usa a ficha efetiva e persiste referência', async (kind, mime, bytes) => {
  await env.DB.prepare("UPDATE channels SET type='telegram',provider='telegram_bot' WHERE id='ch-a'").run()
  const response = await request(`media?connection_id=ch-a&media=${kind}&name=${encodeURIComponent('Proposta Março (final).bin')}`, { method: 'POST', headers: { 'content-type': mime, 'content-length': String(new TextEncoder().encode(bytes).byteLength) }, body: new TextEncoder().encode(bytes) })
  expect(response.status).toBe(201)
  const saved = await response.json() as { id: string; url: string }
  // O nome do arquivo vai no fim da URL (o app mostra o cartão do arquivo com ele), limpo e com a extensão do tipo.
  expect(saved.url).toMatch(new RegExp(`/${saved.id}/Proposta-Marco-final\\.[a-z0-9]+$`))
  const publicObject = await request(`media/public/${saved.url.split('/media/public/')[1]}`, { method: 'GET' })
  expect(publicObject.headers.get('content-disposition')).toMatch(/filename="Proposta-Marco-final\./)
  expect(publicObject.status).toBe(200)
  expect(publicObject.headers.get('content-type')).toBe(mime)
  expect(new Uint8Array(await publicObject.arrayBuffer())).toEqual(new TextEncoder().encode(bytes))
})

it('publicação recusa mídia que ainda aponta para a ManyChat', async () => {
  const blocks = [
    [{ kind: 'text', text: 'Oi' }, { kind: 'media', media: 'image', url: 'https://manybot-thumbnails.s3.eu-central-1.amazonaws.com/a/pic.png' }],
    [{ kind: 'card', aspectRatio: 'horizontal', cards: [{ title: 'Card', imageUrl: 'https://manybot-thumbnails.s3.eu-central-1.amazonaws.com/a/card.jpg' }] }],
  ]
  for (const [i, list] of blocks.entries()) {
    if (i === 1) await env.DB.prepare("UPDATE channels SET type='instagram',provider='instagram_unified' WHERE id='ch-a'").run()
    if (i === 0) await env.DB.prepare("UPDATE channels SET type='telegram',provider='telegram_bot' WHERE id='ch-a'").run()
    const graph = { nodes: [
      { id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
      { id: 'm', type: 'message', position: { x: 200, y: 0 }, config: { blocks: list } },
    ], edges: [{ from: 't', port: 'next', to: 'm' }] }
    expect((await request('automations/auto-a/draft', { method: 'PUT', body: JSON.stringify({ graph }) })).status).toBe(200)
    const refused = await request('automations/auto-a/publish', { method: 'POST' })
    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('ManyChat')
  }
})

// Auditoria de segurança, D4: o upload não carrega o corpo inteiro na memória.
it('D4: sem Content-Length é 411; Content-Length acima do teto é 413 sem ler o corpo; mentira no tamanho é recusada e nada fica guardado', async () => {
  await env.DB.prepare("UPDATE channels SET type='telegram',provider='telegram_bot',capabilities_override=? WHERE id='ch-a'").bind(JSON.stringify({ media: { file: { maxBytes: 1024, mime: ['application/pdf'] } } })).run()
  const send = (headers: Record<string, string>, body: BodyInit) => request('media?connection_id=ch-a&media=file', { method: 'POST', headers: { 'content-type': 'application/pdf', ...headers }, body, duplex: 'half' } as RequestInit)
  const pdf = new TextEncoder().encode('%PDF-1.7\n' + 'x'.repeat(200))
  const streamOf = (bytes: Uint8Array, pulled = { n: 0 }) => new ReadableStream<Uint8Array>({ pull(c) { if (pulled.n >= bytes.length) { c.close(); return } c.enqueue(bytes.slice(pulled.n, pulled.n + 64)); pulled.n += 64 } }, { highWaterMark: 0 })
  expect((await send({}, streamOf(pdf))).status).toBe(411)
  const pulled = { n: 0 }, big = new TextEncoder().encode('%PDF-1.7\n' + 'x'.repeat(100_000))
  expect((await send({ 'content-length': String(big.length) }, streamOf(big, pulled))).status).toBe(413)
  expect(pulled.n).toBe(0)
  const before = await env.DB.prepare('SELECT count(*) n FROM media_objects').first<number>('n')
  // Declara 100 bytes e manda 209 (maior), ou declara 500 e manda 209 (menor).
  expect((await send({ 'content-length': '100' }, streamOf(pdf))).status).toBe(413)
  expect((await send({ 'content-length': '500' }, streamOf(pdf))).status).toBe(400)
  expect(await env.DB.prepare('SELECT count(*) n FROM media_objects').first<number>('n')).toBe(before)
  const ok = await send({ 'content-length': String(pdf.length) }, streamOf(pdf))
  expect(ok.status).toBe(201)
  expect(await ok.json()).toMatchObject({ mime: 'application/pdf', size: pdf.length })
})
it('D4: arquivo grande sobe em fluxo, só o começo é lido para conferir o formato e o conteúdo chega inteiro', async () => {
  await env.DB.prepare("UPDATE channels SET type='telegram',provider='telegram_bot',capabilities_override=? WHERE id='ch-a'").bind(JSON.stringify({ media: { file: { maxBytes: 4_000_000, mime: ['application/pdf'] } } })).run()
  const pdf = new Uint8Array(3_000_000).fill(120); pdf.set(new TextEncoder().encode('%PDF-1.7\n'))
  const saved = await request('media?connection_id=ch-a&media=file', { method: 'POST', headers: { 'content-type': 'application/pdf', 'content-length': String(pdf.length) }, body: pdf })
  expect(saved.status).toBe(201)
  const { url } = await saved.json() as { url: string }
  const back = await request(`media/public/${url.split('/media/public/')[1]}`, { method: 'GET' })
  // Tamanho e SHA-256 em vez de toEqual: comparar 3 MB elemento por elemento levava ~8 s e estourava o limite do teste.
  const received = new Uint8Array(await back.arrayBuffer())
  const sha = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
  expect(received.length).toBe(pdf.length)
  expect(await sha(received)).toBe(await sha(pdf))
})
