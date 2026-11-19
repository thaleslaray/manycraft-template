import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import handler, { app } from '../src/index'
import { authenticatedRequest, fixtureCookie, origin, seedAuth } from './auth-helpers'

// Auditoria de segurança, grupo A (A3 e A4). Só dados fictícios.
let ownerCookie = '', userBCookie = ''
const panel = (path: string, method = 'GET', body?: unknown, cookie = ownerCookie) =>
  authenticatedRequest(path, 'a', { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, cookie)
const addMember = (role: string) => env.DB.prepare("INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES ('m-ab','a','user-b',?)").bind(role).run()
const deliver = (url: string, hottok?: string) => app.request(url.replace(/^https?:\/\/[^/]+/, origin), { method: 'POST',
  headers: { 'content-type': 'application/json', ...(hottok ? { 'X-HOTMART-HOTTOK': hottok } : {}) },
  body: JSON.stringify({ event: 'PURCHASE_APPROVED', data: { buyer: { email: 'b@example.test', name: 'Comprador Ficticio' } } }) }, env)

beforeEach(async () => { await seedAuth(); ownerCookie = await fixtureCookie('a'); userBCookie = await fixtureCookie('b') })

describe('A3 token do webhook Hotmart só para quem gerencia a equipe', () => {
  it('visualizador lê só o estado, sem a URL com token', async () => {
    await addMember('viewer')
    expect((await panel('integrations/hotmart', 'PUT', { hottok: 'segredo-hot' })).status).toBe(200)
    const read = await panel('integrations/hotmart', 'GET', undefined, userBCookie)
    expect(read.status).toBe(200)
    const body = await read.json() as Record<string, unknown>
    expect(body).toEqual({ configured: true, has_secret: true, last_received_at: null })
    expect(JSON.stringify(body)).not.toMatch(/[a-f0-9]{36}/)
    expect((await panel('integrations/hotmart', 'PUT', {}, userBCookie)).status).toBe(403)
  })
  it('administrador continua recebendo a URL', async () => {
    await addMember('administrator')
    await panel('integrations/hotmart', 'PUT', {})
    const body = await (await panel('integrations/hotmart', 'GET', undefined, userBCookie)).json() as { url: string; configured: boolean }
    expect(body.url).toMatch(/\/api\/hooks\/hotmart\/[a-f0-9]{36}$/)
    expect(body.configured).toBe(true)
  })
  it('sem integração, o visualizador vê configured false', async () => {
    await addMember('viewer')
    expect(await (await panel('integrations/hotmart', 'GET', undefined, userBCookie)).json()).toEqual({ configured: false })
  })
})

describe('A4 token do webhook Hotmart pode ser trocado', () => {
  it('rotate gera URL nova e a antiga dá 404', async () => {
    const first = await (await panel('integrations/hotmart', 'PUT', {})).json() as { url: string }
    const second = await (await panel('integrations/hotmart', 'PUT', { rotate: true })).json() as { url: string }
    expect(second.url).toMatch(/\/api\/hooks\/hotmart\/[a-f0-9]{36}$/)
    expect(second.url).not.toBe(first.url)
    expect((await deliver(first.url)).status).toBe(404)
    expect((await deliver(second.url)).status).toBe(200)
  })
  it('PUT sem rotate mantém a URL', async () => {
    const first = await (await panel('integrations/hotmart', 'PUT', {})).json() as { url: string }
    const second = await (await panel('integrations/hotmart', 'PUT', { hottok: 'x' })).json() as { url: string }
    expect(second.url).toBe(first.url)
  })
  it('rotate mantém o segredo; hottok null limpa', async () => {
    const first = await (await panel('integrations/hotmart', 'PUT', { hottok: 'segredo-hot' })).json() as { url: string }
    const rotated = await (await panel('integrations/hotmart', 'PUT', { rotate: true })).json() as { url: string }
    expect((await deliver(rotated.url)).status).toBe(401)
    expect((await deliver(rotated.url, 'segredo-hot')).status).toBe(200)
    expect(first.url).not.toBe(rotated.url)
    const cleared = await (await panel('integrations/hotmart', 'PUT', { hottok: null })).json() as { url: string }
    expect(cleared.url).toBe(rotated.url)
    expect((await deliver(rotated.url)).status).toBe(200)
    expect((await (await panel('integrations/hotmart')).json() as { has_secret: boolean }).has_secret).toBe(false)
  })
  it('rotate é só para quem gerencia a equipe', async () => {
    await addMember('editor')
    expect((await panel('integrations/hotmart', 'PUT', { rotate: true }, userBCookie)).status).toBe(403)
  })
})

// O hottok só confere a origem e o painel nunca o mostra de volta: fica só o SHA-256, como o segredo de webhook dos canais.
const sha256 = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('')
const hookRow = () => env.DB.prepare("SELECT * FROM integration_hooks WHERE workspace_id='a' AND kind='hotmart'").first<Record<string, unknown>>()
const hasSecret = async () => (await (await panel('integrations/hotmart')).json() as { has_secret: boolean }).has_secret
/** Linha gravada antes da migração do hash: o hottok ficava em claro na coluna secret. */
const legacyHook = async () => {
  const { url } = await (await panel('integrations/hotmart', 'PUT', {})).json() as { url: string }
  await env.DB.prepare("UPDATE integration_hooks SET secret='segredo-antigo' WHERE workspace_id='a'").run()
  return url
}

describe('hottok guardado só como hash', () => {
  it('o banco guarda só o SHA-256 e o webhook confere o hottok com ele', async () => {
    const { url } = await (await panel('integrations/hotmart', 'PUT', { hottok: 'segredo-hot' })).json() as { url: string }
    const row = await hookRow()
    expect(JSON.stringify(row)).not.toContain('segredo-hot')
    expect(row).toMatchObject({ secret: null, secret_hash: await sha256('segredo-hot') })
    expect(await hasSecret()).toBe(true)
    expect((await deliver(url)).status).toBe(401)
    expect((await deliver(url, 'segredo-errado')).status).toBe(401)
    expect((await deliver(url, 'segredo-hot')).status).toBe(200)
  })
  it('hottok em claro de antes continua valendo e vira hash no primeiro webhook', async () => {
    const url = await legacyHook()
    expect(await hasSecret()).toBe(true)
    expect((await deliver(url, 'segredo-errado')).status).toBe(401)
    expect((await deliver(url, 'segredo-antigo')).status).toBe(200)
    expect(await hookRow()).toMatchObject({ secret: null, secret_hash: await sha256('segredo-antigo') })
    expect((await deliver(url, 'segredo-antigo')).status).toBe(200)
    expect((await deliver(url)).status).toBe(401)
  })
  it('gravar um hottok novo apaga o valor em claro de antes', async () => {
    const url = await legacyHook()
    await panel('integrations/hotmart', 'PUT', { hottok: 'segredo-novo' })
    expect(await hookRow()).toMatchObject({ secret: null, secret_hash: await sha256('segredo-novo') })
    expect((await deliver(url, 'segredo-antigo')).status).toBe(401)
    expect((await deliver(url, 'segredo-novo')).status).toBe(200)
  })
  it('hottok null limpa o hash e também o valor em claro de antes', async () => {
    const url = await legacyHook()
    await panel('integrations/hotmart', 'PUT', { hottok: null })
    expect(await hookRow()).toMatchObject({ secret: null, secret_hash: null })
    expect(await hasSecret()).toBe(false)
    expect((await deliver(url)).status).toBe(200)
  })
  it('o cron diário troca pelo hash os hottoks em claro que nenhum webhook converteu', async () => {
    const url = await legacyHook()
    await handler.scheduled({ scheduledTime: Date.now(), cron: '0 3 * * *', noRetry() {} }, env)
    expect(await hookRow()).toMatchObject({ secret: null, secret_hash: await sha256('segredo-antigo') })
    expect((await deliver(url, 'segredo-antigo')).status).toBe(200)
  })
})

describe('conversão dos hottoks em claro só mexe em linhas da Hotmart', () => {
  it('o cron e a conversão filtram kind=hotmart', async () => {
    const { hashLegacyHottoks } = await import('../src/hotmart')
    const sql: string[] = []
    const db = {
      prepare: (q: string) => { sql.push(q); const s = { bind: () => s, all: async () => ({ results: [{ token: 't', secret: 'claro' }] }) }; return s },
      batch: async () => [],
    } as unknown as D1Database
    await hashLegacyHottoks(db)
    expect(sql).toHaveLength(2)
    for (const q of sql) expect(q).toMatch(/kind='hotmart'/)
  })
})
