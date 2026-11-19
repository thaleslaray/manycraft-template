// Defeitos achados na varredura ao vivo da API (.scratch/api-varredura/ao-vivo.md, D1–D8, e funis.md #4/#5), pela borda HTTP com provedor falso.
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/env'
import { ensureConversation } from '../src/inbox/service'
import { origin, seedAuth } from './auth-helpers'
import { giveCredentials } from './credentials'

const bindings = (extra: Partial<Env> = {}) => ({ ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: 'a', DEV_PROVIDER_API_BASE: undefined, PUBLIC_BASE_URL: undefined, ...extra } as Env)
function call(method: string, path: string, body?: unknown) {
  return app.request(`${origin}/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'x-workspace': 'a', origin, 'content-type': 'application/json' } }, bindings())
}
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>
let handler: Handler
const graphError = (code: number, extra: Record<string, unknown> = {}, status = 400) => Response.json({ error: { message: 'raw', type: 'OAuthException', code, fbtrace_id: 'TRACE1', ...extra } }, { status })

async function channel(id: string, type: string, provider: string, credentials?: Record<string, string>, state = 'connected') {
  await env.DB.prepare('INSERT INTO channels(id,workspace_id,type,provider,external_id,connection_state) VALUES (?,?,?,?,?,?)').bind(id, 'a', type, provider, `ext-${id}`, state).run()
  if (credentials) await giveCredentials(env, id, credentials)
}
const errorOf = async (r: Response) => (await r.json() as { error: string }).error

beforeEach(async () => {
  await seedAuth()
  handler = url => { throw new Error(`Pedido inesperado: ${url}`) }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => handler(String(input instanceof Request ? input.url : input), init))
})
afterEach(() => { vi.restoreAllMocks() })

describe('D1 revisão de recursos da Meta', () => {
  it('sem credencial guardada: 409 com a frase de colar o token, sem chamar a Meta', async () => {
    await channel('ig-sem', 'instagram', 'instagram_unified')
    const r = await call('GET', '/connections/ig-sem/meta-review')
    expect(r.status).toBe(409)
    expect(await errorOf(r)).toMatch(/sem credencial salva.*token/i)
  })
  it('a Meta recusa: repassa código e subcódigo traduzidos, com status de recusa', async () => {
    await channel('ig-com', 'instagram', 'instagram_unified', { accessToken: 'tok', accountId: '1789', webhookSecret: 's' })
    handler = () => graphError(190, { error_subcode: 463 })
    const r = await call('GET', '/connections/ig-com/meta-review')
    expect(r.status).toBe(409)
    expect(await errorOf(r)).toMatch(/token.*código 190, subcódigo 463/)
  })
})

describe('D2 nome de usuário e D3 perfil comercial do WhatsApp', () => {
  beforeEach(() => channel('wa-1', 'whatsapp', 'meta_whatsapp_cloud', { accessToken: 'tok', phoneNumberId: '555', appSecret: 'x', webhookSecret: 's' }))
  it('D2: recusa de regra da Meta vira 422 com código e a mensagem para o usuário', async () => {
    handler = () => graphError(100, { error_subcode: 2388001, error_user_msg: 'Nome de usuário já em uso' })
    const r = await call('POST', '/connections/wa-1/username', { username: 'loja.teste' })
    expect(r.status).toBe(422)
    const error = await errorOf(r)
    expect(error).toContain('código 100, subcódigo 2388001')
    expect(error).toContain('Nome de usuário já em uso')
  })
  it('D2: Meta fora do ar (sem corpo de erro) segue 502', async () => {
    handler = () => new Response('bad gateway', { status: 503 })
    expect((await call('POST', '/connections/wa-1/username', { username: 'loja.teste' })).status).toBe(502)
  })
  it('D3: perfil comercial recusado devolve código e frase, sem ecoar o texto cru da Meta', async () => {
    handler = () => graphError(131009, { error_user_msg: 'dado da conta 5511999' })
    const r = await call('PUT', '/connections/wa-1/business-profile', { about: 'Olá' })
    expect(r.status).toBe(422)
    const error = await errorOf(r)
    expect(error).toContain('código 131009')
    expect(error).not.toContain('5511999')
  })
})

describe('D4 modelos sem ID da conta do WhatsApp Business (WABA)', () => {
  it('canSync só com WABA; a sincronização sem WABA responde 409 dizendo o que informar', async () => {
    await channel('wa-sem-waba', 'whatsapp', 'meta_whatsapp_cloud', { accessToken: 'tok', phoneNumberId: '555', appSecret: 'x', webhookSecret: 's' })
    await channel('wa-com-waba', 'whatsapp', 'meta_whatsapp_cloud', { accessToken: 'tok', phoneNumberId: '556', appSecret: 'x', wabaId: '9001', webhookSecret: 's' })
    const options = await (await call('GET', '/message-templates/options')).json() as { connections: { id: string; canSync: boolean }[] }
    expect(options.connections.find(c => c.id === 'wa-sem-waba')?.canSync).toBe(false)
    expect(options.connections.find(c => c.id === 'wa-com-waba')?.canSync).toBe(true)
    const r = await call('POST', '/message-templates/wa-sem-waba/sync')
    expect(r.status).toBe(409)
    expect(await errorOf(r)).toMatch(/ID da conta do WhatsApp Business \(WABA\)/)
  })
})

describe('D5 envio no inbox fora da janela', () => {
  it('texto com a janela de 24 h vencida: 409 com motivo próprio, não "canal indisponível"', async () => {
    await channel('wa-2', 'whatsapp', 'meta_whatsapp_cloud', { accessToken: 'tok', phoneNumberId: '557', appSecret: 'x', webhookSecret: 's' })
    const old = Date.now() - 2 * 86400_000
    await env.DB.prepare("INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,identity_kind,opted_in,window_expires_at,last_inbound_at) VALUES ('cc-wa2','a','c-a','wa-2','BR.test2','bsuid',1,?,?)").bind(old + 86400_000, old).run()
    const conversation = await ensureConversation(env, 'a', 'c-a', 'wa-2')
    const r = await call('POST', `/inbox/conversations/${conversation}/messages`, { kind: 'reply', text: 'Oi' })
    expect(r.status).toBe(409)
    const error = await errorOf(r)
    expect(error).toMatch(/janela.*modelo aprovado/)
    expect(error).not.toMatch(/não está disponível/)
  })
})

describe('D6 webhook que falha não rebaixa conexão ligada', () => {
  it('Telegram conectado: setWebhook recusado devolve o passo manual e a conexão segue connected', async () => {
    await channel('tg-1', 'telegram', 'telegram_bot', { botToken: '111:AAA', webhookSecret: 's' })
    await env.DB.prepare("UPDATE channels SET webhook_mode='auto' WHERE id='tg-1'").run()
    handler = url => url.includes('/setWebhook') ? Response.json({ ok: false, error_code: 400, description: 'Bad Request: bad webhook: HTTPS url must be provided' }, { status: 400 })
      : Response.json({ ok: true, result: { id: 111, is_bot: true, username: 'bot' } })
    const r = await call('POST', '/connections/tg-1/webhook')
    expect(r.status).toBe(200)
    const row = await env.DB.prepare("SELECT connection_state,webhook_mode FROM channels WHERE id='tg-1'").first()
    expect(row).toEqual({ connection_state: 'connected', webhook_mode: 'auto' })
  })
  it('conexão ainda pendente segue indo para pending com o passo manual', async () => {
    await channel('tg-2', 'telegram', 'telegram_bot', { botToken: '222:BBB', webhookSecret: 's' }, 'error')
    handler = url => url.includes('/setWebhook') ? Response.json({ ok: false, error_code: 400, description: 'bad webhook' }, { status: 400 })
      : Response.json({ ok: true, result: { id: 222, is_bot: true, username: 'bot2' } })
    await call('POST', '/connections/tg-2/webhook')
    expect(await env.DB.prepare("SELECT connection_state FROM channels WHERE id='tg-2'").first('connection_state')).toBe('pending')
  })
})

describe('D7 conexão ligada sem credencial salva', () => {
  beforeEach(() => channel('ig-vazio', 'instagram', 'instagram_unified'))
  it('posts e stories dizem que falta a credencial', async () => {
    for (const path of ['posts', 'stories']) {
      const r = await call('GET', `/connections/ig-vazio/${path}`)
      expect(r.status).toBe(409)
      expect(await errorOf(r)).toMatch(/sem credencial salva/)
    }
  })
  it('refresh diz "sem credencial", não "token venceu", e não chama o provedor', async () => {
    const body = await (await call('POST', '/connections/ig-vazio/refresh')).json() as { ok: boolean; detail: string }
    expect(body.ok).toBe(false)
    expect(body.detail).toMatch(/sem credencial salva/)
    expect(body.detail).not.toMatch(/venceu/)
  })
})

describe('D8 erro sem mensagem', () => {
  it('404 lançado sem texto ganha a frase padrão', async () => {
    const r = await call('POST', '/inbox/mentions/nao-existe/read')
    expect(r.status).toBe(404)
    expect(await errorOf(r)).toBe('Recurso não encontrado.')
  })
  it('PATCH no papel do dono: 409 explicando, em vez de 404 vazio', async () => {
    const r = await call('PATCH', '/team/member-a', { role: 'editor' })
    expect(r.status).toBe(409)
    expect(await errorOf(r)).toMatch(/dono/)
  })
})

describe('transmissão: público pela query e sem tag', () => {
  beforeEach(async () => {
    await channel('tg-b', 'telegram', 'telegram_bot', { botToken: '333:CCC', webhookSecret: 's' })
    await env.DB.prepare("INSERT INTO segments(id,workspace_id,name,filter) VALUES ('seg-1','a','Quentes',?)").bind(JSON.stringify({ match: 'all', rules: [{ type: 'tag', tag_id: 'tag-a', operator: 'has' }] })).run()
  })
  it('#4 GET /broadcasts/audience aceita conditions repetido ou separado por vírgula', async () => {
    for (const q of ['conditions=segment', 'conditions=segment&conditions=tag', 'conditions=segment,tag']) {
      const r = await call('GET', `/broadcasts/audience?tag=all&channel=telegram&channel_id=tg-b&segment_id=seg-1&${q}`)
      expect(r.status, q).toBe(200)
    }
  })
  it('#5 tag é opcional: filtro só por segmento', async () => {
    const r = await call('POST', '/broadcasts/audience', { channel: 'telegram', channel_id: 'tg-b', segment_id: 'seg-1', conditions: ['segment'] })
    expect(r.status).toBe(200)
  })
})
