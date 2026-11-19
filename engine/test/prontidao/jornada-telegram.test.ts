import { afterEach, beforeEach, it, vi } from 'vitest'
import { canalTelegram } from './canal-telegram'
import { desligarWorkflows, jornadaPadrao, ligarWorkflows, prepararEspaco } from './jornada'
import { instalarRede, TelegramBot } from './simuladores'

let sim: TelegramBot
beforeEach(async () => { await prepararEspaco(); sim = new TelegramBot(); instalarRede(sim); await ligarWorkflows() })
afterEach(async () => { await desligarWorkflows(); vi.restoreAllMocks() })

it('[telegram] jornada: conectar → fluxo → botão → condição → ação', async ({ task }) => {
  await jornadaPadrao(task, canalTelegram(sim))
}, 60000)
