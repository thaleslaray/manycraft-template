import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/env'
import { ensureConversation, type Message } from '../src/inbox/service'
import { origin, seedAuth } from './auth-helpers'
import { giveCredentials } from './credentials'

const bindings = () => ({ ...env, DEV_AUTO_LOGIN: '1', DEV_WORKSPACE_ID: 'a', CHANNEL_LIMITER: undefined, MEDIA_PUBLIC_URL: 'https://media.example.test', BETTER_AUTH_URL: 'https://engine.example.test' } as unknown as Env)
const post = (body: unknown, runtime = bindings()) => app.request(`${origin}/api/inbox/conversations/inbox-cc-a/messages`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin, 'x-workspace': 'a' } }, runtime)
const media = (id: string, type: string, size: number, workspace = 'a') =>
  env.DB.prepare('INSERT INTO media_objects(id,workspace_id,object_key,content_type,size,created_at) VALUES (?,?,?,?,?,?)').bind(id, workspace, `${id}/foto.png`, type, size, Date.now()).run()
const telegramOk = () => vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true, result: { message_id: 321 } }))
const ID = '11111111-1111-4111-8111-111111111111'

beforeEach(async () => {
  await seedAuth()
  await env.DB.prepare("UPDATE channels SET type='telegram' WHERE id='ch-a'").run()
  await giveCredentials(env, 'ch-a', { botToken: 'TESTONLY-MEDIA', webhookSecret: 'secret' })
  await ensureConversation(env, 'a', 'c-a', 'ch-a')
})
afterEach(() => vi.restoreAllMocks())

it('envia imagem pela caixa de entrada com o mesmo envio de mídia do motor e mostra o anexo na conversa', async () => {
  await media(ID, 'image/png', 1000)
  const send = telegramOk()
  const response = await post({ kind: 'media', media: 'image', media_id: ID, caption: 'Segue o produto' })
  expect(response.status).toBe(201)
  const message = await response.json() as Message
  expect(message).toMatchObject({ sender: 'human', status: 'sent', text: 'Segue o produto',
    media: { kind: 'image', status: 'stored', mime: 'image/png', size: 1000, url: `/api/inbox/media/${ID}` } })
  expect(send.mock.calls[0][0]).toBe('https://api.telegram.org/botTESTONLY-MEDIA/sendPhoto')
  expect(JSON.parse(String(send.mock.calls[0][1]?.body))).toMatchObject({ chat_id: 'user-a', photo: `https://media.example.test/${ID}/foto.png` })
  const history = await (await app.request(`${origin}/api/inbox/conversations/inbox-cc-a/messages`, { headers: { origin, 'x-workspace': 'a' } }, bindings())).json() as { rows: Message[] }
  expect(history.rows.at(-1)?.media?.url).toBe(`/api/inbox/media/${ID}`)
})

it('a conversa informa a conexão e a ficha de mídia, para o painel oferecer só o que o canal aceita', async () => {
  const list = await (await app.request(`${origin}/api/inbox/conversations?status=all`, { headers: { origin, 'x-workspace': 'a' } }, bindings())).json() as { rows: { connection_id: string; connection_profile: { media: Record<string, { maxBytes: number }> } }[] }
  expect(list.rows[0].connection_id).toBe('ch-a')
  expect(list.rows[0].connection_profile.media.image.maxBytes).toBe(5e6)
})

it('recusa arquivo fora da ficha do canal (tipo ou tamanho) ou de outro espaço, sem tocar a rede', async () => {
  const send = telegramOk()
  await media(ID, 'audio/wav', 1000)
  expect((await post({ kind: 'media', media: 'audio', media_id: ID })).status).toBe(409)
  const big = '22222222-2222-4222-8222-222222222222'
  await media(big, 'image/png', 6e6)
  expect((await post({ kind: 'media', media: 'image', media_id: big })).status).toBe(409)
  const other = '33333333-3333-4333-8333-333333333333'
  await media(other, 'image/png', 10, 'b')
  expect((await post({ kind: 'media', media: 'image', media_id: other })).status).toBe(409)
  expect(send).not.toHaveBeenCalled()
  expect(await env.DB.prepare('SELECT count(*) n FROM messages').first('n')).toBe(0)
})

it('no WhatsApp respeita a janela e aceita PDF dentro dela', async () => {
  await env.DB.prepare("DELETE FROM conversations WHERE id='inbox-cc-a'").run()
  await env.DB.prepare("DELETE FROM contact_channels WHERE id='cc-a'").run()
  await env.DB.prepare("UPDATE channels SET type='whatsapp',provider='meta_whatsapp_cloud' WHERE id='ch-a'").run()
  await env.DB.prepare("INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,identity_kind,window_expires_at,last_inbound_at,opted_in) VALUES ('cc-a','a','c-a','ch-a','BR.testonly','bsuid',?,?,1)")
    .bind(Date.now() - 1000, Date.now() - 25 * 3600_000).run()
  await ensureConversation(env, 'a', 'c-a', 'ch-a')
  await giveCredentials(env, 'ch-a', { accessToken: 'TESTONLY', phoneNumberId: '123' })
  await env.DB.prepare('INSERT INTO media_objects(id,workspace_id,object_key,content_type,size,created_at) VALUES (?,?,?,?,?,?)').bind(ID, 'a', `${ID}/proposta.pdf`, 'application/pdf', 2000, Date.now()).run()
  const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ messaging_product: 'whatsapp', messages: [{ id: 'fake-doc' }] }))
  expect((await post({ kind: 'media', media: 'file', media_id: ID })).status).toBe(409)
  expect(send).not.toHaveBeenCalled()
  await env.DB.prepare("UPDATE contact_channels SET window_expires_at=?,last_inbound_at=? WHERE id='cc-a'").bind(Date.now() + 3600_000, Date.now()).run()
  const response = await post({ kind: 'media', media: 'file', media_id: ID, name: 'proposta.pdf' })
  expect(response.status).toBe(201)
  expect(await response.json()).toMatchObject({ status: 'sent', text: '[Arquivo] proposta.pdf', media: { kind: 'file', name: 'proposta.pdf' } })
  expect(JSON.parse(String(send.mock.calls[0][1]?.body))).toMatchObject({ type: 'document', document: { link: `https://media.example.test/${ID}/proposta.pdf` } })
})

it('erro do provedor fica no balão da mídia enviada', async () => {
  await media(ID, 'image/png', 1000)
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: false, error_code: 400, description: 'Bad Request: wrong file identifier' }, { status: 400 }))
  const message = await (await post({ kind: 'media', media: 'image', media_id: ID })).json() as Message
  expect(message.status).toBe('failed')
  expect(message.error).toBeTruthy()
  expect(message.media?.kind).toBe('image')
})

it('arquivo que o contato mandou (bucket privado) não vira anexo: nunca ganha endereço público', async () => {
  await env.DB.prepare("INSERT INTO media_objects(id,workspace_id,object_key,content_type,size,created_at,bucket) VALUES (?,?,?,?,?,?,'inbound')").bind(ID, 'a', ID, 'image/png', 1000, Date.now()).run()
  const send = telegramOk()
  const response = await post({ kind: 'media', media: 'image', media_id: ID })
  expect(response.status).toBe(409)
  expect(send).not.toHaveBeenCalled()
})
