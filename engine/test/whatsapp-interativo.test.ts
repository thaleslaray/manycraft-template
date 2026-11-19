import { expect, it } from 'vitest'
import { metaWhatsappCloud } from '../src/channels/meta-whatsapp-cloud'
import { effectiveProfile } from '../src/channels/core/profile-merge'
import type { SendTarget } from '../src/channels/contract'
import type { OutboundMessage } from '../src/channels/types'
import { reason as publishReason } from '../src/channels/core/publish-check'

// Formatos: replica/contratos/meta-whatsapp/exemplos/envio/{interativo-cta-url,interativo-lista,digitando-e-lida}.json
const profile = effectiveProfile('whatsapp', 'meta_whatsapp_cloud')
const connection = { id: 'wa-x', workspaceId: 'a', kind: 'whatsapp' as const, provider: 'meta_whatsapp_cloud' as const, externalId: '123', displayName: null,
  status: 'connected' as const, settings: {}, profile }
const target: SendTarget = { kind: 'direct', externalUserId: 'BR.abc123' }
const bodies: Record<string, unknown>[] = []
const fakeFetch = (async (_url: string, init: RequestInit) => {
  bodies.push(JSON.parse(String(init.body)))
  if (bodies.at(-1)!.status === 'read') return Response.json({ success: true })   // a Meta devolve só success para "lida"
  return Response.json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.out.${bodies.length}` }] })
}) as unknown as typeof fetch
const ctx = { connection, credentials: { accessToken: 'TESTONLY', phoneNumberId: '123' }, fetch: fakeFetch, target }
const fit = (message: OutboundMessage) => metaWhatsappCloud.fit(message, profile)
const link = { type: 'url' as const, title: 'Ver datas', url: 'https://www.luckyshrub.com/datas' }
const reply = { type: 'postback' as const, id: 'sim', title: 'Sim' }
const row = (n: number, extra: Record<string, unknown> = {}) => ({ id: `r${n}`, title: `Linha ${n}`, ...extra })
const list = (patch: Partial<Extract<OutboundMessage, { kind: 'list' }>> = {}): OutboundMessage =>
  ({ kind: 'list', text: 'Qual envio você prefere?', buttonText: 'Opções de envio', sections: [{ title: 'Rápido', rows: [row(1), row(2)] }], ...patch })

it('botão de link vira um CTA URL com um único botão, no formato oficial', async () => {
  const [part] = (fit({ kind: 'text', text: 'Toque no botão para ver as datas.', buttons: [link] }) as { messages: OutboundMessage[] }).messages
  bodies.length = 0
  expect(await metaWhatsappCloud.send(ctx, part)).toMatchObject({ ok: true, parts: 1 })
  expect(bodies[0]).toEqual({ messaging_product: 'whatsapp', recipient: 'BR.abc123', type: 'interactive', interactive: { type: 'cta_url',
    body: { text: 'Toque no botão para ver as datas.' }, action: { name: 'cta_url', parameters: { display_text: 'Ver datas', url: 'https://www.luckyshrub.com/datas' } } } })
})
it('botão de link não se mistura com botões de resposta nem com outro link', () => {
  expect(fit({ kind: 'text', text: 'Oi', buttons: [reply, link] })).toMatchObject({ ok: false, reason: 'unsupported' })
  expect(fit({ kind: 'text', text: 'Oi', quickReplies: [{ id: 'q', title: 'Rápida' }], buttons: [link] })).toMatchObject({ ok: false, reason: 'unsupported' })
  expect(fit({ kind: 'text', text: 'Oi', buttons: [link, { ...link, title: 'Outro' }] })).toMatchObject({ ok: false, reason: 'unsupported' })
  expect(fit({ kind: 'text', text: 'Oi', buttons: [link] })).toHaveProperty('messages')
})
it('CTA URL respeita corpo de 1.024 e rótulo de 20', async () => {
  const result = fit({ kind: 'text', text: 'á'.repeat(1025), buttons: [{ ...link, title: 'x'.repeat(30) }] }) as { messages: OutboundMessage[] }
  const sent = result.messages.filter(m => m.kind === 'text')
  expect(sent.every(m => [...m.text].length <= 1024)).toBe(true)
  const last = sent.at(-1) as Extract<OutboundMessage, { kind: 'text' }>
  expect([...last.buttons![0].title].length).toBeLessThanOrEqual(20)
})

it('lista é enviada no formato oficial, com cabeçalho e rodapé', async () => {
  const message = list({ header: 'Escolha o envio', footer: 'Lucky Shrub', sections: [
    { title: 'Quero logo', rows: [row(1, { description: 'Em 1 a 2 dias' }), row(2)] }, { title: 'Posso esperar', rows: [row(3)] }] })
  const fitted = fit(message) as { messages: OutboundMessage[] }
  bodies.length = 0
  expect(await metaWhatsappCloud.send(ctx, fitted.messages[0])).toMatchObject({ ok: true })
  expect(bodies[0]).toEqual({ messaging_product: 'whatsapp', recipient: 'BR.abc123', type: 'interactive', interactive: { type: 'list',
    header: { type: 'text', text: 'Escolha o envio' }, body: { text: 'Qual envio você prefere?' }, footer: { text: 'Lucky Shrub' },
    action: { button: 'Opções de envio', sections: [
      { title: 'Quero logo', rows: [{ id: 'r1', title: 'Linha 1', description: 'Em 1 a 2 dias' }, { id: 'r2', title: 'Linha 2' }] },
      { title: 'Posso esperar', rows: [{ id: 'r3', title: 'Linha 3' }] }] } } })
})
it.each<[string, Partial<Extract<OutboundMessage, { kind: 'list' }>>]>([
  ['corpo acima de 1.024', { text: 'a'.repeat(1025) }],
  ['botão acima de 20', { buttonText: 'a'.repeat(21) }],
  ['cabeçalho acima de 60', { header: 'a'.repeat(61) }],
  ['rodapé acima de 60', { footer: 'a'.repeat(61) }],
  ['título de linha acima de 24', { sections: [{ title: 'S', rows: [row(1, { title: 'a'.repeat(25) })] }] }],
  ['descrição de linha acima de 72', { sections: [{ title: 'S', rows: [row(1, { description: 'a'.repeat(73) })] }] }],
  ['id de linha acima de 200', { sections: [{ title: 'S', rows: [row(1, { id: 'a'.repeat(201) })] }] }],
  ['título de seção acima de 24', { sections: [{ title: 'a'.repeat(25), rows: [row(1)] }] }],
  ['11 linhas', { sections: [{ title: 'S', rows: Array.from({ length: 11 }, (_, i) => row(i)) }] }],
  ['11 seções', { sections: Array.from({ length: 11 }, (_, i) => ({ title: `S${i}`, rows: [row(i)] })) }],
  ['sem linhas', { sections: [] }],
  ['ids repetidos', { sections: [{ title: 'S', rows: [row(1), row(1)] }] }],
  ['duas seções sem título', { sections: [{ rows: [row(1)] }, { title: 'B', rows: [row(2)] }] }],
])('lista com %s é barrada antes do envio', (_, patch) => {
  expect(fit(list(patch))).toMatchObject({ ok: false, reason: 'unsupported' })
})
it('lista no limite (10 linhas, 24, 72, 200) passa', () => {
  const rows = Array.from({ length: 10 }, (_, i) => row(i, { id: 'i'.repeat(200), title: 'a'.repeat(24), description: 'd'.repeat(72) }))
  rows.forEach((r, i) => { r.id = `${i}`.padEnd(200, 'i') })
  expect(fit(list({ text: 'a'.repeat(1024), buttonText: 'a'.repeat(20), header: 'a'.repeat(60), footer: 'a'.repeat(60), sections: [{ title: 'a'.repeat(24), rows }] }))).toHaveProperty('messages')
})

it('digitando é status read mais typing_indicator sobre a mensagem recebida', async () => {
  bodies.length = 0
  expect(await metaWhatsappCloud.typing!(ctx, 5, 'wamid.IN')).toMatchObject({ ok: true })
  expect(bodies[0]).toEqual({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.IN', typing_indicator: { type: 'text' } })
})
it('digitando sem mensagem recebida para apontar não vai à rede', async () => {
  bodies.length = 0
  expect(await metaWhatsappCloud.typing!(ctx, 5)).toMatchObject({ ok: false, reason: 'unsupported' })
  expect(bodies).toHaveLength(0)
})
it('o perfil declara só o que o adaptador entrega', () => {
  expect(profile.typing).toEqual({ maxSeconds: 25 })
  expect(profile.list).toEqual({ maxRows: 10, maxSections: 10, rowTitleMax: 24, rowDescMax: 72 })
  expect(profile.buttons).toMatchObject({ types: ['postback', 'url'], maxPerMessage: 3, titleMax: 20 })
  expect(profile.quickReplies).toBeNull()
})

// Revisão wa-03/04: o link do botão só vale com http ou https; excesso de erros no recibo não derruba o recibo.
it.each(['javascript:alert(1)', 'ftp://example.test/arquivo', 'www.luckyshrub.com/datas', 'tel:+5511999990000', 'https://', ''])('botão de link com endereço %j é recusado na publicação', url => {
  expect(fit({ kind: 'text', text: 'Oi', buttons: [{ ...link, url }] })).toMatchObject({ ok: false, reason: 'unsupported', detail: expect.stringMatching(/link button.*http/i) })
})
it('botão de link aceita http e https', () => {
  expect(fit({ kind: 'text', text: 'Oi', buttons: [{ ...link, url: 'http://example.test/a' }] })).toHaveProperty('messages')
  expect(fit({ kind: 'text', text: 'Oi', buttons: [link] })).toHaveProperty('messages')
})
it('recibo failed com mais de 10 erros é lido com os 10 primeiros, não recusado', () => {
  const errors = Array.from({ length: 12 }, (_, i) => ({ code: 131000 + i, title: `erro ${i}` }))
  const events = metaWhatsappCloud.parseInbound({ id: 'wamid.x', kind: 'status', field: 'messages', status: 'failed', timestamp: '1760000000', errors }, connection)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ kind: 'receipt', status: 'failed' })
  const receipt = events[0] as { errors: { code: string }[] }
  expect(receipt.errors.map(e => e.code)).toEqual(errors.slice(0, 10).map(e => String(e.code)))
})

// Cada motivo de lista recusada chega ao operador com o seu próprio texto em português (a publicação não mostra inglês do adaptador).
it.each<[string, Partial<Extract<OutboundMessage, { kind: 'list' }>>, RegExp]>([
  ['corpo', { text: ' ' }, /texto da lista.*1\.024/],
  ['botão', { buttonText: 'a'.repeat(21) }, /botão da lista.*20/],
  ['cabeçalho', { header: 'a'.repeat(61) }, /cabeçalho e o rodapé.*60/],
  ['seções', { sections: [] }, /1 a 10 seções/],
  ['linhas', { sections: [{ title: 'S', rows: Array.from({ length: 11 }, (_, i) => row(i)) }] }, /1 a 10 linhas/],
  ['título de seção ausente', { sections: [{ rows: [row(1)] }, { title: 'B', rows: [row(2)] }] }, /várias seções, cada uma precisa de título/],
  ['seção sem linhas', { sections: [{ title: 'S', rows: [] }, { title: 'B', rows: [row(2)] }] }, /cada seção.*linhas.*24/],
  ['limites da linha', { sections: [{ title: 'S', rows: [row(1, { title: 'a'.repeat(25) })] }] }, /linhas da lista.*200.*24.*72/],
  ['ids repetidos', { sections: [{ title: 'S', rows: [row(1), row(1)] }] }, /identificadores das linhas.*diferentes/],
])('motivo de lista recusada (%s) é traduzido com texto específico', (_name, patch, expected) => {
  const result = fit(list(patch)) as { ok: false; detail: string }
  expect(result.ok).toBe(false)
  expect(publishReason(result.detail)).toMatch(expected)
})
it('o motivo do botão de link inválido é traduzido', () => {
  const result = fit({ kind: 'text', text: 'Oi', buttons: [{ ...link, url: 'ftp://x.test' }] }) as { detail: string }
  expect(publishReason(result.detail)).toMatch(/endereço do botão de link.*https/)
})
