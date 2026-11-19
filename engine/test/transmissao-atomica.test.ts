import { env as runtime } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/env'
import type { Principal } from '../src/permissions'
import { cancelBroadcast, processBroadcastBatch, saveBroadcast } from '../src/db/broadcasts'
import { giveCredentials } from './credentials'
import { d1ComGancho } from './d1-gancho'
import { seed } from './fixtures'

const owner: Principal = { userId: 'test-owner', workspaceId: 'a', role: 'owner' }
let env: Env
const input = (overrides: Record<string, unknown> = {}) => ({ name: 'Campanha', content: 'Olá, transmissão!', status: 'sending', audience: { tag: 'all', channel: 'telegram', channel_id: 'tg-a' }, ...overrides })
const passo = (id: string, text: string, x = 0) => ({ id, type: 'message', position: { x, y: 0 }, config: { blocks: [{ kind: 'text', text }] } })
const doisPassos = { nodes: [passo('a1', 'Primeiro passo'), passo('a2', 'Segundo passo', 300)], edges: [{ from: 'a1', port: 'next', to: 'a2' }] }
const daquiUmaHora = () => new Date(Date.now() + 3600_000).toISOString()
const queda = (trecho: string) => ({ ...env, DB: d1ComGancho(env.DB, trecho, () => { throw new Error('D1 indisponível') }) })
const telegramOk = () => Response.json({ ok: true, result: { message_id: 100 + vi.mocked(fetch).mock.calls.length } })
const transmissao = (id: string) => env.DB.prepare('SELECT status,copied_graph,first_node_id,automation_id,scheduled_at FROM broadcasts WHERE id=?').bind(id).first()
const destinatario = (id: string) => env.DB.prepare('SELECT status FROM broadcast_recipients WHERE broadcast_id=?').bind(id).first('status')
const execucao = (id: string) => env.DB.prepare('SELECT f.status FROM flow_runs f JOIN broadcast_recipients r ON r.run_id=f.id WHERE r.broadcast_id=?').bind(id).first('status')

beforeEach(async () => {
  await seed()
  env = { ...runtime, APP_ENV: 'development', CHANNEL_LIMITER: undefined, INBOUND: { send: vi.fn(async () => {}) } as unknown as Queue,
    FLOW_RUN: { create: vi.fn(async () => ({})), get: vi.fn(async () => ({ sendEvent: vi.fn() })) } as unknown as NonNullable<Env['FLOW_RUN']> }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels(id,workspace_id,type,external_id) VALUES ('tg-a','a','telegram','test-tg-a')"),
    env.DB.prepare("INSERT INTO contacts(id,workspace_id,first_name) VALUES ('c-tg','a','Ana')"),
    env.DB.prepare("INSERT INTO contact_channels(id,workspace_id,contact_id,channel_id,external_user_id,opted_in,identity_kind) VALUES ('cc-tg','a','c-tg','tg-a','1001',1,'provider_id')"),
  ])
  await giveCredentials(env, 'tg-a', { botToken: 'TESTONLY', webhookSecret: 'transmissao-atomica' })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    expect(String(url)).toMatch(/^https:\/\/api\.telegram\.org\/botTESTONLY\//)
    return telegramOk()
  })
})
afterEach(() => { vi.restoreAllMocks() })

describe('transmissão de vários passos: a transmissão e a cópia do fluxo saem no mesmo lote', () => {
  it('agendar: se a cópia do fluxo falhar, a transmissão não fica gravada só com o texto', async () => {
    await expect(saveBroadcast(queda('INSERT INTO automations'), owner, input({ status: 'scheduled', scheduled_at: daquiUmaHora(), flow: doisPassos })))
      .rejects.toThrow('D1 indisponível')
    expect(await env.DB.prepare('SELECT count(*) AS n FROM broadcasts').first('n')).toBe(0)
    expect(env.INBOUND!.send).not.toHaveBeenCalled()
    const saved: any = await saveBroadcast(env, owner, input({ status: 'scheduled', scheduled_at: daquiUmaHora(), flow: doisPassos }))
    expect(await transmissao(saved.id)).toMatchObject({ status: 'scheduled', first_node_id: 'a1', automation_id: `broadcast-${saved.id}` })
  })
  it('reagendar um rascunho: se a cópia do fluxo falhar, o rascunho fica como estava', async () => {
    const draft = await saveBroadcast(env, owner, input({ status: 'draft' }))
    await expect(saveBroadcast(queda('INSERT INTO automations'), owner, input({ id: draft.id, status: 'scheduled', scheduled_at: daquiUmaHora(), flow: doisPassos })))
      .rejects.toThrow('D1 indisponível')
    expect(await transmissao(draft.id)).toEqual({ status: 'draft', copied_graph: null, first_node_id: null, automation_id: null, scheduled_at: null })
    expect(await env.DB.prepare('SELECT count(*) AS n FROM automations WHERE id=?').bind(`broadcast-${draft.id}`).first('n')).toBe(0)
  })
  it('envio sendo preparado (lease ativo): a recusa também não troca a cópia do fluxo', async () => {
    const saved: any = await saveBroadcast(env, owner, input({ status: 'scheduled', scheduled_at: daquiUmaHora(), flow: doisPassos }))
    const before = await transmissao(saved.id)
    await env.DB.prepare('UPDATE broadcasts SET lease_until=? WHERE id=?').bind(Date.now() + 60_000, saved.id).run()
    const outro = { nodes: [passo('b1', 'Outro início'), passo('b2', 'Outro fim', 300)], edges: [{ from: 'b1', port: 'next', to: 'b2' }] }
    await expect(saveBroadcast(env, owner, input({ id: saved.id, status: 'scheduled', scheduled_at: daquiUmaHora(), flow: outro })))
      .rejects.toMatchObject({ status: 409 })
    expect(await transmissao(saved.id)).toEqual(before)
    expect(await env.DB.prepare('SELECT draft_graph FROM automations WHERE id=?').bind(`broadcast-${saved.id}`).first('draft_graph')).toBe(JSON.stringify(doisPassos))
  })
})

