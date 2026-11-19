/**
 * Estresse: N contatos (padrão 1.000) mandam a mesma palavra-chave em poucos segundos, cada webhook chega duas vezes, e o fluxo tem
 * mensagem → espera → pergunta → resposta → mensagem final. O que se confere:
 *  - cada contato roda o fluxo exatamente uma vez;
 *  - nenhuma mensagem perdida ou duplicada (3 por contato, na ordem);
 *  - as filas drenam e não sobra envio pendente ou incerto;
 *  - nenhum erro de D1.
 * Os tempos (p50/p95) e as falhas vão para `task.meta.estresse`, de onde o relatório sai. Falha de contagem derruba o teste com a conta feita.
 */
import { afterEach, beforeEach, inject, it, vi } from 'vitest'
import { expect } from 'vitest'
import { canalWhatsapp, contaCheia } from './canal-whatsapp'
import { env } from 'cloudflare:workers'
import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { consumeInbound } from '../../src/jobs'
import { elo, esperar, grafoDoEstresse, prepararEspaco, publicarFluxo, sql } from './jornada'
import { instalarRede, MetaGraph } from './simuladores'
import type { InboundEvent } from '../../src/integrations'

declare module 'vitest' { interface ProvidedContext { prontidaoContatos?: number } }
const N = inject('prontidaoContatos') ?? 1000   // vitest.prontidao.config.ts (PRONTIDAO_CONTATOS)
const passo = (texto: string) => console.log(`[estresse] ${new Date().toISOString().slice(11, 19)} ${texto}`)
const LOTE = 50          // max_batch_size da fila (wrangler.jsonc)
const CONSUMIDORES = 5   // lotes processados ao mesmo tempo
const textos = ['Oi! Vou te fazer uma pergunta.', 'Qual é o seu e-mail?', 'Anotado, obrigado.']

let sim: MetaGraph
beforeEach(async () => {
  await prepararEspaco()
  sim = new MetaGraph(); sim.atrasoMs = 15
  instalarRede(sim)
  // Os tempos são os reais (espera de 1 s, limitador de 30 envios/s por canal): sem acelerar nada.
})
afterEach(() => { vi.restoreAllMocks() })

const percentil = (valores: number[], p: number) => { const o = [...valores].sort((a, b) => a - b); return o.length ? o[Math.min(o.length - 1, Math.ceil(p * o.length) - 1)] : 0 }
const resumo = (valores: number[]) => ({ n: valores.length, p50: Math.round(percentil(valores, 0.5)), p95: Math.round(percentil(valores, 0.95)), max: Math.round(Math.max(0, ...valores)) })
async function emParalelo<T>(itens: T[], limite: number, fn: (item: T) => Promise<void>) {
  let i = 0
  await Promise.all(Array.from({ length: limite }, async () => { while (i < itens.length) await fn(itens[i++]) }))
}

