import { giveCredentials } from './credentials'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { authenticatedRequest, seedAuth } from './auth-helpers'

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
let calls: string[]

function mockTelegram(photos: { file_id: string; width: number; height: number }[][], download = new Response(jpeg)) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/getUserProfilePhotos')) return Response.json({ ok: true, result: { total_count: photos.length, photos } })
    if (url.includes('/getFile')) return Response.json({ ok: true, result: { file_path: 'photos/file_1.jpg' } })
    if (url.startsWith('https://api.telegram.org/file/bot')) return download
    throw new Error(`Unexpected network call: ${url}`)
  })
}

beforeEach(async () => {
  calls = []
  await seedAuth()
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('tg-a','a','telegram','bot-a')"),
    env.DB.prepare("INSERT INTO contacts (id,workspace_id,first_name,profile_pic_url) VALUES ('tg-c','a','Ana','/api/contacts/tg-c/avatar')"),
    env.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id) VALUES ('tg-cc','a','tg-c','tg-a','4242')"),
  ])
  await giveCredentials(env, 'tg-a', { botToken: 'TESTONLY', webhookSecret: 'secret-tg-a' })
})
afterEach(() => vi.restoreAllMocks())

it('devolve a imagem do menor tamanho >=160px com cache privado e sem expor o token', async () => {
  mockTelegram([[{ file_id: 'small', width: 90, height: 90 }, { file_id: 'mid', width: 320, height: 320 }, { file_id: 'big', width: 640, height: 640 }]])
  const response = await authenticatedRequest('contacts/tg-c/avatar')
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('image/jpeg')
  expect(response.headers.get('cache-control')).toBe('private, max-age=86400')
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(jpeg)
  expect(calls.some(u => u.includes('getFile') && u.includes('file_id=mid'))).toBe(true)
  expect(calls.some(u => u.includes('user_id=4242') && u.includes('limit=1'))).toBe(true)
  expect([...response.headers].join('\n')).not.toContain('TESTONLY')
  const stored = await env.DB.prepare('SELECT group_concat(profile_pic_url) AS v FROM contacts').first<{ v: string }>()
  expect(stored?.v).not.toContain('TESTONLY')
  expect(stored?.v).not.toContain('api.telegram.org')
})

it('usa a maior foto quando nenhuma tem 160px', async () => {
  mockTelegram([[{ file_id: 'a', width: 50, height: 50 }, { file_id: 'b', width: 100, height: 100 }]])
  expect((await authenticatedRequest('contacts/tg-c/avatar')).status).toBe(200)
  expect(calls.some(u => u.includes('file_id=b'))).toBe(true)
})

it('404 sem foto, sem expor o token, e 404 quando o download falha', async () => {
  mockTelegram([])
  const none = await authenticatedRequest('contacts/tg-c/avatar')
  expect(none.status).toBe(404)
  expect(await none.text()).not.toContain('TESTONLY')
  vi.restoreAllMocks()
  mockTelegram([[{ file_id: 'a', width: 200, height: 200 }]], new Response('x', { status: 500 }))
  expect((await authenticatedRequest('contacts/tg-c/avatar')).status).toBe(404)
  vi.restoreAllMocks()
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('https://api.telegram.org/botTESTONLY/x'))
  const failed = await authenticatedRequest('contacts/tg-c/avatar')
  expect(failed.status).toBe(404)
  expect(await failed.text()).not.toContain('TESTONLY')
})

it('contato sem vínculo Telegram (Instagram) é 404 sem chamar a rede', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network must never be used'))
  expect((await authenticatedRequest('contacts/c-a/avatar')).status).toBe(404)
  expect(fetch).not.toHaveBeenCalled()
})

it('outro workspace não acessa e não dispara chamada ao Telegram', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network must never be used'))
  expect((await authenticatedRequest('contacts/tg-c/avatar', 'b')).status).toBe(404)
  expect(fetch).not.toHaveBeenCalled()
})

it('sem sessão é 401; header de workspace não autentica nem com query', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network must never be used'))
  const { app } = await import('../src/index')
  const anon = await app.request('https://engine.test/api/contacts/tg-c/avatar?workspace=a', {}, { ...env, APP_ENV: 'production' })
  expect(anon.status).toBe(401)
  expect(fetch).not.toHaveBeenCalled()
})

it('<img> sem header: workspace por query só nesta rota, com sessão e membership verificados', async () => {
  mockTelegram([[{ file_id: 'a', width: 200, height: 200 }]])
  const { fixtureCookie } = await import('./auth-helpers')
  const { app } = await import('../src/index')
  const get = async (path: string, workspace: string, user = 'a') => app.request(`https://engine.test/api/${path}${path.includes('?') ? '&' : '?'}workspace=${workspace}`,
    { headers: { cookie: await fixtureCookie(user) } }, env)
  expect((await get('contacts/tg-c/avatar', 'a')).status).toBe(200)
  expect((await get('contacts/tg-c/avatar', 'a', 'b')).status).toBe(404) // usuário do workspace b não é membro de a
  expect((await get('contacts/tg-c', 'a')).status).toBe(400) // outras rotas continuam exigindo o header
})
