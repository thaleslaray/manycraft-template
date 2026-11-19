import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareTemplateMessage } from '../src/inbox/template-message'
import { refreshMarketing } from '../src/channels/core/marketing'
import { authenticatedRequest, seedAuth } from './auth-helpers'
import { giveCredentials } from './credentials'

// Ficha wa-09. Elegibilidade: GET /{waba_id}?fields=marketing_messages_onboarding_status (ELIGIBLE | ONBOARDED), P/marketing-messages/onboarding.md.
let graph: { status?: number; body: unknown }
const settings = async () => JSON.parse((await env.DB.prepare("SELECT settings FROM channels WHERE id='wa-a'").first<string>('settings'))!) as Record<string, any>
const urls = () => vi.mocked(fetch).mock.calls.map(c => String(c[0]))
const answer = (marketing_messages_onboarding_status: string, disabled = false) =>
  { graph = { body: { marketing_messages_onboarding_status, disable_marketing_messages_on_cloud_api: disabled, id: '456' } } }
beforeEach(async () => {
  await seedAuth()
  await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,settings) VALUES ('wa-a','a','whatsapp','meta_whatsapp_cloud','123','{\"wabaId\":\"456\"}')").run()
  await giveCredentials(env, 'wa-a', { accessToken: 'TESTONLY', phoneNumberId: '123' })
  await env.DB.prepare(`INSERT INTO message_templates(id,workspace_id,channel_id,group_id,name_human,language_code,status,category,body)
    VALUES ('promo','a','wa-a','promo','promo_outubro','pt_BR','approved','marketing','Oferta de hoje'),('util','a','wa-a','util','pedido','pt_BR','approved','utility','Pedido pronto')`).run()
  answer('ONBOARDED')
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    expect(init!.headers).toMatchObject({ Authorization: 'Bearer TESTONLY' })
    return Response.json(graph.body, { status: graph.status ?? 200 })
  })
})
afterEach(() => vi.restoreAllMocks())

it('conta ONBOARDED fica habilitada e a checagem guarda status e data na conexão', async () => {
  const before = Date.now()
  expect(await refreshMarketing(env, 'a', 'wa-a')).toMatchObject({ supported: true, enabled: true, status: 'ONBOARDED', notice: null })
  expect(urls()).toEqual(['https://graph.facebook.com/v26.0/456?fields=marketing_messages_onboarding_status,disable_marketing_messages_on_cloud_api'])
  const saved = (await settings()).marketingMessages
  expect(saved).toMatchObject({ enabled: true, status: 'ONBOARDED' })
  expect(saved.checkedAt).toBeGreaterThanOrEqual(before)
  expect((await settings()).wabaId).toBe('456')
})
it('conta ELIGIBLE (termos não aceitos) segue em /messages e o aviso traz os prazos e o que fazer', async () => {
  answer('ELIGIBLE')
  const view = await refreshMarketing(env, 'a', 'wa-a')
  expect(view).toMatchObject({ enabled: false, status: 'ELIGIBLE' })
  expect(view.notice).toMatch(/13\/04\/2027/)
  expect(view.notice).toMatch(/13\/10\/2027/)
  expect(view.notice).toMatch(/Aceitar termos/)
  expect((await settings()).marketingMessages).toMatchObject({ enabled: false, status: 'ELIGIBLE' })
})
it('sem aceite e com marketing desligado na API de nuvem o aviso diz que o envio está bloqueado', async () => {
  answer('ELIGIBLE', true)
  expect((await refreshMarketing(env, 'a', 'wa-a')).notice).toMatch(/bloqueado/)
})
it('falha na checagem mantém o último estado e não inventa habilitação', async () => {
  await refreshMarketing(env, 'a', 'wa-a')
  graph = { status: 500, body: { error: { code: 2 } } }
  expect(await refreshMarketing(env, 'a', 'wa-a')).toMatchObject({ enabled: true, status: 'ONBOARDED', error: expect.stringMatching(/Não foi possível/) })
  graph = { status: 400, body: { error: { code: 100, message: 'Unknown field' } } }
  await env.DB.prepare("UPDATE channels SET settings='{\"wabaId\":\"456\"}' WHERE id='wa-a'").run()
  expect(await refreshMarketing(env, 'a', 'wa-a')).toMatchObject({ enabled: false, status: null, checkedAt: null })
})
it('token recusado (190) marca a conexão com erro', async () => {
  graph = { status: 401, body: { error: { code: 190 } } }
  await expect(refreshMarketing(env, 'a', 'wa-a')).rejects.toMatchObject({ status: 409 })
  expect(await env.DB.prepare("SELECT connection_state AS s FROM channels WHERE id='wa-a'").first<string>('s')).toBe('error')
})
it('conexão sem ID da conta do WhatsApp Business (WABA) não consulta a Meta e diz o que falta', async () => {
  await env.DB.prepare("UPDATE channels SET settings='{}' WHERE id='wa-a'").run()
  expect(await refreshMarketing(env, 'a', 'wa-a')).toMatchObject({ supported: true, enabled: false, error: expect.stringMatching(/ID da conta do WhatsApp Business \(WABA\)/) })
  expect(fetch).not.toHaveBeenCalled()
})
it('conexão de outro provedor não tem Marketing Messages API', async () => {
  await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id) VALUES ('uz','a','whatsapp','uazapi','x')").run()
  expect(await refreshMarketing(env, 'a', 'uz')).toMatchObject({ supported: false, enabled: false })
  expect(fetch).not.toHaveBeenCalled()
})

