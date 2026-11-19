import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/env'
import { giveCredentials } from './credentials'
import { origin, seedAuth } from './auth-helpers'

const SERVER = 'https://loja.uazapi.com', TOKEN = 'UZ-SECRET-TOKEN', ADMIN = 'UZ-ADMIN-TOKEN'
const bindings = () => ({ ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: 'a', DEV_PROVIDER_API_BASE: undefined, PUBLIC_BASE_URL: undefined } as Env)
function call(method: string, path: string, body?: unknown) {
  return app.request(`${origin}/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'x-workspace': 'a', origin, 'content-type': 'application/json' } }, bindings())
}
let instance: { id: string; status: string; qrcode?: string; profileName?: string }
let calls: { path: string; body: Record<string, unknown> }[]
let all: { name: string; token: string }[]

beforeEach(async () => {
  await seedAuth()
  calls = []
  all = [{ name: 'principal', token: TOKEN }]
  instance = { id: 'r183e2ef', status: 'disconnected' }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.origin !== SERVER) throw new Error(`Unexpected request: ${url.href}`)
    calls.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : {} })
    if (url.pathname === '/instance/all') return new Headers(init?.headers).get('admintoken') === ADMIN ? Response.json(all.map(i => ({ ...i, id: 'r183e2ef', status: 'disconnected' }))) : Response.json({ message: 'Invalid admin token.' }, { status: 401 })
    if (new Headers(init?.headers).get('token') !== TOKEN) return Response.json({ error: 'Invalid token' }, { status: 401 })
    if (url.pathname === '/instance/status') return Response.json({ instance, status: { connected: instance.status === 'connected' } })
    if (url.pathname === '/instance/connect') { instance = { ...instance, status: 'connecting', qrcode: 'data:image/png;base64,QR-1' }; return Response.json({ response: 'Connecting' }) }
    if (url.pathname === '/webhook') return Response.json([{ id: 'wh' }])
    return Response.json({}, { status: 404 })
  })
})
afterEach(() => { vi.restoreAllMocks() })

const create = (over: Record<string, unknown> = {}) => call('POST', '/connections', { kind: 'whatsapp', provider: 'uazapi', displayName: 'Loja', credentials: { serverUrl: SERVER, token: TOKEN }, ...over })

describe('catálogo e conexão por QR', () => {
  it('WhatsApp ganha a etapa de provedor, com aviso de bloqueio e as opções só da UAZAPI', async () => {
    const { channels } = await (await call('GET', '/connections/catalog')).json() as { channels: { kind: string; providers: { id: string; notice?: string; options?: { key: string; type: string }[]; fields: { key: string; secret: boolean }[] }[] }[] }
    const whatsapp = channels.find(c => c.kind === 'whatsapp')!
    expect(whatsapp.providers.map(p => p.id).sort()).toEqual(['meta_whatsapp_cloud', 'uazapi', 'zapi'])
    const uazapi = whatsapp.providers.find(p => p.id === 'uazapi')!
    expect(uazapi.notice).toMatch(/bloquear o número/)
    expect(uazapi.fields).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'token', secret: true }), expect.objectContaining({ key: 'serverUrl', secret: false })]))
    expect(uazapi.options!.map(o => o.key)).toEqual(['typing', 'markRead', 'rejectCalls', 'rejectCallMessage', 'unopenedMessageText'])
    expect(whatsapp.providers.find(p => p.id === 'meta_whatsapp_cloud')!.options).toBeUndefined()
  })
  it('cria a conexão, registra o webhook e devolve o QR; só a prova da UAZAPI marca como conectada', async () => {
    const response = await create()
    expect(response.status).toBe(201)
    const { connection, step } = await response.json() as { connection: { id: string; status: string; externalId: string; webhook: { registered: boolean; mode: string } }; step: { kind: string; qr: string } }
    expect(step).toMatchObject({ kind: 'qr', qr: 'data:image/png;base64,QR-1' })
    expect(connection).toMatchObject({ status: 'connecting', externalId: 'uazapi:r183e2ef', webhook: { registered: true, mode: 'auto' } })
    const hook = calls.find(c => c.path === '/webhook')!.body
    expect(hook).toMatchObject({ enabled: true, url: `${origin}/api/hooks/${connection.id}`, excludeMessages: ['wasSentByApi'] })
    expect(hook.events).toEqual(expect.arrayContaining(['messages', 'messages_update', 'connection']))
    // The panel keeps asking while the QR is open: still waiting, then paired.
    expect(((await (await call('POST', `/connections/${connection.id}/connect`)).json()) as { step: { kind: string }; connection: { status: string } })).toMatchObject({ step: { kind: 'qr' }, connection: { status: 'connecting' } })
    instance = { ...instance, status: 'connected', profileName: 'Loja da Ana' }
    const done = await (await call('POST', `/connections/${connection.id}/connect`)).json() as { step: { kind: string }; connection: { status: string } }
    expect(done).toMatchObject({ step: { kind: 'done' }, connection: { status: 'connected' } })
    // The token is encrypted at rest and never comes back.
    const everything = JSON.stringify([await (await call('GET', '/connections')).json(), done, (await env.DB.prepare('SELECT * FROM channels WHERE id=?').bind(connection.id).first())])
    expect(everything).not.toContain(TOKEN)
    expect(await env.DB.prepare('SELECT sync_cursor FROM channels WHERE id=?').bind(connection.id).first('sync_cursor')).toBeGreaterThan(0)
  })
  it('instância já pareada conecta direto, token errado e servidor que não é https são recusados', async () => {
    instance = { id: 'r183e2ef', status: 'connected', profileName: 'Loja da Ana' }
    expect(await (await create({ displayName: undefined })).json()).toMatchObject({ step: { kind: 'done' }, connection: { status: 'connected', displayName: 'Loja da Ana' } })
    expect((await create({ credentials: { serverUrl: SERVER, token: 'errado' } })).status).toBe(422)
    expect((await create({ credentials: { serverUrl: 'http://loja.uazapi.com', token: TOKEN } })).status).toBe(400)
    expect((await create({ credentials: { serverUrl: 'https://10.0.0.1', token: TOKEN } })).status).toBe(422)   // refused before any request leaves
  })
  it('a mesma instância não conecta duas vezes', async () => {
    expect((await create()).status).toBe(201)
    expect((await create()).status).toBe(409)
  })
})

describe('token de administrador', () => {
  const asAdmin = (extra: Record<string, string> = {}) => create({ credentials: { serverUrl: SERVER, token: ADMIN, ...extra } })
  const stored = async (id: string) => {
    const { openRow } = await import('../src/channels/core/credentials')
    return openRow(env as never, 'a', id, await env.DB.prepare('SELECT credentials_ciphertext,credentials_iv,credentials_key_version FROM channels WHERE id=?').bind(id).first())
  }
  it('com uma só instância, usa a dela; guarda cifrados o token da instância e o de administrador, e nenhum volta pela API', async () => {
    const response = await asAdmin()
    expect(response.status).toBe(201)
    const body = await response.json() as { connection: { id: string }; step: { kind: string } }
    expect(body.step.kind).toBe('qr')
    expect(calls.map(c => c.path)).toEqual(expect.arrayContaining(['/instance/all', '/instance/connect', '/webhook']))
    const saved = await stored(body.connection.id)
    expect(saved).toMatchObject({ serverUrl: SERVER, token: TOKEN, adminToken: ADMIN })
    const row = JSON.stringify(await env.DB.prepare('SELECT * FROM channels WHERE id=?').bind(body.connection.id).first())
    const shown = JSON.stringify([body, await (await call('GET', '/connections')).json(), await (await call('GET', `/connections/${body.connection.id}`)).json()])
    for (const text of [row, shown]) { expect(text).not.toContain(TOKEN); expect(text).not.toContain(ADMIN) }
  })
  it('com várias instâncias escolhe pelo nome; sem nome ou com nome errado recusa listando os nomes', async () => {
    all = [{ name: 'vendas', token: 'OUTRO' }, { name: 'principal', token: TOKEN }]
    const ok = await asAdmin({ instanceName: 'principal' })
    expect(ok.status).toBe(201)
    expect(await stored((await ok.json() as { connection: { id: string } }).connection.id)).toMatchObject({ token: TOKEN, adminToken: ADMIN })
    await env.DB.prepare('DELETE FROM channels WHERE provider=?').bind('uazapi').run()
    for (const extra of [{} as Record<string, string>, { instanceName: 'inexistente' }]) {
      const refused = await asAdmin(extra)
      expect(refused.status).toBe(422)
      const { error } = await refused.json() as { error: string }
      expect(error).toContain('vendas'); expect(error).toContain('principal')
    }
  })
  it('recusa quando não vale nem como token da instância nem como o de administrador', async () => {
    const refused = await create({ credentials: { serverUrl: SERVER, token: 'errado' } })
    expect(refused.status).toBe(422)
    expect(await refused.json()).toMatchObject({ error: 'O provedor não aceitou o token (nem como token da instância, nem como token de administrador).' })
  })
  it('o token da instância continua funcionando sem consultar a lista de instâncias', async () => {
    expect((await create()).status).toBe(201)
    expect(calls.map(c => c.path)).not.toContain('/instance/all')
  })
})

describe('opções da conexão', () => {
  async function connected() {
    instance = { id: 'r183e2ef', status: 'connected' }
    return (await (await create()).json() as { connection: { id: string } }).connection.id
  }
  it('padrão desligado; salva as opções declaradas e mostra os valores sem segredo', async () => {
    const id = await connected()
    expect((await (await call('GET', `/connections/${id}`)).json() as { settings: unknown }).settings).toEqual({})
    const saved = await call('PATCH', `/connections/${id}`, { settings: { typing: true, markRead: true, rejectCalls: true, rejectCallMessage: ' Não atendo ligações. ', unopenedMessageText: 'Reenvie, por favor.' } })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ settings: { typing: true, markRead: true, rejectCalls: true, rejectCallMessage: 'Não atendo ligações.', unopenedMessageText: 'Reenvie, por favor.' } })
    // An empty text clears the option; a boolean can be switched off again.
    expect(await (await call('PATCH', `/connections/${id}`, { settings: { rejectCallMessage: '', typing: false } })).json()).toMatchObject({ settings: { typing: false, markRead: true } })
  })
  it('recusa opção desconhecida, de tipo errado ou de outro provedor', async () => {
    const id = await connected()
    expect((await call('PATCH', `/connections/${id}`, { settings: { apiBase: 'https://evil.test' } })).status).toBe(400)
    expect((await call('PATCH', `/connections/${id}`, { settings: { typing: 'sim' } })).status).toBe(400)
    expect((await call('PATCH', `/connections/${id}`, { settings: { rejectCallMessage: 'x'.repeat(501) } })).status).toBe(400)
    await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('wa-a','a','whatsapp','phone-id')").run()
    await giveCredentials(env, 'wa-a', { accessToken: 'T', phoneNumberId: 'phone-id', appSecret: 's', webhookSecret: 'v' })
    expect((await call('PATCH', `/connections/wa-a`, { settings: { typing: true } })).status).toBe(400)   // the official WhatsApp does not show them
  })
})

describe('publicação', () => {
  const draft = (blocks: unknown[]) => JSON.stringify({ nodes: [
    { id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'm', type: 'message', position: { x: 1, y: 0 }, config: { blocks } }], edges: [{ from: 't', port: 'next', to: 'm' }] })
  async function setup(channel: string, blocks: unknown[]) {
    await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,provider,external_id,display_name) VALUES ('uz-a','a','whatsapp','uazapi','uazapi:r1','Loja UAZAPI')").run()
    await env.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id,display_name) VALUES ('wa-a','a','whatsapp','phone-id','Número oficial')").run()
    await env.DB.prepare("UPDATE triggers SET channel_id=? WHERE id='trg-a'").bind(channel).run()
    await env.DB.prepare("UPDATE automations SET draft_graph=? WHERE id='auto-a'").bind(draft(blocks)).run()
  }
  const publish = () => call('POST', '/automations/auto-a/publish')
  it('bloqueia recurso que a conexão do gatilho não entrega e diz qual, onde e em qual conexão', async () => {
    await setup('uz-a', [{ kind: 'text', text: 'Veja a oferta' }, { type: 'template', name: 'oferta' }])
    const response = await publish()
    expect(response.status).toBe(409)
    const { error } = await response.json() as { error: string }
    expect(error).toMatch(/template de mensagem/)
    expect(error).toContain('“Veja a oferta”')
    expect(error).toContain('Loja UAZAPI')
    expect(await env.DB.prepare("SELECT published_version_id FROM automations WHERE id='auto-a'").first('published_version_id')).toBeNull()
  })
  it('o mesmo passo publica quando o gatilho é do WhatsApp oficial, que tem templates', async () => {
    await setup('wa-a', [{ kind: 'text', text: 'Veja a oferta' }, { type: 'template', name: 'oferta' }])
    expect((await publish()).status).toBe(201)
  })
  it('texto com botões publica na UAZAPI; cartões e anexos não', async () => {
    await setup('uz-a', [{ kind: 'text', text: 'Escolha' }, { kind: 'button', id: 'b1', label: 'Sim', action: { type: 'go_to_node' } }])
    expect((await publish()).status).toBe(201)
    await env.DB.prepare("UPDATE automations SET draft_graph=? WHERE id='auto-a'").bind(draft([{ kind: 'text', text: 'Galeria' }, { type: 'cards' }, { type: 'attachment' }])).run()
    const { error } = await (await publish()).json() as { error: string }
    expect(error).toMatch(/cartões/)
    expect(error).toMatch(/anexo/)
  })
  it('gatilho de grupo bloqueia botões (em grupo a resposta sai só como texto) e publica texto', async () => {
    await setup('uz-a', [{ kind: 'text', text: 'Escolha' }, { kind: 'button', id: 'b1', label: 'Sim', action: { type: 'go_to_node' } }])
    await env.DB.prepare("UPDATE triggers SET audience='group',group_match='mention' WHERE id='trg-a'").run()
    await env.DB.prepare("UPDATE channels SET status='connected' WHERE id='uz-a'").run()
    const response = await publish()
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: string }).error).toMatch(/botões na mensagem “Escolha” não funciona na conexão Loja UAZAPI/)
    await env.DB.prepare("UPDATE automations SET draft_graph=? WHERE id='auto-a'").bind(draft([{ kind: 'text', text: 'Oi, grupo' }])).run()
    expect((await publish()).status).toBe(201)
  })
  it('gatilho de outra conexão não é afetado pela UAZAPI', async () => {
    await setup('ch-a', [{ kind: 'text', text: 'Veja' }, { type: 'template', name: 'oferta' }])
    await env.DB.prepare("UPDATE channels SET status='connected' WHERE id='ch-a'").run()
    // ch-a (Instagram) cannot send a template either, but the UAZAPI connection is not tied to this automation.
    const { error } = await (await publish()).json() as { error: string }
    expect(error).not.toContain('UAZAPI')
  })
})
