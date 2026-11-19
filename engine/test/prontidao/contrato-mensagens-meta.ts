import { env } from 'cloudflare:workers'
import { expect } from 'vitest'
import { connectionRuntime } from '../../src/channels/core/runtime'
import type { SendResult } from '../../src/channels/types'
import { errosMensagens } from './simulador-meta-mensagens'
import type { SimuladorMensagens } from './simulador-meta-mensagens'
import type { Canal } from './jornada'

type Caso = { nome: string; resposta: () => Response; ok: (r: SendResult) => boolean; esperado: string }
const razao = (r: SendResult) => (r.ok ? 'ok' : r.reason)
const naoIncerto = (...razoes: string[]) => (r: SendResult) => !r.ok && razoes.includes(r.reason)

/**
 * Exercita o adaptador (provider.send) contra cada erro do simulador e junta TODAS as divergências antes de falhar.
 * `id` do canal já conectado; o envio vai direto ao adaptador do registro, com o fetch trocado pelo simulador.
 */
export async function contratoEnvio(canal: Canal, sim: SimuladorMensagens, channelId: string) {
  const rt = await connectionRuntime(env as never, 'a', channelId)
  const credentials = await rt.credentials()
  const usuario = canal.usuario(7)
  const enviar = () => rt.provider!.send({ connection: rt.connection, credentials, fetch: rt.fetch, intent: 'automation', target: { kind: 'direct', externalUserId: usuario } } as never, { kind: 'text', text: 'Oi, teste de contrato' })

  const feliz = await enviar()
  expect(feliz, 'envio normal deveria dar certo').toMatchObject({ ok: true })
  expect(sim.enviadas.at(-1)).toMatchObject({ para: usuario, texto: 'Oi, teste de contrato' })

  const casos: Caso[] = [
    { nome: 'token expirado (190)', resposta: errosMensagens.tokenExpirado, ok: naoIncerto('rejected'), esperado: 'rejected (nunca uncertain/rate_limited: repetir não adianta)' },
    { nome: 'limite da aplicação (4)', resposta: errosMensagens.limiteApp, ok: naoIncerto('rate_limited'), esperado: 'rate_limited' },
    { nome: 'limite por usuário (17)', resposta: errosMensagens.limiteUsuario, ok: naoIncerto('rate_limited'), esperado: 'rate_limited' },
    { nome: 'limite da página (32)', resposta: errosMensagens.limitePagina, ok: naoIncerto('rate_limited'), esperado: 'rate_limited' },
    { nome: 'limite personalizado (613)', resposta: errosMensagens.limite613, ok: naoIncerto('rate_limited'), esperado: 'rate_limited' },
    { nome: 'limite de uso de negócio (80002 Instagram / 80006 Messenger)', resposta: sim.nome.startsWith('instagram') ? errosMensagens.limiteInstagramBuc : errosMensagens.limiteMessengerBuc, ok: naoIncerto('rate_limited'), esperado: 'rate_limited' },
    { nome: 'HTTP 429 com Retry-After', resposta: errosMensagens.http429, ok: r => !r.ok && r.reason === 'rate_limited' && r.retryAfterSec === 3, esperado: 'rate_limited com retryAfterSec=3' },
    { nome: 'sem permissão (10)', resposta: errosMensagens.semPermissao, ok: naoIncerto('rejected'), esperado: 'rejected' },
    { nome: 'sem permissão (200)', resposta: errosMensagens.permissao200, ok: naoIncerto('rejected'), esperado: 'rejected' },
    { nome: 'usuário indisponível (551)', resposta: errosMensagens.usuarioIndisponivel, ok: naoIncerto('blocked'), esperado: 'blocked (o contato não recebe; não repetir)' },
    { nome: 'fora da janela de 24 h (10/2018278)', resposta: errosMensagens.foraDaJanela, ok: naoIncerto('outside_window'), esperado: 'outside_window' },
    { nome: 'parâmetro inválido (100)', resposta: errosMensagens.parametroInvalido, ok: naoIncerto('rejected'), esperado: 'rejected' },
    { nome: 'erro 500 do servidor', resposta: errosMensagens.interno, ok: naoIncerto('uncertain'), esperado: 'uncertain (resultado ambíguo: reconciliar)' },
  ]
  const divergencias: string[] = []
  for (const caso of casos) {
    const antes = sim.envios.length
    sim.programar({ resposta: caso.resposta })
    const r = await enviar()
    if (sim.envios.length !== antes + 1) divergencias.push(`${caso.nome}: o adaptador fez ${sim.envios.length - antes} chamadas (esperado 1; repetir às cegas é proibido)`)
    if (!caso.ok(r)) divergencias.push(`${caso.nome}: resultado ${JSON.stringify(r)} — esperado ${caso.esperado}`)
    else if (razao(r) === 'rejected' && !('code' in r && r.code)) divergencias.push(`${caso.nome}: rejected sem código`)
  }
  // Janela e bloqueio programados no estado do simulador (e não só como erro pontual).
  sim.janelaFechada.add(usuario)
  const j = await enviar()
  if (!naoIncerto('outside_window')(j)) divergencias.push(`janela fechada no simulador: ${JSON.stringify(j)} — esperado outside_window`)
  sim.janelaFechada.delete(usuario)
  expect(divergencias, 'DEFEITOS NOSSOS no adaptador:\n' + divergencias.join('\n')).toEqual([])
}
