import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context) } })
const { configureDataMode } = await import('../../data/api.ts')
const { getInsights } = await import('../../data/insights.ts')
const originalFetch = globalThis.fetch
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
afterEach(() => { globalThis.fetch = originalFetch; configureDataMode(undefined) })

test('período e canal filtram API real sem recalcular agregados retornados', async () => {
  configureDataMode('real')
  const report = { period: 14, points: [{ date: '2026-10-23', contacts: 3, messages: 5, clicks: 0 }], automations: [], totals: { contacts: 3, messages: 5, clicks: 0, clickRate: 0 } }
  const calls = []
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return json(url === '/api/session/workspace' ? { workspace_id: 'real', name: 'Operação' } : report) }
  assert.deepEqual(await getInsights('demo', 14, 'telegram'), report)
  const url = new URL(calls[1].url, 'http://localhost')
  assert.equal(url.pathname, '/api/insights')
  assert.equal(Number(url.searchParams.get('to')) - Number(url.searchParams.get('from')), 14 * 86400)
  assert.equal(url.searchParams.get('channel'), 'telegram')
  assert.equal(calls[1].init.headers.get('x-workspace'), 'real')
})

test('validação impede período/canal inválidos e preserva erros de serviço', async () => {
  configureDataMode('real')
  globalThis.fetch = async url => url === '/api/session/workspace' ? json({ workspace_id: 'real', name: 'Operação' }) : json({ error: 'Consulta indisponível' }, 503)
  await assert.rejects(getInsights('demo', 1), /período/)
  await assert.rejects(getInsights('demo', 7, 'inventado'), /canal/)
  await assert.rejects(getInsights('demo', 7), /Consulta indisponível/)
})

const { passoDoEixo, rotuloDoEixo } = await import('./insights-logic.ts')

test('eixo do gráfico: sete intervalos de passo redondo e rótulos curtos', () => {
  assert.equal(passoDoEixo(23), 4)
  assert.equal(passoDoEixo(70_000), 10_000)
  assert.equal(passoDoEixo(0), 1)
  assert.equal(passoDoEixo(23_831), 4_000)
  for (const max of [1, 7, 23, 999, 23_831, 84_277]) assert.ok(passoDoEixo(max) * 7 >= max, `o topo cobre ${max}`)
  assert.equal(rotuloDoEixo(70_000), '70 mil')
  assert.equal(rotuloDoEixo(4), '4')
  assert.equal(rotuloDoEixo(1_500), '1.500')
})