it('o envio de modelo carrega a categoria; só marketing consulta a conta, e só uma vez por dia', async () => {
  expect((await prepareTemplateMessage(env, 'a', 'wa-a', { id: 'util', params: {} })).message).toMatchObject({ category: 'utility' })
  expect(fetch).not.toHaveBeenCalled()
  expect((await prepareTemplateMessage(env, 'a', 'wa-a', { id: 'promo', params: {} })).message).toMatchObject({ category: 'marketing' })
  expect((await settings()).marketingMessages).toMatchObject({ enabled: true })
  await prepareTemplateMessage(env, 'a', 'wa-a', { id: 'promo', params: {} })
  expect(fetch).toHaveBeenCalledTimes(1)
  await env.DB.prepare("UPDATE channels SET settings=json_set(settings,'$.marketingMessages.checkedAt',?) WHERE id='wa-a'").bind(Date.now() - 25 * 3600_000).run()
  await prepareTemplateMessage(env, 'a', 'wa-a', { id: 'promo', params: {} })
  expect(fetch).toHaveBeenCalledTimes(2)
})
it('checagem que falha durante o envio não impede o envio nem é repetida a cada mensagem', async () => {
  graph = { status: 500, body: {} }
  expect((await prepareTemplateMessage(env, 'a', 'wa-a', { id: 'promo', params: {} })).message).toMatchObject({ category: 'marketing' })
  await prepareTemplateMessage(env, 'a', 'wa-a', { id: 'promo', params: {} })
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('rotas do painel: GET devolve o estado (consultando se nunca checou) e POST força nova checagem', async () => {
  const get = await authenticatedRequest('connections/wa-a/marketing')
  expect(get.status).toBe(200)
  expect(await get.json()).toMatchObject({ enabled: true, status: 'ONBOARDED' })
  answer('ELIGIBLE')
  expect(await (await authenticatedRequest('connections/wa-a/marketing')).json()).toMatchObject({ enabled: true })
  const post = await authenticatedRequest('connections/wa-a/marketing', 'a', { method: 'POST' })
  expect(await post.json()).toMatchObject({ enabled: false, status: 'ELIGIBLE', notice: expect.any(String) })
  expect((await authenticatedRequest('connections/wa-a/marketing', 'b')).status).toBe(404)
})

it('134102 no envio desliga a rota de marketing até a próxima checagem confirmar', async () => {
  await refreshMarketing(env, 'a', 'wa-a')
  const { noteConnectionFailure } = await import('../src/channels/core/failure')
  await noteConnectionFailure(env, 'a', 'wa-a', { ok: false, reason: 'rejected', code: '134102', detail: '' })
  expect((await settings()).marketingMessages).toMatchObject({ enabled: false, status: 'ONBOARDED' })
  await noteConnectionFailure(env, 'a', 'uz-sem-estado', { ok: false, reason: 'rejected', code: '134102', detail: '' })
  expect(await env.DB.prepare("SELECT connection_state AS s FROM channels WHERE id='wa-a'").first<string>('s')).toBe('connected')
})

it('depois do 134102 o próximo envio de marketing consulta a Meta de novo, sem esperar 24 horas', async () => {
  await refreshMarketing(env, 'a', 'wa-a')
  const { noteConnectionFailure } = await import('../src/channels/core/failure')
  await noteConnectionFailure(env, 'a', 'wa-a', { ok: false, reason: 'rejected', code: '134102', detail: '' })
  answer('ELIGIBLE')
  vi.mocked(fetch).mockClear()
  await prepareTemplateMessage(env, 'a', 'wa-a', { id: 'promo', params: {} })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect((await settings()).marketingMessages).toMatchObject({ enabled: false, status: 'ELIGIBLE' })
})
it('conta ONBOARDED recusada com 134102 não ganha o aviso de "ainda não usa a API de Mensagens de Marketing"', async () => {
  await refreshMarketing(env, 'a', 'wa-a')
  const { noteConnectionFailure } = await import('../src/channels/core/failure')
  await noteConnectionFailure(env, 'a', 'wa-a', { ok: false, reason: 'rejected', code: '134102', detail: '' })
  const { connectionMarketing } = await import('../src/channels/core/marketing')
  vi.mocked(fetch).mockClear()
  const view = await connectionMarketing(env, 'a', 'wa-a').catch(e => e)
  expect(view.notice ?? '').not.toMatch(/ainda não usa/)
  // ONBOARDED sem estar habilitada só acontece quando a Meta recusou o envio: o aviso diz isso.
  await env.DB.prepare("UPDATE channels SET settings=json_set(settings,'$.marketingMessages',json(?)) WHERE id='wa-a'").bind(JSON.stringify({ enabled: false, status: 'ONBOARDED', checkedAt: Date.now() })).run()
  const fresco = await connectionMarketing(env, 'a', 'wa-a')
  expect(fresco).toMatchObject({ enabled: false, status: 'ONBOARDED' })
  expect(fresco.notice).toMatch(/134102/)
  expect(fresco.notice).not.toMatch(/ainda não usa/)
})
