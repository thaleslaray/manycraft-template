import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { effectiveProfile } from '../src/channels/core/profile-merge'
import { connectionRuntime } from '../src/channels/core/runtime'
import { listConnections } from '../src/channels/core/connections'
import { seed } from './fixtures'

const insert = (id: string, type: string, provider?: string) => env.DB.prepare(
  `INSERT INTO channels (id,workspace_id,type,external_id${provider ? ',provider' : ''}) VALUES (?,?,?,?${provider ? ',?' : ''})`)
  .bind(...[id, 'a', type, `ext-${id}`, ...(provider ? [provider] : [])]).run()

describe('migração 0012: canal vira conexão', () => {
  beforeEach(seed)

  it('conexão criada sem provedor entra como legacy e a runtime cai no padrão do canal', async () => {
    await insert('x-wa', 'whatsapp')
    const runtime = await connectionRuntime(env, 'a', 'x-wa')
    expect(runtime.connection).toMatchObject({ kind: 'whatsapp', provider: 'meta_whatsapp_cloud', status: 'connected', settings: {} })
    expect(runtime.connection.profile).toEqual(effectiveProfile('whatsapp', 'meta_whatsapp_cloud'))
    expect(runtime.adapter.capabilities()).toEqual(effectiveProfile('whatsapp', 'meta_whatsapp_cloud'))
  })
  it('o ajuste da conexão entra na ficha efetiva', async () => {
    await insert('x-ig', 'instagram', 'instagram_unified')
    await env.DB.prepare('UPDATE channels SET capabilities_override = ? WHERE id = ?').bind(JSON.stringify({ remove: ['cards'] }), 'x-ig').run()
    expect((await connectionRuntime(env, 'a', 'x-ig')).connection.profile.cards).toBeNull()
  })
  it('linha nova sem provedor recebe o padrão do canal', async () => {
    await insert('x-tg2', 'telegram')
    expect(await env.DB.prepare('SELECT provider FROM channels WHERE id=?').bind('x-tg2').first('provider')).toBe('telegram_bot')
  })
  it('estado acompanha o status escrito pelo código antigo', async () => {
    await insert('x-tg3', 'telegram')
    await env.DB.prepare("UPDATE channels SET status='disconnected' WHERE id=?").bind('x-tg3').run()
    expect((await connectionRuntime(env, 'a', 'x-tg3')).connection.status).toBe('disconnected')
  })
  it('desativada continua desconectada: o banco recusa a saúde "conectada" nela (0125) e Canais e Início mostram o mesmo', async () => {
    await insert('x-tg4', 'telegram')
    await env.DB.prepare("UPDATE channels SET status='disconnected' WHERE id=?").bind('x-tg4').run()
    await expect(env.DB.prepare("UPDATE channels SET connection_state='connected' WHERE id=?").bind('x-tg4').run()).rejects.toThrow(/connection_disabled_state/)
    expect((await listConnections(env, 'a', 'http://x')).find(c => c.id === 'x-tg4')?.status).toBe('disconnected')
    const row = await env.DB.prepare("SELECT CASE WHEN status='disconnected' THEN 'disconnected' ELSE connection_state END AS s FROM channels WHERE id='x-tg4'").first('s')
    expect(row).toBe('disconnected')
  })
  it('update não cria par canal/provedor incompatível', async () => {
    await insert('x-wa2', 'whatsapp')
    await expect(env.DB.prepare("UPDATE channels SET provider='telegram_bot' WHERE id=?").bind('x-wa2').run()).rejects.toThrow(/provider_kind_mismatch|connection_provider_immutable/)
    await env.DB.prepare("UPDATE channels SET type='telegram' WHERE id=?").bind('x-wa2').run()
    expect(await env.DB.prepare('SELECT provider FROM channels WHERE id=?').bind('x-wa2').first('provider')).toBe('telegram_bot')
  })
  it('conexão de outro workspace não resolve', async () => {
    await expect(connectionRuntime(env, 'b', 'ch-a')).rejects.toThrow(/not found/)
  })
  it('a view connections expõe o nome novo e nenhuma coluna de credencial', async () => {
    await insert('x-tg', 'telegram', 'telegram_bot')
    const row = await env.DB.prepare('SELECT * FROM connections WHERE id = ?').bind('x-tg').first<Record<string, unknown>>()
    expect(row).toMatchObject({ kind: 'telegram', provider: 'telegram_bot', status: 'connected', workspace_id: 'a' })
    expect(Object.keys(row!).filter((key) => /token|secret|credential/i.test(key))).toEqual([])
  })
  it('provedor só serve os canais que declara e não muda depois de definido', async () => {
    await expect(insert('bad', 'telegram', 'meta_whatsapp_cloud')).rejects.toThrow(/provider_kind_mismatch/)
    await insert('x-up', 'whatsapp')
    await env.DB.prepare("UPDATE channels SET provider='meta_whatsapp_cloud' WHERE id='x-up'").run()
    await expect(env.DB.prepare("UPDATE channels SET provider='uazapi' WHERE id='x-up'").run()).rejects.toThrow(/immutable/)
  })
  it('instagram_unified só serve o canal instagram, é o padrão do canal e o provedor não muda depois (migrações 0116 e 0122)', async () => {
    await insert('x-iu', 'instagram', 'instagram_unified')
    expect(await env.DB.prepare('SELECT provider FROM channels WHERE id=?').bind('x-iu').first('provider')).toBe('instagram_unified')
    await expect(insert('bad-iu', 'whatsapp', 'instagram_unified')).rejects.toThrow(/provider_kind_mismatch/)
    await insert('x-wa-iu', 'whatsapp')
    await expect(env.DB.prepare("UPDATE channels SET provider='instagram_unified' WHERE id='x-wa-iu'").run()).rejects.toThrow(/provider_kind_mismatch|connection_provider_immutable/)
    await insert('x-iu-padrao', 'instagram')
    expect(await env.DB.prepare('SELECT provider FROM channels WHERE id=?').bind('x-iu-padrao').first('provider')).toBe('instagram_unified')
    // 'legacy' passa na CHECK e no provider_kind: a recusa vem só do gatilho de imutabilidade.
    await expect(env.DB.prepare("UPDATE channels SET provider='legacy' WHERE id='x-iu-padrao'").run()).rejects.toThrow(/connection_provider_immutable/)
    expect((await connectionRuntime(env, 'a', 'x-iu')).connection.provider).toBe('instagram_unified')
  })
  it('estados novos de conexão são aceitos e os inválidos recusados', async () => {
    await insert('x-st', 'whatsapp')
    await env.DB.prepare("UPDATE channels SET connection_state='connecting' WHERE id='x-st'").run()
    await expect(env.DB.prepare("UPDATE channels SET connection_state='nope' WHERE id='x-st'").run()).rejects.toThrow()
  })
})
