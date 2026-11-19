import { env as runtime } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WhatsAppAdapter, type SendContext } from '../src/channels'
import { normalizeInbound } from '../src/channels/core/inbound'
import { connectionRuntime } from '../src/channels/core/runtime'
import { consumeInbound } from '../src/jobs'
import { webhooks, MAX_WEBHOOK_BYTES, type InboundEvent, type IntegrationEnv } from '../src/integrations'
import { getWhatsappIdentity, getWhatsappIdentityByPhone, upsertWhatsappIdentity } from '../src/db/contacts'
import { deleteContacts } from '../src/contacts'
import type { Env } from '../src/env'
import { giveCredentials, testKeyring } from './credentials'
import { seed } from './fixtures'

const secret = 'TEST-APP-SECRET', user = 'BR.abc123', phoneId = '123456789'
const token = 'a'.repeat(24)
// What the adapter class reads; the connection's stored credentials hold the same values.
const view = { META_APP_SECRET: secret, META_VERIFY_TOKEN: 'VERIFY-TEST', WHATSAPP_ACCESS_TOKEN: 'TESTONLY', WHATSAPP_PHONE_NUMBER_ID: phoneId }
let env: IntegrationEnv, adapter: WhatsAppAdapter, context: SendContext
let accepted: InboundEvent[]
let create: ReturnType<typeof vi.fn>, sendEvent: ReturnType<typeof vi.fn>
const graph = { nodes: [
  { id: 'start', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
  { id: 'offer', type: 'message', position: { x: 1, y: 0 }, config: { blocks: [
    { kind: 'text', text: 'Escolha' }, { kind: 'button', id: 'next', label: 'Continuar', action: { type: 'go_to_node' } },
  ] } },
], edges: [{ from: 'start', port: 'next', to: 'offer' }] }
const nowSeconds = () => String(Math.floor(Date.now() / 1000))
const incoming = (overrides: Record<string, unknown> = {}) => ({ id: 'wamid.in', type: 'text', timestamp: nowSeconds(), from_user_id: user, text: { body: 'quero' }, ...overrides })
const envelope = (messages: unknown[] = [], statuses: unknown[] = [], contacts: unknown[] = []) => ({ object: 'whatsapp_business_account', entry: [{ id: 'test-waba',
  changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneId }, messages, statuses, contacts } }],
}] })
async function signed(body: unknown, key = secret) {
  const text = JSON.stringify(body)
  const hmac = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(text))
  const hex = [...new Uint8Array(sig)].map(n => n.toString(16).padStart(2, '0')).join('')
  return { method: 'POST', body: text, headers: { 'X-Hub-Signature-256': `sha256=${hex}` } }
}
async function deliver(body: unknown) {
  accepted = []
  expect((await webhooks.request('/meta', await signed(body), env)).status).toBe(200)
  return consume(...accepted)
}
async function consume(...events: InboundEvent[]) {
  const messages = events.map(body => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn(), id: crypto.randomUUID(), timestamp: new Date() }))
  await consumeInbound({ messages } as unknown as MessageBatch<unknown>, env)
  return messages
}
/** What the queue consumer reads from one signed delivery (webhook -> queue -> normalizeInbound), without dispatching it. */
async function read(body: unknown) {
  accepted = []
  expect((await webhooks.request('/meta', await signed(body), env)).status).toBe(200)
  const rt = await connectionRuntime(env, 'a', 'wa-a')
  return (await Promise.all(accepted.map(event => normalizeInbound(rt, event)))).flat()
}
async function count(sql: string) { return runtime.DB.prepare(sql).first<number>('n') }
async function body() { return JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)![1]!.body)) }
async function row() { return runtime.DB.prepare("SELECT content FROM messages WHERE source='automation'").first<{ content: string }>() }

