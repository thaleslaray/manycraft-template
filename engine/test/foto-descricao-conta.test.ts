import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { authenticatedRequest, fixtureCookie, seedAuth } from './auth-helpers'

beforeEach(seedAuth)
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
function armazem() {
  const guardado = new Map<string, { body: ArrayBuffer; type: string }>()
  const MEDIA = {
    put: async (key: string, body: ArrayBuffer | ReadableStream, o: { httpMetadata: { contentType: string } }) => { guardado.set(key, { body: body instanceof ReadableStream ? await new Response(body).arrayBuffer() : body, type: o.httpMetadata.contentType }) },
    get: async (key: string) => { const o = guardado.get(key); return o ? { body: o.body, httpMetadata: { contentType: o.type } } : null },
    delete: async (key: string) => { guardado.delete(key) },
  } as unknown as R2Bucket
  return { ...env, MEDIA } as typeof env
}
const enviar = async (b: typeof env, cookie: string, type = 'image/png', bytes: BodyInit = png) =>
  authenticatedRequest('media?purpose=account_photo&name=foto.png', 'a', { method: 'POST', headers: { 'content-type': type, 'content-length': String(new Blob([bytes as never]).size) }, body: bytes }, cookie, b)
const configuracoes = (b: typeof env, cookie: string, method: string, body?: unknown) =>
  authenticatedRequest('workspace-settings', 'a', { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, cookie, b)

it('guarda, devolve e limpa a foto e a descrição da conta', async () => {
  const b = armazem(), cookie = await fixtureCookie()
  expect(await (await configuracoes(b, cookie, 'GET')).json()).toMatchObject({ photo_url: null, description: null })
  const up = await enviar(b, cookie)
  expect(up.status).toBe(201)
  const { id } = await up.json() as { id: string }
  const salvo = await configuracoes(b, cookie, 'PATCH', { photo_media_id: id, description: 'Loja de plantas' })
  expect(salvo.status).toBe(200)
  const dados = await salvo.json() as { photo_url: string; description: string }
  expect(dados.description).toBe('Loja de plantas')
  expect(dados.photo_url).toBe(`/api/workspace-settings/photo/${id}`)
  const foto = await authenticatedRequest(`workspace-settings/photo/${id}`, 'a', {}, cookie, b)
  expect(foto.status).toBe(200)
  expect(foto.headers.get('content-type')).toBe('image/png')
  const limpo = await configuracoes(b, cookie, 'PATCH', { photo_media_id: null, description: null })
  expect(await limpo.json()).toMatchObject({ photo_url: null, description: null })
  expect((await authenticatedRequest(`workspace-settings/photo/${id}`, 'a', {}, cookie, b)).status).toBe(404)
})

it('recusa descrição longa, arquivo que não é imagem e foto de outro espaço', async () => {
  const b = armazem(), cookie = await fixtureCookie()
  expect((await configuracoes(b, cookie, 'PATCH', { description: 'x'.repeat(281) })).status).toBe(400)
  expect((await enviar(b, cookie, 'application/pdf', new TextEncoder().encode('%PDF-1.7'))).status).toBe(400)
  expect((await configuracoes(b, cookie, 'PATCH', { photo_media_id: crypto.randomUUID() })).status).toBe(409)
  const { id } = await (await enviar(b, cookie)).json() as { id: string }
  await env.DB.prepare("UPDATE media_objects SET workspace_id='b' WHERE id=?").bind(id).run()
  expect((await configuracoes(b, cookie, 'PATCH', { photo_media_id: id })).status).toBe(409)
})

it('o PATCH aplica a mesma validação do envio: só PNG, JPG ou WebP de até 2 MB', async () => {
  const b = armazem(), cookie = await fixtureCookie()
  const inserir = async (tipo: string, tamanho: number) => {
    const id = crypto.randomUUID()
    await env.DB.prepare('INSERT INTO media_objects(id,workspace_id,object_key,content_type,size,created_at) VALUES (?,?,?,?,?,?)').bind(id, 'a', `${id}/x`, tipo, tamanho, Date.now()).run()
    return id
  }
  expect((await configuracoes(b, cookie, 'PATCH', { photo_media_id: await inserir('application/pdf', 10) })).status).toBe(409)
  expect((await configuracoes(b, cookie, 'PATCH', { photo_media_id: await inserir('image/gif', 10) })).status).toBe(409)
  expect((await configuracoes(b, cookie, 'PATCH', { photo_media_id: await inserir('image/png', 2 * 1024 * 1024 + 1) })).status).toBe(409)
  expect((await configuracoes(b, cookie, 'PATCH', { photo_media_id: await inserir('image/webp', 2 * 1024 * 1024) })).status).toBe(200)
})

it('trocar ou remover a foto apaga a mídia antiga do D1 e do R2', async () => {
  const b = armazem(), cookie = await fixtureCookie()
  const subir = async () => (await (await enviar(b, cookie)).json() as { id: string }).id
  const existe = async (id: string) => !!(await env.DB.prepare('SELECT 1 FROM media_objects WHERE id=?').bind(id).first())
  const primeira = await subir(), segunda = await subir()
  await configuracoes(b, cookie, 'PATCH', { photo_media_id: primeira })
  await configuracoes(b, cookie, 'PATCH', { photo_media_id: segunda })
  expect(await existe(primeira)).toBe(false)
  expect(await existe(segunda)).toBe(true)
  expect(await b.MEDIA!.get(`${primeira}/foto.png`)).toBeNull()
  expect(await b.MEDIA!.get(`${segunda}/foto.png`)).not.toBeNull()
  // Salvar a mesma foto de novo não apaga nada.
  await configuracoes(b, cookie, 'PATCH', { photo_media_id: segunda })
  expect(await existe(segunda)).toBe(true)
  await configuracoes(b, cookie, 'PATCH', { photo_media_id: null })
  expect(await existe(segunda)).toBe(false)
  expect(await b.MEDIA!.get(`${segunda}/foto.png`)).toBeNull()
})
