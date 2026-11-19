import { expect, it } from 'vitest'
import { telegramBot } from '../src/channels/telegram-bot'
import { capabilities } from '../src/channels/capabilities'
import { connectionFromRow, liteRow } from '../src/channels/core/connection'

it.each([
  ['image', 'sendPhoto', 'photo'], ['audio', 'sendAudio', 'audio'],
  ['video', 'sendVideo', 'video'], ['file', 'sendDocument', 'document'],
] as const)('envia %s pelo contrato neutro e respeita a ficha efetiva', async (media, method, key) => {
  const part = { kind: 'media' as const, media, url: 'https://media.test/produto' }
  const profile = capabilities('telegram')
  expect(telegramBot.fit(part, profile)).toEqual({ messages: [part], degraded: [] })
  const calls: { url: string; body: unknown }[] = []
  const result = await telegramBot.send({
    connection: connectionFromRow(liteRow('telegram', 'test', 'a')), credentials: { botToken: 'TESTONLY' },
    target: { kind: 'direct', externalUserId: '42' },
    fetch: (async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      return Response.json({ ok: true, result: { message_id: 77 } })
    }) as typeof fetch,
  }, part)
  expect(result).toEqual({ ok: true, externalId: '77', parts: 1 })
  expect(calls).toEqual([{ url: `https://api.telegram.org/botTESTONLY/${method}`, body: { chat_id: '42', [key]: part.url } }])
  delete profile.media[media]
  expect(telegramBot.fit(part, profile)).toMatchObject({ ok: false, reason: 'unsupported' })
})

it('provedor sem transporte de mídia recusa antes de usar a rede', async () => {
  const { uazapi } = await import('../src/channels/uazapi')
  const part = { kind: 'media' as const, media: 'image' as const, url: 'https://media.test/a.png' }
  expect(uazapi.fit(part, capabilities('whatsapp'))).toMatchObject({ ok: false, reason: 'unsupported' })
})

it.each(['', 'file:///private/example.png', 'javascript:alert(1)', '{{campo:sem-valor|}}'])('recusa URL de mídia não resolvida ou inválida antes de enviar: %s', async url => {
  let calls = 0
  const result = await telegramBot.send({ connection: connectionFromRow(liteRow('telegram', 'test', 'a')), credentials: { botToken: 'TESTONLY' }, target: { kind: 'direct', externalUserId: '42' }, fetch: (async () => { calls++; return Response.json({ ok: true }) }) as typeof fetch }, { kind: 'media', media: 'image', url })
  expect(result).toMatchObject({ ok: false, reason: 'unsupported' })
  expect(calls).toBe(0)
})
