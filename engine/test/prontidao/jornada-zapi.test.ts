import { afterEach, beforeEach, it, vi } from 'vitest'
import { canalZapi } from './canal-zapi'
import { desligarWorkflows, jornadaPadrao, ligarWorkflows, prepararEspaco } from './jornada'
import { instalarRede } from './simuladores'
import { ZapiClassica, webhooksZapi, zapiErros } from './simulador-zapi'
import { contratoNaoOficial } from './contrato-whatsapp-naoficial'

let sim: ZapiClassica
beforeEach(async () => { await prepararEspaco(); sim = new ZapiClassica(); instalarRede(sim); await ligarWorkflows() })
afterEach(async () => { await desligarWorkflows(); vi.restoreAllMocks() })

it('[zapi] jornada: conectar por QR → fluxo → botão → condição → ação', async ({ task }) => {
  try { await jornadaPadrao(task, canalZapi(sim)) } catch (e) { console.log(JSON.stringify(task.meta.elos)); throw e }
}, 60000)

it('[zapi] contrato: erros do servidor, webhook duplicado e recibos fora de ordem', async () => {
  const canal = canalZapi(sim)
  const envios = () => sim.chamadas.filter(c => /\/send-[a-z-]+$/.test(c.caminho) && c.metodo === 'POST').length
  await contratoNaoOficial({
    nome: 'zapi', canal, sim, envios, endereco: u => u,
    invalidarCredencial: () => { const k = sim.clientToken; sim.clientToken = 'CLIENT-TOKEN-ROTACIONADO'; return () => { sim.clientToken = k } },
    derrubarInstancia: () => { sim.pareado = false; return () => { sim.pareado = true } },
    respostas: { limite: () => zapiErros.limite(3), numeroInexistente: zapiErros.numeroInexistente, interno: zapiErros.interno500, gatewayRuim: () => new Response('<html>', { status: 502 }), proibido: zapiErros.semPermissao },
    recibo: (u, id, estado) => webhooksZapi.estado(sim, u, id, estado === 'read' ? 'READ' : 'RECEIVED'),
    idPrimeiroEnvio: () => 'OUT1'.padEnd(32, '0'),
    credencialErrada: 'segredo-de-outra-conexao',
  })
}, 60000)
