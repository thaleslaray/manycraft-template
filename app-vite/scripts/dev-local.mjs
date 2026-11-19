import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { mkdirSync, createWriteStream } from "node:fs"

const appDir = fileURLToPath(new URL("../", import.meta.url))
// Portas padrão 5173 (painel) e 8788 (engine); outras só quando outra sessão já usa essas (ex.: worktree em paralelo).
const panelPort = process.env.DEV_PANEL_PORT ?? "5173", enginePort = process.env.DEV_ENGINE_PORT ?? "8788"
const registryPath = process.env.DEV_REGISTRY_PATH ?? `${appDir}.wrangler/registry`
const logDir = `${appDir}.wrangler/logs`
mkdirSync(logDir, { recursive: true })
const engineArgs = ["dev", "--config", "../engine/wrangler.jsonc", "--env", "dev", "--name", "manycraft-engine", "--local", "--test-scheduled", "--port", enginePort, "--inspector-port", "0"]
if (process.env.DEV_STATE_PATH) engineArgs.push("--persist-to", process.env.DEV_STATE_PATH)
if (process.env.DEV_AUTH_URL) engineArgs.push("--var", `BETTER_AUTH_URL:${process.env.DEV_AUTH_URL}`)
if (process.env.DEV_PUBLIC_URL) engineArgs.push("--var", `PUBLIC_BASE_URL:${process.env.DEV_PUBLIC_URL}`)
// Provedores falsos locais (Graph API, UAZAPI...): o motor guarda esse endereço nas conexões novas em vez de falar com o provedor real.
// Ver o painel como outro papel no auto-login (viewer, livechat_agent...).
if (process.env.DEV_ROLE) engineArgs.push("--var", `DEV_ROLE:${process.env.DEV_ROLE}`)
// Padrão http://127.0.0.1:8799 no modo local (worktrees não têm engine/.dev.vars); DEV_PROVIDER_API_BASE=off ou vazio desliga.
const providerBase = process.env.DEV_PROVIDER_API_BASE ?? "http://127.0.0.1:8799"
if (providerBase && providerBase !== "off") engineArgs.push("--var", `DEV_PROVIDER_API_BASE:${providerBase}`)
const engineLogDir = fileURLToPath(new URL("../../.dev-logs/", import.meta.url))
mkdirSync(engineLogDir, { recursive: true })
// DEV_ENGINE_LOG troca o arquivo (ambientes paralelos das jornadas gravam cada um no seu).
const engineLog = createWriteStream(process.env.DEV_ENGINE_LOG ?? `${engineLogDir}engine.log`, { flags: "a" })
const processes = []
let closing = false
function stop(code = 0) {
  if (closing) return
  closing = true
  for (const child of processes) child.kill("SIGTERM")
  process.exitCode = code
}
function start(file, args, extraEnv = {}, tee = null) {
  const child = spawn(process.execPath, [file, ...args], {
    cwd: appDir, stdio: tee ? ["inherit", "pipe", "pipe"] : "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: logDir, WRANGLER_REGISTRY_PATH: registryPath, MINIFLARE_REGISTRY_PATH: registryPath, CHOKIDAR_USEPOLLING: process.env.CHOKIDAR_USEPOLLING ?? "1", ...extraEnv },
  })
  processes.push(child)
  if (tee) {
    child.stdout.on("data", d => { process.stdout.write(d); tee.write(d) })
    child.stderr.on("data", d => { process.stderr.write(d); tee.write(d) })
  }
  child.on("error", () => { console.error("Falha ao iniciar o ambiente local."); stop(1) })
  child.on("exit", code => { if (!closing) stop(code ?? 1) })
}
console.log(`Engine local + painel em http://localhost:${panelPort}. Configure e prepare o banco do engine antes de usar.`)
start("node_modules/wrangler/bin/wrangler.js", engineArgs, {}, engineLog)
start("node_modules/vite/bin/vite.js", ["--host", "127.0.0.1", "--port", panelPort, "--strictPort"], {}, engineLog)
process.on("SIGINT", () => stop())
process.on("SIGTERM", () => stop())
