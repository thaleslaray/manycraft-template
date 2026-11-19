import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { app } from '../src/index'
import { fixtureCookie, seedAuth } from './auth-helpers'
import { mergeLeadText, type CardsBlock } from '../src/schemas/message-cards'
import { effectiveProfile } from '../src/channels/core/profile-merge'

// Publicação do cartão e da galeria na conexão oficial do WhatsApp: carrossel (2 a 10 cards) ou mídia com botões (1 card).
let cookie = ''
beforeEach(async () => {
  await seedAuth(); cookie = await fixtureCookie()
  await env.DB.prepare("DELETE FROM conversations WHERE id='inbox-cc-a'").run()
  await env.DB.prepare("DELETE FROM contact_channels WHERE channel_id='ch-a'").run()
  await env.DB.prepare("UPDATE channels SET type='whatsapp',provider='meta_whatsapp_cloud',status='connected',display_name='WhatsApp da loja' WHERE id='ch-a'").run()
})
const request = (path: string, init: RequestInit) => app.request(`/api/${path}`, { ...init, headers: { cookie, 'x-workspace': 'a', 'content-type': 'application/json', origin: 'https://engine.test' } }, env)
const graph = (...blocks: unknown[]) => ({ nodes: [{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} }, { id: 'm', type: 'message', position: { x: 300, y: 0 }, config: { blocks } }], edges: [{ from: 't', port: 'next', to: 'm' }] })
const publish = async (...blocks: unknown[]) => {
  expect((await request('automations/auto-a/draft', { method: 'PUT', body: JSON.stringify({ graph: graph(...blocks) }) })).status).toBe(200)
  const response = await request('automations/auto-a/publish', { method: 'POST' })
  return { status: response.status, text: await response.text() }
}
const link = { type: 'url', title: 'Comprar', url: 'https://loja.example.test/p' }
const card = (n: number, extra: Record<string, unknown> = {}) => ({ title: `Planta ${n}`, subtitle: 'Fácil de cuidar', imageUrl: `https://media.example.test/${n}.png`, buttons: [link], ...extra })
const gallery = (cards: unknown[]) => ({ kind: 'gallery', aspectRatio: 'horizontal', cards })
const text = (t: string) => ({ kind: 'text', text: t })

it('galeria de 2 cards com texto antes publica como carrossel', async () => {
  expect((await publish(text('Veja as novidades:'), gallery([card(1), card(2)]))).status).toBe(201)
})
it('botão do passo entre o texto e a galeria não tira o texto de abertura', async () => {
  expect((await publish(text('Veja as novidades:'), { kind: 'button', id: 'b1', label: 'Falar com a loja', action: { type: 'url', url: 'https://loja.example.test' } }, gallery([card(1), card(2)]))).status).toBe(201)
})
it('galeria sem texto antes é barrada com o motivo e o nome da conexão', async () => {
  const refused = await publish(gallery([card(1), card(2)]))
  expect(refused.status).toBe(409)
  expect(refused.text).toContain('WhatsApp da loja')
  expect(refused.text).toContain('texto de abertura')
})
it.each<[string, unknown[]]>([
  ['card sem imagem', [card(1), card(2, { imageUrl: undefined })]],
  ['texto do card acima de 160', [card(1, { subtitle: 'a'.repeat(200) }), card(2)]],
  ['botões diferentes entre cards', [card(1), card(2, { buttons: [{ type: 'postback', title: 'Quero', id: 'b:0' }] })]],
])('galeria barrada na publicação: %s', async (_name, cards) => {
  const refused = await publish(text('Veja:'), gallery(cards))
  expect(refused.status).toBe(409)
  expect(refused.text).toContain('WhatsApp da loja')
})
it('cartão único publica com imagem e botão, e sem texto antes', async () => {
  expect((await publish({ kind: 'card', aspectRatio: 'horizontal', cards: [card(1)] })).status).toBe(201)
  expect((await publish({ kind: 'card', aspectRatio: 'horizontal', cards: [card(1, { buttons: [{ type: 'postback', title: 'Quero', id: 'x' }] })] })).status).toBe(201)
})
it('cartão único com botão de ligar é barrado com o motivo', async () => {
  const refused = await publish({ kind: 'card', aspectRatio: 'horizontal', cards: [card(1, { buttons: [{ type: 'call', title: 'Ligar', phone: '+5511999999999' }] })] })
  expect(refused.status).toBe(409)
  expect(refused.text).toContain('botão de ligar')
})
it('galeria com variável no título publica e a conexão sem carrossel continua recusando', async () => {
  expect((await publish(text('Olá {{primeiro_nome}}'), gallery([card(1, { title: '{{primeiro_nome}}' }), card(2)]))).status).toBe(201)
  await env.DB.prepare("UPDATE channels SET type='telegram',provider='telegram_bot' WHERE id='ch-a'").run()
  expect((await publish(text('Veja:'), gallery([card(1), card(2)]))).status).toBe(409)
})

it('o texto antes da galeria vira a abertura do carrossel e deixa de ser enviado sozinho', () => {
  const profile = effectiveProfile('whatsapp', 'meta_whatsapp_cloud')
  const cards = [card(1), card(2)] as CardsBlock['cards']
  const blocks = [text('Veja:'), { kind: 'button', id: 'b' }, { kind: 'gallery', aspectRatio: 'horizontal' as const, cards }]
  expect(mergeLeadText(blocks, profile)).toEqual([{ kind: 'button', id: 'b' }, { ...blocks[2], text: 'Veja:' }])
  expect(mergeLeadText([text('Veja:'), { kind: 'typing', seconds: 2 }, blocks[2]], profile)).toHaveLength(3)           // uma pausa separa: sem texto de abertura
  expect(mergeLeadText([text('Veja:'), { kind: 'card', aspectRatio: 'horizontal' as const, cards: [cards[0]] }], profile)).toHaveLength(2)   // card único não é carrossel
  expect(mergeLeadText(blocks, effectiveProfile('instagram', 'instagram_unified'))).toEqual(blocks)                    // outros canais não mudam
})
