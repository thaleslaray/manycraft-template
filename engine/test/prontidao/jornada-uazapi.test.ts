import { afterEach, beforeEach, it, vi } from 'vitest'
import { canalUazapi } from './canal-uazapi'
import { desligarWorkflows, jornadaPadrao, ligarWorkflows, prepararEspaco } from './jornada'
import { instalarRede } from './simuladores'
import { Uazapi, uazapiErros, webhooksUazapi } from './simulador-uazapi'
import { contratoNaoOficial } from './contrato-whatsapp-naoficial'

let sim: Uazapi
beforeEach(async () => { await prepararEspaco(); sim = new Uazapi(); instalarRede(sim); await ligarWorkflows() })
afterEach(async () => { await desligarWorkflows(); vi.restoreAllMocks() })

it('[uazapi] jornada: conectar por QR → fluxo → botão → condição → ação', async ({ task }) => {
  try { await jornadaPadrao(task, canalUazapi(sim)) } catch (e) { console.log(JSON.stringify(task.meta.elos)); throw e }
}, 60000)

it('[uazapi] contrato: erros do servidor, webhook duplicado e recibos fora de ordem', async () => {
  const canal = canalUazapi(sim)
  const envios = () => sim.chamadas.filter(c => c.caminho.startsWith('/send/')).length
  await contratoNaoOficial({
    nome: 'uazapi', canal, sim, envios, endereco: webhooksUazapi.jid,
    invalidarCredencial: () => { const t = sim.token; sim.token = 'TOKEN-ROTACIONADO'; return () => { sim.token = t } },
    derrubarInstancia: () => { sim.instancia.status = 'disconnected'; return () => { sim.instancia.status = 'connected' } },
    respostas: { limite: () => uazapiErros.limite(3), numeroInexistente: uazapiErros.numeroInexistente, interno: uazapiErros.generico500, gatewayRuim: uazapiErros.bruto502,
      proibido: () => Response.json({ error: 'Forbidden' }, { status: 403 }), recusaDoWhatsapp: uazapiErros.whatsappRecusou },
    recibo: (u, id, estado) => webhooksUazapi.recibo(sim, u, id, estado === 'read' ? 'Read' : 'Delivered'),
    idPrimeiroEnvio: () => 'OUT000001',
    credencialErrada: 'TOKEN-DE-OUTRA-INSTANCIA',
  })
}, 60000)
