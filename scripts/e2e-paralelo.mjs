#!/usr/bin/env node
// Jornadas no navegador em N ambientes isolados ao mesmo tempo (padrão 3; E2E_AMBIENTES=N).
// Cada ambiente: banco novo (db:e2e) em .dev-logs/e2e-amb-<i>/estado, painel, motor, provedor falso e registro próprios.
// Reparte as jornadas pelo tempo medido na rodada anterior (scripts/e2e-divisao.mjs; sem medida, 15 s por teste) e roda cada parte
// com `--test-list` num ambiente (sem conseguir listar, cai no `--shard=i/N`), junta os relatórios (blob + merge-reports) e derruba tudo no fim, inclusive em erro ou Ctrl+C.
// Uso: node scripts/e2e-paralelo.mjs [specs e opções extras do playwright]   (segura a trava de testes a rodada inteira)
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { createServer } from "node:net"
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join, resolve } from "node:path"
import { acquireTestLock } from "./test-lock.mjs"
import { contarGrupos, dividir, duracoesDoRelatorio, listaDeTestes } from "./e2e-divisao.mjs"

const root = resolve(fileURLToPath(import.meta.url), "../..")
const app = join(root, "app-vite"), engine = join(root, "engine")
const N = Math.max(1, Number.parseInt(process.env.E2E_AMBIENTES ?? "3", 10) || 3)
const BASE = { painel: Number(process.env.E2E_PORTA_PAINEL ?? 5400), motor: Number(process.env.E2E_PORTA_MOTOR ?? 8900), provedor: Number(process.env.E2E_PORTA_PROVEDOR ?? 8950) }
const extras = process.argv.slice(2)
// --last-failed: a lista juntada da rodada anterior (e2e/.resultados) vai numa cópia por ambiente, porque o Playwright
// também grava o resultado no arquivo do --last-failed-file (um ambiente apagaria o do outro).
const ULTIMA = join(app, "e2e/.resultados/.last-run.json")
const soFalhas = extras.includes("--last-failed") && !extras.some(a => a.startsWith("--last-failed-file"))
const ultimaDoAmbiente = a => join(a.dir, soFalhas ? "ultima-rodada.json" : "resultados/.last-run.json")
const PRONTO_MS = Number(process.env.E2E_PRONTO_MS ?? 180_000)
const t0 = Date.now()
const seg = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`
const log = m => console.log(`[paralelo ${seg()}] ${m}`)
// Durações da última rodada, por arquivo e projeto; no diretório comum do git, vale para todas as worktrees.
const comum = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim()
const ARQ_DURACOES = resolve(root, comum, "e2e-duracoes.json")
const lerJson = (arq, padrao) => { try { return JSON.parse(readFileSync(arq, "utf8")) } catch { return padrao } }

const ambientes = Array.from({ length: N }, (_, k) => {
  const i = k + 1, dir = join(root, ".dev-logs", `e2e-amb-${i}`)
  const portas = { painel: BASE.painel + i, motor: BASE.motor + i, provedor: BASE.provedor + i }
  return {
    i, dir, portas, estado: join(dir, "estado"),
    painel: `http://localhost:${portas.painel}`, motor: `http://localhost:${portas.motor}`, provedor: `http://127.0.0.1:${portas.provedor}`,
    servidor: null, shard: null,
  }
})

// Derrubar: o dev:local sobe em grupo de processos próprio (vite, wrangler, workerd); mata o grupo inteiro.
const grupos = new Set()
function derrubar() {
  for (const pid of grupos) { try { process.kill(-pid, "SIGTERM") } catch {} }
  grupos.clear()
}
process.on("exit", derrubar)
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => { log(`${s}: derrubando os ambientes`); derrubar(); process.exit(130) })

