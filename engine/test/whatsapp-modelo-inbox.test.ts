import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Graph } from '../src/contracts'
import { canalWhatsapp } from './prontidao/canal-whatsapp'
import { apiJson, consumir, desligarWorkflows, esperar, esperarEnviadas, ligarWorkflows, prepararEspaco, publicarFluxo } from './prontidao/jornada'
import { instalarRede, MetaGraph } from './prontidao/simuladores'

// O modelo enviado por uma automação aparece no inbox com o nome e o texto que o contato recebeu, com as variáveis preenchidas.
let sim: MetaGraph
let canal: ReturnType<typeof canalWhatsapp>
let channelId: string
beforeEach(async () => {
  await prepararEspaco()
  sim = new MetaGraph()
  instalarRede(sim)
  await ligarWorkflows()
  canal = canalWhatsapp(sim)
  channelId = await canal.conectar()
  await env.DB.prepare("UPDATE channels SET status='connected' WHERE id=?").bind(channelId).run()
})
afterEach(async () => { await desligarWorkflows(); vi.restoreAllMocks() })

const no = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, config })

it('o modelo da automação fica no inbox com o nome e o corpo renderizado', async () => {
  const workspace = (await env.DB.prepare('SELECT workspace_id FROM channels WHERE id=?').bind(channelId).first<{ workspace_id: string }>())!.workspace_id
  await env.DB.prepare(`INSERT INTO message_templates(id,workspace_id,channel_id,group_id,name_human,language_code,status,category,header_type,header_text,body,footer,buttons)
    VALUES ('tpl-pedido',?,?,'tpl-pedido','pedido_confirmado','pt_BR','approved','utility','text','Olá {{nome}}','Pedido {{pedido}} confirmado.','Equipe Horizonte',?)`)
    .bind(workspace, channelId, JSON.stringify([{ type: 'url', text: 'Abrir pedido', url: 'https://example.test/pedidos/{{codigo}}' }])).run()
  sim.modelos.push({ id: 'meta-pedido', name: 'pedido_confirmado', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY',
    components: [{ type: 'HEADER', format: 'TEXT', text: 'Olá {{nome}}' }, { type: 'BODY', text: 'Pedido {{pedido}} confirmado.' }] } as never)
  await publicarFluxo('whatsapp', { nodes: [no('start', 'trigger'), no('m', 'message', { blocks: [{ kind: 'text', text: 'provisório' }] })], edges: [{ from: 'start', port: 'next', to: 'm' }] } as unknown as Graph)
  await apiJson('PUT', 'automations/auto-a/draft', { graph: { nodes: [no('start', 'trigger'),
    no('tpl', 'template_message', { template_id: 'tpl-pedido', params: { pedido: '123', 'header:nome': 'Ana', 'button:0:codigo': 'X9' } }),
    no('depois', 'message', { blocks: [{ kind: 'text', text: 'Qualquer dúvida, responda aqui.' }] })],
  edges: [{ from: 'start', port: 'next', to: 'tpl' }, { from: 'tpl', port: 'next', to: 'depois' }] } })
  await apiJson('POST', 'automations/auto-a/publish', undefined, 201)
  const r = await canal.mensagem(canal.usuario(1), 'quero', 1)
  await consumir(r.eventos)
  await esperarEnviadas(canal, 1, 'modelo')
  const gravada = await esperar('modelo no inbox', () => env.DB.prepare("SELECT content FROM messages WHERE direction='out' AND json_extract(content,'$.sender')='automation'").all<{ content: string }>(),
    v => v.results.length > 0)
  expect(gravada.results.map(m => JSON.parse(m.content).text)).toContain('[Modelo: pedido_confirmado]\nOlá Ana\nPedido 123 confirmado.\nEquipe Horizonte\nAbrir pedido: https://example.test/pedidos/X9')
}, 30000)
