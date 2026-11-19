import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/env'
import { hooks } from '../src/channels/core/hooks'
import { consumeInbound } from '../src/jobs'
import type { InboundEvent } from '../src/integrations'
import { ensureConversation } from '../src/inbox/service'
import { origin, seedAuth } from './auth-helpers'

const BOT_ONE = '111:AAA-first-bot-token', BOT_TWO = '222:BBB-second-bot-token'
// A local .dev.vars must not leak into these tests (DEV_PROVIDER_API_BASE would redirect the fake Bot API).
const bindings = (extra: Partial<Env> = {}) => ({ ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: 'a', DEV_PROVIDER_API_BASE: undefined, PUBLIC_BASE_URL: undefined, ...extra } as Env)
function call(method: string, path: string, body?: unknown, workspace = 'a', runtime = bindings()) {
  return app.request(`${origin}/api/connections${path === '/' ? '' : path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'x-workspace': workspace, origin, 'content-type': 'application/json' } }, runtime)
}
type Bot = { id: number; username: string; registered: boolean }
const telegram = new Map<string, Bot>()       // bot token -> state of the fake Bot API
let onGetMe: ((token: string) => Promise<void>) | undefined
let apiCalls: { token: string; method: string; body: Record<string, unknown> }[]
function fakeTelegram() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    const graph = /^https:\/\/graph\.facebook\.com\/[^/]+\/(\d+)\?/.exec(url)
    if (graph) return Response.json({ id: graph[1], verified_name: 'Loja e2e' })   // WhatsApp Cloud: any access token is accepted
    const match = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)/.exec(url)
    if (!match) throw new Error(`Unexpected request: ${String(input)}`)
    const [, token, method] = match
    apiCalls.push({ token, method, body: init?.body ? JSON.parse(String(init.body)) : {} })
    const bot = telegram.get(token)
    if (!bot) return Response.json({ ok: false, error_code: 401, description: 'Unauthorized' }, { status: 401 })
    if (method === 'getMe') { await onGetMe?.(token); return Response.json({ ok: true, result: { id: bot.id, is_bot: true, username: bot.username } }) }
    if (method === 'setWebhook') { bot.registered = true; return Response.json({ ok: true, result: true }) }
    if (method === 'deleteWebhook') { bot.registered = false; return Response.json({ ok: true, result: true }) }
    return Response.json({ ok: true, result: { message_id: 500 + apiCalls.length } })
  })
}
const dump = async () => JSON.stringify((await env.DB.prepare('SELECT * FROM channels').all()).results)

beforeEach(async () => {
  await seedAuth()
  apiCalls = []
  onGetMe = undefined
  telegram.clear()
  telegram.set(BOT_ONE, { id: 111, username: 'first_bot', registered: false })
  telegram.set(BOT_TWO, { id: 222, username: 'second_bot', registered: false })
  fakeTelegram()
})
afterEach(() => { vi.restoreAllMocks() })

describe('catálogo', () => {
  it('lista os canais conectáveis com os campos de cada provedor e sem etapa de provedor quando há um só', async () => {
    const { channels } = await (await call('GET', '/catalog')).json() as { channels: { kind: string; providers: { id: string; fields: { key: string; secret: boolean }[] }[] }[] }
    // Messenger congelado: some do catálogo, mas conexões existentes seguem.
    expect(channels.map(c => c.kind).sort()).toEqual(['email', 'instagram', 'telegram', 'whatsapp'])
    const tg = channels.find(c => c.kind === 'telegram')!
    expect(tg.providers.map(p => p.id)).toEqual(['telegram_bot'])
    expect(tg.providers[0].fields).toMatchObject([{ key: 'botToken', secret: true }])
  })
  it('Instagram tem um provedor só, o login unificado, com o rótulo Instagram', async () => {
    const { channels } = await (await call('GET', '/catalog')).json() as { channels: { kind: string; providers: { id: string; label: string }[] }[] }
    expect(channels.find(c => c.kind === 'instagram')!.providers.map(p => [p.id, p.label])).toEqual([['instagram_unified', 'Instagram']])
  })
})

describe('criar conexão', () => {
  it('Telegram: valida o token, cifra, registra o webhook sozinho e nunca devolve segredo', async () => {
    const response = await call('POST', '/', { kind: 'telegram', credentials: { botToken: BOT_ONE } })
    expect(response.status).toBe(201)
    const text = await response.text()
    const { connection, step } = JSON.parse(text)
    expect(step.kind).toBe('done')
    expect(connection).toMatchObject({ kind: 'telegram', provider: 'telegram_bot', displayName: '@first_bot', externalId: '111', status: 'connected', hasCredentials: true,
      webhook: { mode: 'auto', registered: true, url: `${origin}/api/hooks/${connection.id}` } })
    expect(text).not.toContain(BOT_ONE)
    const register = apiCalls.find(c => c.method === 'setWebhook')!
    expect(register.body).toMatchObject({ url: `${origin}/api/hooks/${connection.id}` })
    // The secret Telegram will echo back is not in the response, and nothing is stored in clear.
    expect(text).not.toContain(String(register.body.secret_token))
    const stored = await dump()
    expect(stored).not.toContain(BOT_ONE)
    expect(stored).not.toContain(String(register.body.secret_token))
    expect(JSON.stringify(await (await call('GET', '/')).json())).not.toContain(BOT_ONE)
  })
  it('o webhook registrado funciona: a entrega com o segredo certo chega na fila, com outro segredo não', async () => {
    const { connection } = await (await call('POST', '/', { kind: 'telegram', credentials: { botToken: BOT_ONE } })).json() as { connection: { id: string } }
    const secret = String(apiCalls.find(c => c.method === 'setWebhook')!.body.secret_token)
    const sent: InboundEvent[] = []
    const e = { ...bindings(), INBOUND: { send: async (event: InboundEvent) => { sent.push(event) } } as unknown as Queue<InboundEvent> }
    const update = { update_id: 1, message: { message_id: 1, from: { id: 5, first_name: 'Ana' }, chat: { id: 5, type: 'private' }, text: 'oi' } }
    const post = (token: string) => hooks.request(`/${connection.id}`, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': token }, body: JSON.stringify(update) }, e)
    expect((await post('outro')).status).toBe(401)
    expect((await post(secret)).status).toBe(200)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ channelId: connection.id, workspaceId: 'a' })
  })
  it('token recusado pelo provedor: 422 e nada é gravado', async () => {
    const before = await dump()
    const response = await call('POST', '/', { kind: 'telegram', credentials: { botToken: '999:not-a-real-token' } })
    expect(response.status).toBe(422)
    expect(await dump()).toBe(before)
    expect((await response.json() as { error: string }).error).toMatch(/não aceitou este token/)
  })
  it('provedor fora do ar (503 ou sem resposta) diz isso, em vez de acusar o token', async () => {
    const before = await dump()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('<h1>503</h1>', { status: 503 }))
    const fora = await call('POST', '/', { kind: 'telegram', credentials: { botToken: BOT_ONE } })
    expect(fora.status).toBe(422)
    expect((await fora.json() as { error: string }).error).toMatch(/fora do ar/)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new TypeError('fetch failed') })
    const semResposta = await call('POST', '/', { kind: 'telegram', credentials: { botToken: BOT_ONE } })
    expect((await semResposta.json() as { error: string }).error).toMatch(/fora do ar/)
    expect(await dump()).toBe(before)
  })
  it('campos faltando, formato errado ou desconhecidos são recusados sem repetir o valor', async () => {
    expect((await call('POST', '/', { kind: 'telegram', credentials: {} })).status).toBe(400)
    const bad = await call('POST', '/', { kind: 'telegram', credentials: { botToken: 'sem-formato' } })
    expect(bad.status).toBe(400)
    expect(await bad.text()).not.toContain('sem-formato')
    expect((await call('POST', '/', { kind: 'telegram', credentials: { botToken: BOT_ONE, extra: 'x' } })).status).toBe(400)
    expect((await call('POST', '/', { kind: 'messenger', credentials: {} })).status).toBe(400)
  })
  it('Instagram: o provedor antigo é desconhecido e sem provedor a conexão nasce no login unificado', async () => {
    const credentials = { accessToken: 'IGAA-token-colado', accountId: '17841400000000001', appSecret: 'meta-app-secret' }
    const antigo = await call('POST', '/', { kind: 'instagram', provider: 'instagram_login', credentials })
    expect(antigo.status).toBe(400)
    expect(await antigo.json()).toMatchObject({ error: 'Este canal ainda não pode ser conectado pelo painel.' })
    const novo = await call('POST', '/', { kind: 'instagram', credentials })
    expect(novo.status).toBe(201)
    expect((await novo.json() as { connection: { provider: string } }).connection.provider).toBe('instagram_unified')
  })
  it('a mesma conta não conecta duas vezes', async () => {
    expect((await call('POST', '/', { kind: 'telegram', credentials: { botToken: BOT_ONE } })).status).toBe(201)
    expect((await call('POST', '/', { kind: 'telegram', credentials: { botToken: BOT_ONE } })).status).toBe(409)
  })
  it('conexão Meta: guarda cifrado, gera token de verificação e devolve o passo guiado com URL e token', async () => {
    const response = await call('POST', '/', { kind: 'whatsapp', credentials: { accessToken: 'EAAG-secret-access', phoneNumberId: '5550001', appSecret: 'meta-app-secret' } })
    expect(response.status).toBe(201)
    const { connection, step } = await response.json() as { connection: { id: string; status: string }; step: { kind: string; callbackUrl: string; verifyToken: string; checklist: string[] } }
    expect(step).toMatchObject({ kind: 'manual_webhook', callbackUrl: `${origin}/api/webhooks/meta` })
    expect(step.verifyToken.length).toBeGreaterThanOrEqual(20)
    expect(step.checklist.length).toBeGreaterThan(0)
    expect(connection.status).toBe('pending')
    const stored = await dump()
    for (const secret of ['EAAG-secret-access', 'meta-app-secret', step.verifyToken]) expect(stored).not.toContain(secret)
    // The shared Meta route now accepts the handshake with this connection's own token.
    const { webhooks } = await import('../src/integrations')
    const handshake = await webhooks.request(`/meta?hub.mode=subscribe&hub.verify_token=${step.verifyToken}&hub.challenge=77`, {}, bindings())
    expect(await handshake.text()).toBe('77')
  })
})

describe('isolamento por workspace', () => {
  it('outro workspace não lista, lê, troca credencial, reconfigura webhook nem arquiva', async () => {
    const { connection } = await (await call('POST', '/', { kind: 'telegram', credentials: { botToken: BOT_ONE } })).json() as { connection: { id: string } }
    const idsOf = async (r: Response) => (await r.json() as { id: string }[]).map(c => c.id)
    expect(await idsOf(await call('GET', '/', undefined, 'b', bindings({ DEV_WORKSPACE_ID: 'b' })))).toEqual(['ch-b'])
    expect(await idsOf(await call('GET', '/'))).toContain(connection.id)
    const b = bindings({ DEV_WORKSPACE_ID: 'b' })
    expect((await call('GET', `/${connection.id}`, undefined, 'b', b)).status).toBe(404)
    expect((await call('POST', `/${connection.id}/rotate`, { credentials: { botToken: BOT_TWO } }, 'b', b)).status).toBe(404)
    expect((await call('POST', `/${connection.id}/webhook`, undefined, 'b', b)).status).toBe(404)
    expect((await call('DELETE', `/${connection.id}`, undefined, 'b', b)).status).toBe(404)
    expect((await call('GET', `/${connection.id}`)).status).toBe(200)
  })
})

describe('trocar credencial', () => {
  it('regrava cifrado com o token novo, registra o webhook de novo e passa a enviar com ele', async () => {
    telegram.set('111:AAA-rotated-token', { id: 111, username: 'first_bot', registered: false })
    const { connection } = await (await call('POST', '/', { kind: 'telegram', credentials: { botToken: BOT_ONE } })).json() as { connection: { id: string } }
    const response = await call('POST', `/${connection.id}/rotate`, { credentials: { botToken: '111:AAA-rotated-token' } })
    expect(response.status).toBe(200)
    const body = await response.json() as { rotatedAt: number }
    expect(typeof body.rotatedAt).toBe('number')
    expect(JSON.stringify(body)).not.toContain('rotated-token')
    expect(apiCalls.filter(c => c.token === '111:AAA-rotated-token').map(c => c.method)).toEqual(['getMe', 'setWebhook'])
    expect(await dump()).not.toContain('rotated-token')
    // The connection uses the new token from now on.
    const { connectionRuntime } = await import('../src/channels/core/runtime')
    expect((await (await connectionRuntime(env, 'a', connection.id)).credentials()).botToken).toBe('111:AAA-rotated-token')
  })
  it('credencial de outra conta é recusada e a antiga continua valendo', async () => {
    const { connection } = await (await call('POST', '/', { kind: 'telegram', credentials: { botToken: BOT_ONE } })).json() as { connection: { id: string } }
    expect((await call('POST', `/${connection.id}/rotate`, { credentials: { botToken: BOT_TWO } })).status).toBe(409)
    expect((await call('POST', `/${connection.id}/rotate`, { credentials: { botToken: '1:invalid' } })).status).toBe(422)
    const { connectionRuntime } = await import('../src/channels/core/runtime')
    expect((await (await connectionRuntime(env, 'a', connection.id)).credentials()).botToken).toBe(BOT_ONE)
  })
  it('Meta: trocar só o token de acesso mantém os outros segredos; trocar o número é recusado', async () => {
    const { connection } = await (await call('POST', '/', { kind: 'whatsapp', credentials: { accessToken: 'old-access', phoneNumberId: '5550002', appSecret: 'kept-secret' } })).json() as { connection: { id: string } }
    expect((await call('POST', `/${connection.id}/rotate`, { credentials: { accessToken: 'new-access' } })).status).toBe(200)
    const { connectionRuntime } = await import('../src/channels/core/runtime')
    expect(await (await connectionRuntime(env, 'a', connection.id)).credentials()).toMatchObject({ accessToken: 'new-access', appSecret: 'kept-secret', phoneNumberId: '5550002' })
    expect((await call('POST', `/${connection.id}/rotate`, { credentials: { phoneNumberId: '9' } })).status).toBe(400)
  })
})

describe('arquivar', () => {
  it('preserva contatos e conversas, para o webhook, apaga credenciais e libera a conta para reconectar', async () => {
    const { connection } = await (await call('POST', '/', { kind: 'telegram', credentials: { botToken: BOT_ONE } })).json() as { connection: { id: string } }
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contacts (id,workspace_id,first_name) VALUES ('arch-c','a','Bia')"),
      env.DB.prepare("INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id,opted_in) VALUES ('arch-cc','a','arch-c',?,'700',1)").bind(connection.id),
    ])
    const conversationId = await ensureConversation(env, 'a', 'arch-c', connection.id)
    const count = async (sql: string) => env.DB.prepare(sql).bind(connection.id).first<number>('n')
    const links = await count('SELECT count(*) n FROM contact_channels WHERE channel_id=?')
    expect((await call('DELETE', `/${connection.id}`)).status).toBe(204)
    expect(await count('SELECT count(*) n FROM contact_channels WHERE channel_id=?')).toBe(links)
    expect(await env.DB.prepare('SELECT count(*) n FROM conversations WHERE id=?').bind(conversationId).first('n')).toBe(1)
    expect(await env.DB.prepare('SELECT count(*) n FROM contacts WHERE id=?').bind('arch-c').first('n')).toBe(1)
    // Gone from the list, deliveries refused, credentials dropped, Telegram told to stop.
    expect((await (await call('GET', '/')).json() as { id: string }[]).map(c => c.id)).not.toContain(connection.id)
    expect((await call('GET', `/${connection.id}`)).status).toBe(404)
    expect((await hooks.request(`/${connection.id}`, { method: 'POST', body: '{}' }, bindings())).status).toBe(404)
    expect(await env.DB.prepare('SELECT credentials_ciphertext c, webhook_secret_hash h FROM channels WHERE id=?').bind(connection.id).first()).toEqual({ c: null, h: null })
    expect(apiCalls.some(c => c.method === 'deleteWebhook' && c.token === BOT_ONE)).toBe(true)
    // The same bot can be connected again.
    expect((await call('POST', '/', { kind: 'telegram', credentials: { botToken: BOT_ONE } })).status).toBe(201)
  })
})

describe('duas contas do mesmo canal no mesmo workspace', () => {
  it('cada conexão tem a sua URL, o seu segredo e as suas credenciais', async () => {
    const one = await (await call('POST', '/', { kind: 'telegram', credentials: { botToken: BOT_ONE } })).json() as { connection: { id: string } }
    const two = await (await call('POST', '/', { kind: 'telegram', credentials: { botToken: BOT_TWO } })).json() as { connection: { id: string } }
    expect(one.connection.id).not.toBe(two.connection.id)
    const secrets = apiCalls.filter(c => c.method === 'setWebhook').map(c => String(c.body.secret_token))
    expect(new Set(secrets).size).toBe(2)
    const sent: InboundEvent[] = []
    const e = { ...bindings(), INBOUND: { send: async (event: InboundEvent) => { sent.push(event) } } as unknown as Queue<InboundEvent> }
    const update = { update_id: 3, message: { message_id: 1, from: { id: 5, first_name: 'Ana' }, chat: { id: 5, type: 'private' }, text: 'oi' } }
    const post = (id: string, secret: string) => hooks.request(`/${id}`, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(update) }, e)
    expect((await post(one.connection.id, secrets[1])).status).toBe(401)   // the other bot's secret does not open this one
    expect((await post(one.connection.id, secrets[0])).status).toBe(200)
    expect((await post(two.connection.id, secrets[1])).status).toBe(200)
    expect(sent.map(s => s.channelId)).toEqual([one.connection.id, two.connection.id])
    await consumeInbound({ messages: sent.map(body => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn(), id: crypto.randomUUID(), timestamp: new Date() })) } as unknown as MessageBatch<unknown>, { DB: env.DB })
    // First delivery promotes nothing here (webhook registered => already connected); both rows exist side by side.
    expect(await env.DB.prepare("SELECT count(*) n FROM channels WHERE workspace_id='a' AND type='telegram' AND archived_at IS NULL").first('n')).toBeGreaterThanOrEqual(2)
  })
})

describe('revisão: credenciais', () => {
  it('trocar o token de verificação Meta troca o que o handshake aceita (o novo vale, o antigo não)', async () => {
    const { connection, step } = await (await call('POST', '/', { kind: 'whatsapp', credentials: { accessToken: 'tok', phoneNumberId: '5550077', appSecret: 'app-sec' } })).json() as { connection: { id: string }; step: { verifyToken: string } }
    const { webhooks } = await import('../src/integrations')
    const shake = async (token: string) => (await webhooks.request(`/meta?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=9`, {}, bindings())).status
    expect((await call('POST', `/${connection.id}/rotate`, { credentials: { verifyToken: 'token-novo-de-verificacao' } })).status).toBe(200)
    expect(await shake('token-novo-de-verificacao')).toBe(200)
    expect(await shake(step.verifyToken)).toBe(403)
  })
  it('rotação que termina depois do arquivamento não ressuscita credenciais nem registra o webhook', async () => {
    telegram.set('111:AAA-late-token', { id: 111, username: 'first_bot', registered: false })
    const { connection } = await (await call('POST', '/', { kind: 'telegram', credentials: { botToken: BOT_ONE } })).json() as { connection: { id: string } }
    onGetMe = async token => { if (token === '111:AAA-late-token') { onGetMe = undefined; await call('DELETE', `/${connection.id}`) } }
    expect((await call('POST', `/${connection.id}/rotate`, { credentials: { botToken: '111:AAA-late-token' } })).status).toBe(404)
    expect(await env.DB.prepare('SELECT credentials_ciphertext c FROM channels WHERE id=?').bind(connection.id).first('c')).toBeNull()
    expect(apiCalls.some(c => c.token === '111:AAA-late-token' && c.method === 'setWebhook')).toBe(false)
  })
  it('conexão com provedor fora do catálogo não derruba a lista', async () => {
    await env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id,provider) VALUES ('x-uaz','a','whatsapp','ext-uaz','uazapi')").run()
    const response = await call('GET', '/')
    expect(response.status).toBe(200)
    expect((await response.json() as { id: string }[]).map(c => c.id)).toContain('x-uaz')
  })
})

describe('atualizar conexão', () => {
  it('revalida no provedor e reassina o webhook; token revogado deixa a conexão em erro com o motivo', async () => {
    const { connection } = await (await call('POST', '/', { kind: 'telegram', credentials: { botToken: BOT_ONE } })).json() as { connection: { id: string } }
    telegram.get(BOT_ONE)!.registered = false
    const ok = await (await call('POST', `/${connection.id}/refresh`)).json() as { ok: boolean }
    expect(ok.ok).toBe(true)
    expect(telegram.get(BOT_ONE)!.registered).toBe(true)
    telegram.delete(BOT_ONE)
    const bad = await (await call('POST', `/${connection.id}/refresh`)).json() as { ok: boolean; detail: string }
    expect(bad).toMatchObject({ ok: false, detail: expect.stringContaining('credenciais') })
    expect(await env.DB.prepare('SELECT connection_state FROM channels WHERE id=?').bind(connection.id).first('connection_state')).toBe('error')
  })
})

describe('desativar sem apagar', () => {
  it('desativada não recebe webhook e mantém credenciais; reativar revalida e volta a receber', async () => {
    const { connection } = await (await call('POST', '/', { kind: 'telegram', credentials: { botToken: BOT_ONE } })).json() as { connection: { id: string } }
    const secret = String(apiCalls.find(c => c.method === 'setWebhook')!.body.secret_token)
    const e = { ...bindings(), INBOUND: { send: async () => {} } as unknown as Queue<InboundEvent> }
    const post = () => hooks.request(`/${connection.id}`, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify({ update_id: 9, message: { message_id: 1, from: { id: 5, first_name: 'Ana' }, chat: { id: 5, type: 'private' }, text: 'oi' } }) }, e)
    expect(await (await call('POST', `/${connection.id}/enabled`, { enabled: false })).json()).toMatchObject({ connection: { status: 'disconnected' } })
    expect((await post()).status).toBe(404)
    expect(await env.DB.prepare('SELECT credentials_ciphertext IS NOT NULL FROM channels WHERE id=?').bind(connection.id).first()).toMatchObject({ 'credentials_ciphertext IS NOT NULL': 1 })
    expect(await (await call('POST', `/${connection.id}/enabled`, { enabled: true })).json()).toMatchObject({ ok: true, connection: { status: 'connected' } })
    expect((await post()).status).toBe(200)
  })
})

describe('total de contatos por conexão na lista', () => {
  it('contactTotal é o mesmo total de GET /contacts?connection_id= (excluídos e outro workspace ficam de fora)', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('ch-a2','a','telegram','external-a2'),('ch-vazio','a','telegram','external-vazio')"),
      env.DB.prepare(`INSERT INTO contacts (id,workspace_id,first_name,subscribed_at,status) VALUES
        ('c-a2','a','Dois',1001,'subscribed'),('c-a3','a','Três',1002,'unsubscribed'),('c-del','a','Excluído',1003,'deleted')`),
      env.DB.prepare(`INSERT INTO contact_channels (id,workspace_id,contact_id,channel_id,external_user_id) VALUES
        ('cc-a2','a','c-a2','ch-a','u2'),('cc-a2b','a','c-a2','ch-a2','u2b'),('cc-a3','a','c-a3','ch-a2','u3'),('cc-del','a','c-del','ch-a','u4')`),
    ])
    const list = await (await call('GET', '/')).json() as { id: string; contactTotal?: number }[]
    const totals = Object.fromEntries(list.map(c => [c.id, c.contactTotal]))
    expect(totals).toEqual({ 'ch-a': 2, 'ch-a2': 2, 'ch-vazio': 0 })
    for (const id of Object.keys(totals)) {
      const page = await (await app.request(`${origin}/api/contacts?connection_id=${id}`, { headers: { 'x-workspace': 'a', origin } }, bindings())).json() as { total: number }
      expect(`${id} ${page.total}`).toBe(`${id} ${totals[id]}`)
    }
    const b = await (await call('GET', '/', undefined, 'b', bindings({ DEV_WORKSPACE_ID: 'b' }))).json() as { id: string; contactTotal?: number }[]
    expect(b.map(c => [c.id, c.contactTotal])).toEqual([['ch-b', 1]])
  })
})
