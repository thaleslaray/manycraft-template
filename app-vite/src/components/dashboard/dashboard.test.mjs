import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context)
} })
const { configureDataMode } = await import('../../data/api.ts')
const { getDashboard, reportFilters, reportQuery } = await import('../../data/dashboard.ts')
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; configureDataMode(undefined) })
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

test('painel lê API com período/canal e usa contexto autenticado em vez do workspace da rota', async () => {
  configureDataMode('real')
  const calls = []
  const summary = { reference_at: '2026-10-23T12:00:00Z', period_days: 7, metrics: [{ key: 'contacts', value: 4, delta: null }], most_used: [], empty: false }
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return json(url === '/api/session/workspace' ? { workspace_id: 'real', name: 'Operação' } : summary) }
  assert.deepEqual(await getDashboard('workspace-da-url', { from: 100, to: 200, channel: 'telegram' }), summary)
  const call = calls[1]
  assert.equal(call.url, '/api/dashboard?from=100&to=200&channel=telegram')
  assert.equal(call.init.headers.get('x-workspace'), 'real')
  assert.deepEqual(reportFilters(7, 'all', 1_000_000_000), { from: 395200, to: 1000000, channel: 'all' })
  assert.equal(reportQuery({ from: 1, to: 2, channel: 'all' }), 'from=1&to=2')
  assert.throws(() => reportQuery({ from: 2, to: 1 }), /período/)
})

test('falha do backend não é substituída por demonstração', async () => {
  configureDataMode('real')
  globalThis.fetch = async url => url === '/api/session/workspace' ? json({ workspace_id: 'real', name: 'Operação' }) : json({ error: 'Banco indisponível' }, 503)
  await assert.rejects(getDashboard('demo'), /Banco indisponível/)
})

const { abasDeCanal, proximosPassos, rotuloDaContagem } = await import('./inicio-logic.ts')

test('abas do Início: Todos os canais e uma por tipo conectado, na ordem fixa, sem repetir', () => {
  assert.deepEqual(abasDeCanal(undefined).map(a => a.value), ['all'])
  const canais = [
    { id: '1', name: 'a', type: 'instagram', status: 'connected' },
    { id: '2', name: 'b', type: 'instagram', status: 'connected' },
    { id: '3', name: 'c', type: 'telegram', status: 'connected' },
    { id: '4', name: 'd', type: 'whatsapp', status: 'error' },
    { id: '5', name: 'e', type: 'sms', status: 'connected' },
  ]
  assert.deepEqual(abasDeCanal(canais), [
    { value: 'all', label: 'Todos os canais' },
    { value: 'telegram', label: 'Telegram' },
    { value: 'instagram', label: 'Instagram' },
  ])
})

test('primeiros passos: no máximo três linhas e contagem de concluídos', () => {
  const passos = [1, 2, 3, 4].map(n => ({ key: `k${n}`, label: `p${n}`, done: n === 1 }))
  const r = proximosPassos(passos)
  assert.equal(r.linhas.length, 3)
  assert.equal(r.concluidos, 1)
  assert.equal(r.total, 4)
  assert.equal(proximosPassos(undefined).total, 0)
  assert.equal(r.pendente, true)
})

test('primeiros passos: com tudo feito o cartão some (não fica "5 de 5 concluídos")', () => {
  const feitos = [1, 2, 3, 4, 5].map(n => ({ key: `k${n}`, label: `p${n}`, done: true }))
  assert.equal(proximosPassos(feitos).pendente, false)
  assert.equal(proximosPassos([...feitos.slice(1), { key: 'k6', label: 'p6', done: false }]).pendente, true)
})

test('contagem do Início no singular e no plural', () => {
  assert.equal(rotuloDaContagem(1, 'canal conectado', 'canais conectados'), 'canal conectado')
  assert.equal(rotuloDaContagem(0, 'canal conectado', 'canais conectados'), 'canais conectados')
  assert.equal(rotuloDaContagem(3, 'contato', 'contatos'), 'contatos')
})
