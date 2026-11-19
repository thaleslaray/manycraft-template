import { env as runtime } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/env'
import { connectionAdapter } from '../src/channels'
import { giveCredentials } from './credentials'
import { seed } from './fixtures'

let env: Env
beforeEach(async () => {
  await seed()
  env = { ...runtime } as Env
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('wa-meta','a','whatsapp','123456789')"),
    env.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id,provider) VALUES ('wa-uaz','a','whatsapp','uazapi:r183e2ef','uazapi')"),
  ])
  await giveCredentials(env, 'wa-meta', { accessToken: 'TESTONLY', phoneNumberId: '123456789', appSecret: 'x' })
  await giveCredentials(env, 'wa-uaz', { serverUrl: 'https://loja.uazapi.com', token: 'UZ-TOKEN' })
})

describe('o envio escolhe o adaptador pelo provedor da conexão', () => {
  it('duas conexões do mesmo canal usam, cada uma, as regras do próprio provedor, sem marcador no ambiente', async () => {
    expect(env).not.toHaveProperty('CONNECTION_PROVIDER')
    expect((await connectionAdapter(env, 'a', 'wa-meta', 'whatsapp')).capabilities().window).not.toBeNull()
    expect((await connectionAdapter(env, 'a', 'wa-uaz', 'whatsapp')).capabilities().window).toBeNull()
  })
  it('canais só declarados continuam resolvendo pelo registro', async () => {
    expect((await connectionAdapter(env, 'a', 'nao-existe', 'tiktok')).capabilities().text.linksClickable).toBe(false)
  })
})
