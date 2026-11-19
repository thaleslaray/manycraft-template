import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getConnection } from '../src/channels/core/connections'
import { seedAuth } from './auth-helpers'
import { giveCredentials } from './credentials'

// Conexões antigas do WhatsApp oficial não têm settings.accountId: a conta é provada na Meta (GET /{waba}/phone_numbers lista o número)
// com o token da própria conexão e a wabaId guardada; o painel avisa enquanto ela não for conhecida.
// A Meta real recusa whatsapp_business_account no nó do número (#100).
let phones: { status?: number; pages: Array<{ data: Array<{ id: string }>; next?: boolean }> }
const settings = async (id = 'wa-a') => JSON.parse((await env.DB.prepare('SELECT settings FROM channels WHERE id=?').bind(id).first<string>('settings'))!) as Record<string, any>
const credentials = (extra: Record<string, string> = { wabaId: '456' }) => giveCredentials(env, 'wa-a', { accessToken: 'TESTONLY', phoneNumberId: '123', appSecret: 'segredo', ...extra })
beforeEach(async () => {
  await seedAuth()
  await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,connection_state,settings) VALUES ('wa-a','a','whatsapp','meta_whatsapp_cloud','123','connected','{}')").run()
  await credentials()
  phones = { pages: [{ data: [{ id: '999' }, { id: '123' }] }] }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input)), path = url.pathname.replace(/^\/v[\d.]+/, '')
    expect(init!.headers).toMatchObject({ Authorization: 'Bearer TESTONLY' })
    if (path === '/123') {
      if (url.searchParams.get('fields')?.includes('whatsapp_business_account')) return Response.json({ error: { message: '(#100) Tried accessing nonexisting field (whatsapp_business_account)', code: 100 } }, { status: 400 })
      return Response.json({ id: '123', verified_name: 'Loja' })
    }
    if (path === '/456/phone_numbers') {
      const page = Number(url.searchParams.get('page') ?? 0), body = phones.pages[page]
      return Response.json({ data: body.data, ...(body.next ? { paging: { next: `${url.origin}${url.pathname}?page=${page + 1}` } } : {}) }, { status: phones.status ?? 200 })
    }
    return Response.json({ error: { code: 100 } }, { status: 400 })
  })
})
afterEach(() => vi.restoreAllMocks())

it('conexão antiga ganha o accountId provado pela lista de números da WABA e deixa de acusar a falta', async () => {
  const view = await getConnection(env, 'a', 'wa-a', 'https://x.test')
  expect(view.accountIdMissing).toBe(false)
  expect((await settings()).accountId).toBe('456')
})
it('acha o número em página seguinte da lista (paging.next)', async () => {
  phones = { pages: [{ data: [{ id: '999' }], next: true }, { data: [{ id: '123' }] }] }
  expect((await getConnection(env, 'a', 'wa-a', 'https://x.test')).accountIdMissing).toBe(false)
  expect((await settings()).accountId).toBe('456')
})
it('número fora da lista, ou a lista falhando, deixa sem conta e o painel avisa; a consulta só se repete depois de um tempo', async () => {
  phones = { pages: [{ data: [{ id: '999' }] }] }
  expect((await getConnection(env, 'a', 'wa-a', 'https://x.test')).accountIdMissing).toBe(true)
  expect((await getConnection(env, 'a', 'wa-a', 'https://x.test')).accountIdMissing).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(3)   // o número, a saúde do número e a lista, uma vez só (com wabaId digitado e sem prova, nem o debug_token nem a assinatura são tentados)
  expect((await settings()).accountId).toBeUndefined()
  await env.DB.prepare("UPDATE channels SET settings=json_set(settings,'$.accountCheckedAt',?) WHERE id='wa-a'").bind(Date.now() - 2 * 3600_000).run()
  phones = { status: 400, pages: [{ data: [] }] }
  expect((await getConnection(env, 'a', 'wa-a', 'https://x.test')).accountIdMissing).toBe(true)
  await env.DB.prepare("UPDATE channels SET settings=json_set(settings,'$.accountCheckedAt',?) WHERE id='wa-a'").bind(Date.now() - 2 * 3600_000).run()
  phones = { pages: [{ data: [{ id: '123' }] }] }
  expect((await getConnection(env, 'a', 'wa-a', 'https://x.test')).accountIdMissing).toBe(false)
})
it('sem wabaId não há accountId e a lista nem é consultada', async () => {
  await credentials({})
  expect((await getConnection(env, 'a', 'wa-a', 'https://x.test')).accountIdMissing).toBe(true)
  // O número, a saúde do número (que aqui não diz a conta dona) e, para achar a conta que o token enxerga, o debug_token; a lista de números de uma conta digitada não existe para consultar.
  expect(vi.mocked(fetch).mock.calls.map(c => new URL(String(c[0])).pathname)).toEqual(['/v26.0/123', '/v26.0/123', '/v26.0/debug_token'])
})
it('provedor que não tem conta acima do número não pede nada à Meta nem acusa falta', async () => {
  vi.mocked(fetch).mockClear()
  await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id) VALUES ('uz','a','whatsapp','uazapi','x')").run()
  expect((await getConnection(env, 'a', 'uz', 'https://x.test')).accountIdMissing).toBe(false)
  expect(fetch).not.toHaveBeenCalled()
})
