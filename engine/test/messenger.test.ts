import { env as runtime } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MessengerAdapter, type SendContext } from '../src/channels'
import { consumeInbound } from '../src/jobs'
import { webhooks, type InboundEvent, type IntegrationEnv } from '../src/integrations'
import { giveCredentials, testKeyring } from './credentials'
import { seed } from './fixtures'

const secret = 'TEST-MESSENGER-APP-SECRET'
const page = '110022003300440', user = '550066007700880', stranger = '550066007700999'
let env: IntegrationEnv, adapter: MessengerAdapter, context: SendContext
let accepted: InboundEvent[]
let create: ReturnType<typeof vi.fn>
const graph = { nodes: [
  { id: 'start', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
  { id: 'offer', type: 'message', position: { x: 1, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Escolha' }] } },
], edges: [{ from: 'start', port: 'next', to: 'offer' }] }
const item = (overrides: Record<string, unknown> = {}) => ({ sender: { id: stranger }, recipient: { id: page }, timestamp: Date.now(), message: { mid: 'm.in.1', text: 'quero' }, ...overrides })
const envelope = (...messaging: unknown[]) => ({ object: 'page', entry: [{ id: page, time: Date.now(), messaging }] })
async function signed(body: unknown, key = secret) {
  const text = JSON.stringify(body)
  const hmac = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(text))
  return { method: 'POST', body: text, headers: { 'X-Hub-Signature-256': `sha256=${[...new Uint8Array(sig)].map(n => n.toString(16).padStart(2, '0')).join('')}` } }
}
async function consume(...events: InboundEvent[]) {
  const messages = events.map(body => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn(), id: crypto.randomUUID(), timestamp: new Date() }))
  await consumeInbound({ messages } as unknown as MessageBatch<unknown>, env)
  return messages
}
async function deliver(body: unknown) {
  accepted = []
  expect((await webhooks.request('/meta', await signed(body), env)).status).toBe(200)
  return consume(...accepted)
}
const publish = () => runtime.DB.batch([
  runtime.DB.prepare("UPDATE triggers SET channel_id='ch-a' WHERE id='trg-a'"),
  runtime.DB.prepare("UPDATE keywords SET status='live' WHERE id='key-a'"),
  runtime.DB.prepare("UPDATE automations SET status='live', published_version_id='ms-v' WHERE id='auto-a'")])
const status = (id: string) => runtime.DB.prepare('SELECT delivery_status s, content FROM messages WHERE id=?').bind(id).first<{ s: string | null; content: string }>()

beforeEach(async () => {
  await seed()
  accepted = []
  create = vi.fn(async () => ({}))
  env = { DB: runtime.DB, ...testKeyring,
    INBOUND: { send: async (event: InboundEvent) => { accepted.push(event) } } as unknown as Queue<InboundEvent>,
    FLOW_RUN: { create, get: async () => ({ sendEvent: async () => {}, status: async () => ({ status: 'running' }) }) } as unknown as NonNullable<IntegrationEnv['FLOW_RUN']> }
  await runtime.DB.batch([
    runtime.DB.prepare("UPDATE channels SET type='messenger', provider='messenger_page', external_id=? WHERE id='ch-a'").bind(page),
    runtime.DB.prepare("UPDATE contact_channels SET external_user_id=?,window_expires_at=?,human_window_expires_at=? WHERE id='cc-a'").bind(user, Date.now() + 86400000, Date.now() + 7 * 86400000),
    runtime.DB.prepare("INSERT INTO automation_versions(id,workspace_id,automation_id,version,graph) VALUES ('ms-v','a','auto-a',1,?)").bind(JSON.stringify(graph)),
    runtime.DB.prepare("INSERT INTO flow_runs(id,workspace_id,contact_id,automation_version_id,channel_id,current_node_id) VALUES ('ms-run','a','c-a','ms-v','ch-a','offer')"),
  ])
  context = { runId: 'ms-run', step: 1, part: 0, channelId: 'ch-a', externalUserId: user, mode: { ok: true, mode: 'free' },
    run: { id: 'ms-run', workspace_id: 'a', contact_id: 'c-a', channel_id: 'ch-a', external_user_id: user, channel_type: 'messenger',
      automation_version_id: 'ms-v', automation_id: 'auto-a', graph: JSON.stringify(graph), start_node_id: null, depth: 0 } }
  await giveCredentials(runtime, 'ch-a', { accessToken: 'TESTONLY', pageId: page, appSecret: secret, verifyToken: 'VERIFY-TEST' })
  adapter = new MessengerAdapter(env as never)
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    if (url.endsWith(`/${page}/messages`)) return Response.json({ recipient_id: user, message_id: `mid.out.${vi.mocked(fetch).mock.calls.length}` })
    if (url.includes(`/${stranger}?fields=first_name,last_name,profile_pic`)) return Response.json({ first_name: 'Joana', last_name: 'Prado', profile_pic: 'https://cdn.test/joana.jpg' })
    throw new Error(`unexpected request ${url}`)
  })
})
afterEach(() => { vi.restoreAllMocks() })

