import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import handler, { app } from '../src/index'
import type { Env } from '../src/env'
import { authenticatedRequest, fixtureCookie, origin, seedAuth } from './auth-helpers'

// A Hotmart reenvia eventos. Todo evento 2.0.0 traz o campo "id", "código único de identificação do evento recebido"
// (developers.hotmart.com/docs/pt-BR/2.0.0/webhook/purchase-webhook e cart-abandonment-webhook, conferido em 2026-11-13).
// A reentrega responde 200 sem reprocessar. Só dados fictícios.
let cookie = '', url = ''
const panel = (path: string, method = 'GET', body?: unknown, workspace = 'a', session = cookie) =>
  authenticatedRequest(path, workspace, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, session)
/** Workflows falsos: guardam as execuções criadas e podem ficar fora do ar. */
function fakeFlows() {
  const flows = { created: [] as string[], down: false }
  const binding = {
    create: async ({ id }: { id: string }) => { if (flows.down) throw new Error('workflows fora do ar'); flows.created.push(id); return {} },
    get: async () => ({ status: async () => ({ status: 'unknown' }) }),
  }
  return { flows, bindings: { ...env, FLOW_RUN: binding } as unknown as Env }
}
let flows: ReturnType<typeof fakeFlows>['flows'], bindings: Env
const deliver = async (body: unknown, to = url) => {
  const response = await app.request(to.replace(/^https?:\/\/[^/]+/, origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, bindings)
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}
const purchase = (id?: string) => ({ ...(id === undefined ? {} : { id }), creation_date: 1_700_000_000_000, event: 'PURCHASE_APPROVED', version: '2.0.0',
  data: { buyer: { email: 'comprador@exemplo.test', name: 'Comprador Ficticio' }, product: { id: 123, name: 'Curso X' }, purchase: { status: 'APPROVED' } } })
const runs = () => env.DB.prepare("SELECT count(*) AS n FROM flow_runs WHERE workspace_id='a' AND id LIKE 'hotmart-%'").first<number>('n')
const marks = () => env.DB.prepare('SELECT workspace_id,event_id FROM hotmart_events ORDER BY workspace_id,event_id').all<{ workspace_id: string; event_id: string }>().then(r => r.results)

beforeEach(async () => {
  await seedAuth()
  cookie = await fixtureCookie()
  ;({ flows, bindings } = fakeFlows())
  url = (await (await panel('integrations/hotmart', 'PUT', {})).json() as { url: string }).url
  // Automação publicada com gatilho Hotmart ativo; o comprador é o contato c-a, que já conversa pelo canal ch-a.
  await env.DB.prepare("UPDATE contacts SET email='comprador@exemplo.test' WHERE id='c-a'").run()
  await env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('v-h','a','auto-a',1,(SELECT draft_graph FROM automations WHERE id='auto-a'))").run()
  await env.DB.prepare("UPDATE automations SET status='live',published_version_id='v-h' WHERE id='auto-a'").run()
  const trigger = await (await panel('automations/auto-a/triggers', 'POST', { type: 'hotmart', name: 'Compra', node_id: 't', config: { events: ['PURCHASE_APPROVED'], product_ids: [] } })).json() as { id: string }
  expect((await panel(`automations/auto-a/triggers/${trigger.id}`, 'PATCH', { state: 'active' })).status).toBe(200)
})

it('reentrega do mesmo evento responde 200 sem reprocessar', async () => {
  expect(await deliver(purchase('evt-1'))).toEqual({ status: 200, body: { accepted: true, started: 1 } })
  expect(await deliver(purchase('evt-1'))).toEqual({ status: 200, body: { accepted: true, duplicate: true, started: 0 } })
  expect(flows.created).toHaveLength(1)
  expect(await runs()).toBe(1)
  expect(await marks()).toEqual([{ workspace_id: 'a', event_id: 'evt-1' }])
})

it('eventos com ids diferentes são processados cada um', async () => {
  expect((await deliver(purchase('evt-1'))).body).toEqual({ accepted: true, started: 1 })
  expect((await deliver(purchase('evt-2'))).body).toEqual({ accepted: true, started: 1 })
  expect(await runs()).toBe(2)
})

it('o mesmo id em outro espaço não conta como reentrega', async () => {
  const urlB = (await (await panel('integrations/hotmart', 'PUT', {}, 'b', await fixtureCookie('b'))).json() as { url: string }).url
  expect((await deliver(purchase('evt-1'))).body).toEqual({ accepted: true, started: 1 })
  expect((await deliver(purchase('evt-1'), urlB)).body).toEqual({ accepted: true, started: 0 })
  // O espaço b não tem gatilho Hotmart: nada iniciou, então a marca dele sai (o "reenviar" depois de publicar funciona).
  expect(await marks()).toEqual([{ workspace_id: 'a', event_id: 'evt-1' }])
})

it('evento sem id segue sendo processado como antes (não há o que comparar)', async () => {
  expect((await deliver(purchase())).body).toEqual({ accepted: true, started: 1 })
  expect((await deliver(purchase())).body).toEqual({ accepted: true, started: 1 })
  expect(await marks()).toEqual([])
})

it('falha no meio solta o id: a reentrega termina o trabalho sem duplicar a execução', async () => {
  flows.down = true
  expect((await deliver(purchase('evt-1'))).status).toBe(500)
  expect(await marks()).toEqual([])
  expect(await runs()).toBe(1)
  flows.down = false
  expect(await deliver(purchase('evt-1'))).toEqual({ status: 200, body: { accepted: true, started: 1 } })
  expect(await runs()).toBe(1)
  expect(flows.created).toHaveLength(1)
  expect((await deliver(purchase('evt-1'))).body).toEqual({ accepted: true, duplicate: true, started: 0 })
})

it('o cron diário apaga as marcas com mais de 60 dias (o prazo do histórico da Hotmart) e mantém as recentes', async () => {
  const day = 86_400_000, now = Date.now()
  await env.DB.batch([['velho', now - 61 * day], ['recente', now - 59 * day]].map(([id, at]) =>
    env.DB.prepare("INSERT INTO hotmart_events (workspace_id,event_id,received_at) VALUES ('a',?,?)").bind(id, at)))
  await handler.scheduled({ scheduledTime: now, cron: '0 3 * * *', noRetry() {} }, env)
  expect(await marks()).toEqual([{ workspace_id: 'a', event_id: 'recente' }])
})

it('evento que não iniciou nenhuma execução não fica marcado: o "reenviar" do histórico depois de publicar a automação inicia', async () => {
  await env.DB.prepare("UPDATE automations SET status='stopped' WHERE id='auto-a'").run()
  expect(await deliver(purchase('evt-1'))).toEqual({ status: 200, body: { accepted: true, started: 0 } })
  expect(await marks()).toEqual([])
  await env.DB.prepare("UPDATE automations SET status='live' WHERE id='auto-a'").run()
  expect(await deliver(purchase('evt-1'))).toEqual({ status: 200, body: { accepted: true, started: 1 } })
  expect(await marks()).toEqual([{ workspace_id: 'a', event_id: 'evt-1' }])
  expect((await deliver(purchase('evt-1'))).body).toEqual({ accepted: true, duplicate: true, started: 0 })
})

it.each([['vazio', ''], ['nulo', null], ['longo demais', 'x'.repeat(201)], ['objeto', { a: 1 }]])('id %s conta como ausente: processa sem marcar, não dá 400', async (_name, id) => {
  expect(await deliver({ ...purchase(), id })).toEqual({ status: 200, body: { accepted: true, started: 1 } })
  expect(await marks()).toEqual([])
})