const portaLivre = porta => new Promise(ok => {
  const s = createServer().once("error", () => ok(false)).once("listening", () => s.close(() => ok(true)))
  s.listen(porta, "127.0.0.1")
})
const esperar = ms => new Promise(r => setTimeout(r, ms))
const rodar = (cmd, args, { saida, ...opts }) => new Promise(ok => {
  const f = spawn(cmd, args, opts)
  if (saida) { f.stdout.on("data", d => saida.write(d)); f.stderr.on("data", d => saida.write(d)) }
  f.on("error", e => ok({ status: 127, erro: e.message }))
  f.on("close", status => ok({ status: status ?? 1 }))
})
const ultimas = (arquivo, n = 25) => { try { return readFileSync(arquivo, "utf8").trimEnd().split("\n").slice(-n).join("\n") } catch { return "(sem log)" } }

async function preparar(a) {
  rmSync(a.dir, { recursive: true, force: true })
  mkdirSync(a.dir, { recursive: true })
  for (const [nome, porta] of Object.entries(a.portas)) {
    if (!(await portaLivre(porta))) throw new Error(`ambiente ${a.i}: porta ${porta} (${nome}) ocupada; mude E2E_PORTA_${nome.toUpperCase()} ou feche o que usa a porta`)
  }
  // Cache de dependências do Vite já aquecido (cópia barata no APFS), um por ambiente.
  const cache = join(app, "node_modules/.vite")
  if (existsSync(cache)) cpSync(cache, join(a.dir, "vite-cache"), { recursive: true })
  const saida = createWriteStream(join(a.dir, "db-e2e.log"))
  const r = await rodar("npm", ["run", "db:e2e"], { cwd: engine, env: { ...process.env, DEV_STATE_PATH: a.estado }, stdio: ["ignore", "pipe", "pipe"], saida })
  await new Promise(r => saida.end(r))
  if (r.status !== 0) throw new Error(`ambiente ${a.i}: db:e2e falhou\n${ultimas(join(a.dir, "db-e2e.log"))}`)
}

function subir(a) {
  const saida = createWriteStream(join(a.dir, "servidor.log"), { flags: "a" })
  a.servidorCaiu = false
  const f = spawn("npm", ["run", "dev:local"], {
    cwd: app, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DEV_PANEL_PORT: String(a.portas.painel), DEV_ENGINE_PORT: String(a.portas.motor), DEV_STATE_PATH: a.estado,
      DEV_REGISTRY_PATH: join(a.dir, "registro"), DEV_PROVIDER_API_BASE: a.provedor, DEV_PUBLIC_URL: a.motor, DEV_AUTH_URL: a.painel,
      DEV_VITE_CACHE_DIR: join(a.dir, "vite-cache"), DEV_VITE_STATE_PATH: join(a.dir, "estado-painel"), DEV_ENGINE_LOG: join(a.dir, "motor.log"),
    },
  })
  f.stdout.pipe(saida); f.stderr.pipe(saida)
  grupos.add(f.pid)
  a.servidor = f
  f.on("exit", () => { if (a.servidor === f) a.servidorCaiu = true })
}

// Um servidor que cai ao subir (ex.: porta disputada por outro processo naquele instante) ganha uma segunda chance.
async function subirAtePronto(a) {
  subir(a)
  try { await pronto(a) } catch (e) {
    if (!a.servidorCaiu) throw e
    log(`ambiente ${a.i}: o servidor caiu ao subir; tentando de novo (${String(e.message).split("\n").at(-1)})`)
    subir(a)
    await pronto(a)
  }
}

// Pronto = painel 200 e o motor expõe o provedor falso deste ambiente (não o do .dev.vars nem o de outro ambiente).
async function pronto(a) {
  const limite = Date.now() + PRONTO_MS
  let motivo = "sem resposta"
  while (Date.now() < limite) {
    if (a.servidorCaiu) throw new Error(`ambiente ${a.i}: o servidor saiu antes de ficar pronto\n${ultimas(join(a.dir, "servidor.log"))}`)
    try {
      const painel = await fetch(a.painel, { signal: AbortSignal.timeout(3000) })
      const cat = await fetch(`${a.motor}/api/connections/catalog`, { headers: { "x-workspace": "demo-workspace" }, signal: AbortSignal.timeout(3000) })
      const base = cat.ok ? (await cat.json()).development?.providerApiBase : undefined
      if (painel.status === 200 && base === a.provedor) return
      motivo = `painel ${painel.status}, motor ${cat.status}, providerApiBase ${base ?? "(nenhum)"} (esperado ${a.provedor})`
      if (painel.status === 200 && base && base !== a.provedor) throw new Error(`ambiente ${a.i}: o motor usa o provedor ${base}, não ${a.provedor} (DEV_PROVIDER_API_BASE do engine/.dev.vars venceu o --var?)`)
    } catch (e) { if (String(e.message).startsWith(`ambiente ${a.i}`)) throw e }
    await esperar(1000)
  }
  throw new Error(`ambiente ${a.i}: não ficou pronto em ${PRONTO_MS / 1000}s (${motivo})\n${ultimas(join(a.dir, "servidor.log"))}`)
}