beforeEach(async () => {
  await seed()
  accepted = []
  create = vi.fn(async () => ({})); sendEvent = vi.fn(async () => {})
  env = { DB: runtime.DB, ...testKeyring,
    INBOUND: { send: async (event: InboundEvent) => { accepted.push(event) } } as unknown as Queue<InboundEvent>,
    FLOW_RUN: { create, get: async () => ({ sendEvent, status: async () => ({ status: 'running' }) }) } as unknown as NonNullable<IntegrationEnv['FLOW_RUN']> }
  await runtime.DB.batch([
    runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('wa-a','a','whatsapp',?)").bind(phoneId),
    runtime.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('wa-v','a','auto-a',1,?)").bind(JSON.stringify(graph)),
  ])
  await upsertWhatsappIdentity(runtime.DB, 'a', { contact_id: 'c-a', channel_id: 'wa-a', bsuid: user })
  await runtime.DB.prepare("UPDATE contact_channels SET opted_in=1,window_expires_at=? WHERE channel_id='wa-a'").bind(Date.now() + 86400000).run()
  await runtime.DB.prepare("INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,channel_id,current_node_id) VALUES ('wa-run','a','c-a','wa-v','wa-a','offer')").run()
  context = { runId: 'wa-run', step: 1, part: 0, channelId: 'wa-a', externalUserId: user, mode: { ok: true, mode: 'free' },
    run: { id: 'wa-run', workspace_id: 'a', contact_id: 'c-a', channel_id: 'wa-a', external_user_id: user, channel_type: 'whatsapp',
      automation_version_id: 'wa-v', automation_id: 'auto-a', graph: JSON.stringify(graph), start_node_id: null, depth: 0 } }
  await giveCredentials(runtime, 'wa-a', { accessToken: 'TESTONLY', phoneNumberId: phoneId, appSecret: secret, verifyToken: 'VERIFY-TEST' })
  adapter = new WhatsAppAdapter({ ...env, ...view })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(input).toBe(`https://graph.facebook.com/v26.0/${phoneId}/messages`)
    expect(init!.headers).toMatchObject({ Authorization: 'Bearer TESTONLY' })
    return Response.json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.out.${vi.mocked(fetch).mock.calls.length}` }] })
  })
})
afterEach(() => { vi.restoreAllMocks() })

it('envia texto via recipient BSUID, persiste e replay não envia de novo', async () => {
  const message = { kind: 'text' as const, text: 'Texto de teste' }
  expect(await adapter.send(context, message)).toMatchObject({ ok: true, externalId: 'wamid.out.1', parts: 1 })
  expect(await body()).toEqual({ messaging_product: 'whatsapp', recipient: user, type: 'text', text: { body: message.text, preview_url: false } })
  expect(await adapter.send(context, message)).toMatchObject({ ok: true, externalId: 'wamid.out.1' })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(JSON.parse((await row())!.content)).toMatchObject({ status: 'sent', whatsapp: { runId: 'wa-run', nodeId: 'offer' } })
})
it('interactive usa até três botões, títulos20, IDs256 e corpo1024; divide sem perder texto/opções', async () => {
  const buttons = Array.from({ length: 4 }, (_, i) => ({ type: 'postback' as const, id: `option-${i}`, title: `${i}${'a'.repeat(25)}` }))
  const result = await adapter.send(context, { kind: 'text', text: 'á'.repeat(1025), buttons })
  expect(result).toMatchObject({ ok: true, parts: 3, degraded: expect.arrayContaining([{ kind: 'text_split', parts: 2 }, { kind: 'buttons_split', from: 4, messages: 2 }]) })
  const payloads = vi.mocked(fetch).mock.calls.map(c => JSON.parse(String(c[1]!.body)))
  expect(payloads[1].interactive).toMatchObject({ type: 'button', body: { text: 'á' }, action: { buttons: expect.any(Array) } })
  expect(payloads[1].interactive.action.buttons).toHaveLength(3)
  expect(payloads[1].interactive.action.buttons[0]).toEqual({ type: 'reply', reply: { id: 'option-0', title: `0${'a'.repeat(18)}…` } })
  expect(payloads[2].interactive.action.buttons).toHaveLength(1)
  const fit = (id: string) => adapter.fit({ kind: 'text', text: 'Olá', buttons: [{ type: 'postback', id, title: 'Ir' }] }, adapter.capabilities())
  expect(fit('a'.repeat(256))).toHaveProperty('messages')
  expect(fit('a'.repeat(257))).toMatchObject({ reason: 'unsupported' })
  expect(adapter.fit({ kind: 'text', text: 'Olá', buttons: [{ type: 'postback', id: 'a', title: 'Igual' }, { type: 'postback', id: 'b', title: 'Igual' }] }, adapter.capabilities())).toMatchObject({ reason: 'unsupported' })
})
it('envia template fora da janela com idioma obrigatório, parâmetros posicionais ordenados e nomeados', async () => {
  await runtime.DB.prepare("UPDATE contact_channels SET window_expires_at=1 WHERE channel_id='wa-a'").run()
  const mode = adapter.canSend({ optedIn: true, windowExpiresAt: 1, humanWindowExpiresAt: Date.now() + 86400000 }, Date.now(), 'human')
  expect(mode).toMatchObject({ reason: 'outside_window', canUseTemplate: true })
  expect(await adapter.send({ ...context, mode }, { kind: 'template', templateId: 'hello_world', params: { language_code: 'en_US' } })).toMatchObject({ ok: true })
  expect((await body()).template).toEqual({ name: 'hello_world', language: { code: 'en_US' } })
  expect(await adapter.send({ ...context, step: 2, mode }, { kind: 'template', templateId: 'pedido', params: { language_code: 'pt_BR', '2': '42', '1': 'Ana' } })).toMatchObject({ ok: true })
  expect((await body()).template.components[0].parameters).toEqual([{ type: 'text', text: 'Ana' }, { type: 'text', text: '42' }])
  expect(await adapter.send({ ...context, step: 3, mode }, { kind: 'template', templateId: 'pedido', params: { language_code: 'pt_BR', nome: 'Ana' } })).toMatchObject({ ok: true })
  expect((await body()).template.components[0].parameters).toEqual([{ type: 'text', text: 'Ana', parameter_name: 'nome' }])
  expect(adapter.fit({ kind: 'template', templateId: 'hello_world', params: {} }, adapter.capabilities())).toMatchObject({ reason: 'unsupported' })
})
it('barra janela exata/ausente e opt-in no banco mesmo com contexto free forjado; template não dispensa consentimento', async () => {
  await runtime.DB.prepare("UPDATE contact_channels SET window_expires_at=1 WHERE channel_id='wa-a'").run()
  expect(await adapter.send(context, { kind: 'text', text: 'Olá' })).toMatchObject({ reason: 'outside_window' })
  expect(adapter.canSend({ optedIn: true, windowExpiresAt: 1000, humanWindowExpiresAt: null }, 1000, 'automation')).toMatchObject({ reason: 'outside_window' })
  await runtime.DB.prepare("UPDATE contact_channels SET opted_in=0 WHERE channel_id='wa-a'").run()
  expect(await adapter.send(context, { kind: 'template', templateId: 'hello_world', params: { language_code: 'en_US' } })).toMatchObject({ reason: 'not_opted_in' })
  expect(fetch).not.toHaveBeenCalled()
  expect(await count('SELECT count(*) n FROM flow_outbound')).toBe(0)
})
it.each([130429, 131056])('limite Meta %s permite retry sem duplicar envio', async code => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { code, message: 'not persisted' } }, { status: 400, headers: { 'Retry-After': '2' } }))
  expect(await adapter.send(context, { kind: 'text', text: 'Olá' })).toMatchObject({ reason: 'rate_limited', retryAfterSec: 2 })
  expect(await adapter.send(context, { kind: 'text', text: 'Olá' })).toMatchObject({ ok: true })
  expect(await count("SELECT count(*) n FROM flow_outbound WHERE status='sent'")).toBe(1)
})
it.each(['network', 'invalid', 'rejected'])('envio %s não confirma nem repete rede e não persiste erro bruto', async kind => {
  if (kind === 'network') vi.mocked(fetch).mockRejectedValueOnce(new Error('sensitive'))
  else vi.mocked(fetch).mockResolvedValueOnce(Response.json(kind === 'invalid' ? { bogus: true } : { error: { code: 190, message: 'sensitive' } }, { status: kind === 'invalid' ? 200 : 401 }))
  expect(await adapter.send(context, { kind: 'text', text: 'Olá' })).toMatchObject({ ok: false, reason: kind === 'rejected' ? 'rejected' : 'uncertain' })
  // O 190 deixa a conexão com erro: a reexecução é barrada antes da rede; nos outros casos o envio fica incerto.
  expect(await adapter.send(context, { kind: 'text', text: 'Olá' })).toMatchObject(kind === 'rejected' ? { code: 'connection_unavailable' } : { reason: 'uncertain' })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect((await row())!.content).not.toContain('sensitive')
})
it('erro131047 retorna janela fechada e configuração/canal/identidade incorretos não usam rede', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { code: 131047 } }, { status: 400 }))
  expect(await adapter.send(context, { kind: 'text', text: 'Olá' })).toMatchObject({ reason: 'outside_window', canUseTemplate: true })
  expect(await adapter.send({ ...context, channelId: 'wa-other' }, { kind: 'text', text: 'Olá' })).toMatchObject({ code: 'context_mismatch' })
  expect(await new WhatsAppAdapter({ ...env, ...view, WHATSAPP_PHONE_NUMBER_ID: '987' }).send(context, { kind: 'text', text: 'Olá' })).toMatchObject({ code: 'channel_not_configured' })
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('HMAC cobre bytes originais antes da fila e do parser; limita tamanho; mantém handshake', async () => {
  const payload = envelope([incoming()])
  const init = await signed(payload)
  expect((await webhooks.request('/meta', { ...init, body: init.body + ' ' }, env)).status).toBe(401)
  expect((await webhooks.request('/meta', await signed(payload, 'wrong'), env)).status).toBe(401)
  expect(accepted).toHaveLength(0)
  // The same signed bytes go through, and the queued event reads as the message.
  expect((await webhooks.request('/meta', init, env)).status).toBe(200)
  expect(accepted).toHaveLength(1)
  expect(await normalizeInbound(await connectionRuntime(env, 'a', 'wa-a'), accepted[0])).toMatchObject([{ kind: 'message', externalUserId: user, text: 'quero' }])
  expect((await webhooks.request('/meta?hub.mode=subscribe&hub.verify_token=VERIFY-TEST&hub.challenge=123', {}, env)).status).toBe(200)
  expect((await webhooks.request('/meta', await signed({ padding: 'x'.repeat(MAX_WEBHOOK_BYTES) }), env)).status).toBe(413)
})
it('texto assinado sem telefone usa W7, janela pelo timestamp e disparo de keyword único; repetição não prolonga', async () => {
  await runtime.DB.prepare("UPDATE automations SET status='live',published_version_id='wa-v' WHERE id='auto-a'").run()
  await runtime.DB.prepare("UPDATE triggers SET channel_id='wa-a' WHERE id='trg-a'").run()
  await runtime.DB.prepare("UPDATE keywords SET status='live' WHERE id='key-a'").run()
  await runtime.DB.prepare("UPDATE contact_channels SET window_expires_at=NULL WHERE channel_id='wa-a'").run()
  const at = Math.floor((Date.now() - 60_000) / 1000) * 1000
  const messages = await deliver(envelope([incoming({ timestamp: String(at / 1000) })], [], [{ user_id: user, profile: { name: 'Pessoa teste' } }]))
  expect(messages[0].retry).not.toHaveBeenCalled()
  expect(messages[0].ack).toHaveBeenCalledOnce()
  expect((await getWhatsappIdentity(runtime.DB, 'a', 'wa-a', user))?.window_expires_at).toBe(new Date(at + 86400000).toISOString())
  expect(create).toHaveBeenCalledTimes(1)
  await consume(...accepted)
  expect(create).toHaveBeenCalledTimes(1)
  expect(await count("SELECT count(*) n FROM messages WHERE direction='in'")).toBe(1)
  expect(await count("SELECT count(*) n FROM trigger_firings WHERE workspace_id='a'")).toBe(1)
})
it('novo BSUID não usa telefone como chave, primeira mensagem concede opt-in e opt-out posterior não é desfeito', async () => {
  const messages = await deliver(envelope([incoming({ from_user_id: 'BR.other', from: '5511999999999' })], [], [{ user_id: 'BR.other', wa_id: '5511999999999' }]))
  expect(messages[0].ack).toHaveBeenCalledOnce()
  const identity = await getWhatsappIdentity(runtime.DB, 'a', 'wa-a', 'BR.other')
  expect(identity).toMatchObject({ external_user_id: 'BR.other', identity_kind: 'bsuid', phone_e164: '+5511999999999', opted_in: true })
  expect((await getWhatsappIdentityByPhone(runtime.DB, 'a', 'wa-a', '+5511999999999'))?.id).toBe(identity!.id)
  await runtime.DB.prepare("UPDATE contact_channels SET opted_in=0 WHERE id=?").bind(identity!.id).run()
  await deliver(envelope([incoming({ id: 'wamid.next', from_user_id: 'BR.other' })]))
  expect(await getWhatsappIdentity(runtime.DB, 'a', 'wa-a', 'BR.other')).toMatchObject({ id: identity!.id, opted_in: false })
  expect(await read(envelope([incoming({ id: 'wamid.nobsuid', from_user_id: undefined, from: '5511999999999' })]))).toMatchObject([{ kind: 'ignored' }])
  expect(create).not.toHaveBeenCalled()
})
it.each(['keyword', 'welcome_message'])('WhatsApp excluído cria outro contato e dispara %s sem restaurar o tombstone', async kind => {
  await runtime.DB.batch([
    runtime.DB.prepare("UPDATE automations SET status='live',published_version_id='wa-v' WHERE id='auto-a'"),
    runtime.DB.prepare("UPDATE triggers SET channel_id='wa-a',kind=?,repeat_mode='once' WHERE id='trg-a'").bind(kind),
    runtime.DB.prepare("UPDATE keywords SET status='live' WHERE id='key-a'"),
  ])
  const bsuid = 'BR.deleted', contacts = [{ user_id: bsuid, wa_id: '5511999999999', profile: { name: 'Pessoa fictícia' } }]
  await deliver(envelope([incoming({ from_user_id: bsuid })], [], contacts))
  const original = accepted.slice()
  const previous = await getWhatsappIdentity(runtime.DB, 'a', 'wa-a', bsuid)
  expect(previous).toBeTruthy()
  expect(create).toHaveBeenCalledTimes(1)
  await deleteContacts(env as Env, 'a', [previous!.contact_id])
  await consume(...original)
  expect(await getWhatsappIdentity(runtime.DB, 'a', 'wa-a', bsuid)).toBeNull()
  await deliver(envelope([incoming({ id: 'wamid.after-delete', from_user_id: bsuid })], [], contacts))
  const fresh = await getWhatsappIdentity(runtime.DB, 'a', 'wa-a', bsuid)
  expect(fresh!.contact_id).not.toBe(previous!.contact_id)
  expect(fresh).toMatchObject({ opted_in: true, identity_kind: 'bsuid', phone_e164: '+5511999999999' })
  expect(await runtime.DB.prepare('SELECT status,first_name,last_input_text,last_interaction_at FROM contacts WHERE id=?')
    .bind(previous!.contact_id).first()).toEqual({ status: 'deleted', first_name: null, last_input_text: null, last_interaction_at: null })
  expect(create).toHaveBeenCalledTimes(2)
  expect(await count("SELECT count(*) n FROM trigger_firings WHERE trigger_id='trg-a'")).toBe(2)
})
it('exclusão WhatsApp limpa recibos sem run e seus retries sem apagar a entrada de outra identidade', async () => {
  await deliver(envelope([incoming({ id: 'wamid.private', from_user_id: 'BR.private', text: { body: 'Dado privado' } })], [],
    [{ user_id: 'BR.private', wa_id: '5511999999999', profile: { name: 'Pessoa fictícia' } }]))
  const original = accepted.slice(), identity = await getWhatsappIdentity(runtime.DB, 'a', 'wa-a', 'BR.private')
  expect(create).not.toHaveBeenCalled()
  await deliver(envelope([incoming({ id: 'wamid.other', from_user_id: 'BR.other' })]))
  const other = accepted[0]
  await deleteContacts(env as Env, 'a', [identity!.contact_id])
  const receipt = await runtime.DB.prepare('SELECT payload,processed_at,planned_at FROM inbound_events WHERE id=?')
    .bind(JSON.stringify(['meta', 'wa-a', original[0].eventId])).first<{ payload: string; processed_at: number; planned_at: number }>()
  expect(receipt).toMatchObject({ payload: '{}', processed_at: expect.any(Number), planned_at: expect.any(Number) })
  expect(await runtime.DB.prepare('SELECT payload FROM inbound_events WHERE id=?')
    .bind(JSON.stringify(['meta', 'wa-a', other.eventId])).first('payload')).toContain('BR.other')
  await consume(...original)
  expect(await getWhatsappIdentity(runtime.DB, 'a', 'wa-a', 'BR.private')).toBeNull()
})
it('entradas WhatsApp concorrentes convergem na identidade W7 sem contatos órfãos', async () => {
  const events = ['first', 'second'].map(id => ({ version: 1 as const, provider: 'meta' as const, workspaceId: 'a', channelId: 'wa-a',
    eventId: id, receivedAt: Date.now(), payload: { ...incoming({ id, from_user_id: 'BR.concurrent' }), kind: 'message', field: 'messages' } }))
  for (const result of await Promise.all(events.map(event => consume(event)))) expect(result[0].retry).not.toHaveBeenCalled()
  expect(await count("SELECT count(*) n FROM contact_channels WHERE external_user_id='BR.concurrent'")).toBe(1)
  expect(await count("SELECT count(*) n FROM contacts WHERE optin_source='whatsapp'")).toBe(1)
})
it('button_reply segue o callback compartilhado, autoriza BSUID/canal, deduplica e abre janela sem reinscrever', async () => {
  await runtime.DB.prepare("UPDATE flow_runs SET status='waiting_click' WHERE id='wa-run'").run()
  await runtime.DB.prepare("INSERT INTO button_tokens(token,workspace_id,run_id,node_id,step_index,button_id,expires_at) VALUES (?,'a','wa-run','offer',1,'next',?)").bind(token, Date.now() + 60000).run()
  await runtime.DB.prepare("UPDATE contact_channels SET window_expires_at=1,opted_in=0 WHERE channel_id='wa-a'").run()
  const click = (from = user) => incoming({ type: 'interactive', from_user_id: from, interactive: { type: 'button_reply', button_reply: { id: `b:${token}`, title: 'não confiar neste título' } } })
  await deliver(envelope([{ ...click('BR.other'), id: 'wamid.wrong-user' }]))
  expect(sendEvent).not.toHaveBeenCalled()
  const messages = await deliver(envelope([click()]))
  expect(messages[0].retry).not.toHaveBeenCalled()
  expect(sendEvent).toHaveBeenCalledExactlyOnceWith({ type: 'click_1', payload: { token } })
  await consume(...accepted)
  expect(sendEvent).toHaveBeenCalledTimes(1)
  expect((await getWhatsappIdentity(runtime.DB, 'a', 'wa-a', user))?.opted_in).toBe(false)
  expect(await count("SELECT count(*) n FROM messages WHERE direction='in' AND json_extract(content,'$.text')='Continuar'")).toBe(1)
  expect(fetch).not.toHaveBeenCalled() // WhatsApp has no Telegram ACK.
})
const inboxClicks = (text: string) => count(`SELECT count(*) n FROM messages WHERE direction='in' AND json_extract(content,'$.text')='${text}'`)
const cardClick = (id = 'wamid.q3a') => incoming({ id, type: 'button', button: { payload: 'q3a', text: 'Quero o 3' } })
it('clique que não casa com o botão esperado aparece na caixa de entrada sem avançar o fluxo', async () => {
  await runtime.DB.prepare("UPDATE flow_runs SET status='waiting_click' WHERE id='wa-run'").run()
  await runtime.DB.prepare("INSERT INTO button_tokens(token,workspace_id,run_id,node_id,step_index,button_id,expires_at) VALUES (?,'a','wa-run','offer',1,'b1',?)").bind(token, Date.now() + 60000).run()
  const messages = await deliver(envelope([cardClick()]))
  expect(messages[0].retry).not.toHaveBeenCalled()
  expect(sendEvent).not.toHaveBeenCalled()
  expect(await inboxClicks('Quero o 3')).toBe(1)
  await consume(...accepted)
  expect(await inboxClicks('Quero o 3')).toBe(1)
})
it('clique sem nenhuma execução ativa aparece na caixa de entrada', async () => {
  await runtime.DB.prepare("DELETE FROM flow_runs WHERE id='wa-run'").run()
  await deliver(envelope([incoming({ id: 'wamid.title', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'q3a', title: 'Título do botão' } } })]))
  expect(sendEvent).not.toHaveBeenCalled()
  expect(await inboxClicks('Título do botão')).toBe(1)
})
it('clique esperado grava uma única mensagem, mesmo reentregue', async () => {
  await runtime.DB.prepare("UPDATE flow_runs SET status='waiting_click' WHERE id='wa-run'").run()
  await runtime.DB.prepare("INSERT INTO button_tokens(token,workspace_id,run_id,node_id,step_index,button_id,expires_at) VALUES (?,'a','wa-run','offer',1,'next',?)").bind(token, Date.now() + 60000).run()
  await deliver(envelope([incoming({ id: 'wamid.expected', type: 'button', button: { payload: `b:${token}`, text: 'Texto do provedor' } })]))
  await consume(...accepted)
  expect(sendEvent).toHaveBeenCalledTimes(1)
  expect(await count("SELECT count(*) n FROM messages WHERE direction='in' AND json_extract(content,'$.sender')='contact'")).toBe(1)
  expect(await inboxClicks('Continuar')).toBe(1)
})
it('clique de template button.payload também normaliza para click', async () => {
  expect(await read(envelope([incoming({ type: 'button', button: { payload: `b:${token}`, text: 'Continuar' } })])))
    .toMatchObject([{ kind: 'click', externalUserId: user, payload: `b:${token}` }])
})
it('status sent/delivered/read/failed geram node_events sem dobrar mesmo fora de ordem/timestamp distinto e após avançar nó', async () => {
  await adapter.send(context, { kind: 'text', text: 'Olá' })
  await runtime.DB.prepare("UPDATE flow_runs SET current_node_id='another' WHERE id='wa-run'").run()
  for (const [i, status] of ['read', 'sent', 'delivered', 'failed', 'read'].entries()) {
    const result = await deliver(envelope([], [{ id: 'wamid.out.1', status, timestamp: String(Number(nowSeconds()) + i) }]))
    expect(result[0].retry).not.toHaveBeenCalled()
    expect(result[0].ack).toHaveBeenCalledOnce()
  }
  const metrics = await runtime.DB.prepare("SELECT node_id,type FROM node_events WHERE flow_run_id='wa-run' ORDER BY type").all()
  expect(metrics.results).toEqual(['delivered', 'failed', 'read', 'sent'].map(type => ({ node_id: 'offer', type })))
  expect(JSON.parse((await row())!.content)).toMatchObject({ status: 'delivered', whatsappStatus: 'read' })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(await count("SELECT count(*) n FROM inbound_events WHERE id LIKE '%wamid.out.1%'")).toBe(4)
})
it('status adiantado fica pendente para retry e read sozinho conta delivered uma vez', async () => {
  const status = envelope([], [{ id: 'wamid.out.1', status: 'read', timestamp: nowSeconds() }])
  const pending = await deliver(status)
  expect(pending[0].retry).toHaveBeenCalledOnce()
  expect(pending[0].ack).not.toHaveBeenCalled()
  await adapter.send(context, { kind: 'text', text: 'Olá' })
  const retried = await consume(...accepted)
  expect(retried[0].ack).toHaveBeenCalledOnce()
  expect(await count("SELECT count(*) n FROM node_events WHERE type IN ('delivered','read')")).toBe(2)
})
it('status de outro workspace/canal não afeta métricas; eventos fora de messages são ignorados', async () => {
  await adapter.send(context, { kind: 'text', text: 'Olá' })
  await runtime.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('wa-b','b','whatsapp','other-phone')").run()
  const event: InboundEvent = { version: 1, provider: 'meta', workspaceId: 'b', channelId: 'wa-b', eventId: 'out:read', receivedAt: Date.now(),
    payload: { field: 'messages', kind: 'status', id: 'wamid.out.1', status: 'read', timestamp: nowSeconds() } }
  expect((await consume(event))[0].retry).toHaveBeenCalledOnce()
  expect(await count("SELECT count(*) n FROM node_events WHERE type='read'")).toBe(0)
  const other = { object: 'whatsapp_business_account', entry: [{ id: 'x', changes: [{ field: 'account_update', value: {} }] }] }
  await deliver(other)
  expect(accepted).toHaveLength(0)
})

// Camada de mensageria, tarefa 03.
const receipt = (status: 'sent' | 'delivered' | 'read' | 'failed', at = Date.now()) => consume({ version: 1, provider: 'meta', workspaceId: 'a', channelId: 'wa-a',
  eventId: `wamid.out.1:${status}`, receivedAt: at, payload: { id: 'wamid.out.1', kind: 'status', field: 'messages', status, timestamp: String(Math.floor(at / 1000)) } })
it('recibo lido antes do entregue não regride o estado: a coluna de entrega fica em lido e as métricas contam cada passo uma vez', async () => {
  await adapter.send(context, { kind: 'text', text: 'Olá' })
  const delivery = () => runtime.DB.prepare("SELECT delivery_status AS s FROM messages WHERE source='automation'").first<string>('s')
  expect(await delivery()).toBe('sent')
  await receipt('read')
  expect(await delivery()).toBe('read')
  await receipt('delivered')
  await receipt('sent')
  expect(await delivery()).toBe('read')
  expect(JSON.parse((await row())!.content)).toMatchObject({ whatsappStatus: 'read', status: 'delivered' })
  expect(await count("SELECT count(*) n FROM node_events WHERE type IN ('delivered','read')")).toBe(2)
})
it('falha só vale enquanto nada melhor chegou; entregue depois de falha avança', async () => {
  await adapter.send(context, { kind: 'text', text: 'Olá' })
  const delivery = () => runtime.DB.prepare("SELECT delivery_status AS s FROM messages WHERE source='automation'").first<string>('s')
  await receipt('failed')
  expect(await delivery()).toBe('failed')
  await receipt('delivered')
  expect(await delivery()).toBe('delivered')
})
// Ficha wa-03: motivo da falha visível. Os erros vêm do exemplo messages-status-falha.json do contrato (replica/contratos/meta-whatsapp).
const failedWith = (errors: unknown[]) => consume({ version: 1, provider: 'meta', workspaceId: 'a', channelId: 'wa-a', eventId: 'wamid.out.1:failed', receivedAt: Date.now(),
  payload: { id: 'wamid.out.1', kind: 'status', field: 'messages', status: 'failed', timestamp: nowSeconds(), errors } })
it.each([
  [131049, 'This message was not delivered to maintain healthy ecosystem engagement.', /limitou mensagens de marketing/],
  [131050, 'Recipient opted out of marketing messages', /cancelou o recebimento de mensagens de marketing/],
  [131026, 'Message undeliverable', /não conseguiu entregar/],
  [131047, 'Re-engagement message', /janela de atendimento/],
  [131063, 'Marketing messages disabled on Cloud API', /marketing/],
  [131064, 'Throttled by template category', /limitou os envios/],
  [131065, 'No max price for country', /país/],
  [131070, 'Another app is controlling this thread', /outro app/],
])('recibo failed %i guarda errors[] e a caixa de entrada mostra o motivo em pt-BR', async (code, title, notice) => {
  await adapter.send(context, { kind: 'text', text: 'Olá' })
  await failedWith([{ code, title, message: title, error_data: { details: `detalhe ${code}` }, href: '/documentation/business-messaging/whatsapp/support/error-codes' }])
  const content = JSON.parse((await row())!.content)
  expect(content).toMatchObject({ whatsappStatus: 'failed', status: 'failed', whatsappErrors: [{ code: String(code), title, detail: `detalhe ${code}` }] })
  expect(content.error).toMatch(notice)
  expect(await runtime.DB.prepare("SELECT delivery_error AS e FROM messages WHERE source='automation'").first<string>('e')).toBe(content.error)
})
it('recibo failed com código desconhecido ainda mostra o código e o título da Meta', async () => {
  await adapter.send(context, { kind: 'text', text: 'Olá' })
  await failedWith([{ code: 999999, title: 'Something new', error_data: { details: 'novo' } }])
  expect(JSON.parse((await row())!.content).error).toMatch(/999999/)
})
it('recibo failed sem errors[] mantém a mensagem genérica; entregue depois da falha limpa o motivo', async () => {
  await adapter.send(context, { kind: 'text', text: 'Olá' })
  await receipt('failed')
  expect(JSON.parse((await row())!.content).error).toMatch(/não confirmou/)
  await failedWith([{ code: 131026, title: 'x' }])
  await receipt('delivered')
  expect(JSON.parse((await row())!.content)).toMatchObject({ status: 'delivered' })
  expect(JSON.parse((await row())!.content).error).toBeUndefined()
})
it('recibo sent atrasado depois de failed 131049 preserva o motivo, os erros e o código', async () => {
  await adapter.send(context, { kind: 'text', text: 'Olá' })
  await failedWith([{ code: 131049, title: 'Healthy ecosystem', error_data: { details: 'limite' } }])
  const before = JSON.parse((await row())!.content)
  expect(before.error).toMatch(/limitou mensagens de marketing/)
  await receipt('sent')
  const after = JSON.parse((await row())!.content)
  expect(after).toMatchObject({ whatsappStatus: 'failed', status: 'failed', error: before.error, deliveryErrorCode: '131049', whatsappErrors: [{ code: '131049' }] })
  expect(await runtime.DB.prepare("SELECT delivery_error AS e FROM messages WHERE source='automation'").first<string>('e')).toBe(before.error)
})
it('a ficha efetiva decide o template fora da janela: sem templates na conexão, o envio é barrado sem rede', async () => {
  const { deliverAutomation } = await import('../src/channels/core/delivery')
  const { metaWhatsappCloud } = await import('../src/channels/meta-whatsapp-cloud')
  const { effectiveProfile } = await import('../src/channels/core/profile-merge')
  const connection = { id: 'wa-a', workspaceId: 'a', kind: 'whatsapp' as const, provider: 'meta_whatsapp_cloud' as const, externalId: phoneId, displayName: null, status: 'connected' as const,
    settings: {}, profile: effectiveProfile('whatsapp', 'meta_whatsapp_cloud') }
  const credentials = async () => ({ accessToken: 'TESTONLY', phoneNumberId: phoneId })
  const outside = adapter.canSend({ optedIn: true, windowExpiresAt: 1, humanWindowExpiresAt: null }, Date.now(), 'automation')
  const template = { kind: 'template' as const, templateId: 'hello_world', params: { language_code: 'en_US' } }
  expect(await deliverAutomation(env, { connection: { ...connection, profile: effectiveProfile('whatsapp', 'meta_whatsapp_cloud', { remove: ['templates'] }) }, provider: metaWhatsappCloud, credentials },
    { ...context, mode: outside }, template)).toMatchObject({ ok: false, reason: 'outside_window' })
  expect(fetch).not.toHaveBeenCalled()
  expect(await deliverAutomation(env, { connection, provider: metaWhatsappCloud, credentials }, { ...context, mode: outside }, template)).toMatchObject({ ok: true })
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('resposta humana pela caixa respeita a janela da ficha: dentro envia, fora fica indisponível sem rede', async () => {
  const { ensureConversation } = await import('../src/inbox/service')
  const { deliverHuman } = await import('../src/channels/core/delivery')
  const { connectionRuntime } = await import('../src/channels/core/runtime')
  const conversationId = await ensureConversation(env, 'a', 'c-a', 'wa-a')
  const rt = await connectionRuntime(env, 'a', 'wa-a')
  const send = () => deliverHuman(env, { connection: rt.connection, provider: rt.provider!, credentials: rt.credentials },
    { workspaceId: 'a', conversationId, contactId: 'c-a', externalUserId: user, text: 'Oi, sou eu' })
  expect(await send()).toMatchObject({ ok: true, message: { status: 'sent' } })
  expect(await body()).toEqual({ messaging_product: 'whatsapp', recipient: user, type: 'text', text: { body: 'Oi, sou eu', preview_url: false } })
  await runtime.DB.prepare("UPDATE contact_channels SET window_expires_at=1 WHERE channel_id='wa-a'").run()
  expect(await send()).toEqual({ ok: false, reason: 'outside_window' })
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('a regra própria da conexão vale no envio do adaptador: sem templates na ficha, o template fora da janela é barrado sem rede', async () => {
  await runtime.DB.prepare(`UPDATE channels SET capabilities_override='{"remove":["templates"]}' WHERE id='wa-a'`).run()
  await runtime.DB.prepare("UPDATE contact_channels SET window_expires_at=1 WHERE channel_id='wa-a'").run()
  const outside = adapter.canSend({ optedIn: true, windowExpiresAt: 1, humanWindowExpiresAt: null }, Date.now(), 'automation')
  expect(await adapter.send({ ...context, mode: outside }, { kind: 'template', templateId: 'hello_world', params: { language_code: 'en_US' } }))
    .toMatchObject({ ok: false, reason: 'outside_window' })
  expect(fetch).not.toHaveBeenCalled()
})
it('recusa da checagem final, antes da rede, devolve o passo a pronto e não registra mensagem falha', async () => {
  const { deliverAutomation } = await import('../src/channels/core/delivery')
  const { metaWhatsappCloud } = await import('../src/channels/meta-whatsapp-cloud')
  const { effectiveProfile } = await import('../src/channels/core/profile-merge')
  const connection = { id: 'wa-a', workspaceId: 'a', kind: 'whatsapp' as const, provider: 'meta_whatsapp_cloud' as const, externalId: phoneId, displayName: null, status: 'connected' as const,
    settings: {}, profile: effectiveProfile('whatsapp', 'meta_whatsapp_cloud') }
  const credentials = async () => ({ accessToken: 'TESTONLY', phoneNumberId: phoneId })
  let calls = 0
  const closing = { ok: false as const, reason: 'outside_window' as const, window: 'standard' as const, expiredAt: Date.now(), canUseTemplate: false }
  const hooks = { guard: async () => (++calls === 2 ? closing : undefined) }
  expect(await deliverAutomation(env, { connection, provider: metaWhatsappCloud, credentials }, context, { kind: 'text', text: 'Olá' }, hooks)).toMatchObject({ reason: 'outside_window' })
  expect(fetch).not.toHaveBeenCalled()
  expect(await runtime.DB.prepare('SELECT status FROM flow_outbound').first<string>('status')).toBe('ready')
  expect(await count("SELECT count(*) n FROM messages WHERE source='automation'")).toBe(0)
  expect(await deliverAutomation(env, { connection, provider: metaWhatsappCloud, credentials }, context, { kind: 'text', text: 'Olá' }, { guard: async () => undefined })).toMatchObject({ ok: true })
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('digitando aponta para a última mensagem recebida do contato e vai como lida mais typing_indicator', async () => {
  const { ensureConversation, recordMessage } = await import('../src/inbox/service')
  const conv = await ensureConversation(runtime, 'a', 'c-a', 'wa-a')
  const inbound = (id: string, at: number) => recordMessage(runtime, { id: `in-${id}`, workspaceId: 'a', conversationId: conv, direction: 'in', sender: 'contact', text: 'oi',
    status: 'delivered', externalMessageId: `whatsapp:wa-a:${user}:${id}`, connectionId: 'wa-a', createdAt: at })
  await inbound('wamid.antiga', 1000)
  await inbound('wamid.recente', 2000)
  vi.mocked(fetch).mockImplementationOnce(async () => Response.json({ success: true }))
  expect(await adapter.send(context, { kind: 'typing', seconds: 3 })).toMatchObject({ ok: true })
  expect(await body()).toEqual({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.recente', typing_indicator: { type: 'text' } })
  expect(await count("SELECT count(*) n FROM messages WHERE source='automation'")).toBe(0)
})
it('quem decide que o digitando precisa da última mensagem é o adaptador, não o id do provedor', async () => {
  const { ensureConversation, recordMessage } = await import('../src/inbox/service')
  const { deliverAutomation } = await import('../src/channels/core/delivery')
  const { metaWhatsappCloud } = await import('../src/channels/meta-whatsapp-cloud')
  const { effectiveProfile } = await import('../src/channels/core/profile-merge')
  const connection = { id: 'wa-a', workspaceId: 'a', kind: 'whatsapp' as const, provider: 'meta_whatsapp_cloud' as const, externalId: phoneId, displayName: null, status: 'connected' as const,
    settings: {}, profile: effectiveProfile('whatsapp', 'meta_whatsapp_cloud') }
  const credentials = async () => ({ accessToken: 'TESTONLY', phoneNumberId: phoneId })
  const conv = await ensureConversation(runtime, 'a', 'c-a', 'wa-a')
  await recordMessage(runtime, { id: 'in-clone', workspaceId: 'a', conversationId: conv, direction: 'in', sender: 'contact', text: 'oi',
    status: 'delivered', externalMessageId: `whatsapp:wa-a:${user}:wamid.clone`, connectionId: 'wa-a', createdAt: 1000 })
  const clone = { ...metaWhatsappCloud, id: 'meta_whatsapp_cloud_clone' as never }
  vi.mocked(fetch).mockImplementationOnce(async () => Response.json({ success: true }))
  expect(await deliverAutomation(env, { connection, provider: clone, credentials }, context, { kind: 'typing', seconds: 3 })).toMatchObject({ ok: true })
  expect(await body()).toMatchObject({ message_id: 'wamid.clone' })
  // Um adaptador que não declara a necessidade não recebe a mensagem de volta.
  const seen: unknown[] = []
  const plain = { ...metaWhatsappCloud, typingNeedsReplyTo: undefined, typing: async (_c: unknown, _s: number, replyTo?: string) => { seen.push(replyTo); return { ok: true as const, externalId: 't', parts: 0 } } }
  await deliverAutomation(env, { connection, provider: plain as never, credentials }, context, { kind: 'typing', seconds: 3 })
  expect(seen).toEqual([undefined])
})
it('digitando numa conversa que o contato nunca iniciou não vai à rede nem derruba o passo', async () => {
  expect(await adapter.send(context, { kind: 'typing', seconds: 3 })).toMatchObject({ ok: false, reason: 'unsupported' })
  expect(fetch).not.toHaveBeenCalled()
})

it('carrinho: pedido do catálogo grava o último carrinho e dispara o gatilho de carrinho da conexão', async () => {
  await runtime.DB.prepare("UPDATE automations SET status='live',published_version_id='wa-v' WHERE id='auto-a'").run()
  await runtime.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES ('trg-cart','a','auto-a','wa-a','Carrinho','cart_reply','active','every_time','{\"node_id\":\"start\"}')").run()
  const order = { catalog_id: 'CAT1', text: 'quero esses', product_items: [{ product_retailer_id: 'sku-1', quantity: 2, item_price: 10, currency: 'BRL' }] }
  await deliver(envelope([incoming({ type: 'order', text: undefined, order })], [], [{ user_id: user, profile: { name: 'Pessoa teste' } }]))
  expect(JSON.parse((await runtime.DB.prepare("SELECT last_cart FROM contacts WHERE last_cart IS NOT NULL").first<string>('last_cart'))!)).toMatchObject({ catalogId: 'CAT1', items: [{ productId: 'sku-1', quantity: 2 }] })
  expect(await count("SELECT count(*) n FROM trigger_firings WHERE trigger_id='trg-cart'")).toBe(1)
})

it('anúncio (CTWA): mensagem vinda do anúncio escolhido dispara o gatilho de anúncio; outro anúncio não', async () => {
  await runtime.DB.prepare("UPDATE automations SET status='live',published_version_id='wa-v' WHERE id='auto-a'").run()
  await runtime.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status,repeat_mode,config) VALUES ('trg-ad','a','auto-a','wa-a','Anúncio','widget','ctwa_trigger','active','every_time','{\"node_id\":\"start\",\"ad_ids\":[\"120330000000001\"]}')").run()
  await deliver(envelope([incoming({ id: 'wamid.ad2', referral: { source_type: 'ad', source_id: '999', headline: 'Outro' } })], [], [{ user_id: user, profile: { name: 'P' } }]))
  expect(await count("SELECT count(*) n FROM trigger_firings WHERE trigger_id='trg-ad'")).toBe(0)
  await deliver(envelope([incoming({ id: 'wamid.ad1', referral: { source_type: 'ad', source_id: '120330000000001', headline: 'Promo' } })], [], [{ user_id: user, profile: { name: 'P' } }]))
  expect(await count("SELECT count(*) n FROM trigger_firings WHERE trigger_id='trg-ad'")).toBe(1)
})

// Mensagem enviada por uma pessoa na caixa de entrada (resposta ou modelo que abre a conversa): sem flow_outbound, só a linha em messages.
async function humanSent(wamid = 'wamid.human.1') {
  await runtime.DB.prepare("INSERT INTO conversations(id,workspace_id,contact_channel_id,status) SELECT 'conv-h','a',id,'open' FROM contact_channels WHERE channel_id='wa-a'").run()
  await runtime.DB.prepare(`INSERT INTO messages(id,workspace_id,conversation_id,direction,source,external_message_id,content,connection_id,delivery_status)
    VALUES ('m-h','a','conv-h','out','human',?,'{"sender":"human","text":"Oi","status":"sent"}','wa-a','sent')`).bind(`whatsapp:wa-a:${user}:${wamid}`).run()
}
const humanReceipt = (status: 'sent' | 'delivered' | 'read', wamid = 'wamid.human.1', at = Date.now()) => consume({ version: 1, provider: 'meta', workspaceId: 'a', channelId: 'wa-a',
  eventId: `${wamid}:${status}`, receivedAt: at, payload: { id: wamid, kind: 'status', field: 'messages', status, timestamp: String(Math.floor(at / 1000)) } })
it('mensagem enviada pela caixa de entrada recebe entregue e lido, e um sent atrasado não rebaixa', async () => {
  await humanSent()
  const state = () => runtime.DB.prepare("SELECT delivery_status AS s, content FROM messages WHERE id='m-h'").first<{ s: string; content: string }>()
  expect((await humanReceipt('delivered'))[0].ack).toHaveBeenCalledOnce()
  expect((await state())!.s).toBe('delivered')
  await humanReceipt('read')
  await humanReceipt('sent')
  expect(await state()).toMatchObject({ s: 'read' })
  expect(JSON.parse((await state())!.content)).toMatchObject({ whatsappStatus: 'read', status: 'delivered' })
  expect(await count('SELECT count(*) n FROM node_events')).toBe(0)
})
it('recibo de id desconhecido: recente fica para nova tentativa, antigo é descartado sem erro', async () => {
  await humanSent()
  const fresh = await humanReceipt('delivered', 'wamid.foreign')
  expect(fresh[0].retry).toHaveBeenCalledOnce()
  const old = await humanReceipt('delivered', 'wamid.foreign', Date.now() - 11 * 60_000)
  expect(old[0].ack).toHaveBeenCalledOnce()
  expect(old[0].retry).not.toHaveBeenCalled()
})