it('DM de quem escreve pela primeira vez vira contato com nome e foto, abre a janela e dispara a automação', async () => {
  await publish()
  const [message] = await deliver(envelope(item()))
  expect(message.ack).toHaveBeenCalled()
  const cc = await runtime.DB.prepare('SELECT * FROM contact_channels WHERE channel_id=? AND external_user_id=?').bind('ch-a', stranger).first<{ contact_id: string; opted_in: number; window_expires_at: number; human_window_expires_at: number }>()
  expect(cc).toMatchObject({ opted_in: 1 })
  expect(cc!.window_expires_at - Date.now()).toBeGreaterThan(23 * 3600_000)
  expect(cc!.human_window_expires_at - Date.now()).toBeGreaterThan(6 * 86400_000)
  expect(await runtime.DB.prepare('SELECT first_name,last_name,profile_pic_url FROM contacts WHERE id=?').bind(cc!.contact_id).first())
    .toEqual({ first_name: 'Joana', last_name: 'Prado', profile_pic_url: 'https://cdn.test/joana.jpg' })
  expect(await runtime.DB.prepare("SELECT content FROM messages WHERE direction='in' AND external_message_id=?").bind(`messenger:ch-a:${stranger}:m.in.1`).first()).not.toBeNull()
  expect(create).toHaveBeenCalledTimes(1)
})

it('o like do Messenger (figurinha de polegar nos três tamanhos) dispara a regra Curtir; outra figurinha não', async () => {
  await publish()
  await runtime.DB.batch([runtime.DB.prepare("UPDATE keywords SET rule='thumbs_up',words='[]' WHERE id='key-a'"),
    runtime.DB.prepare("UPDATE triggers SET repeat_mode='every_time' WHERE id='trg-a'")])
  const sticker = (mid: string, id: number) => item({ message: { mid, sticker_id: id, attachments: [{ type: 'image', payload: { url: 'https://cdn.test/s.png', sticker_id: id } }] } })
  await deliver(envelope(sticker('m.like.s', 369239263222822)))
  await deliver(envelope(sticker('m.like.m', 369239343222814)))
  await deliver(envelope(sticker('m.like.l', 369239383222810)))
  expect(create).toHaveBeenCalledTimes(3)
  expect(await runtime.DB.prepare("SELECT content FROM messages WHERE direction='in' AND external_message_id=?").bind(`messenger:ch-a:${stranger}:m.like.s`).first()).not.toBeNull()
  await deliver(envelope(sticker('m.other', 111111111111111)))
  await deliver(envelope(item({ message: { mid: 'm.text', text: 'quero' } })))
  expect(create).toHaveBeenCalledTimes(3)
})

it('o mesmo webhook entregue duas vezes não duplica mensagem nem disparo', async () => {
  await publish()
  await deliver(envelope(item()))
  await deliver(envelope(item()))
  expect(await runtime.DB.prepare("SELECT count(*) n FROM messages WHERE direction='in'").first<number>('n')).toBe(1)
  expect(await runtime.DB.prepare('SELECT count(*) n FROM flow_runs WHERE inbound_event_id IS NOT NULL').first<number>('n')).toBe(1)
})

it('webhook de outra página, sem conexão que o prove, é recusado sem enfileirar', async () => {
  const other = { object: 'page', entry: [{ id: '999', messaging: [{ ...item(), recipient: { id: '999' } }] }] }
  accepted = []
  expect((await webhooks.request('/meta', await signed(other), env)).status).toBe(401)
  expect((await webhooks.request('/meta', await signed(envelope(item()), 'segredo-errado'), env)).status).toBe(401)
  expect(accepted).toHaveLength(0)
})

