import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Graph } from '../../src/contracts'
import { canalInstagramUnificado } from './canal-instagram-unificado'
import { contratoEnvio } from './contrato-mensagens-meta'
import { consumir, desligarWorkflows, elo, esperar, jornadaPadrao, ligarWorkflows, prepararEspaco, publicarFluxo, sql } from './jornada'
import { InstagramUnificadoGraph, PERMISSOES_UNIFICADO } from './simulador-instagram-unificado'
import { instalarRede } from './simuladores'

// Instagram pelo login unificado (graph.facebook.com, token de usuário do sistema): a mesma jornada do usuário novo, só que contra um simulador
// que responde apenas às rotas do unificado. O host do login do Instagram não é aceito: qualquer chamada para lá derruba o teste.
let sim: InstagramUnificadoGraph
beforeEach(async () => {
  await prepararEspaco()
  sim = new InstagramUnificadoGraph()
  instalarRede(sim)
  await ligarWorkflows()
})
afterEach(async () => { await desligarWorkflows(); vi.restoreAllMocks() })

const no = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, config })
const GET = (caminho: string) => sim.chamadas.some(c => c.metodo === 'GET' && c.caminho === `/v26.0/${caminho}`)

it('[instagram unificado] jornada: conectar → fluxo → botão → condição → ação → mensagem final', async ({ task }) => {
  const canal = canalInstagramUnificado(sim)
  try { await jornadaPadrao(task, canal) } catch (e) { console.log(JSON.stringify(task.meta.elos)); throw e }
  await elo(task, 'conferiu a conta pelo ID e assinou o webhook, sem depender de /me', async () => {
    expect(GET(sim.contaId), 'a conta é conferida em /<IG_ID>?fields=id,username').toBe(true)
    expect(sim.chamadas.filter(c => c.caminho === '/v26.0/me'), 'o /me do unificado não traz user_id: nada pode depender dele').toEqual([])
    expect(sim.assinaturas.length, 'subscribed_apps pedido ao conectar').toBeGreaterThan(0)
    expect(sim.assinaturas[0]).toContain('messages')
    // Webhook do app assinado sozinho, depois de gravar a conexão: a Meta conferiu o callback (handshake na rota real) uma vez e deu certo.
    expect(sim.verificacoes, 'a Meta conferiu o callback ao assinar').toEqual([{ callback: expect.stringMatching(/\/api\/webhooks\/meta$/), status: 200, ok: true }])
    expect(sim.webhookDoApp?.callback).toMatch(/\/api\/webhooks\/meta$/)
    expect(sim.webhookDoApp?.campos).toEqual(expect.arrayContaining(['messages', 'messaging_postbacks', 'comments', 'standby']))
    const assinatura = sim.chamadas.filter(c => c.metodo === 'POST' && c.caminho === `/v26.0/${sim.appId}/subscriptions`)
    expect(assinatura, 'uma assinatura do webhook do app ao conectar').toHaveLength(1)
    expect(assinatura[0].consulta, 'token de verificação no corpo, nunca na URL').not.toContain('verify_token')
    expect(sim.chamadas.length, 'o simulador registrou chamadas').toBeGreaterThan(0)
    const vazaram = sim.chamadas.filter(c => new URLSearchParams(c.consulta).has('access_token') || c.consulta.includes(sim.token) || c.caminho.includes(sim.token))
    expect(vazaram.map(c => `${c.metodo} ${c.caminho}?${c.consulta.replace(sim.token, '***')}`), 'token fora da URL (caminho e query): só no cabeçalho Authorization').toEqual([])
    const conta = sim.chamadas.filter(c => c.metodo === 'GET' && c.caminho === `/v26.0/${sim.contaId}`)
    expect(conta.length).toBeGreaterThan(0)
    for (const c of conta) expect(new URLSearchParams(c.consulta).get('fields'), 'a leitura da conta pede fields=id,username').toBe('id,username')
  })
}, 60000)

it('[instagram unificado] contrato: o adaptador classifica cada erro da Graph API de forma sensata', async () => {
  const canal = canalInstagramUnificado(sim)
  const id = await canal.conectar()
  await contratoEnvio(canal, sim, id)
}, 60000)

it('[instagram unificado] permissões: /me/permissions no formato real, com as sete permissões concedidas', async () => {
  const resposta = await (await fetch(`https://graph.facebook.com/v26.0/me/permissions`, { headers: { Authorization: `Bearer ${sim.token}` } })).json() as { data: { permission: string; status: string }[] }
  expect(resposta.data.map(p => p.permission)).toEqual(PERMISSOES_UNIFICADO)
  expect(resposta.data.every(p => p.status === 'granted')).toBe(true)
  const me = await (await fetch(`https://graph.facebook.com/v26.0/me`, { headers: { Authorization: `Bearer ${sim.token}` } })).json() as Record<string, unknown>
  expect(me).not.toHaveProperty('user_id')
  await expect(fetch('https://graph.instagram.com/v26.0/me')).rejects.toThrow('Rede real proibida')
})

