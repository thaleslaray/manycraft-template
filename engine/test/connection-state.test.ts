import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/env'
import { connectionFromRow, liteRow } from '../src/channels/core/connection'
import { connectionTransitions, effectiveConnectionState, moveConnection } from '../src/channels/core/connection-state'
import { emailConnection } from '../src/email-channel/store'
import { syncZapi } from '../src/channels/zapi-sync'
import { origin, seedAuth } from './auth-helpers'

// Máquina de estados da conexão (channels/core/connection-state.ts): `status` (chave da equipe) e `connection_state` (saúde) nunca se contradizem.
const BOT = '111:AAA-state-bot-token'
const bindings = () => ({ ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: 'a', DEV_PROVIDER_API_BASE: undefined, PUBLIC_BASE_URL: undefined } as Env)
function call(method: string, path: string, body?: unknown) {
  return app.request(`${origin}/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'x-workspace': 'a', origin, 'content-type': 'application/json' } }, bindings())
}
let botValid = true
beforeEach(async () => {
  await seedAuth()
  botValid = true
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const match = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)/.exec(String(input instanceof Request ? input.url : input))
    if (!match) throw new Error(`Unexpected request: ${String(input)}`)
    if (!botValid) return Response.json({ ok: false, error_code: 401, description: 'Unauthorized' }, { status: 401 })
    if (match[2] === 'getMe') return Response.json({ ok: true, result: { id: 111, is_bot: true, username: 'state_bot' } })
    return Response.json({ ok: true, result: true })
  })
})
afterEach(() => { vi.restoreAllMocks() })

const row = (id: string) => env.DB.prepare('SELECT status,connection_state,status_detail,state_changed_at FROM channels WHERE id=?').bind(id)
  .first<{ status: string; connection_state: string; status_detail: string | null; state_changed_at: number | null }>()
async function connectBot(): Promise<string> {
  const response = await call('POST', '/connections', { kind: 'telegram', credentials: { botToken: BOT } })
  expect(response.status).toBe(201)
  return ((await response.json()) as { connection: { id: string } }).connection.id
}

describe('conexão desativada pela equipe', () => {
  it('"Atualizar conexão" numa conexão desativada não a religa: a saúde continua desligada (antes virava "conectada")', async () => {
    const id = await connectBot()
    expect(await row(id)).toMatchObject({ status: 'connected', connection_state: 'connected' })
    expect((await call('POST', `/connections/${id}/enabled`, { enabled: false })).status).toBe(200)
    const refreshed = await call('POST', `/connections/${id}/refresh`)
    expect(refreshed.status).toBe(200)
    expect(await refreshed.json()).toMatchObject({ ok: true, connection: { status: 'disconnected', active: false } })
    expect(await row(id)).toMatchObject({ status: 'disconnected', connection_state: 'disconnected' })
  })
  it('"Atualizar conexão" sem nada achado numa conexão desativada mantém o motivo "Desativada pela equipe" (antes ficava vazio)', async () => {
    const id = await connectBot()
    await call('POST', `/connections/${id}/enabled`, { enabled: false })
    expect((await call('POST', `/connections/${id}/refresh`)).status).toBe(200)
    expect(await row(id)).toMatchObject({ status: 'disconnected', status_detail: 'Desativada pela equipe. Reative quando quiser.' })
  })
  it('trocar a credencial de uma conexão desativada registra o webhook mas não a religa', async () => {
    const id = await connectBot()
    await call('POST', `/connections/${id}/enabled`, { enabled: false })
    expect((await call('POST', `/connections/${id}/rotate`, { credentials: { botToken: BOT } })).status).toBe(200)
    expect(await row(id)).toMatchObject({ status: 'disconnected', connection_state: 'disconnected', status_detail: 'Desativada pela equipe. Reative quando quiser.' })
  })
  it('reativar confere no provedor: recusado continua desligada com o motivo; aceito volta conectada', async () => {
    const id = await connectBot()
    await call('POST', `/connections/${id}/enabled`, { enabled: false })
    botValid = false
    expect(await (await call('POST', `/connections/${id}/enabled`, { enabled: true })).json()).toMatchObject({ ok: false, connection: { status: 'disconnected', active: false } })
    expect(await row(id)).toMatchObject({ status: 'disconnected', connection_state: 'disconnected', status_detail: expect.stringContaining('Gere um token novo') })
    botValid = true
    expect(await (await call('POST', `/connections/${id}/enabled`, { enabled: true })).json()).toMatchObject({ ok: true, connection: { status: 'connected', active: true } })
    expect(await row(id)).toMatchObject({ status: 'connected', connection_state: 'connected', status_detail: null })
  })
  it('o banco recusa saúde diferente de desligada numa conexão desligada (invariante da 0125)', async () => {
    const id = await connectBot()
    await call('POST', `/connections/${id}/enabled`, { enabled: false })
    await expect(env.DB.prepare("UPDATE channels SET connection_state='connected' WHERE id=?").bind(id).run()).rejects.toThrow(/connection_disabled_state/)
    const notices = () => env.DB.prepare("SELECT count(*) AS n FROM workspace_notices WHERE workspace_id='a' AND kind='connection'").first<number>('n')
    const before = await notices()
    await env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id,status) VALUES ('tg-off','a','telegram','off-bot','disconnected')").run()
    expect(await row('tg-off')).toMatchObject({ status: 'disconnected', connection_state: 'disconnected' })
    // Nasceu desligada: a correção da saúde não é queda e não avisa "A conexão parou".
    expect(await notices()).toBe(before)
  })
  it('o e-mail da plataforma desativado não volta sozinho quando alguém grava algo de e-mail (antes voltava "conectado")', async () => {
    const id = await emailConnection(env, 'a')
    await call('POST', `/connections/${id}/enabled`, { enabled: false })
    expect(await emailConnection(env, 'a')).toBe(id)
    expect(await row(id)).toMatchObject({ status: 'disconnected', connection_state: 'disconnected' })
    // Sem conferência no provedor, reativar religa direto (antes respondia 400 e só a gravação de e-mail a religava).
    expect(await (await call('POST', `/connections/${id}/enabled`, { enabled: true })).json()).toMatchObject({ ok: true, connection: { status: 'connected' } })
  })
  it('o e-mail da plataforma desarquivado pela 0126 (desativado, sem credenciais) volta a ter credenciais e reativa pelo botão', async () => {
    const id = await emailConnection(env, 'a')
    await call('POST', `/connections/${id}/enabled`, { enabled: false })
    await env.DB.prepare('UPDATE channels SET credentials_ciphertext=NULL,credentials_iv=NULL,credentials_key_version=NULL WHERE id=?').bind(id).run()
    expect(await emailConnection(env, 'a')).toBe(id)
    expect(await env.DB.prepare('SELECT credentials_ciphertext IS NOT NULL AS sealed FROM channels WHERE id=?').bind(id).first('sealed')).toBe(1)
    expect(await (await call('POST', `/connections/${id}/enabled`, { enabled: true })).json()).toMatchObject({ ok: true, connection: { status: 'connected' } })
  })
  it('o e-mail da plataforma não pode ser arquivado (arquivado, nada o recriava: o id é fixo)', async () => {
    const id = await emailConnection(env, 'a')
    const response = await call('DELETE', `/connections/${id}`)
    expect(response.status).toBe(409)
    expect(await response.text()).toContain('O e-mail da plataforma não pode ser arquivado')
    expect(await env.DB.prepare('SELECT archived_at,status FROM channels WHERE id=?').bind(id).first()).toMatchObject({ archived_at: null, status: 'connected' })
  })
})

describe('eventos do provedor', () => {
  const zapiEvent = (payload: Record<string, unknown>, receivedAt: number) => syncZapi({
    env, event: { version: 1, provider: 'meta', workspaceId: 'a', channelId: 'zp', eventId: crypto.randomUUID(), receivedAt, payload },
    connection: connectionFromRow({ ...liteRow('whatsapp', 'zp', 'a'), provider: 'zapi' }), credentials: {}, fetch,
  } as Parameters<typeof syncZapi>[0])
  beforeEach(async () => {
    await env.DB.prepare("INSERT INTO channels (id,workspace_id,type,provider,external_id) VALUES ('zp','a','whatsapp','zapi','5511999990000')").run()
  })
  it('evento "conectado" da Z-API não religa uma conexão desativada pela equipe', async () => {
    await moveConnection(env.DB, { id: 'zp', event: 'disable', to: 'disconnected' })
    await zapiEvent({ type: 'ConnectedCallback', connected: true, momment: Date.now() }, Date.now())
    expect(await row('zp')).toMatchObject({ status: 'disconnected', connection_state: 'disconnected' })
  })
  it('evento mais velho que a última mudança não vale; o mais novo vale', async () => {
    const now = Date.now()
    await moveConnection(env.DB, { id: 'zp', event: 'refresh', to: 'connected', at: now })
    await zapiEvent({ type: 'DisconnectedCallback', disconnected: true, momment: now - 5000 }, now - 5000)
    expect(await row('zp')).toMatchObject({ connection_state: 'connected' })
    await zapiEvent({ type: 'DisconnectedCallback', disconnected: true, momment: now + 1000 }, now + 1000)
    expect(await row('zp')).toMatchObject({ connection_state: 'disconnected', state_changed_at: now + 1000 })
  })
  it('a recusa de envio só derruba conexão conectada ou pendente', async () => {
    await moveConnection(env.DB, { id: 'zp', event: 'provider_event', to: 'connecting' })
    expect(await moveConnection(env.DB, { id: 'zp', event: 'send_refused', to: 'error' })).toBe(false)
    expect(await row('zp')).toMatchObject({ connection_state: 'connecting' })
  })
  it('transição fora da tabela é erro de programação', async () => {
    await expect(moveConnection(env.DB, { id: 'zp', event: 'first_delivery', to: 'error' })).rejects.toThrow(/Transição inválida/)
  })
})

describe('leitores usam o estado efetivo', () => {
  beforeEach(async () => {
    await env.DB.prepare("INSERT INTO channels (id,workspace_id,type,external_id,display_name) VALUES ('tg-err','a','telegram','err-bot','Bot com erro')").run()
    await moveConnection(env.DB, { id: 'tg-err', event: 'send_refused', to: 'error', detail: 'Token recusado.' })
  })
  it('Conformidade aponta a conexão com erro mesmo ligada (antes só olhava `status`)', async () => {
    const body = await (await call('GET', '/compliance')).json() as { issues: { kind: string; title: string }[] }
    expect(body.issues.filter(i => i.kind === 'connection').map(i => i.title)).toContain('Conexão Bot com erro com erro')
  })
  it('estado efetivo: desligada vence a saúde', () => {
    expect(effectiveConnectionState({ status: 'disconnected', connection_state: 'connected' })).toBe('disconnected')
    expect(effectiveConnectionState({ status: 'connected', connection_state: 'restricted' })).toBe('restricted')
  })
})

describe('código-fonte', () => {
  const sources = Object.entries(import.meta.glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
  it('só a máquina de estados escreve `connection_state` ou `status` de channels', () => {
    expect(sources.length).toBeGreaterThan(100)
    const offenders: string[] = []
    for (const [path, text] of sources) {
      if (path.endsWith('/channels/core/connection-state.ts')) continue
      for (const statement of text.match(/UPDATE channels SET[^`"]*/g) ?? []) {
        if (/\bconnection_state\s*=|[\s,]status\s*=/.test(statement)) offenders.push(`${path}: ${statement.slice(0, 80)}`)
      }
    }
    expect(offenders).toEqual([])
  })
  it('só a máquina de estados lê `connection_state` cru (os demais usam o estado efetivo)', () => {
    const allowed = ['/channels/core/connection-state.ts', '/channels/core/connection.ts', '/channels/core/connections.ts', '/channels/core/delivery.ts']
    const offenders = sources.filter(([path, text]) => !allowed.some(end => path.endsWith(end)) && /connection_state/.test(text)).map(([path]) => path)
    expect(offenders).toEqual([])
  })
  it('toda transição tem destino', () => {
    for (const rule of Object.values(connectionTransitions)) expect(rule.to.length).toBeGreaterThan(0)
  })
})
