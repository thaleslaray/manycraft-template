/**
 * Teste de contrato dos provedores de WhatsApp não oficial (UAZAPI e Z-API): o adaptador real contra erros do servidor (simulador) e contra
 * webhooks repetidos e fora de ordem. O que o produto DEVERIA fazer está afirmado aqui; se o código atual diverge, o teste fica vermelho
 * e o defeito vai para o relatório (não se conserta src por este arquivo).
 */
import { env } from 'cloudflare:workers'
import { expect } from 'vitest'
import { connectionRuntime } from '../../src/channels/core/runtime'
import type { SendResult } from '../../src/channels/types'
import type { InboundEvent } from '../../src/integrations'
import { consumir, esperarEnviadas, publicarFluxo, grafoDaJornada, sql, esperar, type Canal } from './jornada'
import type { Falha, Enviada } from './simuladores'

type Sim = { enviadas: Enviada[]; falhas: Falha[]; programar(f: Falha): unknown }
export type Descritor = {
  nome: string
  canal: Canal & { channelId: string; entregar(corpo: unknown, credencial?: string): Promise<{ status: number; eventos: InboundEvent[] }> }
  sim: Sim
  /** Quantas chamadas de ENVIO o servidor recebeu. */
  envios(): number
  /** O servidor passa a recusar o token/Secret Key; devolve a função que restaura. */
  invalidarCredencial(): () => void
  /** A instância/canal fica offline (celular desconectado); devolve a função que restaura. */
  derrubarInstancia(): () => void
  respostas: { limite(): Response; numeroInexistente(): Response; interno(): Response; gatewayRuim(): Response; proibido(): Response; recusaDoWhatsapp?(): Response }
  /** Corpo do webhook de recibo para a mensagem enviada de id externo `idExterno` (o servidor devolveu esse id no envio). */
  recibo(usuario: string, idExterno: string, estado: 'delivered' | 'read'): unknown
  /** Id que o servidor deu ao primeiro envio. */
  idPrimeiroEnvio(): string
  /** Endereço do contato como o provedor o conhece (JID na UAZAPI, telefone na Z-API). */
  endereco(usuario: string): string
  /** Credencial errada para a entrega do webhook. */
  credencialErrada: string
}

const alvo = (usuario: string) => ({ kind: 'direct' as const, externalUserId: usuario })
const texto = { kind: 'text' as const, text: 'Olá, teste de contrato' }