function rodarShard(a) {
  if (a.lista && !a.lista.grupos.length) return Promise.resolve(0)
  const saida = createWriteStream(join(a.dir, "jornadas.log"))
  let parte = `--shard=${a.i}/${N}`
  if (a.lista) { parte = `--test-list=${join(a.dir, "lista.txt")}`; writeFileSync(join(a.dir, "lista.txt"), listaDeTestes(a.lista.grupos)) }
  const args = ["playwright", "test", "-c", "e2e/playwright.config.ts", parte, "--reporter=blob,list", ...extras]
  if (soFalhas) {
    const copia = ultimaDoAmbiente(a) // fora da pasta de resultados, que o Playwright limpa ao começar
    if (existsSync(ULTIMA)) copyFileSync(ULTIMA, copia)
    args.push(`--last-failed-file=${copia}`)
  }
  const f = spawn("npx", args, {
    cwd: app, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, E2E_PAINEL: a.painel, E2E_ENGINE: a.motor, E2E_STATE_PATH: a.estado, DEV_PROVIDER_API_BASE: a.provedor,
      E2E_SAIDA: join(a.dir, "resultados"), PLAYWRIGHT_BLOB_OUTPUT_DIR: join(a.dir, "blob"), FORCE_COLOR: "0",
    },
  })
  a.feitos = 0
  let resto = ""
  const contar = d => {
    const linhas = (resto + d.toString()).split("\n")
    resto = linhas.pop()
    a.feitos += linhas.filter(l => /^\s*[✓✘-]\s+\d+ /.test(l)).length
  }
  f.stdout.on("data", d => { saida.write(d); contar(d) })
  f.stderr.on("data", d => saida.write(d))
  return new Promise(ok => f.on("close", status => ok(status ?? 1)))
}

