import { expect, it } from 'vitest'
import { metaWhatsappCloud } from '../src/channels/meta-whatsapp-cloud'
import { effectiveProfile } from '../src/channels/core/profile-merge'
import type { SendTarget } from '../src/channels/contract'
import type { OutboundMessage } from '../src/channels/types'
import { reason as publishReason } from '../src/channels/core/publish-check'

// Formatos: replica/contratos/meta-whatsapp/exemplos/envio/{interativo-carrossel-botao-url,interativo-carrossel-resposta-rapida,interativo-cta-url,interativo-botoes-resposta,imagem-por-link}.json
// Limites: replica/contratos/meta-whatsapp/limites.md (Carrossel interativo) e P/messages/interactive-media-carousel-messages.md.
const examples = import.meta.glob('../../replica/contratos/meta-whatsapp/exemplos/envio/*.json', { query: '?raw', import: 'default', eager: true })
const example = (file: string) => {
  const { _fonte, ...body } = JSON.parse(String(examples[`../../replica/contratos/meta-whatsapp/exemplos/envio/${file}`]).replaceAll('<WA_USER_PHONE>', '16505551234'))
  delete body.recipient_type   // opcional na Meta; o adaptador nunca o envia
  return body as Record<string, any>
}
const profile = effectiveProfile('whatsapp', 'meta_whatsapp_cloud')
const connection = { id: 'wa-x', workspaceId: 'a', kind: 'whatsapp' as const, provider: 'meta_whatsapp_cloud' as const, externalId: '123', displayName: null,
  status: 'connected' as const, settings: {}, profile }
