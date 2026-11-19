import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { app } from '../src/index'
import { metaWhatsappCloud } from '../src/channels/meta-whatsapp-cloud'
import { matchesKeyword } from '../src/flow/matcher'
import { fixtureCookie, seedAuth } from './auth-helpers'

let cookie = ''
beforeEach(async () => { await seedAuth(); cookie = await fixtureCookie() })
const request = (path: string, init: RequestInit = {}) => app.request(`/api/${path}`, { ...init, headers: { cookie, 'x-workspace': 'a', 'content-type': 'application/json', origin: 'https://engine.test', ...init.headers } }, { ...env, APP_ENV: 'development', PUBLIC_BASE_URL: 'http://localhost:5822' })
const trigger = { id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} }
async function publish(nodes: unknown[], edges: unknown[]) {
  const graph = { nodes: [trigger, ...nodes], edges }
  expect((await request('automations/auto-a/draft', { method: 'PUT', body: JSON.stringify({ graph }) })).status).toBe(200)
  const response = await request('automations/auto-a/publish', { method: 'POST' })
  return { status: response.status, text: await response.text() }
}
const message = (blocks: unknown[]) => [{ id: 'm', type: 'message', position: { x: 200, y: 0 }, config: { blocks } }]
const toM = [{ from: 't', port: 'next', to: 'm' }]
const whatsapp = () => env.DB.batch([
  env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id) VALUES ('wa-x','a','whatsapp','meta_whatsapp_cloud','777')"),
  env.DB.prepare("UPDATE triggers SET channel_id='wa-x' WHERE workspace_id='a'"),
])
const button = (label: string) => ({ kind: 'button', id: label, label, action: { type: 'go_to_node' } })

it('D1: duas ou mais respostas na mesma mensagem publicam na conexão oficial do WhatsApp', async () => {
  await whatsapp()
  const result = await publish(message([{ kind: 'text', text: 'Escolha' }, button('Sim'), button('Não')]), toM)
  expect(result.status).toBe(201)
})

it('D2: o bloqueio de recurso diz o passo e o motivo em português', async () => {
  await whatsapp()
  const result = await publish(message([{ kind: 'text', text: 'Escolha' }, button('Sim'),
    { kind: 'button', id: 'site', label: 'Site', action: { type: 'url', url: 'https://example.com' } }]), toM)
  expect(result.status).toBe(409)
  expect(result.text).toContain('Escolha')
  expect(result.text).toContain('botão de link precisa ficar sozinho')
  expect(result.text).not.toMatch(/Only reply buttons|link button/i)
})

it('D3: pergunta sem campo de destino bloqueia dizendo o passo e o que falta', async () => {
  const result = await publish([{ id: 'm', type: 'question', position: { x: 200, y: 0 },
    config: { text: 'Qual o seu e-mail?', answer_type: 'email', field_id: '', retry_message: 'Tente de novo', max_attempts: 2, skip: false, timeout: { value: 1, unit: 'hours' } } }], toM)
  expect(result.status).toBe(400)
  expect(result.text).toContain('Qual o seu e-mail?')
  expect(result.text).toContain('Escolha o campo de destino.')
})

it('D5: "Iniciar automação" sem destino bloqueia a publicação', async () => {
  const result = await publish([...message([{ kind: 'text', text: 'Oi' }]), { id: 'g', type: 'start_automation', position: { x: 400, y: 0 }, config: { automation_id: '' } }],
    [...toM, { from: 'm', port: 'next', to: 'g' }])
  expect(result.status).toBe(400)
  expect(result.text).toContain('Iniciar automação')
  expect(result.text).toContain('Escolha a automação')
})

it('D6: gatilho de automação nunca publicada não fica ativo', async () => {
  await env.DB.prepare("UPDATE triggers SET status='draft' WHERE id='trg-a'").run()
  const response = await request('automations/auto-a/triggers/trg-a', { method: 'PATCH', body: JSON.stringify({ state: 'active' }) })
  expect(response.status).toBe(409)
  expect(await response.text()).toContain('Publique')
  expect(await env.DB.prepare("SELECT status FROM triggers WHERE id='trg-a'").first()).toEqual({ status: 'draft' })
})

it('D7: "é exatamente" ignora espaços nas pontas', () => {
  const rule = { rule: 'is', words: ['sim1'], case_sensitive: false }
  expect(matchesKeyword('sim1 ', rule)).toBe(true)
  expect(matchesKeyword('  SIM1\n', rule)).toBe(true)
  expect(matchesKeyword('sim1 e mais', rule)).toBe(false)
})

it('D8: o nome do perfil do WhatsApp vira nome e sobrenome, não tudo em primeiro nome', () => {
  const body = { object: 'whatsapp_business_account', entry: [{ id: 'w', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp',
    metadata: { phone_number_id: '1' }, contacts: [{ user_id: 'BR.abc123', wa_id: '5511999999999', profile: { name: 'Marina Souza Lima' } }],
    messages: [{ id: 'wamid.1', type: 'text', timestamp: '1700000000', from_user_id: 'BR.abc123', text: { body: 'oi' } }] } }] }] }
  const [event] = metaWhatsappCloud.parseInbound(body, {} as never)
  expect(event).toMatchObject({ from: { profile: { firstName: 'Marina', lastName: 'Souza Lima' } } })
})

const link = { kind: 'button', id: 'site', label: 'Ver datas', action: { type: 'url', url: 'https://example.com/datas' } }
it('WA-04: um único botão de link publica na conexão oficial do WhatsApp', async () => {
  await whatsapp()
  expect((await publish(message([{ kind: 'text', text: 'Veja as datas' }, link]), toM)).status).toBe(201)
})
it('WA-04: botão de link junto com botão de resposta é barrado na publicação, em português', async () => {
  await whatsapp()
  const result = await publish(message([{ kind: 'text', text: 'Escolha' }, button('Sim'), link]), toM)
  expect(result.status).toBe(409)
  expect(result.text).toContain('Escolha')
  expect(result.text).toContain('botão de link precisa ficar sozinho')
  expect(result.text).not.toMatch(/link button|reply buttons/i)
})
it('WA-04: dois botões de link são barrados na publicação', async () => {
  await whatsapp()
  const result = await publish(message([{ kind: 'text', text: 'Links' }, link, { ...link, id: 'outro', label: 'Outro' }]), toM)
  expect(result.status).toBe(409)
  expect(result.text).toContain('botão de link precisa ficar sozinho')
})
