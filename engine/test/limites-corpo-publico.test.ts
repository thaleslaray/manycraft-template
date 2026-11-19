import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../src/index'
import { authenticatedRequest, fixtureCookie, origin, seedAuth } from './auth-helpers'

// Auditoria de segurança, D2: as rotas públicas também têm teto de corpo, aplicado antes de ler o JSON.
beforeEach(seedAuth)

const pad = (bytes: number) => JSON.stringify({ lixo: 'x'.repeat(bytes) })
const post = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
  app.request(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }, env)
/** Corpo em fluxo (sem Content-Length) de 1 MB em pedaços de 16 KB; conta quanto o servidor puxou. */
function streamed(total = 1_000_000) {
  const state = { pulled: 0 }
  const chunk = new TextEncoder().encode('x'.repeat(16_384))
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (state.pulled >= total) { controller.close(); return }
    state.pulled += chunk.byteLength; controller.enqueue(chunk)
  } }, { highWaterMark: 0 })
  return { body, state }
}
const stream = (path: string, body: ReadableStream) => app.request(`${origin}${path}`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half' } as RequestInit, env)

describe('D2 teto de corpo nas rotas públicas', () => {
  it.each(['/api/pixel/event', '/api/invite-preview', '/api/hooks/hotmart/' + 'a'.repeat(36)])('%s recusa 1 MB com 413', async path => {
    expect((await post(path, pad(1_000_000))).status).toBe(413)
  })
  it('API pública v1 recusa 1 MB com 413, mesmo com chave inválida', async () => {
    expect((await post('/api/public/v1/sending/sendContent', pad(1_000_000), { authorization: 'Bearer a:errada' })).status).toBe(413)
  })
  it('corpo sem Content-Length é cortado na leitura, sem consumir o corpo inteiro', async () => {
    for (const path of ['/api/pixel/event', '/api/invite-preview', '/api/hooks/hotmart/' + 'a'.repeat(36), '/api/public/v1/sending/sendContent']) {
      const { body, state } = streamed()
      const response = await stream(path, body)
      expect(response.status, path).toBe(413)
      expect(state.pulled, path).toBeLessThan(500_000)
    }
  })
  it('corpo normal continua passando pelas rotas públicas', async () => {
    expect((await post('/api/pixel/event', JSON.stringify({ token: 'x', kind: 'conversion' }))).status).toBe(401)
    expect((await post('/api/invite-preview', JSON.stringify({ token: 't'.repeat(40) }))).status).toBe(404)
    expect((await post('/api/hooks/hotmart/' + 'a'.repeat(36), JSON.stringify({ event: 'X', data: {} }))).status).toBe(404)
  })
  it('sendContent legítimo de 60 KB passa do teto (o limite da API pública é folgado)', async () => {
    const cookie = await fixtureCookie('a')
    const key = (await (await authenticatedRequest('api-keys', 'a', { method: 'POST' }, cookie)).json() as { token: string }).token
    const messages = Array.from({ length: 10 }, () => ({ type: 'text', text: 'a'.repeat(2000),
      buttons: Array.from({ length: 3 }, () => ({ type: 'url', caption: 'Abrir', url: 'https://example.com/' + 'p'.repeat(2000) })) }))
    const body = JSON.stringify({ subscriber_id: 'c-a', data: { version: 'v2', content: { messages } } })
    expect(body.length).toBeGreaterThan(64 * 1024)
    const response = await post('/api/public/v1/sending/sendContent', body, { authorization: `Bearer ${key}` })
    expect(response.status).not.toBe(413)
  })
})
