import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import { authenticatedRequest, origin, seedAuth } from './auth-helpers'

beforeEach(seedAuth)

it('widget de site: script público com o link, e diagnóstico de HTTPS, script presente e duplicado', async () => {
  const r = await authenticatedRequest('site-widgets', 'a', { method: 'POST', body: JSON.stringify({ label: 'Fale conosco', target_url: 'https://t.me/bot?start=site' }) })
  expect(r.status).toBe(201)
  const { id } = await r.json() as { id: string }
  const js = await (await app.request(`${origin}/api/site-widget/${id}.js`, {}, env)).text()
  expect(js).toContain('https://t.me/bot?start=site')
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`<script src="https://x/api/site-widget/${id}.js"></script><script src="https://x/api/site-widget/${id}.js"></script>`))
  const d = await (await authenticatedRequest(`site-widgets/${id}/diagnose`, 'a', { method: 'POST', body: JSON.stringify({ page_url: 'https://loja.example/' }) })).json() as { ok: boolean; checks: { check: string; ok: boolean }[] }
  expect(d.ok).toBe(false)
  expect(d.checks.find(c => c.check === 'script')?.ok).toBe(true)
  expect(d.checks.find(c => c.check === 'duplicate')?.ok).toBe(false)
  vi.restoreAllMocks()
})

type Diagnosis = { ok: boolean; checks: { check: string; ok: boolean; detail: string }[] }
const newWidget = async () => (await (await authenticatedRequest('site-widgets', 'a', { method: 'POST', body: JSON.stringify({ label: 'Fale conosco', target_url: 'https://t.me/bot?start=site' }) })).json() as { id: string }).id
const diagnose = async (id: string, page_url: string) => await (await authenticatedRequest(`site-widgets/${id}/diagnose`, 'a', { method: 'POST', body: JSON.stringify({ page_url }) })).json() as Diagnosis
const check = (d: Diagnosis, name: string) => d.checks.find(c => c.check === name)
/** Internet falsa: responde por endereço e, como o fetch de verdade, segue sozinha o redirecionamento quando redirect não é 'manual'. */
function fakeWeb(pages: Record<string, () => Response>) {
  const visited: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    let address = input instanceof Request ? input.url : String(input)
    for (let hop = 0; ; hop++) {
      visited.push(address)
      const response = pages[address]?.() ?? new Response('não existe', { status: 404 })
      const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
      if (!location || init?.redirect === 'manual') return response
      if (hop >= 20) throw new TypeError('Too many redirects')
      address = new URL(location, address).href
    }
  })
  return visited
}
const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { location: to } })
const pageWith = (id: string) => () => new Response(`<html><script src="https://engine.example/api/site-widget/${id}.js"></script></html>`)

describe('diagnóstico do widget: cada destino passa pela regra das requisições externas', () => {
  afterEach(() => { vi.restoreAllMocks() })
  it('não segue redirecionamento para endereço interno', async () => {
    const id = await newWidget()
    const visited = fakeWeb({ 'https://loja.example/': redirect('http://169.254.169.254/latest/meta-data/'), 'http://169.254.169.254/latest/meta-data/': pageWith(id) })
    const d = await diagnose(id, 'https://loja.example/')
    expect(visited).toEqual(['https://loja.example/'])
    expect(check(d, 'domain')).toMatchObject({ ok: false, detail: expect.stringContaining('redireciona') })
    expect(check(d, 'script')?.ok).toBe(false)
    expect(d.ok).toBe(false)
  })
  it('segue redirecionamentos públicos, inclusive relativos, até a página final', async () => {
    const id = await newWidget()
    const visited = fakeWeb({ 'http://loja.example/': redirect('https://loja.example/', 301), 'https://loja.example/': redirect('/pt/'), 'https://loja.example/pt/': pageWith(id) })
    const d = await diagnose(id, 'http://loja.example/')
    expect(visited).toEqual(['http://loja.example/', 'https://loja.example/', 'https://loja.example/pt/'])
    expect(check(d, 'domain')?.ok).toBe(true)
    expect(check(d, 'script')?.ok).toBe(true)
  })
  it('para depois de 5 redirecionamentos', async () => {
    const id = await newWidget()
    const visited = fakeWeb({ 'https://loja.example/a': redirect('/b'), 'https://loja.example/b': redirect('/a') })
    const d = await diagnose(id, 'https://loja.example/a')
    expect(visited).toHaveLength(6)
    expect(check(d, 'domain')).toMatchObject({ ok: false, detail: 'A página redireciona mais de 5 vezes.' })
  })
  it('recusa endereço com usuário e senha sem abrir a página', async () => {
    const id = await newWidget()
    const visited = fakeWeb({})
    const d = await diagnose(id, 'https://usuario:senha@loja.example/')
    expect(visited).toEqual([])
    expect(check(d, 'domain')).toMatchObject({ ok: false, detail: 'O endereço não pode conter usuário ou senha.' })
  })
  it('lê só o começo da página (até 2 MB) e não fica preso numa resposta sem fim', async () => {
    const id = await newWidget()
    const state = { pulled: 0 }
    const filler = new TextEncoder().encode('x'.repeat(65_536))
    const head = new TextEncoder().encode(`<script src="https://engine.example/api/site-widget/${id}.js"></script>`)
    fakeWeb({ 'https://loja.example/': () => new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      controller.enqueue(state.pulled ? filler : head); state.pulled += state.pulled ? filler.byteLength : head.byteLength
    } }, { highWaterMark: 0 })) })
    const d = await diagnose(id, 'https://loja.example/')
    expect(check(d, 'script')?.ok).toBe(true)
    expect(state.pulled).toBeLessThanOrEqual(2_000_000 + filler.byteLength)
  })
})