export async function contratoNaoOficial(d: Descritor) {
  const { canal, sim } = d
  const channelId = await canal.conectar()
  await publicarFluxo(canal.tipo, grafoDaJornada())
  const u = canal.usuario(1)

  // ───── Entrada: webhook com credencial errada nunca chega à fila
  const falso = await canal.entregar(await mensagemDe(canal, u, 'quero', 900), d.credencialErrada)
  expect.soft(falso.status, 'webhook com credencial errada').toBe(401)
  expect.soft(falso.eventos, 'webhook com credencial errada não pode entrar na fila').toHaveLength(0)

  // ───── Entrada: o mesmo webhook 2× (e 3×) cria UMA execução e UMA resposta
  const primeira = await canal.mensagem(u, 'quero', 1)
  expect(primeira.status).toBe(200)
  await consumir(primeira.eventos)
  await esperarEnviadas(canal, 1, 'primeira resposta')
  for (let i = 0; i < 2; i++) {
    const repetida = await canal.mensagem(u, 'quero', 1)
    expect(repetida.status, 'webhook duplicado deve ser aceito (200) para a UAZAPI/Omni não repetir').toBe(200)
    await consumir(repetida.eventos)
  }
  await new Promise(r => setTimeout(r, 200))
  expect(await sql.n("SELECT count(*) n FROM flow_runs WHERE channel_id=?", channelId), 'execuções depois de webhook duplicado').toBe(1)
  expect(sim.enviadas, 'mensagens enviadas depois de webhook duplicado').toHaveLength(1)
  expect(await sql.n("SELECT count(*) n FROM messages WHERE direction='in' AND connection_id=?", channelId), 'mensagens recebidas gravadas').toBe(1)

  // ───── Entrada: recibos fora de ordem (read antes de delivered) e repetidos
  const idExterno = d.idPrimeiroEnvio()
  const lerEstado = () => sql.um<{ delivery_status: string }>("SELECT delivery_status FROM messages WHERE direction='out' AND connection_id=? ORDER BY rowid LIMIT 1", channelId)
  const entregaRecibo = async (estado: 'delivered' | 'read') => {
    const r = await canal.entregar(d.recibo(u, idExterno, estado))
    expect(r.status, `recibo ${estado}`).toBe(200)
    const resultado = await consumir(r.eventos)
    expect.soft(resultado.retryMessages, `recibo ${estado} não deveria pedir nova tentativa`).toHaveLength(0)
  }
  await entregaRecibo('read')
  await entregaRecibo('delivered')   // chega depois do read
  await entregaRecibo('read')        // e o read de novo
  expect.soft((await lerEstado())?.delivery_status, 'um delivered tardio não pode desfazer o read').toBe('read')
  expect.soft(await sql.n("SELECT count(*) n FROM node_events WHERE type='read'"), 'eventos de leitura duplicados').toBeLessThanOrEqual(1)
  expect.soft(await sql.n("SELECT count(*) n FROM node_events WHERE type='delivered'"), 'eventos de entrega duplicados').toBeLessThanOrEqual(1)

  // ───── Saída: como cada erro do servidor é classificado
  const rt = await connectionRuntime(env as never, 'a', channelId, { requireConnected: true })
  const enviar = async (): Promise<{ r: SendResult; chamadas: number }> => {
    const antes = d.envios()
    const r = await rt.provider!.send({ connection: rt.connection, credentials: await rt.credentials(), fetch: (i, o) => fetch(i, o), env: env as never, intent: 'automation', target: alvo(d.endereco(u)) }, texto)
    return { r, chamadas: d.envios() - antes }
  }
  const falhar = (resposta: () => Response) => sim.programar({ quando: (_r, url) => /send\/|send-|\/messages$/.test(url.pathname), resposta })
  const rejeitado = (nome: string, r: SendResult, chamadas: number) => {
    expect.soft(r, `${nome}: deve ser rejeitado de vez`).toMatchObject({ ok: false, reason: 'rejected' })
    expect.soft(chamadas, `${nome}: não pode repetir o envio`).toBe(1)
  }
  const incerto = (nome: string, r: SendResult, chamadas: number) => {
    expect.soft(r, `${nome}: o resultado é incerto (a plataforma pode ter enviado)`).toMatchObject({ ok: false, reason: 'uncertain' })
    expect.soft(chamadas, `${nome}: não pode reenviar`).toBe(1)
  }
  { const volta = d.invalidarCredencial(); const { r, chamadas } = await enviar(); volta(); rejeitado('token/Secret Key inválido (401)', r, chamadas) }
  { falhar(d.respostas.proibido); const { r, chamadas } = await enviar(); rejeitado('sem permissão (403)', r, chamadas) }
  { const volta = d.derrubarInstancia(); const { r, chamadas } = await enviar(); volta(); rejeitado('instância/canal offline', r, chamadas) }
  { falhar(d.respostas.numeroInexistente); const { r, chamadas } = await enviar(); rejeitado('número que não está no WhatsApp', r, chamadas) }
  if (d.respostas.recusaDoWhatsapp) { falhar(d.respostas.recusaDoWhatsapp); const { r, chamadas } = await enviar(); rejeitado('o WhatsApp recusou o envio', r, chamadas) }
  { falhar(d.respostas.interno); const { r, chamadas } = await enviar(); incerto('erro 500 do servidor', r, chamadas) }
  { falhar(d.respostas.gatewayRuim); const { r, chamadas } = await enviar(); incerto('502 com corpo que não é JSON', r, chamadas) }
  { sim.programar({ quando: (_r, url) => /send\/|send-|\/messages$/.test(url.pathname), resposta: () => { throw new DOMException('The operation timed out.', 'TimeoutError') } })
    const { r, chamadas } = await enviar(); incerto('tempo esgotado', r, chamadas) }
  { falhar(d.respostas.limite); const { r, chamadas } = await enviar()
    expect.soft(r, '429: limite de taxa').toMatchObject({ ok: false, reason: 'rate_limited', retryAfterSec: 3 })
    expect.soft(chamadas, '429: uma chamada').toBe(1)
    const depois = await enviar()
    expect.soft(depois.r, 'depois do 429 a nova tentativa passa').toMatchObject({ ok: true }) }

  // ───── Saída pelo fluxo real: uma falha incerta (500) não reenvia a mensagem sozinha
  await new Promise(r => setTimeout(r, 1200))   // o limitador deixa 1 mensagem por segundo por conversa
  const u2 = canal.usuario(2)
  falhar(d.respostas.interno); sim.falhas.at(-1)!.vezes = 20
  const antes = d.envios()
  const segunda = await canal.mensagem(u2, 'quero', 2)
  await consumir(segunda.eventos)
  await esperar('execução do segundo contato', () => sql.um<{ status: string }>("SELECT status FROM flow_runs WHERE channel_id=? ORDER BY created_at DESC LIMIT 1", channelId), v => !!v && v.status !== 'running', 8000).catch(() => undefined)
  await new Promise(r => setTimeout(r, 1500))
  expect.soft(d.envios() - antes, 'o fluxo não pode reenviar depois de um 500 incerto').toBe(1)
  sim.falhas.length = 0
}

async function mensagemDe(canal: Canal, usuario: string, textoMsg: string, seq: number) {
  // Corpo cru da mesma mensagem, para entregar com credencial errada: pega-se o que o canal entregaria, sem passar pela fila.
  return canal.mensagem === undefined ? null : (await capturarCorpo(canal as never, usuario, textoMsg, seq))
}
async function capturarCorpo(canal: Canal & { entregar: (c: unknown, k?: string) => Promise<unknown> }, usuario: string, textoMsg: string, seq: number) {
  let corpo: unknown
  const original = canal.entregar
  canal.entregar = async (c: unknown) => { corpo = c; return { status: 200, eventos: [] } }
  try { await canal.mensagem(usuario, textoMsg, seq) } finally { canal.entregar = original as never }
  return corpo
}
