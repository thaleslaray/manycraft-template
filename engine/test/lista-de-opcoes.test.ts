import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { app } from '../src/index'
import { fixtureCookie, seedAuth } from './auth-helpers'
import { capabilities } from '../src/channels/capabilities'
import { listError, listLimits } from '../src/schemas/message-list'

// Lista de opções: regras de publicação pela ficha da conexão.
const text = (t: string) => ({ kind: 'text', text: t })
const row = (id: string, title: string, description?: string) => ({ id, title, ...(description ? { description } : {}) })
const list = (extra: Record<string, unknown> = {}) => ({ kind: 'list', buttonText: 'Ver assuntos', sections: [
  { title: 'Vendas', rows: [row('v1', 'Preços'), row('v2', 'Planos', 'Mensal e anual')] }, { title: 'Ajuda', rows: [row('h1', 'Suporte')] }], ...extra })

it('limites da lista vêm da ficha: só o WhatsApp oficial declara e a interseção usa o menor valor', () => {
  expect(listLimits([capabilities('whatsapp')])).toEqual({ maxRows: 10, maxSections: 10, rowTitleMax: 24, rowDescMax: 72 })
  expect(listLimits([capabilities('whatsapp'), capabilities('telegram')])).toBeNull()
  expect(listLimits([{ list: { maxRows: 10, maxSections: 10, rowTitleMax: 24, rowDescMax: 72 } }, { list: { maxRows: 5, maxSections: 3, rowTitleMax: 20, rowDescMax: 60 } }]))
    .toEqual({ maxRows: 5, maxSections: 3, rowTitleMax: 20, rowDescMax: 60 })
})

it.each<[string, unknown[], string]>([
  ['sem texto', [list()], 'texto da mensagem'],
  ['duas listas', [text('Oi'), list(), list()], 'só uma lista'],
  ['com botão', [text('Oi'), list(), { kind: 'button', id: 'b', label: 'x', action: { type: 'go_to_node' } }], 'não coexiste'],
  ['com resposta rápida', [text('Oi'), list(), { kind: 'quick_reply', id: 'q', label: 'x' }], 'não coexiste'],
  ['botão da lista vazio', [text('Oi'), list({ buttonText: ' ' })], 'botão que abre a lista'],
  ['botão da lista com 21 caracteres', [text('Oi'), list({ buttonText: 'a'.repeat(21) })], 'até 20'],
  ['11 opções', [text('Oi'), list({ sections: [{ title: 'A', rows: Array.from({ length: 11 }, (_, i) => row(`r${i}`, `Opção ${i}`)) }] })], 'até 10 opções'],
  ['título da opção com 25 caracteres', [text('Oi'), list({ sections: [{ rows: [row('a', 'a'.repeat(25))] }] })], 'até 24'],
  ['descrição com 73 caracteres', [text('Oi'), list({ sections: [{ rows: [row('a', 'Ok', 'a'.repeat(73))] }] })], 'até 72'],
  ['seção sem título entre várias', [text('Oi'), list({ sections: [{ rows: [row('a', 'A')] }, { title: 'B', rows: [row('b', 'B')] }] })], 'título a cada seção'],
  ['opções com o mesmo identificador', [text('Oi'), list({ sections: [{ rows: [row('a', 'A'), row('a', 'B')] }] })], 'identificador próprio'],
  ['seção vazia', [text('Oi'), list({ sections: [{ title: 'A', rows: [] }] })], 'ao menos uma opção'],
])('regra de publicação: %s', (_name, blocks, message) => {
  expect(listError(blocks as never, [capabilities('whatsapp')])).toContain(message)
})
it('lista no limite (10 opções de 24 e 72 caracteres, botão de 20) passa', () => {
  const rows = Array.from({ length: 10 }, (_, i) => row(`r${i}`, 'a'.repeat(24), 'b'.repeat(72)))
  expect(listError([text('Oi'), list({ buttonText: 'a'.repeat(20), sections: [{ title: 'A'.repeat(24), rows }] })] as never, [capabilities('whatsapp')])).toBeUndefined()
})
it('conexão sem lista na ficha recusa o bloco', () => {
  expect(listError([text('Oi'), list()] as never, [capabilities('telegram')])).toContain('não oferece lista')
})

// ───────── Publicar pela ficha da conexão ─────────
let cookie = ''
const request = (path: string, init: RequestInit) => app.request(`/api/${path}`, { ...init, headers: { cookie, 'x-workspace': 'a', 'content-type': 'application/json', origin: 'https://engine.test' } }, env)
const graph = (...blocks: unknown[]) => ({ nodes: [{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} }, { id: 'm', type: 'message', position: { x: 300, y: 0 }, config: { blocks } }], edges: [{ from: 't', port: 'next', to: 'm' }] })
async function publish(...blocks: unknown[]) {
  expect((await request('automations/auto-a/draft', { method: 'PUT', body: JSON.stringify({ graph: graph(...blocks) }) })).status).toBe(200)
  const response = await request('automations/auto-a/publish', { method: 'POST' })
  return { status: response.status, text: await response.text() }
}
async function connect(type: string, provider: string) {
  await seedAuth(); cookie = await fixtureCookie()
  await env.DB.prepare("DELETE FROM conversations WHERE id='inbox-cc-a'").run()
  await env.DB.prepare("DELETE FROM contact_channels WHERE channel_id='ch-a'").run()
  await env.DB.prepare("UPDATE channels SET type=?,provider=?,status='connected',display_name='Conexão da loja' WHERE id='ch-a'").bind(type, provider).run()
}

it('publicar recusa lista acima do limite, mostrando o motivo, e aceita a que cabe na ficha do WhatsApp', async () => {
  await connect('whatsapp', 'meta_whatsapp_cloud')
  expect((await publish(text('Escolha'), list())).status).toBe(201)
  const tooMany = await publish(text('Escolha'), list({ sections: [{ title: 'A', rows: Array.from({ length: 11 }, (_, i) => row(`r${i}`, `Opção ${i}`)) }] }))
  expect(tooMany.status).toBe(409)
  expect(tooMany.text).toContain('até 10 opções')
  const longTitle = await publish(text('Escolha'), list({ sections: [{ rows: [row('a', 'a'.repeat(25))] }] }))
  expect(longTitle.status).toBe(409)
  expect(longTitle.text).toContain('até 24 caracteres')
})
it('publicar recusa lista numa conexão que não a oferece', async () => {
  await connect('telegram', 'telegram_bot')
  const refused = await publish(text('Escolha'), list())
  expect(refused.status).toBe(409)
  expect(refused.text).toContain('não oferece lista')
})
