import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Graph } from '../src/contracts'
import { canalWhatsapp } from './prontidao/canal-whatsapp'
import { apiJson, consumir, desligarWorkflows, esperar, esperarEnviadas, ligarWorkflows, prepararEspaco, publicarFluxo } from './prontidao/jornada'
import { instalarRede, MetaGraph } from './prontidao/simuladores'

// O fluxo roda de ponta a ponta contra o simulador da Graph API: o que a Meta recebe é o carrossel (galeria) ou a mídia com botão (cartão único).
let sim: MetaGraph
let canal: ReturnType<typeof canalWhatsapp>
beforeEach(async () => {
  await prepararEspaco()
  sim = new MetaGraph()
  instalarRede(sim)
  await ligarWorkflows()
  canal = canalWhatsapp(sim)
  const id = await canal.conectar()
  await env.DB.prepare("UPDATE channels SET status='connected' WHERE id=?").bind(id).run()   // o webhook manual já chegou
})
afterEach(async () => { await desligarWorkflows(); vi.restoreAllMocks() })

const no = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, config })
const grafo = (...blocks: unknown[]) => ({ nodes: [no('start', 'trigger'), no('vitrine', 'message', { blocks })], edges: [{ from: 'start', port: 'next', to: 'vitrine' }] }) as unknown as Graph
const card = (n: number) => ({ title: `Planta ${n}`, subtitle: 'Fácil de cuidar', imageUrl: `https://media.example.test/${n}.png`, buttons: [{ type: 'url', title: 'Comprar', url: `https://loja.example.test/${n}` }] })
async function rodar(g: Graph) {
  await publicarFluxo('whatsapp', grafo({ kind: 'text', text: 'provisório' }))   // a palavra-chave cria o gatilho; a vitrine só publica com a conexão do gatilho conhecida
  await apiJson('PUT', 'automations/auto-a/draft', { graph: g })
  await apiJson('POST', 'automations/auto-a/publish', undefined, 201)
  const r = await canal.mensagem(canal.usuario(1), 'quero', 1)
  expect(r.status).toBe(200)
  await consumir(r.eventos)
}

it('texto mais galeria chega à Meta como um único carrossel, com o texto como abertura', async () => {
  await rodar(grafo({ kind: 'text', text: 'Veja as novidades, {{first_name|amigo}}:' }, { kind: 'gallery', aspectRatio: 'horizontal', cards: [card(1), card(2)] }))
  const enviadas = await esperarEnviadas(canal, 1, 'carrossel')
  await new Promise(r => setTimeout(r, 300))
  expect(canal.enviadas()).toHaveLength(1)   // o texto não sai sozinho
  expect(enviadas[0].bruto).toEqual({ messaging_product: 'whatsapp', recipient: canal.usuario(1), type: 'interactive', interactive: { type: 'carousel',
    body: { text: expect.stringMatching(/^Veja as novidades, .+:$/) }, action: { cards: [1, 2].map((n, card_index) => ({ card_index, type: 'cta_url',
      header: { type: 'image', image: { link: `https://media.example.test/${n}.png` } }, body: { text: `Planta ${n}\nFácil de cuidar` },
      action: { name: 'cta_url', parameters: { display_text: 'Comprar', url: `https://loja.example.test/${n}` } } })) } } })
}, 30000)

it('a galeria com botões de resposta fica legível no inbox: abertura, cartões e botões', async () => {
  const resposta = (n: number) => ({ ...card(n), buttons: [{ type: 'postback', title: `Quero ${n}`, id: `q${n}` }] })
  await rodar(grafo({ kind: 'text', text: 'Conheça nossos cursos:' }, { kind: 'gallery', aspectRatio: 'horizontal', cards: [resposta(1), resposta(2)] }))
  await esperarEnviadas(canal, 1, 'carrossel')
  const gravada = await esperar('galeria no inbox', () => env.DB.prepare("SELECT content FROM messages WHERE direction='out' AND json_extract(content,'$.sender')='automation'").all<{ content: string }>(),
    v => v.results.length > 0)
  const content = JSON.parse(gravada.results[0].content) as { text: string; buttons?: { title: string }[] }
  expect(content.text).toBe('Conheça nossos cursos:\n\nPlanta 1 · Fácil de cuidar\nPlanta 2 · Fácil de cuidar')
  expect(content.buttons?.map(b => b.title)).toEqual(['Quero 1', 'Quero 2'])
}, 30000)

it('cartão único chega como botão de link com cabeçalho de imagem', async () => {
  await rodar(grafo({ kind: 'card', aspectRatio: 'horizontal', cards: [card(1)] }))   // o cartão único não precisa de texto antes
  const enviadas = await esperarEnviadas(canal, 1, 'cartão')
  expect(enviadas[0].bruto).toMatchObject({ type: 'interactive', interactive: { type: 'cta_url', header: { type: 'image', image: { link: 'https://media.example.test/1.png' } },
    body: { text: 'Planta 1\nFácil de cuidar' }, action: { name: 'cta_url', parameters: { display_text: 'Comprar', url: 'https://loja.example.test/1' } } } })
}, 30000)
