import { afterEach, beforeEach, it, vi } from 'vitest'
import { canalWhatsapp, contaCheia } from './canal-whatsapp'
import { desligarWorkflows, jornadaPadrao, ligarWorkflows, prepararEspaco } from './jornada'
import { instalarRede, MetaGraph } from './simuladores'

let sim: MetaGraph
beforeEach(async () => {
  await prepararEspaco()
  sim = new MetaGraph()
  sim.modelos = contaCheia()
  sim.porPagina = 4   // força paginação (a conta tem 10 modelos)
  instalarRede(sim)
  await ligarWorkflows()
})
afterEach(async () => { await desligarWorkflows(); vi.restoreAllMocks() })

it('[whatsapp_cloud] jornada: conectar → sincronizar → fluxo → botão → condição → ação → transmissão com modelo', async ({ task }) => {
  try { await jornadaPadrao(task, canalWhatsapp(sim)) } catch (e) { console.log(JSON.stringify(task.meta.elos)); throw e }
}, 60000)
