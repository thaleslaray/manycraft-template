import { env } from 'cloudflare:workers'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { templateDraftSchema, templateLanguages } from '../src/channels/template-draft'
import { authenticatedRequest, seedAuth } from './auth-helpers'

// Limites de replica/contratos/meta-whatsapp/limites.md (seção Templates; fonte P/templates/components.md [upd. 2026-06-24]).
const base = { name: 'pedido_confirmado', category: 'utility', language: 'pt_BR', header: { type: 'none' }, body: 'Seu pedido está confirmado.', examples: {}, footer: '', buttons: [] }
const ok = (change: object) => templateDraftSchema.safeParse({ ...base, ...change }).success
const replies = (n: number, size = 5) => Array.from({ length: n }, (_, i) => ({ type: 'reply', text: `${String(i).padStart(size - 1, 'r')}x` }))

it('cabeçalho de texto vai até 60 caracteres', () => {
  expect(ok({ header: { type: 'text', text: 'a'.repeat(60) } })).toBe(true)
  expect(ok({ header: { type: 'text', text: 'a'.repeat(61) } })).toBe(false)
})
it('rodapé até 60 e corpo até 1.024', () => {
  expect(ok({ footer: 'a'.repeat(60) })).toBe(true)
  expect(ok({ footer: 'a'.repeat(61) })).toBe(false)
  expect(ok({ body: 'a'.repeat(1024) })).toBe(true)
  expect(ok({ body: 'a'.repeat(1025) })).toBe(false)
})
it('até 10 botões no total, 10 respostas rápidas, 2 de URL e texto de 25 caracteres', () => {
  expect(ok({ buttons: replies(10) })).toBe(true)
  expect(ok({ buttons: replies(11) })).toBe(false)
  expect(ok({ buttons: [{ type: 'reply', text: 'a'.repeat(25) }] })).toBe(true)
  expect(ok({ buttons: [{ type: 'reply', text: 'a'.repeat(26) }] })).toBe(false)
  const url = (i: number) => ({ type: 'url', text: `Site ${i}`, url: `https://exemplo.test/${i}` })
  expect(ok({ buttons: [url(1), url(2)] })).toBe(true)
  expect(ok({ buttons: [url(1), url(2), url(3)] })).toBe(false)
  expect(ok({ buttons: [...replies(3), url(1), url(2)] })).toBe(true)
  expect(ok({ buttons: [{ type: 'url', text: 'Abrir', url: `https://exemplo.test/${'a'.repeat(1970)}` }] })).toBe(true)
  expect(ok({ buttons: [{ type: 'url', text: 'Abrir', url: `https://exemplo.test/${'a'.repeat(2000)}` }] })).toBe(false)
})
it('respostas rápidas ficam agrupadas, não intercaladas com URL', () => {
  const [a, b] = replies(2)
  expect(ok({ buttons: [a, { type: 'url', text: 'Abrir', url: 'https://exemplo.test' }, b] })).toBe(false)
  expect(ok({ buttons: [{ type: 'url', text: 'Abrir', url: 'https://exemplo.test' }, a, b] })).toBe(true)
})
it('aceita os idiomas oficiais de P/templates/supported-languages.md e recusa o resto', () => {
  expect(templateLanguages).toHaveLength(111)
  for (const language of ['pt_BR', 'pt_PT', 'en_US', 'es_CO', 'zh_HK', 'fil', 'prs_AF', 'zu', 'af']) expect(ok({ language })).toBe(true)
  for (const language of ['xx_FAKE', 'pt-BR', 'pt_br', 'es_VE']) expect(ok({ language })).toBe(false)
})

