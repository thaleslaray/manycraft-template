import { env } from 'cloudflare:workers'
import { afterEach, expect, it, vi } from 'vitest'
import { processInboundFast } from '../src/jobs'
import type { InboundEvent } from '../src/integrations'
import { giveCredentials } from './credentials'
import { seed } from './fixtures'
import { ChannelLimiter } from '../src/flow/limiter'
import { currentTiming } from '../src/flow/inline-timing'

// Orçamento de idas ao D1 em fila até a primeira mensagem sair (DM do Instagram, automação de uma mensagem de texto).
// Em produção cada ida em fila custa uma viagem até o banco: antes do corte eram ~87 (contato existente) e ~91 (contato novo).
const ACCOUNT = '17841400000000001', USER = '987654321012345'
const graph = { nodes: [{ id: 'start', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
  { id: 'hello', type: 'message', position: { x: 0, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Oi {{primeiro_nome}}!' }] } }],
  edges: [{ from: 'start', port: 'next', to: 'hello' }] }
let n = 0
const dm = (): InboundEvent => ({ version: 1, provider: 'meta', workspaceId: 'a', channelId: 'ch-a', eventId: `ig.m.${++n}`, receivedAt: Date.now(),
  payload: { object: 'instagram', entry: [{ id: ACCOUNT, time: Math.floor(Date.now() / 1000), messaging: [{ sender: { id: USER }, recipient: { id: ACCOUNT }, timestamp: Date.now(), message: { mid: `ig.m.${n}`, text: 'quero' } }] }] } })

afterEach(() => { vi.restoreAllMocks() })

it('DM do Instagram: a primeira mensagem sai com poucas idas ao D1 em fila; inbox, métrica e passos gravados chegam depois', async () => {
  await seed()
  vi.spyOn(ChannelLimiter.prototype, 'acquire').mockResolvedValue({ allowed: true, retryAfter: 0 })
  const sent: { text: string; idasAntes: number }[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes(`/${USER}?`)) return Response.json({ name: 'Maria Souza', username: 'maria' })
    if (url.endsWith(`/${ACCOUNT}/messages`)) {
      const body = JSON.parse(String(init?.body)) as { message: { text: string } }
      sent.push({ text: body.message.text, idasAntes: currentTiming()!.rt })
      return Response.json({ recipient_id: USER, message_id: `mid.out.${sent.length}` })
    }
    throw new Error(`Pedido inesperado: ${url}`)
  })
  await env.DB.prepare('UPDATE channels SET external_id=? WHERE id=?').bind(ACCOUNT, 'ch-a').run()
  await giveCredentials(env, 'ch-a', { accessToken: 'TOKEN', accountId: ACCOUNT, appSecret: 'S' })
  await env.DB.prepare("INSERT INTO automation_versions (id,workspace_id,automation_id,version,graph) VALUES ('v1','a','auto-a',1,?)").bind(JSON.stringify(graph)).run()
  await env.DB.prepare("UPDATE automations SET status='live',published_version_id='v1' WHERE id='auto-a'").run()
  await env.DB.prepare("UPDATE triggers SET repeat_mode='every_time' WHERE id='trg-a'").run()
  await env.DB.prepare("UPDATE keywords SET status='live' WHERE id='key-a'").run()

  await processInboundFast([dm()], env)   // contato novo (com a busca do perfil)
  await processInboundFast([dm()], env)   // contato que já existe
  expect(sent.map(s => s.text)).toEqual(['Oi Maria!', 'Oi Maria!'])
  expect(sent[0].idasAntes).toBeLessThanOrEqual(24)
  expect(sent[1].idasAntes).toBeLessThanOrEqual(19)

  // O que ficou para depois do envio chegou: mensagens no inbox, métrica, execução encerrada sem Workflow e passos gravados.
  const runs = await env.DB.prepare("SELECT id,status,workflow_created_at,current_node_id FROM flow_runs WHERE workspace_id='a' ORDER BY created_at").all<{ id: string; status: string; workflow_created_at: number; current_node_id: string }>()
  expect(runs.results).toHaveLength(2)
  for (const run of runs.results) {
    expect(run).toMatchObject({ status: 'done', workflow_created_at: 0, current_node_id: 'hello' })
    expect(await env.DB.prepare("SELECT count(*) FROM node_events WHERE flow_run_id=? AND type='sent'").bind(run.id).first('count(*)')).toBe(1)
    expect(await env.DB.prepare('SELECT count(*) FROM flow_inline_steps WHERE run_id=?').bind(run.id).first('count(*)')).toBeGreaterThan(5)
  }
  const inbox = await env.DB.prepare("SELECT direction,content FROM messages WHERE workspace_id='a' ORDER BY rowid").all<{ direction: string; content: string }>()
  // Na ordem: mensagem do contato, marcador do gatilho, resposta da automação (a ordem do inbox não muda com o adiamento).
  expect(inbox.results.map(m => (JSON.parse(m.content) as { sender: string }).sender)).toEqual(['contact', 'system', 'automation', 'contact', 'system', 'automation'])
  expect(await env.DB.prepare('SELECT count(*) FROM inbound_events WHERE processed_at IS NULL').first('count(*)')).toBe(0)
})
