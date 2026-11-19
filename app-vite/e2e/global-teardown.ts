import { existsSync, readFileSync, rmSync } from "node:fs"
import { WORKSPACE, api, limpezaSql, q, servidorNoAr, sql } from "./helpers"
import { impressaoAutomacoes } from "./guarda-automacoes"
import { ARQUIVO_GUARDA, ARQUIVO_INBOX } from "./global-setup"

// Varredura final: apaga só ids com prefixo e2e- (sobras de uma execução interrompida).
export default async function () {
  try {
    if (!(await servidorNoAr())) return
    sql(limpezaSql())
    if (!existsSync(ARQUIVO_GUARDA)) return
    const antes = readFileSync(ARQUIVO_GUARDA, "utf8")
    if (impressaoAutomacoes() !== antes) {
      throw new Error("As jornadas alteraram automações ou versões do banco de desenvolvimento. Jornadas só podem ler as automações existentes ou criar e apagar dados com prefixo e2e-.")
    }
    rmSync(ARQUIVO_GUARDA, { force: true })
  } finally {
    if (existsSync(ARQUIVO_INBOX)) {
      await api('/api/inbox/settings', { method: 'PUT', body: readFileSync(ARQUIVO_INBOX, "utf8") })
      rmSync(ARQUIVO_INBOX, { force: true })
    }
  }
}