it(`[estresse] ${N} contatos, mesma palavra-chave, webhooks duplicados, fluxo com espera e pergunta`, async ({ task }) => {
  const canal = canalWhatsapp(sim)
  sim.modelos = contaCheia()
  const meta: Record<string, unknown> = (task.meta.estresse = { contatos: N })
  await elo(task, 'conectar e publicar fluxo', async () => { await canal.conectar(); await publicarFluxo('whatsapp', grafoDoEstresse()) })

  // 1) Webhooks: cada contato manda "quero"; cada entrega chega duas vezes (a Meta reenvia).
  const usuarios = Array.from({ length: N }, (_, i) => canal.usuario(i + 1))
  const fila: InboundEvent[] = []
  const aceite: number[] = []
  const inicio = Date.now()
  await elo(task, `${N} webhooks (cada um duplicado)`, async () => {
    await emParalelo(usuarios.flatMap((u, i) => [[u, i + 1], [u, i + 1]] as const), 40, async ([u, seq]) => {
      const t = performance.now()
      const r = await canal.mensagem(u, 'quero', seq)
      aceite.push(performance.now() - t)
      expect(r.status, 'o webhook deveria ser aceito').toBe(200)
      fila.push(...r.eventos)
    })
  })
  passo(`webhooks aceitos: ${fila.length} eventos`)
  meta.webhooks = { ...resumo(aceite), entregas: aceite.length, eventosNaFila: fila.length, segundos: +((Date.now() - inicio) / 1000).toFixed(1) }

  // 2) A fila drena em lotes, vários consumidores; o que pedir nova tentativa volta ao fim.
  const lotes = async (eventos: InboundEvent[], rotulo: string) => {
    const duracoes: number[] = []
    let pendentes = eventos, rodadas = 0, tentativas = 0
    while (pendentes.length && rodadas++ < 12) {
      const partes: InboundEvent[][] = []
      for (let i = 0; i < pendentes.length; i += LOTE) partes.push(pendentes.slice(i, i + LOTE))
      const voltaram: InboundEvent[] = []
      await emParalelo(partes, CONSUMIDORES, async parte => {
        const t = performance.now()
        const batch = createMessageBatch('inbound', parte.map((body, k) => ({ id: `m${k}`, timestamp: new Date(), attempts: 1, body })))
        await consumeInbound(batch, env)
        const resultado = await getQueueResult(batch, createExecutionContext())
        duracoes.push(performance.now() - t)
        const ids = new Set(resultado.retryMessages.map((m: { msgId: string }) => m.msgId))
        tentativas += ids.size
        voltaram.push(...parte.filter((_, k) => ids.has(`m${k}`)))
      })
      pendentes = voltaram
    }
    meta[rotulo] = { lotes: resumo(duracoes), novasTentativas: tentativas, rodadas, restantes: pendentes.length }
    expect(pendentes.length, `${rotulo}: eventos que nunca foram aceitos pelo consumidor`).toBe(0)
  }
  await elo(task, 'fila de entrada drena', () => lotes(fila, 'consumo'))
  passo('fila de entrada drenada')

  // 3) Todos chegam na pergunta: 2 mensagens por contato (oi + pergunta).
  const enviadasDe = (texto: string) => sim.enviadas.filter(e => e.texto === texto).length
  const t0 = Date.now()
  const alcancou = async (texto: string) => esperar(`${N} contatos receberem "${texto}" (hoje ${enviadasDe(texto)})`, async () => enviadasDe(texto), v => v >= N, 180_000).then(() => true, () => false)
  const vistoOi = await alcancou(textos[0]), vistoPergunta = await alcancou(textos[1])
  passo(`pergunta: oi=${enviadasDe(textos[0])} pergunta=${enviadasDe(textos[1])}`)
  meta.ateAPergunta = { segundos: +((Date.now() - t0) / 1000).toFixed(1), oi: enviadasDe(textos[0]), pergunta: enviadasDe(textos[1]) }

  // 4) Todos respondem a pergunta; a fila drena de novo.
  const respostas: InboundEvent[] = []
  await emParalelo(usuarios.map((u, i) => [u, i + 1] as const), 40, async ([u, seq]) => {
    const r = await canal.mensagem(u, `pessoa${seq}@exemplo.com`, N + seq)
    expect(r.status).toBe(200)
    respostas.push(...r.eventos)
  })
  await elo(task, 'respostas drenam', () => lotes(respostas, 'consumoRespostas'))
  passo('respostas drenadas')
  const vistoFinal = await alcancou(textos[2])
  passo(`final=${enviadasDe(textos[2])}`)

  // As últimas execuções ainda terminam depois da última mensagem: espera elas assentarem (até 60 s) antes de conferir.
  await esperar('execuções assentarem', () => sql.n("SELECT count(*) n FROM flow_runs WHERE workspace_id='a' AND status NOT IN ('done','failed','cancelled')"), v => v === 0, 60_000).catch(() => undefined)

  // 5) Conferência (as contas vão para o relatório mesmo se algo falhar).
  const porContato = new Map<string, string[]>()
  for (const e of sim.enviadas) porContato.set(e.para, [...(porContato.get(e.para) ?? []), e.texto])
  const incompletos = [...porContato.entries()].filter(([, t]) => t.join('|') !== textos.join('|'))
  const duplicados = sim.enviadas.length - new Set(sim.enviadas.map(e => `${e.para}|${e.texto}`)).size
  const semMensagem = usuarios.filter(u => !porContato.has(u)).length
  const saidas = await sql.todas<{ status: string; n: number }>("SELECT status, count(*) n FROM flow_outbound GROUP BY status")
  const execucoes = await sql.todas<{ status: string; n: number }>("SELECT status, count(*) n FROM flow_runs WHERE workspace_id='a' GROUP BY status")
  const falhas = await sql.n("SELECT count(*) n FROM messages WHERE direction='out' AND delivery_status='failed'")
  const naoProcessados = await sql.n("SELECT count(*) n FROM inbound_events WHERE processed_at IS NULL")
  const campos = await sql.n("SELECT count(*) n FROM contact_field_values WHERE field_id='field-a' AND contact_id IN (SELECT contact_id FROM flow_runs WHERE workspace_id='a')")
  meta.conferencia = { contatosComMensagem: porContato.size, mensagensEnviadas: sim.enviadas.length, esperadas: 3 * N, duplicadas: duplicados, contatosSemNenhuma: semMensagem,
    contatosComSequenciaErrada: incompletos.length, exemploSequenciaErrada: incompletos.slice(0, 3), saidasPorEstado: saidas, execucoesPorEstado: execucoes, mensagensComFalha: falhas,
    eventosNaoProcessados: naoProcessados, campoGravado: campos, chamadasLimitadas: sim.chamadas.length, perguntaVista: vistoPergunta, oiVisto: vistoOi, finalVisto: vistoFinal }
  const totalExecucoes = execucoes.reduce((s, e) => s + e.n, 0)
  expect.soft(totalExecucoes, 'cada contato roda o fluxo exatamente uma vez').toBe(N)
  expect.soft(duplicados, 'mensagens duplicadas').toBe(0)
  expect.soft(semMensagem, 'contatos que não receberam nada').toBe(0)
  expect.soft(incompletos.length, `contatos sem a sequência completa [${textos.join(' → ')}]: ${JSON.stringify(incompletos.slice(0, 2))}`).toBe(0)
  expect.soft(saidas.filter(s => s.status !== 'sent').reduce((a, s) => a + s.n, 0), 'envios que não terminaram como enviados').toBe(0)
  expect.soft(execucoes.filter(e => e.status !== 'done').reduce((a, e) => a + e.n, 0), 'execuções que não terminaram').toBe(0)
  expect.soft(naoProcessados, 'eventos de entrada sem processar').toBe(0)
  expect.soft(campos, 'respostas gravadas no campo').toBe(N)
}, 900_000)
