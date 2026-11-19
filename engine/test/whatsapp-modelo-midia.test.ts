/**
 * Modelo com cabeçalho de mídia sem colar o identificador de exemplo: no envio para revisão o motor baixa a mídia do endereço informado e a sobe
 * pela Resumable Upload API da Meta (POST /{app-id}/uploads com file_name, file_length e file_type; POST /upload:<sessão> com
 * `Authorization: OAuth` e `file_offset: 0`; resposta { h }), developers.facebook.com/docs/graph-api/guides/upload. O app sai do debug_token.
 */
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'
import { giveCredentials } from './credentials'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6])
const input = { name: 'pedido_com_foto', category: 'utility', language: 'pt_BR', header: { type: 'image', mediaUrl: 'https://cdn.exemplo.test/foto.png' },
  body: 'Seu pedido {{1}} saiu.', examples: { '1': '123' }, footer: '', buttons: [] }
const request = (path: string, method = 'GET', body?: unknown) => authenticatedRequest(`message-templates/${path}`, 'a', { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

type Call = { method: string; url: string; headers: Record<string, string>; body?: unknown }
let calls: Call[]
let media: { status?: number; type?: string; bytes?: Uint8Array; length?: string }
let uploads: { session?: Response; finish?: Response }
beforeEach(async () => {
  await seedAuth()
  await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,settings) VALUES ('wa-a','a','whatsapp','meta_whatsapp_cloud','123','{\"accountId\":\"456\"}')").run()
  await giveCredentials(env, 'wa-a', { accessToken: 'TESTONLY', phoneNumberId: '123', wabaId: '456' })
  calls = []; media = {}; uploads = {}
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (raw, init) => {
    const url = String(raw), method = init?.method ?? 'GET', headers = Object.fromEntries(new Headers(init?.headers).entries())
    calls.push({ method, url, headers, body: init?.body })
    if (url === input.header.mediaUrl) {
      const bytes = media.bytes ?? png
      return new Response(bytes, { status: media.status ?? 200, headers: { 'content-type': media.type ?? 'image/png', 'content-length': media.length ?? String(bytes.byteLength) } })
    }
    if (url.includes('/debug_token')) return Response.json({ data: { app_id: '287' } })
    if (url.includes('/287/uploads')) return uploads.session ?? Response.json({ id: 'upload:MTphdHRhY2htZW50?sig=ARZ' })
    if (url.endsWith('/upload:MTphdHRhY2htZW50?sig=ARZ')) return uploads.finish ?? Response.json({ h: '4::aW1hZ2VtLWhhbmRsZQ==' })
    if (url.endsWith('/456/message_templates') && method === 'POST') return Response.json({ id: 'provider-1', status: 'PENDING', category: 'UTILITY' })
    throw new Error(`Rede real proibida no teste: ${url}`)
  })
})
afterEach(() => vi.restoreAllMocks())

const draft = async (change: Record<string, unknown> = {}) => {
  const response = await request('wa-a', 'POST', { ...input, ...change })
  expect(response.status).toBe(201)
  return (await response.json() as { id: string }).id
}

it('rascunho com cabeçalho de imagem não exige mais o identificador de exemplo', async () => {
  await draft()
  expect(fetch).not.toHaveBeenCalled()
})

it('no envio para revisão baixa a mídia, sobe pela Resumable Upload API, usa o identificador e o guarda no modelo', async () => {
  const id = await draft()
  const response = await request(`wa-a/${id}/submit`, 'POST')
  expect(response.status).toBe(200)
  const session = calls.find(c => c.url.includes('/287/uploads'))!
  const query = new URL(session.url).searchParams
  expect(session.method).toBe('POST')
  expect(query.get('file_length')).toBe(String(png.byteLength))
  expect(query.get('file_type')).toBe('image/png')
  expect(query.get('file_name')).toMatch(/\.png$/)
  expect(query.get('access_token')).toBeNull()   // o token vai no cabeçalho, nunca no endereço
  const finish = calls.find(c => c.url.endsWith('/upload:MTphdHRhY2htZW50?sig=ARZ'))!
  expect(finish.method).toBe('POST')
  expect(finish.headers).toMatchObject({ authorization: 'OAuth TESTONLY', file_offset: '0' })
  expect(new Uint8Array(finish.body as ArrayBuffer)).toEqual(png)
  const created = calls.find(c => c.url.endsWith('/456/message_templates'))!
  expect(JSON.parse(String(created.body)).components[0]).toEqual({ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::aW1hZ2VtLWhhbmRsZQ=='] } })
  const [row] = await (await request('wa-a')).json() as { header: { example?: string } }[]
  expect(row.header.example).toBe('4::aW1hZ2VtLWhhbmRsZQ==')
})

it('modelo que já tem o identificador (sincronizado da Meta) não sobe nada', async () => {
  const id = await draft({ header: { ...input.header, example: 'https://scontent.exemplo.test/handle.png' } })
  expect((await request(`wa-a/${id}/submit`, 'POST')).status).toBe(200)
  expect(calls.some(c => c.url.includes('uploads') || c.url === input.header.mediaUrl)).toBe(false)
})

it.each([
  ['arquivo grande demais', () => { media = { length: String(6e6) } }, /grande demais.*5 MB/],
  ['tipo não aceito', () => { media = { type: 'image/gif' } }, /tipo.*não é aceito/i],
  ['endereço que não responde', () => { media = { status: 404 } }, /Não foi possível baixar a mídia/],
  ['Meta recusou a sessão de upload', () => { uploads = { session: Response.json({ error: { code: 100, message: 'Invalid parameter' } }, { status: 400 }) } }, /Meta recusou o envio da mídia/],
  ['Meta recusou o arquivo', () => { uploads = { finish: Response.json({ error: { code: 1, message: 'Upload failed' } }, { status: 400 }) } }, /Meta recusou o envio da mídia/],
])('%s: mensagem clara em português e o modelo volta a rascunho', async (_name, arrange, message) => {
  arrange()
  const id = await draft()
  const response = await request(`wa-a/${id}/submit`, 'POST')
  expect(response.status).toBe(422)
  expect((await response.json() as { error?: string; message?: string }).error ?? '').toMatch(message)
  expect(calls.some(c => c.url.endsWith('/message_templates'))).toBe(false)
  expect(await (await request('wa-a')).json()).toEqual([expect.objectContaining({ id, status: 'draft' })])
})

it('endereço interno da mídia é recusado sem baixar nada', async () => {
  const id = await draft({ header: { type: 'image', mediaUrl: 'http://127.0.0.1:8080/foto.png' } })
  const response = await request(`wa-a/${id}/submit`, 'POST')
  expect(response.status).toBe(422)
  expect(calls).toEqual([])
})