describe('escritor atrasado no envio da transmissão não sobrescreve estado final', () => {
  it('execução cancelada durante a chamada ao canal (o contato saiu) continua cancelada, não vira falha', async () => {
    const b = await saveBroadcast(env, owner, input())
    vi.mocked(fetch).mockImplementation(async () => {
      await env.DB.prepare("UPDATE flow_runs SET status='cancelled' WHERE id LIKE 'broadcast-run-%'").run()
      return telegramOk()
    })
    await processBroadcastBatch(env, 'a', b.id)
    expect(await destinatario(b.id)).toBe('uncertain')
    expect(await execucao(b.id)).toBe('cancelled')
  })
  it('execução cancelada logo antes de fechar o destinatário continua cancelada, não vira concluída', async () => {
    const b = await saveBroadcast(env, owner, input())
    const atrasado = { ...env, DB: d1ComGancho(env.DB, 'UPDATE flow_runs SET status', () =>
      env.DB.prepare("UPDATE flow_runs SET status='cancelled' WHERE id LIKE 'broadcast-run-%'").run()) }
    await processBroadcastBatch(atrasado, 'a', b.id)
    expect(await destinatario(b.id)).toBe('sent')
    expect(await execucao(b.id)).toBe('cancelled')
  })
  it('reentrega que só confirma um envio já aceito pelo canal não tira a execução de cancelada', async () => {
    const b = await saveBroadcast(env, owner, input())
    await processBroadcastBatch(env, 'a', b.id)
    // Rodada que morreu depois de o canal aceitar e antes de marcar o destinatário; nesse meio-tempo o contato saiu.
    await env.DB.batch([
      env.DB.prepare("UPDATE broadcast_recipients SET status='sending' WHERE broadcast_id=?").bind(b.id),
      env.DB.prepare("UPDATE flow_runs SET status='cancelled' WHERE id LIKE 'broadcast-run-%'"),
      env.DB.prepare("UPDATE broadcasts SET status='sending' WHERE id=?").bind(b.id),
    ])
    await processBroadcastBatch(env, 'a', b.id)
    expect(fetch).toHaveBeenCalledOnce()
    expect(await destinatario(b.id)).toBe('sent')
    expect(await execucao(b.id)).toBe('cancelled')
  })
  it('o fim do envio não troca por enviada uma transmissão que outro escritor já fechou', async () => {
    const b = await saveBroadcast(env, owner, input())
    vi.mocked(fetch).mockImplementation(async () => {
      await env.DB.prepare("UPDATE broadcasts SET status='cancelled' WHERE id=?").bind(b.id).run()
      return telegramOk()
    })
    await processBroadcastBatch(env, 'a', b.id)
    expect((await transmissao(b.id))?.status).toBe('cancelled')
  })
  it('lease vencido e transmissão cancelada antes do retrato do público: nada ressuscita nem sai', async () => {
    const b = await saveBroadcast(env, owner, input({ status: 'scheduled', scheduled_at: daquiUmaHora() }))
    await env.DB.prepare('UPDATE broadcasts SET scheduled_at=? WHERE id=?').bind(Date.now() - 1000, b.id).run()
    const atrasado = { ...env, DB: d1ComGancho(env.DB, 'INSERT INTO broadcast_recipients', async () => {
      // Passaram os 2 minutos do lease desta rodada e a pessoa cancelou pelo painel.
      await env.DB.prepare('UPDATE broadcasts SET lease_until=? WHERE id=?').bind(Date.now() - 1, b.id).run()
      await cancelBroadcast(env, owner, b.id)
    }) }
    await processBroadcastBatch(atrasado, 'a', b.id)
    expect((await transmissao(b.id))?.status).toBe('cancelled')
    expect(await env.DB.prepare('SELECT count(*) AS n FROM broadcast_recipients WHERE broadcast_id=?').bind(b.id).first('n')).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('continuação de vários passos: a execução que o contato cancelou entre o envio e a continuação não volta a rodar', async () => {
    const b = await saveBroadcast(env, owner, input({ flow: doisPassos }))
    // Antes do run-state, este UPDATE gravava status='running' sem olhar o estado de origem e ressuscitava a execução cancelada.
    const atrasado = { ...env, DB: d1ComGancho(env.DB, 'UPDATE flow_runs SET start_node_id', () =>
      env.DB.prepare("UPDATE flow_runs SET status='cancelled' WHERE id LIKE 'broadcast-run-%'").run()) }
    await processBroadcastBatch(atrasado, 'a', b.id)
    expect(fetch).toHaveBeenCalledOnce()
    expect(await execucao(b.id)).toBe('cancelled')
    expect(env.FLOW_RUN!.create).not.toHaveBeenCalled()
  })
  it('destinatário e execução fecham juntos: se a gravação da execução falhar, a reentrega fecha os dois', async () => {
    const b = await saveBroadcast(env, owner, input())
    await expect(processBroadcastBatch(queda('UPDATE flow_runs SET status'), 'a', b.id)).rejects.toThrow('D1 indisponível')
    await processBroadcastBatch(env, 'a', b.id)
    expect(fetch).toHaveBeenCalledOnce()
    expect(await destinatario(b.id)).toBe('sent')
    expect(await execucao(b.id)).toBe('done')
  })
})