const input = { ...base, header: { type: 'text', text: 'a'.repeat(60) }, buttons: replies(10) }
const request = (path: string, method = 'GET', body?: unknown) => authenticatedRequest(`message-templates/${path}`, 'a', { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
beforeEach(async () => {
  await seedAuth()
  await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,settings) VALUES ('wa-a','a','whatsapp','meta_whatsapp_cloud','123','{\"wabaId\":\"456\"}')").run()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Rede real proibida no teste') })
})
afterEach(() => vi.restoreAllMocks())

it('rascunho com os limites máximos é salvo e relido sem perda', async () => {
  const response = await request('wa-a', 'POST', input)
  expect(response.status).toBe(201)
  expect(await (await request('wa-a')).json()).toEqual([expect.objectContaining({ header: input.header, buttons: input.buttons, unavailableReason: null })])
})

const BODY = { type: 'BODY', text: 'Seu código chegou.' }
const remote = (id: string, components: unknown[], extra: object = {}) => ({ id, name: `modelo_${id}`, language: 'pt_BR', status: 'APPROVED', category: 'UTILITY', components, ...extra })
const sync = async (data: unknown[]) => {
  const { giveCredentials } = await import('./credentials')
  await giveCredentials(env, 'wa-a', { accessToken: 'TESTONLY', phoneNumberId: '123', wabaId: '456' })
  vi.mocked(fetch).mockResolvedValue(Response.json({ data }))
  expect((await request('wa-a/sync', 'POST')).status).toBe(200)
  return await (await request('wa-a')).json() as { name: string; status: string; unavailableReason: string | null; header: { type: string; text?: string }; buttons: { type: string; text: string }[] }[]
}
it.each([
  ['COPY_CODE', { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE', example: 'PROMO20' }] }, /copiar código/i],
  ['OTP', { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copiar código' }] }, /OTP|autenticação/i],
  ['FLOW', { type: 'BUTTONS', buttons: [{ type: 'FLOW', text: 'Abrir', flow_id: '1' }] }, /Flow/],
  ['MPM', { type: 'BUTTONS', buttons: [{ type: 'MPM', text: 'Ver itens' }] }, /multiproduto|catálogo/i],
  ['CATALOG', { type: 'BUTTONS', buttons: [{ type: 'CATALOG', text: 'Catálogo' }] }, /catálogo/i],
  ['VOICE_CALL', { type: 'BUTTONS', buttons: [{ type: 'VOICE_CALL', text: 'Ligar' }] }, /ligação|chamada/i],
  ['carrossel', { type: 'CAROUSEL', cards: [] }, /carrossel/i],
  ['oferta por tempo limitado', { type: 'LIMITED_TIME_OFFER', limited_time_offer: { text: 'Oferta', has_expiration: true } }, /tempo limitado/i],
  ['cabeçalho de localização', { type: 'HEADER', format: 'LOCATION' }, /localização/i],
])('importar modelo com %s o marca como indisponível, com motivo em português', async (_nome, component, reason) => {
  const list = await sync([remote('1', [component, BODY])])
  expect(list).toEqual([expect.objectContaining({ name: 'modelo_1', status: 'approved', unavailableReason: expect.stringMatching(reason) })])
})
it('modelo de autenticação aprovado é indisponível mesmo só com corpo', async () => {
  const list = await sync([remote('2', [BODY], { category: 'AUTHENTICATION' })])
  expect(list[0].unavailableReason).toMatch(/autenticação/i)
})
it('modelo sem corpo também é importado como indisponível, sem sumir da lista', async () => {
  const list = await sync([remote('3', [{ type: 'CAROUSEL', cards: [] }])])
  expect(list).toHaveLength(1)
  expect(list[0].unavailableReason).toBeTruthy()
})
it('importar mantém cabeçalho de 41 a 60 caracteres e até 10 botões suportados, sem marcar indisponível', async () => {
  const header = 'h'.repeat(55)
  const buttons = [...replies(8).map(b => ({ type: 'QUICK_REPLY', text: b.text })), { type: 'URL', text: 'Abrir', url: 'https://exemplo.test/x' }, { type: 'PHONE_NUMBER', text: 'Ligar', phone_number: '+5511999990000' }]
  const list = await sync([remote('4', [{ type: 'HEADER', format: 'TEXT', text: header }, BODY, { type: 'BUTTONS', buttons }])])
  expect(list).toEqual([expect.objectContaining({ unavailableReason: null, header: { type: 'text', text: header } })])
  expect(list[0].buttons).toHaveLength(9)
})
it('modelo importado e usável não traz motivo; sincronizar de novo atualiza o motivo se o conteúdo mudou na Meta', async () => {
  const first = await sync([remote('5', [BODY, { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE', example: 'X' }] }])])
  expect(first[0].unavailableReason).toBeTruthy()
  vi.mocked(fetch).mockResolvedValue(Response.json({ data: [remote('5', [BODY])] }))
  expect((await request('wa-a/sync', 'POST')).status).toBe(200)
  expect((await (await request('wa-a')).json() as { unavailableReason: string | null }[])[0].unavailableReason).toBeNull()
})
