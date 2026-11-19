import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Graph } from '../src/contracts'
import { canalWhatsapp } from './prontidao/canal-whatsapp'
import { apiJson, consumir, desligarWorkflows, esperar, esperarEnviadas, ligarWorkflows, prepararEspaco, publicarFluxo } from './prontidao/jornada'
import { instalarRede, MetaGraph, webhooksWhatsapp } from './prontidao/simuladores'

// Lista de opções de ponta a ponta contra a Graph API simulada: o que a Meta recebe e o toque na linha seguindo pela saída dela.
const text = (t: string) => ({ kind: 'text', text: t })
const row = (id: string, title: string, description?: string) => ({ id, title, ...(description ? { description } : {}) })
const list = (extra: Record<string, unknown> = {}) => ({ kind: 'list', buttonText: 'Ver assuntos', sections: [
  { title: 'Vendas', rows: [row('v1', 'Preços'), row('v2', 'Planos', 'Mensal e anual')] }, { title: 'Ajuda', rows: [row('h1', 'Suporte')] }], ...extra })

let sim: MetaGraph
let canal: ReturnType<typeof canalWhatsapp>
beforeEach(async () => {
  await prepararEspaco()
  sim = new MetaGraph()
  instalarRede(sim)
  await ligarWorkflows()
  canal = canalWhatsapp(sim)
  const id = await canal.conectar()
  await env.DB.prepare("UPDATE channels SET status='connected' WHERE id=?").bind(id).run()
})
afterEach(async () => { await desligarWorkflows(); vi.restoreAllMocks() })

const no = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, config })
const fluxo = (...blocks: unknown[]) => ({ nodes: [no('start', 'trigger'), no('menu', 'message', { blocks }), no('precos', 'message', { blocks: [text('Segue a tabela de preços.')] }), no('suporte', 'message', { blocks: [text('Chamando o suporte.')] })],
  edges: [{ from: 'start', port: 'next', to: 'menu' }, { from: 'menu', port: 'btn:v1', to: 'precos' }, { from: 'menu', port: 'btn:h1', to: 'suporte' }] }) as unknown as Graph
const listReply = (usuario: string, id: string, rowId: string, title: string) => canal.entregar(webhooksWhatsapp.envelope(sim.telefoneId, [{
  ...webhooksWhatsapp.clique(usuario, id, rowId, title), interactive: { type: 'list_reply', list_reply: { id: rowId, title, description: 'Mensal e anual' } } }], [], [webhooksWhatsapp.contato(usuario)]))

it('a lista chega à Meta no formato oficial e o toque numa linha segue pela saída dela', async () => {
  await publicarFluxo('whatsapp', fluxo(text('provisório')))
  await apiJson('PUT', 'automations/auto-a/draft', { graph: fluxo(text('Sobre o que você quer falar?'), list()) })
  await apiJson('POST', 'automations/auto-a/publish', undefined, 201)
  const r = await canal.mensagem(canal.usuario(1), 'quero', 1)
  await consumir(r.eventos)
  const enviadas = await esperarEnviadas(canal, 1, 'lista')
  const interactive = (enviadas[0].bruto as { interactive: { type: string; body: unknown; action: { button: string; sections: { title: string; rows: { id: string; title: string; description?: string }[] }[] } } }).interactive
  expect(interactive).toMatchObject({ type: 'list', body: { text: 'Sobre o que você quer falar?' }, action: { button: 'Ver assuntos' } })
  expect(interactive.action.sections.map(s => ({ title: s.title, rows: s.rows.map(x => [x.title, x.description]) }))).toEqual([
    { title: 'Vendas', rows: [['Preços', undefined], ['Planos', 'Mensal e anual']] }, { title: 'Ajuda', rows: [['Suporte', undefined]] }])
  const ids = interactive.action.sections.flatMap(s => s.rows.map(x => x.id))
  expect(ids.every(id => /^b:[a-f0-9]{24}$/.test(id))).toBe(true)   // o identificador da linha é o toque do motor, nunca o nome interno
  const suporte = interactive.action.sections[1].rows[0]
  const tap = await listReply(canal.usuario(1), 'wamid.IN000002', suporte.id, suporte.title)
  expect(tap.status).toBe(200)
  await consumir(tap.eventos)
  const depois = await esperarEnviadas(canal, 2, 'resposta da linha')
  expect(depois[1].texto).toBe('Chamando o suporte.')
  expect(canal.enviadas().map(e => e.texto)).not.toContain('Segue a tabela de preços.')
  const clique = await esperar('clique gravado', () => env.DB.prepare("SELECT button_id FROM node_events WHERE type='clicked'").all<{ button_id: string }>(), v => v.results.length > 0)
  expect(clique.results).toEqual([{ button_id: 'h1' }])
  const inbound = (await env.DB.prepare("SELECT content FROM messages WHERE direction='in'").all<{ content: string }>()).results.map(m => JSON.parse(m.content).text)
  expect(inbound).toContain('Suporte')
}, 90000)

it('a lista fica legível no inbox: corpo, botão e linhas, com as linhas como botões', async () => {
  await publicarFluxo('whatsapp', fluxo(text('provisório')))
  await apiJson('PUT', 'automations/auto-a/draft', { graph: fluxo(text('Sobre o que você quer falar?'), list()) })
  await apiJson('POST', 'automations/auto-a/publish', undefined, 201)
  const r = await canal.mensagem(canal.usuario(1), 'quero', 1)
  await consumir(r.eventos)
  await esperarEnviadas(canal, 1, 'lista')
  const gravada = await esperar('lista no inbox', () => env.DB.prepare("SELECT content FROM messages WHERE direction='out' AND json_extract(content,'$.sender')='automation'").all<{ content: string }>(),
    v => v.results.length > 0)
  const content = JSON.parse(gravada.results[0].content) as { text: string; buttons?: { title: string }[] }
  expect(content.text).toBe('Sobre o que você quer falar?\n\n[Ver assuntos]\nVendas\n• Preços\n• Planos: Mensal e anual\nAjuda\n• Suporte')
  expect(content.buttons?.map(b => b.title)).toEqual(['Preços', 'Planos', 'Suporte'])
}, 90000)