const target: SendTarget = { kind: 'direct', externalUserId: '16505551234' }
const bodies: Record<string, unknown>[] = []
const fakeFetch = (async (_url: string, init: RequestInit) => {
  bodies.push(JSON.parse(String(init.body)))
  return Response.json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.out.${bodies.length}` }] })
}) as unknown as typeof fetch
const ctx = { connection, credentials: { accessToken: 'TESTONLY', phoneNumberId: '123' }, fetch: fakeFetch, target }
type Cards = Extract<OutboundMessage, { kind: 'cards' }>
const fit = (message: OutboundMessage) => metaWhatsappCloud.fit(message, profile)
const sendOne = async (message: OutboundMessage) => {
  const fitted = fit(message)
  if ('ok' in fitted) throw new Error(fitted.detail)
  bodies.length = 0
  for (const part of fitted.messages) expect(await metaWhatsappCloud.send(ctx, part)).toMatchObject({ ok: true })
  return bodies
}
const lead = 'Of course! Here are three of our latest arrivals, each under $25:'
const plants = [
  { slug: 'blue-echeveria', image: 'blue-echeveria.jpeg', title: '*Blue Echeveria*', subtitle: 'A rosette-shaped succulent with powdery blue leaves, perfect for brightening up any space.' },
  { slug: 'zebra-haworthia', image: 'zebra-haworthia.jpeg', title: '*Zebra Haworthia*', subtitle: 'Striking white stripes on deep green leaves give this compact succulent a bold, modern look.' },
  { slug: 'panda-plant', image: 'panda-plant.jpeg', title: '*Panda Plant*', subtitle: 'Soft, fuzzy leaves with chocolate-brown edges—adorable and easy to care for.' },
]
const card = (p: typeof plants[number], buttons: Cards['cards'][number]['buttons']) => ({ title: p.title, subtitle: p.subtitle, imageUrl: `https://www.luckyshrub.com/assets/${p.image}`, buttons })
const carousel = (buttons: (p: typeof plants[number]) => Cards['cards'][number]['buttons'], patch: Partial<Cards> = {}): Cards =>
  ({ kind: 'cards', text: lead, cards: plants.map(p => card(p, buttons(p))), ...patch })
const urlOf = (p: typeof plants[number]) => [{ type: 'url' as const, title: 'Buy now', url: `https://shop.luckyshrub.com/latest/${p.slug}` }]
const repliesOf = (p: typeof plants[number]) => [{ type: 'postback' as const, id: `learn-${p.slug}`, title: 'Learn more' }, { type: 'postback' as const, id: `fav-${p.slug}`, title: 'Add to favorites' }]
/** O exemplo oficial separa título e descrição com duas quebras; o produto usa uma só e guarda a outra para o cliente. */
const oneBreak = (official: Record<string, any>) => {
  official.interactive.action.cards.forEach((c: any, i: number) => { c.body.text = `${plants[i].title}\n${plants[i].subtitle}` })
  return official
}

it('perfil do WhatsApp oficial declara o carrossel e o instagram segue sem ele', () => {
  expect(profile.cards).toMatchObject({ adaptation: 'interactive_carousel', maxCards: 10 })
  expect(effectiveProfile('instagram', 'instagram_unified').cards).toMatchObject({ adaptation: 'generic_template' })
})

it('galeria com botões de link vira o carrossel oficial', async () => {
  expect(await sendOne(carousel(urlOf))).toEqual([oneBreak(example('interativo-carrossel-botao-url.json'))])
})
it('galeria com botões de resposta vira o carrossel de respostas rápidas oficial', async () => {
  expect(await sendOne(carousel(repliesOf))).toEqual([oneBreak(example('interativo-carrossel-resposta-rapida.json'))])
})
it('carrossel sem subtítulo usa só o título e card sem título de apoio mantém a ordem', async () => {
  const message = carousel(urlOf, { cards: plants.slice(0, 2).map(p => ({ ...card(p, urlOf(p)), subtitle: undefined })) })
  const [body] = await sendOne(message) as any[]
  expect(body.interactive.action.cards.map((c: any) => [c.card_index, c.body.text])).toEqual([[0, '*Blue Echeveria*'], [1, '*Zebra Haworthia*']])
})

it.each<[string, (m: Cards) => Cards]>([
  ['sem o texto principal', m => ({ ...m, text: undefined })],
  ['texto principal acima de 1.024', m => ({ ...m, text: 'a'.repeat(1025) })],
  ['11 cards', m => ({ ...m, cards: Array.from({ length: 11 }, () => m.cards[0]) })],
  ['card sem imagem', m => ({ ...m, cards: [m.cards[0], { ...m.cards[1], imageUrl: undefined }] })],
  ['card sem botão', m => ({ ...m, cards: [m.cards[0], { ...m.cards[1], buttons: [] }] })],
  ['corpo do card acima de 160', m => ({ ...m, cards: [{ ...m.cards[0], subtitle: 'a'.repeat(160) }, m.cards[1]] })],
  ['corpo do card com 3 quebras de linha', m => ({ ...m, cards: [{ ...m.cards[0], title: 'a\nb', subtitle: 'c\nd' }, m.cards[1]] })],
  ['botões de tipos diferentes entre os cards', m => ({ ...m, cards: [m.cards[0], { ...m.cards[1], buttons: repliesOf(plants[1]) }] })],
  ['quantidade de botões diferente entre os cards', m => ({ ...m, cards: [{ ...m.cards[0], buttons: repliesOf(plants[0]) }, { ...m.cards[1], buttons: repliesOf(plants[1]).slice(0, 1) }] })],
  ['mais de um botão de link no card', m => ({ ...m, cards: m.cards.map(c => ({ ...c, buttons: [...urlOf(plants[0]), ...urlOf(plants[1])] })) })],
  ['link misturado com resposta no mesmo card', m => ({ ...m, cards: m.cards.map(c => ({ ...c, buttons: [...urlOf(plants[0]), ...repliesOf(plants[0]).slice(0, 1)] })) })],
  ['botão de ligar', m => ({ ...m, cards: m.cards.map(c => ({ ...c, buttons: [{ type: 'call' as const, title: 'Ligar', phone: '+5511999999999' }] })) })],
  ['rótulo do botão acima de 20', m => ({ ...m, cards: m.cards.map(c => ({ ...c, buttons: [{ type: 'url' as const, title: 'a'.repeat(21), url: 'https://example.test' }] })) })],
  ['mais de 2 botões de resposta por card', m => ({ ...m, cards: m.cards.map((c, i) => ({ ...c, buttons: [...repliesOf(plants[i]), { type: 'postback' as const, id: `x${i}`, title: 'Outro' }] })) })],
  ['toque no card sem equivalente', m => ({ ...m, cards: [{ ...m.cards[0], actionUrl: 'https://example.test' }, m.cards[1]] })],
  ['link do botão sem http(s)', m => ({ ...m, cards: m.cards.map(c => ({ ...c, buttons: [{ type: 'url' as const, title: 'Ver', url: 'ftp://example.test' }] })) })],
])('carrossel recusado na publicação, não no envio: %s', (_name, change) => {
  const refused = fit(change(carousel(urlOf)))
  expect(refused).toMatchObject({ ok: false, reason: 'unsupported' })
  expect(publishReason((refused as { detail: string }).detail)).toMatch(/[a-zçã]/)
})
it('o motivo recusado cita o limite em português', () => {
  expect((fit(carousel(urlOf, { cards: [{ ...carousel(urlOf).cards[0], subtitle: 'a'.repeat(160) }, carousel(urlOf).cards[1]] })) as { detail: string }).detail).toMatch(/160 caracteres/)
  expect((fit(carousel(urlOf, { cards: Array.from({ length: 11 }, () => carousel(urlOf).cards[0]) })) as { detail: string }).detail).toMatch(/2 a 10 cards/)
  expect((fit(carousel(urlOf, { text: undefined })) as { detail: string }).detail).toMatch(/texto/)
})
it('resposta rápida do carrossel aceita até 256 no id e 20 no rótulo', () => {
  const ok = carousel(p => [{ type: 'postback', id: p.slug.padEnd(256, 'a'), title: 'b'.repeat(20) }])
  expect(fit(ok)).toHaveProperty('messages')
  expect(fit(carousel(p => [{ type: 'postback', id: p.slug.padEnd(257, 'a'), title: 'ok' }]))).toMatchObject({ ok: false })
})

// Cartão único: o carrossel exige 2 cards, então o card vira mensagem de mídia com legenda e botões.
const single = (patch: Partial<Cards['cards'][number]> = {}): Cards => ({ kind: 'cards', cards: [{ title: 'Oficina de suculentas', subtitle: 'Sábado às 9h', imageUrl: 'https://www.luckyshrub.com/assets/lucky-shrub-banner-logo-v1.png', ...patch }] })
it('cartão único com imagem e link vira CTA URL com cabeçalho de imagem', async () => {
  const [body] = await sendOne(single({ buttons: [{ type: 'url', title: 'See Dates', url: 'https://www.luckyshrub.com?clickID=kqDGWd24Q5TRwoEQTICY7W1JKoXvaZOXWAS7h1P76s0R7Paec4' }] }))
  const official = example('interativo-cta-url.json')
  expect(body).toEqual({ messaging_product: 'whatsapp', to: '16505551234', type: 'interactive',
    interactive: { type: 'cta_url', header: { type: 'image', image: { link: 'https://www.luckyshrub.com/assets/lucky-shrub-banner-logo-v1.png' } },
      body: { text: 'Oficina de suculentas\nSábado às 9h' }, action: official.interactive.action } })
})
it('cartão único com imagem e botões de resposta vira botões com cabeçalho de imagem', async () => {
  const [body] = await sendOne(single({ buttons: [{ type: 'postback', id: 'change-button', title: 'Change' }, { type: 'postback', id: 'cancel-button', title: 'Cancel' }] }))
  const official = example('interativo-botoes-resposta.json')
  expect(body).toEqual({ messaging_product: 'whatsapp', to: '16505551234', type: 'interactive', interactive: { type: 'button',
    header: { type: 'image', image: { link: 'https://www.luckyshrub.com/assets/lucky-shrub-banner-logo-v1.png' } }, body: { text: 'Oficina de suculentas\nSábado às 9h' },
    action: official.interactive.action } })
})
it('cartão único sem botão vira imagem com legenda e sem imagem vira texto com botões', async () => {
  expect(await sendOne(single())).toEqual([{ messaging_product: 'whatsapp', to: '16505551234', type: 'image',
    image: { link: 'https://www.luckyshrub.com/assets/lucky-shrub-banner-logo-v1.png', caption: 'Oficina de suculentas\nSábado às 9h' } }])
  const [body] = await sendOne(single({ imageUrl: undefined, buttons: [{ type: 'url', title: 'Ver', url: 'https://example.test/x' }] })) as any[]
  expect(body.interactive).toEqual({ type: 'cta_url', body: { text: 'Oficina de suculentas\nSábado às 9h' }, action: { name: 'cta_url', parameters: { display_text: 'Ver', url: 'https://example.test/x' } } })
})
it('galeria de um card só também é cartão único', () => {
  expect(fit({ ...single({ buttons: [{ type: 'url', title: 'Ver', url: 'https://example.test/x' }] }), aspectRatio: 'square' })).toHaveProperty('messages')
})
it.each<[string, Partial<Cards['cards'][number]>]>([
  ['botão de ligar', { buttons: [{ type: 'call', title: 'Ligar', phone: '+5511999999999' }] }],
  ['link junto com resposta', { buttons: [{ type: 'url', title: 'Ver', url: 'https://example.test/x' }, { type: 'postback', id: 'a', title: 'Sim' }] }],
  ['dois links', { buttons: [{ type: 'url', title: 'Ver', url: 'https://example.test/x' }, { type: 'url', title: 'Ver 2', url: 'https://example.test/y' }] }],
  ['4 botões de resposta', { buttons: ['a', 'b', 'c', 'd'].map(id => ({ type: 'postback' as const, id, title: id })) }],
  ['corpo acima de 1.024', { subtitle: 'a'.repeat(1024) }],
  ['toque no card', { actionUrl: 'https://example.test/x' }],
  ['títulos de botão repetidos', { buttons: [{ type: 'postback', id: 'a', title: 'Sim' }, { type: 'postback', id: 'b', title: 'Sim' }] }],
])('cartão único recusado na publicação: %s', (_name, patch) => {
  expect(fit(single(patch))).toMatchObject({ ok: false, reason: 'unsupported' })
})