// Lista o que vai rodar (com os filtros extras) e reparte entre os ambientes; null = usar --shard.
function planejar() {
  const r = spawnSync("npx", ["playwright", "test", "-c", "e2e/playwright.config.ts", "--list", "--reporter=json", ...extras, ...(soFalhas ? [`--last-failed-file=${ULTIMA}`] : [])], { cwd: app, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
  let lista
  try { lista = JSON.parse(r.stdout) } catch { log(`não consegui listar as jornadas (saída ${r.status}); divido com --shard`); return null }
  const caixas = dividir(contarGrupos(lista), lerJson(ARQ_DURACOES, {}), N)
  log(`divisão por tempo medido: ${caixas.map((c, k) => `amb${k + 1} ~${Math.round(c.segundos)}s (${c.grupos.length} grupos)`).join(", ")}`)
  return caixas
}

// Só rodada de arquivos inteiros mede o grupo (com --last-failed, -g ou spec:linha o tempo seria de uma parte dele).
function gravarDuracoes(arqRelatorio) {
  if (extras.some(a => a.startsWith("-") || /:\d+$/.test(a))) return
  const novas = duracoesDoRelatorio(lerJson(arqRelatorio, {}))
  if (Object.keys(novas).length) writeFileSync(ARQ_DURACOES, JSON.stringify({ ...lerJson(ARQ_DURACOES, {}), ...novas }, null, 1))
}

// Junta os .last-run.json dos ambientes no padrão (e2e/.resultados), para `npm run e2e -- --last-failed` repetir só as que falharam.
function juntarUltimaRodada() {
  const falhas = new Set()
  let algum = false
  for (const a of ambientes) {
    try { const j = JSON.parse(readFileSync(ultimaDoAmbiente(a), "utf8")); algum = true; for (const t of j.failedTests ?? []) falhas.add(t) } catch {}
  }
  if (!algum) return 0
  mkdirSync(join(app, "e2e/.resultados"), { recursive: true })
  writeFileSync(ULTIMA, JSON.stringify({ status: falhas.size ? "failed" : "passed", failedTests: [...falhas] }, null, 2))
  return falhas.size
}

let release = () => {}
let codigo = 1
try {
  // E2E_SO_SUBIR=1 só sobe e confere os ambientes (sem jornadas, sem trava): para diagnosticar o ambiente.
  const soSubir = process.env.E2E_SO_SUBIR === "1"
  if (process.env.E2E_TRAVA_JA_SEGURA !== "1" && !soSubir) release = await acquireTestLock()
  log(`${N} ambientes: ${ambientes.map(a => `${a.i}=painel ${a.portas.painel}/motor ${a.portas.motor}/provedor ${a.portas.provedor}`).join(", ")}`)
  const plano = planejar()
  if (plano) ambientes.forEach((a, k) => { a.lista = plano[k] })
  await Promise.all(ambientes.map(preparar))
  log("bancos prontos; subindo os servidores")
  await Promise.all(ambientes.map(subirAtePronto))
  if (soSubir) { log("ambientes no ar (E2E_SO_SUBIR=1: sem jornadas)"); codigo = 0; throw null }
  log(`ambientes no ar; rodando ${N} partes (saída de cada um em .dev-logs/e2e-amb-<i>/jornadas.log)`)
  const tShards = Date.now()
  const progresso = setInterval(() => log(ambientes.map(a => `amb${a.i}: ${a.feitos ?? 0}`).join(" | ")), 30_000)
  const status = await Promise.all(ambientes.map(rodarShard))
  clearInterval(progresso)
  log(`partes terminaram em ${((Date.now() - tShards) / 1000).toFixed(0)}s: ${status.map((s, k) => `amb${k + 1}=${s}`).join(" ")}`)
  // Shard que saiu sem blob (ex.: global-setup abortou) mostra o fim do log dele.
  const juntar = join(root, ".dev-logs/e2e-blobs")
  rmSync(juntar, { recursive: true, force: true }); mkdirSync(juntar, { recursive: true })
  for (const a of ambientes) {
    const blobs = existsSync(join(a.dir, "blob")) ? readdirSync(join(a.dir, "blob")).filter(f => f.endsWith(".zip")) : []
    if (!blobs.length) console.error(`\nambiente ${a.i} não gerou relatório:\n${ultimas(join(a.dir, "jornadas.log"), 40)}`)
    for (const b of blobs) copyFileSync(join(a.dir, "blob", b), join(juntar, `amb${a.i}-${b}`))
  }
  const relatorio = join(juntar, "relatorio.json")
  const merge = await rodar("npx", ["playwright", "merge-reports", "--reporter=list,json", juntar], { cwd: app, stdio: "inherit", env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: relatorio } })
  gravarDuracoes(relatorio)
  const falhas = juntarUltimaRodada()
  codigo = status.every(s => s === 0) && merge.status === 0 ? 0 : 1
  log(`rodada paralela ${codigo === 0 ? "ok" : `FALHOU (${falhas} jornada(s) falharam)`} em ${seg()}`)
} catch (e) {
  if (e !== null) { console.error(`\n[paralelo] ${e.message}`); codigo = 1 }
} finally {
  derrubar()
  release()
}
// Dá tempo aos servidores de fecharem antes de sair (o grupo já recebeu SIGTERM).
await Promise.race([Promise.all(ambientes.filter(a => a.servidor && !a.servidorCaiu).map(a => new Promise(r => a.servidor.once("exit", r)))), esperar(5000)])
for (const a of ambientes) rmSync(join(a.dir, "vite-cache"), { recursive: true, force: true })
process.exit(codigo)
