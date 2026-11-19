import { afterEach, beforeEach, it, vi } from 'vitest'
import { canalMessenger } from './canal-messenger'
import { contratoEnvio } from './contrato-mensagens-meta'
import { desligarWorkflows, jornadaPadrao, ligarWorkflows, prepararEspaco } from './jornada'
import { instalarRede } from './simuladores'
import { MessengerGraph } from './simulador-messenger'

let sim: MessengerGraph
beforeEach(async () => {
  await prepararEspaco()
  sim = new MessengerGraph()
  instalarRede(sim)
  await ligarWorkflows()
})
afterEach(async () => { await desligarWorkflows(); vi.restoreAllMocks() })

it('[messenger] jornada: conectar → fluxo → botão → condição → ação → mensagem final', async ({ task }) => {
  try { await jornadaPadrao(task, canalMessenger(sim)) } catch (e) { console.log(JSON.stringify(task.meta.elos)); throw e }
}, 60000)

it('[messenger] contrato: o adaptador classifica cada erro da Graph API de forma sensata', async () => {
  const canal = canalMessenger(sim)
  const id = await canal.conectar()
  await contratoEnvio(canal, sim, id)
}, 60000)
