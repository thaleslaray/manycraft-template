import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/env'
import { origin, seedAuth } from './auth-helpers'
import { ZAPI_CLIENT_TOKEN, ZAPI_INSTANCE, ZAPI_TOKEN } from './conformance/zapi-fixture'

const bindings = () => ({ ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: 'a', DEV_PROVIDER_API_BASE: undefined, PUBLIC_BASE_URL: undefined } as Env)
function call(method: string, path: string, body?: unknown) {
  return app.request(`${origin}/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'x-workspace': 'a', origin, 'content-type': 'application/json' } }, bindings())
}
const BASE = `/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}`
let paired: boolean
let qr: string
let calls: { method: string; path: string; body: Record<string, unknown> }[]

beforeEach(async () => {
  await seedAuth()
  calls = []; paired = false; qr = 'data:image/png;base64,QR-1'
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.origin !== 'https://api.z-api.io') throw new Error(`Unexpected request: ${url.href}`)
    calls.push({ method: init?.method ?? 'GET', path: url.pathname.slice(BASE.length), body: init?.body ? JSON.parse(String(init.body)) : {} })
    if (!url.pathname.startsWith(BASE) || new Headers(init?.headers).get('client-token') !== ZAPI_CLIENT_TOKEN) return Response.json({ error: 'null not allowed' }, { status: 401 })
    if (url.pathname === `${BASE}/status`) return Response.json({ connected: paired, error: paired ? 'You are already connected' : 'You are not connected', smartphoneConnected: paired })
    if (url.pathname === `${BASE}/qr-code`) return Response.json({ value: qr })
    if (init?.method === 'PUT') return Response.json({ value: true })
    return Response.json({}, { status: 404 })
  })
})
afterEach(() => { vi.restoreAllMocks() })

const credentials = { instanceId: ZAPI_INSTANCE, token: ZAPI_TOKEN, clientToken: ZAPI_CLIENT_TOKEN }
const create = (over: Record<string, unknown> = {}) => call('POST', '/connections', { kind: 'whatsapp', provider: 'zapi', displayName: 'Loja', credentials, ...over })

describe('catálogo e conexão por QR', () => {
  it('WhatsApp ganha a Z-API como terceiro provedor, com aviso de bloqueio, QR e sem opções da UAZAPI', async () => {
    const { channels } = await (await call('GET', '/connections/catalog')).json() as { channels: { kind: string; providers: { id: string; notice?: string; pairing?: string; options?: unknown; fields: { key: string; secret: boolean; optional?: boolean }[] }[] }[] }
    const whatsapp = channels.find(c => c.kind === 'whatsapp')!
    expect(whatsapp.providers.map(p => p.id).sort()).toEqual(['meta_whatsapp_cloud', 'uazapi', 'zapi'])
    const zapi = whatsapp.providers.find(p => p.id === 'zapi')!
    expect(zapi).toMatchObject({ pairing: 'qr', notice: expect.stringMatching(/bloquear o número/) })
    expect(zapi.fields).toEqual([expect.objectContaining({ key: 'instanceId', secret: false }), expect.objectContaining({ key: 'token', secret: true }),
      expect.objectContaining({ key: 'clientToken', secret: true, optional: true })])
    expect(zapi.options).toBeUndefined()
  })
  it('cria a conexão, registra os webhooks com o segredo na URL e devolve o QR; só a prova da Z-API marca como conectada', async () => {
    const response = await create()
    expect(response.status).toBe(201)
    const { connection, step } = await response.json() as { connection: { id: string; status: string; externalId: string; webhook: { registered: boolean; mode: string } }; step: { kind: string; qr: string } }
    expect(step).toMatchObject({ kind: 'qr', qr: 'data:image/png;base64,QR-1' })
    expect(connection).toMatchObject({ status: 'connecting', externalId: `zapi:${ZAPI_INSTANCE}`, webhook: { registered: true, mode: 'auto' } })
    const hook = calls.find(c => c.method === 'PUT' && c.path === '/update-webhook-received')!.body
    expect(hook.value).toEqual(expect.stringMatching(new RegExp(`^${origin}/api/hooks/${connection.id}\\?k=[A-Za-z0-9_-]{20,}$`)))
    expect(calls.map(c => c.path)).toEqual(expect.arrayContaining(['/update-webhook-delivery', '/update-webhook-message-status', '/update-webhook-connected', '/update-webhook-disconnected', '/update-notify-sent-by-me']))
    // The panel keeps asking while the QR is open: still waiting, then paired.
    expect(await (await call('POST', `/connections/${connection.id}/connect`)).json()).toMatchObject({ step: { kind: 'qr' }, connection: { status: 'connecting' } })
    paired = true
    expect(await (await call('POST', `/connections/${connection.id}/connect`)).json()).toMatchObject({ step: { kind: 'done' }, connection: { status: 'connected' } })
    // The token, the Client-Token and the webhook secret are encrypted at rest and never come back.
    const secret = new URL(String(hook.value)).searchParams.get('k')!
    const everything = JSON.stringify([await (await call('GET', '/connections')).json(), await env.DB.prepare('SELECT * FROM channels WHERE id=?').bind(connection.id).first()])
    for (const hidden of [ZAPI_TOKEN, ZAPI_CLIENT_TOKEN, secret]) expect(everything).not.toContain(hidden)
  })
  it('instância já pareada conecta direto; token errado é recusado; a mesma instância não conecta duas vezes', async () => {
    paired = true
    expect(await (await create({ displayName: undefined })).json()).toMatchObject({ step: { kind: 'done' }, connection: { status: 'connected' } })
    expect((await create()).status).toBe(409)
    expect((await create({ credentials: { ...credentials, instanceId: 'B'.repeat(32), token: 'errado1234' } })).status).toBe(422)
    expect((await create({ credentials: { ...credentials, instanceId: '../x' } })).status).toBe(400)
  })
  it('reativar um número despareado pede a leitura do QR, com motivo (antes voltava ok:false com o motivo vazio)', async () => {
    paired = true
    const { connection } = await (await create()).json() as { connection: { id: string } }
    await call('POST', `/connections/${connection.id}/enabled`, { enabled: false })
    paired = false
    expect(await (await call('POST', `/connections/${connection.id}/enabled`, { enabled: true })).json())
      .toMatchObject({ ok: false, detail: 'Leia o QR code antes de reativar.', connection: { status: 'disconnected', active: false } })
  })
  it('arquivar não desfaz nada na Z-API (o número continua pareado) e libera a instância', async () => {
    const { connection } = await (await create()).json() as { connection: { id: string } }
    calls = []
    expect((await call('DELETE', `/connections/${connection.id}`)).status).toBeLessThan(300)
    expect(calls).toEqual([])
  })
})