it('[instagram unificado] leitura: o recibo correlaciona a mensagem enviada; repetido não duplica e fora de ordem espera a mensagem', async ({ task }) => {
  const canal = canalInstagramUnificado(sim)
  await elo(task, 'conectar e responder uma palavra-chave', async () => {
    const id = await canal.conectar()
    await publicarFluxo('instagram', { nodes: [no('start', 'trigger'), no('oi', 'message', { blocks: [{ kind: 'text', text: 'Oi, tudo bem?' }] })] as Graph['nodes'], edges: [{ from: 'start', port: 'next', to: 'oi' }] }, 'quero', id)
    const r = await canal.mensagem(canal.usuario(1), 'quero', 1)
    await consumir(r.eventos)
    await esperar('resposta do fluxo', async () => canal.enviadas(), e => e.length >= 1)
  })
  const leitura = (mid: string) => canal.entregar({ object: 'instagram', entry: [{ id: sim.contaId, time: Date.now(), messaging: [{ sender: { id: canal.usuario(1) }, recipient: { id: sim.contaId }, timestamp: Date.now(), read: { mid } }] }] })
  const lidas = () => sql.n("SELECT count(*) n FROM messages WHERE source='automation' AND delivery_status='read'")
  await elo(task, 'leitura da mensagem enviada', async () => {
    const r = await leitura('m_SIM00000001')
    expect(r.status).toBe(200)
    expect((await consumir(r.eventos)).retryMessages).toEqual([])
    expect(await lidas()).toBe(1)
  })
  await elo(task, 'leitura repetida não duplica o evento', async () => {
    const eventos = () => sql.n("SELECT count(*) n FROM node_events WHERE type='read'")
    const antes = await eventos()
    await consumir((await leitura('m_SIM00000001')).eventos)
    expect(await eventos()).toBe(antes)
    expect(await lidas()).toBe(1)
  })
  await elo(task, 'leitura de mensagem ainda desconhecida volta para a fila, sem criar nada', async () => {
    const r = await leitura('m_SIM99999999')
    const fila = await consumir(r.eventos)
    expect(fila.retryMessages.length, 'o recibo adiantado fica para uma nova tentativa').toBe(1)
    expect(await lidas()).toBe(1)
  })
}, 60000)

it('[instagram unificado] comentário: o gatilho abre o fluxo, manda a resposta privada pelo ID do comentário e responde em público; replay não repete', async ({ task }) => {
  const canal = canalInstagramUnificado(sim)
  const grafo = { nodes: [no('start', 'trigger'), no('guia', 'message', { blocks: [{ kind: 'text', text: 'Seu guia está aqui.' }, { kind: 'button', id: 'guia', label: 'Abrir guia', action: { type: 'url', url: 'https://example.com/guia' } }] })] as Graph['nodes'],
    edges: [{ from: 'start', port: 'next', to: 'guia' }] }
  await elo(task, 'conectar e preparar o gatilho de comentário num post', async () => {
    const id = await canal.conectar()
    await publicarFluxo('instagram', grafo, 'quero', id)
    await env.DB.prepare(`UPDATE triggers SET channel_id=?,kind='widget',widget_type='feed_comment',post_scope='specific',target_post_id='post-1',repeat_mode='every_time',
      public_replies='["Veja seu privado!"]',config='{"node_id":"start","include":["quero"]}' WHERE workspace_id='a' AND automation_id='auto-a'`).bind(id).run()
  })
  const comentario = () => canal.entregar({ object: 'instagram', entry: [{ id: sim.contaId, time: Date.now(), changes: [{ field: 'comments', value: { comment_id: 'comment-u1', from: { id: '190001', username: 'ana' }, media: { id: 'post-1' }, text: 'Eu quero', timestamp: new Date().toISOString() } }] }] })
  await elo(task, 'comentário → resposta privada e resposta pública', async () => {
    const r = await comentario()
    expect(r.status).toBe(200)
    expect(r.eventos.length).toBeGreaterThan(0)
    await consumir(r.eventos)
    await esperar('resposta privada ao comentário', async () => sim.respostasPrivadas, e => e.length >= 1)
    expect(sim.respostasPrivadas[0]).toMatchObject({ comentario: 'comment-u1', texto: 'Seu guia está aqui.', botoes: [{ titulo: 'Abrir guia', url: 'https://example.com/guia' }] })
    await esperar('resposta pública ao comentário', async () => sim.respostasPublicas, e => e.length >= 1)
    expect(sim.respostasPublicas[0]).toEqual({ comentario: 'comment-u1', texto: 'Veja seu privado!' })
    expect(sim.chamadas.some(c => c.caminho.endsWith('/likes')), 'curtir comentário não é suportado no unificado').toBe(false)
  })
  await elo(task, 'o mesmo comentário entregue de novo não responde duas vezes', async () => {
    await consumir((await comentario()).eventos)
    await new Promise(r => setTimeout(r, 150))
    expect(sim.respostasPrivadas).toHaveLength(1)
    expect(sim.respostasPublicas).toHaveLength(1)
    expect(await sql.n("SELECT count(*) n FROM flow_runs WHERE workspace_id='a'")).toBe(1)
  })
}, 60000)
