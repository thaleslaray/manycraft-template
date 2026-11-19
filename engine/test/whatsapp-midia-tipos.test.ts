import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { app } from '../src/index'
import { fixtureCookie, seedAuth } from './auth-helpers'
import { effectiveProfile } from '../src/channels/core/profile-merge'
import { mediaError } from '../src/schemas/message-media'

// Tipos de P/business-phone-numbers/media.md (Supported media types, upd. 2026-06-16): documentos txt, xls, xlsx, doc, docx, ppt, pptx, pdf;
// áudio ogg só com codec Opus e mono.
const docs = {
  txt: 'text/plain', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', pdf: 'application/pdf',
}
const profile = effectiveProfile('whatsapp', 'meta_whatsapp_cloud')

it.each(Object.entries(docs))('o perfil do WhatsApp oficial aceita documento .%s até 100 MB', (_ext, mime) => {
  expect(mediaError({ kind: 'media', media: 'file', url: 'https://media.test/arquivo', mime, size: 100e6 }, [profile])).toBeUndefined()
  expect(mediaError({ kind: 'media', media: 'file', url: 'https://media.test/arquivo', mime, size: 100e6 + 1 }, [profile])).toMatch(/excede o limite/)
})
it('documento fora da lista da Meta continua recusado', () => {
  expect(mediaError({ kind: 'media', media: 'file', url: 'https://media.test/a', mime: 'application/zip' }, [profile])).toMatch(/tipo do arquivo/)
})

let cookie = ''
beforeEach(async () => {
  await seedAuth(); cookie = await fixtureCookie()
  await env.DB.prepare("DELETE FROM conversations WHERE id='inbox-cc-a'").run()
  await env.DB.prepare("DELETE FROM contact_channels WHERE channel_id='ch-a'").run()
  await env.DB.prepare("UPDATE channels SET type='whatsapp',provider='meta_whatsapp_cloud',status='connected' WHERE id='ch-a'").run()
})
const upload = (media: string, type: string, body: Uint8Array | string) => app.request(`/api/media?connection_id=ch-a&media=${media}`, { method: 'POST', body,
  headers: { cookie, 'x-workspace': 'a', 'content-type': type, 'content-length': String(new Blob([body]).size), origin: 'https://engine.test' } }, { ...env, APP_ENV: 'development', PUBLIC_BASE_URL: 'http://localhost:5822' })
const bytes = (...n: number[]) => new Uint8Array([...n, ...new Array(64).fill(0)])
const zip = bytes(0x50, 0x4b, 3, 4)
const ole = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)
const sample: Record<string, Uint8Array | string> = { txt: 'Olá, mundo\nSegunda linha', xls: ole, doc: ole, ppt: ole, xlsx: zip, docx: zip, pptx: zip }

it.each(Object.entries(sample))('upload de .%s com o conteúdo certo é aceito e com o conteúdo trocado é recusado', async (ext, body) => {
  const accepted = await upload('file', docs[ext as keyof typeof docs], body)
  expect(accepted.status).toBe(201)
  expect(await accepted.json()).toMatchObject({ mime: docs[ext as keyof typeof docs] })
  const wrong = ext === 'txt' ? bytes(0, 1, 2, 0xff, 0) : new TextEncoder().encode('isto não é um arquivo do Office')
  expect((await upload('file', docs[ext as keyof typeof docs], wrong)).status).toBe(400)
})

// Cabeçalho de página Ogg (27 bytes) + 1 segmento de 19 bytes: "OpusHead", versão 1, canais, ...
const ogg = (codec: 'opus' | 'vorbis', channels = 1) => {
  const head = new Uint8Array(27 + 1 + 19)
  head.set(new TextEncoder().encode('OggS'), 0); head[26] = 1; head[27] = 19
  head.set(new TextEncoder().encode(codec === 'opus' ? 'OpusHead' : '\x01vorbis\0\0'), 28)
  if (codec === 'opus') { head[36] = 1; head[37] = channels }
  return head
}
it('áudio ogg só passa com codec Opus e mono, com o motivo em português', async () => {
  expect((await upload('audio', 'audio/ogg', ogg('opus'))).status).toBe(201)
  const vorbis = await upload('audio', 'audio/ogg', ogg('vorbis'))
  expect(vorbis.status).toBe(400)
  expect(await vorbis.text()).toContain('Opus')
  const stereo = await upload('audio', 'audio/ogg', ogg('opus', 2))
  expect(stereo.status).toBe(400)
  expect(await stereo.text()).toContain('mono')
})
