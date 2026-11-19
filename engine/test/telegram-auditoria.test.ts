import { expect, it } from 'vitest'
import { telegramBot } from '../src/channels/telegram-bot'
import { capabilities } from '../src/channels/capabilities'
import { connectionFromRow, liteRow } from '../src/channels/core/connection'
import { legacyEvents } from '../src/channels/core/legacy-events'

const connection = connectionFromRow(liteRow('telegram', 'test', 'a'))
const sendWith = (part: Parameters<typeof telegramBot.send>[1], reply: unknown = { ok: true, result: { message_id: 7 } }) => {
  const calls: { url: string; body: any }[] = []
  const result = telegramBot.send({ connection, credentials: { botToken: 'TESTONLY' }, target: { kind: 'direct', externalUserId: '42' },
    fetch: (async (input, init) => { calls.push({ url: String(input), body: JSON.parse(String(init?.body)) }); return Response.json(reply) }) as typeof fetch }, part)
  return { calls, result }
}
const user = { id: 42, first_name: 'Ana' }
const priv = { id: 42, type: 'private' }

// Doc: conceitos/sending-files.md (URL: foto 5 MB, demais 20 MB) e metodos/sendDocument.md (sem restricao de tipo).
it('aceita documentos comuns além de PDF e áudio m4a, mantendo os limites de URL da doc', () => {
  const caps = capabilities('telegram')
  expect(caps.media.file).toMatchObject({ maxBytes: 20e6 })
  expect(caps.media.image?.maxBytes).toBe(5e6)
  for (const mime of ['application/pdf', 'application/zip', 'text/csv', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']) expect(caps.media.file?.mime).toContain(mime)
  expect(caps.media.audio?.mime).toEqual(expect.arrayContaining(['audio/mpeg', 'audio/mp4']))
  expect(telegramBot.fit({ kind: 'media', media: 'file', url: 'https://m.test/a.zip', mime: 'application/zip', size: 1000 }, caps)).toMatchObject({ messages: expect.any(Array) })
})

// Doc: metodos/setWebhook.md e tipos/Update.md (my_chat_member: em chat privado chega quando o bot e bloqueado/desbloqueado).
it('registra o webhook pedindo my_chat_member', async () => {
  let body: any
  await telegramBot.registerWebhook!({ connection, credentials: { botToken: 'TESTONLY' }, hookUrl: 'https://x.test/hook', webhookSecret: 's', fetch: (async (_u: unknown, init: RequestInit) => { body = JSON.parse(String(init.body)); return Response.json({ ok: true }) }) as typeof fetch } as any)
  expect(body.allowed_updates).toEqual(['message', 'callback_query', 'my_chat_member'])
})
it.each([['kicked', 'optout'], ['member', 'optin']])('my_chat_member privado com status %s vira %s', (status, kind) => {
  const events = telegramBot.parseInbound({ update_id: 9, my_chat_member: { chat: priv, from: user, date: 1, old_chat_member: { status: 'member', user: { id: 1, is_bot: true } }, new_chat_member: { status, user: { id: 1, is_bot: true } } } }, connection)
  expect(events).toMatchObject([{ kind, eventKey: '9', from: { externalUserId: '42', addressKind: 'telegram_id' } }])
})
it('my_chat_member de grupo ou com status irrelevante é ignorado', () => {
  const upd = (chat: unknown, status: string) => ({ update_id: 10, my_chat_member: { chat, from: user, date: 1, old_chat_member: { status: 'member' }, new_chat_member: { status } } })
  expect(telegramBot.parseInbound(upd({ id: -5, type: 'group' }, 'kicked'), connection)).toMatchObject([{ kind: 'ignored' }])
  expect(telegramBot.parseInbound(upd(priv, 'administrator'), connection)).toMatchObject([{ kind: 'ignored' }])
})
it('sync marca e limpa blocked_at pelo evento my_chat_member', async () => {
  const sql: { q: string; args: unknown[] }[] = []
  const env = { DB: { prepare: (q: string) => ({ bind: (...args: unknown[]) => ({ run: async () => { sql.push({ q, args }) } }) }) } }
  const ctx = { connection, credentials: {}, fetch, env, event: { workspaceId: 'w', channelId: 'c' } } as any
  await telegramBot.sync!(ctx, { kind: 'optout', externalUserId: '42' })
  await telegramBot.sync!(ctx, { kind: 'optin', externalUserId: '42' })
  await telegramBot.sync!(ctx, { kind: 'message', externalUserId: '42', externalMessageId: '1' })
  expect(sql).toHaveLength(2)
  expect(sql[0]!.q).toMatch(/blocked_at=coalesce\(blocked_at,\?\)/)
  expect(sql[1]!.q).toMatch(/blocked_at=NULL/)
})

// Doc: tipos/Message.md (photo, document, voice, video, contact, location, caption) e tipos/Update.md.
it('mensagem com mídia, localização ou contato deixa de chegar como mensagem vazia', () => {
  const msg = (extra: Record<string, unknown>) => telegramBot.parseInbound({ update_id: 1, message: { message_id: 3, from: user, chat: priv, ...extra } }, connection)
  expect(msg({ photo: [{ file_id: 'a' }], caption: 'Olha' })).toMatchObject([{ kind: 'message', text: 'Olha', unsupported: { type: 'photo' } }])
  expect(msg({ voice: { file_id: 'v' } })).toMatchObject([{ kind: 'message', unsupported: { type: 'voice' } }])
  expect(msg({ document: { file_id: 'd' } })).toMatchObject([{ unsupported: { type: 'document' } }])
  expect(msg({ sticker: { file_id: 's' } })).toMatchObject([{ unsupported: { type: 'sticker' } }])
  expect(msg({ location: { latitude: -23.5, longitude: -46.6 } })).toMatchObject([{ location: { latitude: -23.5, longitude: -46.6 } }])
  expect(msg({ contact: { phone_number: '+5511999990000', first_name: 'Bia', last_name: 'Lima' } })).toMatchObject([{ sharedContacts: [{ name: 'Bia Lima', phones: ['+5511999990000'], emails: [] }] }])
  expect(msg({ text: 'oi' })).toMatchObject([{ text: 'oi' }])
  expect(msg({ text: 'oi' })[0]).not.toHaveProperty('unsupported')
})
it('texto acima de 4096 não derruba o update: é cortado', () => {
  const [event] = telegramBot.parseInbound({ update_id: 1, message: { message_id: 3, from: user, chat: priv, text: 'a'.repeat(5000) } }, connection)
  expect(event).toMatchObject({ kind: 'message' })
  expect([...(event as { text: string }).text]).toHaveLength(4096)
})
it('optin/optout atravessam o legado sem virar mensagem', () => {
  expect(legacyEvents([{ kind: 'optout', eventKey: '1', from: { externalUserId: '42', addressKind: 'telegram_id' } }])).toEqual([{ kind: 'optout', externalUserId: '42' }])
})

// Doc: metodos/sendPhoto.md etc. (reply_markup e caption 0-1024 em todos os envios de midia).
it('mídia com botões envia reply_markup inline', async () => {
  const part = { kind: 'media' as const, media: 'image' as const, url: 'https://m.test/a.png', buttons: [{ type: 'postback' as const, id: 'b:1', title: 'Sim' }, { type: 'url' as const, url: 'https://x.test', title: 'Site' }] }
  const fit = telegramBot.fit(part, capabilities('telegram'))
  expect(fit).toMatchObject({ messages: [part] })
  const { calls, result } = sendWith(part)
  expect(await result).toMatchObject({ ok: true })
  expect(calls[0]!.url).toMatch(/sendPhoto$/)
  expect(calls[0]!.body.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Sim', callback_data: 'b:1' }], [{ text: 'Site', url: 'https://x.test' }]] })
})
it('mídia recusa botão inválido ou botões demais para uma mensagem', () => {
  const caps = capabilities('telegram')
  const media = { kind: 'media' as const, media: 'image' as const, url: 'https://m.test/a.png' }
  expect(telegramBot.fit({ ...media, buttons: [{ type: 'call', phone: '+551100000000', title: 'Ligar' }] }, caps)).toMatchObject({ ok: false, reason: 'unsupported' })
  expect(telegramBot.fit({ ...media, buttons: Array.from({ length: 11 }, (_, i) => ({ type: 'postback' as const, id: `b${i}`, title: 'x' })) }, caps)).toMatchObject({ ok: false, reason: 'unsupported' })
})
it('legenda acima de 1024 é cortada no fit e informada', () => {
  const caps = capabilities('telegram')
  const fit = telegramBot.fit({ kind: 'media', media: 'image', url: 'https://m.test/a.png', caption: 'é'.repeat(1500) }, caps)
  if ('ok' in fit) throw new Error('esperava mensagem ajustada')
  expect([...(fit.messages[0] as { caption: string }).caption]).toHaveLength(1024)
  expect(fit.degraded).toContainEqual({ kind: 'text_truncated', at: 1024 })
})
it('o envio usa a legenda ajustada e devolve o motivo do Telegram numa recusa de mídia', async () => {
  const long = sendWith({ kind: 'media', media: 'file', url: 'https://m.test/a.pdf', caption: 'x'.repeat(2000) })
  await long.result
  expect([...long.calls[0]!.body.caption]).toHaveLength(1024)
  const { result } = sendWith({ kind: 'media', media: 'image', url: 'https://m.test/a.png' }, { ok: false, error_code: 400, description: 'Bad Request: failed to get HTTP URL content' })
  expect(await result).toMatchObject({ ok: false, reason: 'rejected', code: '400', detail: expect.stringContaining('failed to get HTTP URL content') })
})