it('envia texto com botões como template, no tipo RESPONSE, e guarda a correlação do recibo', async () => {
  const buttons = [{ type: 'postback' as const, id: 'b:' + 'a'.repeat(24), title: 'Continuar' }, { type: 'url' as const, title: 'Site', url: 'https://example.com' }, { type: 'call' as const, title: 'Ligar', phone: '+5511999990000' }]
  expect(await adapter.send(context, { kind: 'text', text: 'Escolha', buttons })).toMatchObject({ ok: true, externalId: 'mid.out.1' })
  const [url, init] = vi.mocked(fetch).mock.calls[0]
  expect(String(url)).toBe(`https://graph.facebook.com/v26.0/${page}/messages`)
  expect(init!.headers).toMatchObject({ Authorization: 'Bearer TESTONLY' })
  expect(JSON.parse(String(init!.body))).toEqual({ recipient: { id: user }, messaging_type: 'RESPONSE', message: { attachment: { type: 'template', payload: {
    template_type: 'button', text: 'Escolha', buttons: [{ type: 'postback', title: 'Continuar', payload: buttons[0].id },
      { type: 'web_url', title: 'Site', url: 'https://example.com' }, { type: 'phone_number', title: 'Ligar', payload: '+5511999990000' }] } } } })
  const row = await runtime.DB.prepare("SELECT content FROM messages WHERE source='automation'").first<{ content: string }>()
  expect(JSON.parse(row!.content)).toMatchObject({ status: 'sent', messenger: { runId: 'ms-run', nodeId: 'offer' } })
  expect(await adapter.send(context, { kind: 'text', text: 'Escolha', buttons })).toMatchObject({ ok: true, externalId: 'mid.out.1' })
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('janela vencida ou sem consentimento barra o envio sem rede', async () => {
  await runtime.DB.prepare("UPDATE contact_channels SET window_expires_at=1 WHERE id='cc-a'").run()
  expect(await adapter.send(context, { kind: 'text', text: 'Olá' })).toMatchObject({ ok: false, reason: 'outside_window' })
  expect(fetch).not.toHaveBeenCalled()
})

it('entrega e leitura chegam à caixa de entrada, sem regredir quando chegam fora de ordem', async () => {
  await adapter.send(context, { kind: 'text', text: 'Olá' })
  const id = `out-${(await runtime.DB.prepare("SELECT id FROM messages WHERE source='automation'").first<string>('id'))!.slice(4)}`
  const sentAt = (await runtime.DB.prepare('SELECT created_at c FROM messages WHERE id=?').bind(id).first<number>('c'))!
  const base = { sender: { id: user }, recipient: { id: page } }
  // Read first (watermark), then a late delivery receipt that names the message.
  await deliver(envelope({ ...base, timestamp: sentAt + 2000, read: { watermark: sentAt + 1000 } }))
  expect(await status(id)).toMatchObject({ s: 'read' })
  expect(JSON.parse((await status(id))!.content)).toMatchObject({ status: 'delivered', messengerStatus: 'read' })
  await deliver(envelope({ ...base, timestamp: sentAt + 3000, delivery: { mids: ['mid.out.1'], watermark: sentAt + 500 } }))
  expect(await status(id)).toMatchObject({ s: 'read' })
})

it('entrega por id de mensagem marca só aquela mensagem; um recibo antes do envio ser confirmado espera nova tentativa', async () => {
  const base = { sender: { id: user }, recipient: { id: page }, timestamp: Date.now() }
  const [early] = await deliver(envelope({ ...base, delivery: { mids: ['mid.out.1'], watermark: Date.now() } }))
  expect(early.retry).toHaveBeenCalled()
  await adapter.send(context, { kind: 'text', text: 'Olá' })
  await deliver(envelope({ ...base, delivery: { mids: ['mid.out.1'], watermark: Date.now() } }))
  expect(await runtime.DB.prepare("SELECT delivery_status s FROM messages WHERE source='automation'").first<string>('s')).toBe('delivered')
})

it('marca d\'água de leitura anterior à gravação local da mensagem (confirmação HTTP demorada) ainda a alcança', async () => {
  await adapter.send(context, { kind: 'text', text: 'Olá' })
  const id = (await runtime.DB.prepare("SELECT id FROM messages WHERE source='automation'").first<string>('id'))!
  const createdAt = (await runtime.DB.prepare('SELECT created_at c FROM messages WHERE id=?').bind(id).first<number>('c'))!
  const base = { sender: { id: user }, recipient: { id: page } }
  await deliver(envelope({ ...base, timestamp: createdAt, read: { watermark: createdAt - 5000 } }))
  expect(await status(id)).toMatchObject({ s: 'read' })
})
it('entregue que chega depois de lido na corrida entre consumidores não regride o estado', async () => {
  await adapter.send(context, { kind: 'text', text: 'Olá' })
  const id = (await runtime.DB.prepare("SELECT id FROM messages WHERE source='automation'").first<string>('id'))!
  const base = { sender: { id: user }, recipient: { id: page } }
  const real = runtime.DB
  // The other consumer records 'read' right after this one has read the message as still 'sent'.
  const racing = new Proxy(real, { get(target, key) {
    const value = Reflect.get(target, key)
    if (key !== 'prepare') return typeof value === 'function' ? value.bind(target) : value
    return (sql: string) => {
      const statement = target.prepare(sql)
      if (!sql.startsWith('SELECT m.id,m.conversation_id FROM messages m')) return statement
      return { bind: (...args: unknown[]) => ({ all: async () => {
        const rows = await statement.bind(...args).all()
        await target.prepare("UPDATE messages SET delivery_status='read' WHERE id=?").bind(id).run()
        return rows
      } }) }
    }
  } }) as unknown as D1Database
  env = { ...env, DB: racing }
  await deliver(envelope({ ...base, timestamp: Date.now(), delivery: { mids: ['mid.out.1'], watermark: Date.now() } }))
  expect(await status(id)).toMatchObject({ s: 'read' })
})

const refTrigger = (channel: string | null = 'ch-a') => runtime.DB.prepare(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status,config)
  VALUES ('ref-bio','a','auto-a',?,'Link da bio','widget','messenger_ref_url','active',?)`).bind(channel, JSON.stringify({ ref: 'bio' }))
const impressions = () => runtime.DB.prepare("SELECT count(*) n FROM trigger_impressions WHERE trigger_id='ref-bio'").first<{ n: number }>().then(row => row!.n)

it('messaging_referrals (link m.me com ref) conta uma impressão do gatilho, sem duplicar reenvio', async () => {
  await runtime.DB.batch([refTrigger()])
  const referral = item({ message: undefined, referral: { ref: 'bio', source: 'SHORTLINK', type: 'OPEN_THREAD' } })
  const [first] = await deliver(envelope(referral))
  expect(first.ack).toHaveBeenCalled()
  await deliver(envelope(referral))
  expect(await impressions()).toBe(1)
  await deliver(envelope(item({ message: undefined, referral: { ref: 'outro', source: 'SHORTLINK', type: 'OPEN_THREAD' } })))
  expect(await impressions()).toBe(1)
  expect(create).not.toHaveBeenCalled()
})

it('postback.referral (botão Começar aberto por link m.me) conta impressão e continua tratando o clique', async () => {
  await runtime.DB.batch([refTrigger()])
  await deliver(envelope(item({ message: undefined, postback: { mid: 'm.pb.1', payload: 'GET_STARTED', referral: { ref: 'bio', source: 'SHORTLINK', type: 'OPEN_THREAD' } } })))
  expect(await impressions()).toBe(1)
})

it('gatilho de link de referência sem conexão é recusado pelo banco (todo widget exige conexão)', async () => {
  await expect(refTrigger(null).run()).rejects.toThrow(/exige uma conex/)
})

const liveRef = (repeat = 'once') => runtime.DB.prepare(`INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,widget_type,status,repeat_mode,config)
  VALUES ('ref-live','a','auto-a','ch-a','Link ao vivo','widget','messenger_ref_url','active',?,?)`).bind(repeat, JSON.stringify({ node_id: 'start', code: 'abcd2345', handle: 'oficina' }))
const refRuns = () => runtime.DB.prepare("SELECT count(*) n FROM flow_runs WHERE trigger_id='ref-live'").first<{ n: number }>().then(row => row!.n)

it('link m.me com ref aberto numa conversa que já existia inicia a automação do link, uma vez por contato', async () => {
  await publish(); await liveRef().run()
  const referral = (ts: number) => item({ sender: { id: user }, message: undefined, timestamp: ts, referral: { ref: 'abcd2345', source: 'SHORTLINK', type: 'OPEN_THREAD' } })
  await deliver(envelope(referral(1000)))
  expect(await refRuns()).toBe(1)
  expect(create).toHaveBeenCalledTimes(1)
  await deliver(envelope(referral(2000)))
  expect(await refRuns()).toBe(1)
  await deliver(envelope(item({ sender: { id: user }, message: undefined, timestamp: 3000, referral: { ref: 'outro', source: 'SHORTLINK', type: 'OPEN_THREAD' } })))
  expect(await refRuns()).toBe(1)
})

it('referral isolado identifica o contato mas não é mensagem: sem primeira entrada, sem opt-in e sem janela de 24 horas', async () => {
  await publish(); await liveRef().run()
  await deliver(envelope(item({ message: undefined, referral: { ref: 'abcd2345', source: 'SHORTLINK', type: 'OPEN_THREAD' } })))
  const cc = await runtime.DB.prepare('SELECT contact_id,opted_in,window_expires_at,human_window_expires_at,first_inbound_id FROM contact_channels WHERE channel_id=? AND external_user_id=?')
    .bind('ch-a', stranger).first<{ contact_id: string; opted_in: number; window_expires_at: number | null; human_window_expires_at: number | null; first_inbound_id: string | null }>()
  expect(cc).not.toBeNull()
  expect(cc).toMatchObject({ opted_in: 0, first_inbound_id: null })
  expect(cc!.window_expires_at ?? 0).toBe(0)
  expect(cc!.human_window_expires_at ?? 0).toBe(0)
  expect(await runtime.DB.prepare("SELECT count(*) n FROM messages WHERE direction='in'").first('n')).toBe(0)
})

it('Começar aberto por link m.me com ref cria o contato e inicia a automação do link', async () => {
  await publish(); await liveRef().run()
  await deliver(envelope(item({ message: undefined, postback: { mid: 'm.pb.ref', payload: 'GET_STARTED', referral: { ref: 'abcd2345', source: 'SHORTLINK', type: 'OPEN_THREAD' } } })))
  expect(await refRuns()).toBe(1)
  expect(await runtime.DB.prepare('SELECT 1 FROM contact_channels WHERE channel_id=? AND external_user_id=?').bind('ch-a', stranger).first()).not.toBeNull()
})

it('clique que responde uma pergunta aberta não planeja a execução do link (nada de execução órfã)', async () => {
  await publish(); await liveRef().run()
  await deliver(envelope(item({ sender: { id: user }, message: undefined, postback: { mid: 'm.pb.q', payload: `q:${'a'.repeat(24)}:s`, referral: { ref: 'abcd2345', source: 'SHORTLINK', type: 'OPEN_THREAD' } } })))
  expect(await refRuns()).toBe(0)
})

it('link desligado ou de automação parada não inicia nada', async () => {
  await publish(); await liveRef().run()
  await runtime.DB.prepare("UPDATE triggers SET status='draft' WHERE id='ref-live'").run()
  await deliver(envelope(item({ sender: { id: user }, message: undefined, referral: { ref: 'abcd2345', source: 'SHORTLINK', type: 'OPEN_THREAD' } })))
  expect(await refRuns()).toBe(0)
})

it('o like (figurinha) sem gatilho Curtir não aciona a resposta padrão; o emoji digitado continua valendo como texto', async () => {
  await publish()
  await runtime.DB.prepare("INSERT INTO triggers(id,workspace_id,automation_id,channel_id,name,kind,status,repeat_mode,config) VALUES ('dflt','a','auto-a','ch-a','Padrão','default_reply','active','every_time','{}')").run()
  const sticker = (mid: string) => item({ message: { mid, sticker_id: 369239263222822, attachments: [{ type: 'image', payload: { url: 'https://cdn.test/s.png', sticker_id: 369239263222822 } }] } })
  await deliver(envelope(sticker('m.like.nodefault')))
  expect(create).not.toHaveBeenCalled()
  expect(await runtime.DB.prepare("SELECT 1 FROM messages WHERE direction='in' AND external_message_id=?").bind(`messenger:ch-a:${stranger}:m.like.nodefault`).first()).not.toBeNull()
  await deliver(envelope(item({ message: { mid: 'm.typed', text: '👍' } })))
  expect(create).toHaveBeenCalledTimes(1)
})
