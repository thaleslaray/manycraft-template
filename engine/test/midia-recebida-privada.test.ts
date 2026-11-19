import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import type { Env } from '../src/env'
import { storedMedia } from '../src/media-blocks'
import { authenticatedRequest, seedAuth } from './auth-helpers'

/** O que o contato manda vive no bucket privado (INBOUND_MEDIA) e só abre pela rota autenticada da caixa de entrada; a mídia que o espaço envia segue no bucket público (MEDIA). */
beforeEach(seedAuth)
let ID = ''
beforeEach(() => { ID = crypto.randomUUID() })
const guardar = async (bucket: 'media' | 'inbound', workspace = 'a', id = ID) => {
  const alvo = bucket === 'inbound' ? env.INBOUND_MEDIA! : env.MEDIA!
  await alvo.put(`${id}/x.png`, new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]), { httpMetadata: { contentType: 'image/png' } })
  await env.DB.prepare('INSERT INTO media_objects(id,workspace_id,object_key,content_type,size,created_at,bucket) VALUES (?,?,?,?,?,?,?)')
    .bind(id, workspace, `${id}/x.png`, 'image/png', 8, Date.now(), bucket).run()
}

it('a caixa de entrada abre o arquivo do bucket privado para o espaço dono e dá 404 para outro', async () => {
  await guardar('inbound')
  const meu = await authenticatedRequest(`inbox/media/${ID}`)
  expect(meu.status).toBe(200)
  expect(new Uint8Array(await meu.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]))
  expect((await authenticatedRequest(`inbox/media/${ID}`, 'b')).status).toBe(404)
})

it('um objeto antigo (coluna no padrão) continua legível do bucket público', async () => {
  await env.MEDIA!.put(`${ID}/x.png`, new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]), { httpMetadata: { contentType: 'image/png' } })
  await env.DB.prepare('INSERT INTO media_objects(id,workspace_id,object_key,content_type,size,created_at) VALUES (?,?,?,?,?,?)').bind(ID, 'a', `${ID}/x.png`, 'image/png', 8, Date.now()).run()
  expect(await env.DB.prepare('SELECT bucket FROM media_objects WHERE id=?').bind(ID).first('bucket')).toBe('media')
  expect((await authenticatedRequest(`inbox/media/${ID}`)).status).toBe(200)
})

it('o endereço público de mídia nunca é montado para um arquivo que o contato mandou', async () => {
  await guardar('inbound')
  const publico = { ...env, MEDIA_PUBLIC_URL: 'https://midia.exemplo.test', BETTER_AUTH_URL: 'https://engine.test' } as unknown as Env
  // Anexo de fluxo ou de transmissão (storedMedia) recusa, em vez de apontar para um objeto que não está no bucket público.
  await expect(storedMedia(publico, 'a', { kind: 'media', media: 'image', url: '', mediaId: ID } as never)).rejects.toMatchObject({ status: 409 })
  // O anexo escolhido na caixa de entrada tem o teste dele em inbox-media-send.test.ts.
  expect(await (await authenticatedRequest(`media/public/${ID}/x.png`, 'a', {}, undefined, { ...env, APP_ENV: 'development' } as Env)).status).toBe(404)
})

it('a mídia que o espaço envia segue no bucket público e devolve o endereço público', async () => {
  await env.DB.prepare("UPDATE channels SET type='telegram',provider='telegram_bot' WHERE id='ch-a'").run()
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const publico = { ...env, MEDIA_PUBLIC_URL: 'https://midia.exemplo.test', BETTER_AUTH_URL: 'https://engine.test' } as unknown as Env
  const resposta = await authenticatedRequest('media?connection_id=ch-a&media=image', 'a', { method: 'POST', headers: { 'content-type': 'image/png', 'content-length': '8' }, body: png }, undefined, publico)
  expect(resposta.status).toBe(201)
  const salvo = await resposta.json() as { id: string; url: string }
  expect(salvo.url).toMatch(/^https:\/\/midia\.exemplo\.test\//)
  const linha = await env.DB.prepare('SELECT object_key,bucket FROM media_objects WHERE id=?').bind(salvo.id).first<{ object_key: string; bucket: string }>()
  expect(linha?.bucket).toBe('media')
  expect(await env.MEDIA!.head(linha!.object_key)).not.toBeNull()
  expect(await env.INBOUND_MEDIA!.head(linha!.object_key)).toBeNull()
})

it('um arquivo que o contato mandou não vira foto da conta', async () => {
  await guardar('inbound')
  expect((await authenticatedRequest('workspace-settings', 'a', { method: 'PATCH', body: JSON.stringify({ photo_media_id: ID }) })).status).toBe(409)
})
