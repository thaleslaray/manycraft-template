import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { ENGINE, PAINEL, WORKSPACE, api, consulta, servidorNoAr, sql } from "./helpers"
import { impressaoAutomacoes } from "./guarda-automacoes"

// Worktrees e ambientes paralelos (E2E_STATE_PATH, ver scripts/e2e-paralelo.mjs) usam bancos diferentes: uma suíte não pode sobrescrever a foto da outra.
const worktree = createHash("sha256").update(import.meta.dirname + (process.env.E2E_STATE_PATH ?? "")).digest("hex").slice(0, 16)
export const ARQUIVO_GUARDA = join(tmpdir(), `e2e-guarda-automacoes-${worktree}.json`)
export const ARQUIVO_INBOX = join(tmpdir(), `e2e-guarda-inbox-${worktree}.json`)

// As jornadas não podem mutar as automações de exemplo do banco de desenvolvimento
// (a w2-telegram-demo alimenta testes manuais com Telegram). Guarda a foto antes; o teardown compara.
// Ambiente errado derruba a suíte inteira em segundos, com uma mensagem só (em vez de dezenas de falhas depois de ~20 min).
async function exigirAmbiente() {
  const valores = `E2E_PAINEL=${PAINEL} E2E_ENGINE=${ENGINE} DEV_PROVIDER_API_BASE=${process.env.DEV_PROVIDER_API_BASE ?? "(não definida)"}`
  const aborta = (motivo: string) => { throw new Error(`Ambiente das jornadas inválido: ${motivo}. Valores atuais: ${valores}. Suba npm run dev:local (com DEV_PROVIDER_API_BASE) ou aponte E2E_PAINEL e E2E_ENGINE para o par de portas certo.`) }
  const responde = async (url: string, init: RequestInit = {}) => { try { return await fetch(url, { ...init, signal: AbortSignal.timeout(3000) }) } catch { return null } }
  if (!(await responde(PAINEL))) aborta(`o painel não responde em ${PAINEL}`)
  const catalogo = await responde(`${ENGINE}/api/connections/catalog`, { headers: { "x-workspace": WORKSPACE } })
  if (!catalogo) aborta(`o engine não responde em ${ENGINE}`)
  const dev = (await catalogo!.json().catch(() => ({}))) as { development?: { providerApiBase?: string } }
  if (!dev.development?.providerApiBase) aborta(`o engine em ${ENGINE} não tem development.providerApiBase (suba com DEV_PROVIDER_API_BASE)`)
  exigirMigracoes()
}

// Migração nova no código e banco local sem ela dá dezenas de falhas obscuras depois; aborta em segundos com a lista.
function exigirMigracoes() {
  const arquivos = readdirSync(resolve(import.meta.dirname, "../../engine/migrations")).filter(f => f.endsWith(".sql"))
  let aplicadas: Set<string>
  try { aplicadas = new Set(consulta<{ name: string }>("SELECT name FROM d1_migrations").map(r => r.name)) } catch { aplicadas = new Set() }
  const faltam = arquivos.filter(f => !aplicadas.has(f)).sort()
  if (faltam.length) throw new Error(`Migrações não aplicadas no banco local: ${faltam.join(", ")}. Rode: cd engine && npm run db:migrate`)
}

export default async function () {
  await exigirAmbiente()
  if (!(await servidorNoAr())) return
  writeFileSync(ARQUIVO_GUARDA, impressaoAutomacoes())
  // As jornadas partem do comportamento padrão; a preferência do dono volta no teardown.
  // Uma execução interrompida conserva a primeira foto para a próxima conseguir restaurá-la.
  if (!existsSync(ARQUIVO_INBOX)) writeFileSync(ARQUIVO_INBOX, JSON.stringify(await api('/api/inbox/settings')), { mode: 0o600 })
  const original = JSON.parse(readFileSync(ARQUIVO_INBOX, "utf8"))
  await api('/api/inbox/settings', { method: 'PUT', body: JSON.stringify({ ...original, new_message_behavior: 'any_message' }) })
}
