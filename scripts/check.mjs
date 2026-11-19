#!/usr/bin/env node
// Check único. Uso: npm run check
// As etapas rápidas e determinísticas (features.csv, migrações, scripts, vazamentos, typechecks) param no primeiro erro;
// testes do motor, testes do painel e jornadas rodam todos mesmo que um falhe, e cada um repete UMA vez só o que falhou
// antes de dar a etapa como falha (o que passa na repetição sai como "instável:" no resumo).
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { readFileSync, writeFileSync, readdirSync, mkdirSync, createWriteStream, rmSync } from "node:fs"
import { cpus, homedir } from "node:os"
import { acquireTestLock } from "./test-lock.mjs"
import { avisoMaquina, falhasNodeTest, falhasPlaywright, falhasVitest, montarResumo, processosAlheios } from "./check-repetir.mjs"

const root = resolve(fileURLToPath(import.meta.url), "../..")

// Toda a saída vai também para .dev-logs/check.log (sobrescrito a cada rodada): acompanhe por lá, sem `| tail`.
mkdirSync(resolve(root, ".dev-logs"), { recursive: true })
const log = createWriteStream(resolve(root, ".dev-logs/check.log"))
const semCor = t => t.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
for (const nivel of ["log", "error"]) {
  const orig = console[nivel].bind(console)
  console[nivel] = (...a) => { orig(...a); log.write(semCor(a.join(" ")) + "\n") }
}
// Roda uma etapa repassando a saída ao terminal e ao log à medida que chega; `guardar` junta a saída (para achar o que falhou).
// Etapas lentas rodando juntas: cada linha sai com o `prefixo` da etapa (ex.: "[motor] "), para o log não embaralhar.
const rodar = (cmd, cwd, { env, guardar, prefixo } = {}) => new Promise(ok => {
  const f = spawn(cmd[0], cmd.slice(1), { cwd, stdio: ["inherit", "pipe", "pipe"], env: env ? { ...process.env, ...env } : process.env })
  for (const [fluxo, saida] of [[f.stdout, process.stdout], [f.stderr, process.stderr]]) {
    let resto = ""
    const escrever = texto => { saida.write(texto); log.write(semCor(texto)) }
    fluxo.on("data", d => {
      const t = d.toString()
      if (guardar) guardar.push(t)
      if (!prefixo) { escrever(t); return }
      const linhas = (resto + t).split("\n")
      resto = linhas.pop()
      if (linhas.length) escrever(linhas.map(l => prefixo + l + "\n").join(""))
    })
    fluxo.on("end", () => { if (prefixo && resto) escrever(prefixo + resto + "\n") })
  }
  f.on("close", status => ok(status ?? 1))
})
// A trava de testes é por processo: quem já a segura (jornadas rodando junto com o motor) não espera por si mesmo.
let travasSeguras = 0
async function travar() {
  if (travasSeguras++ > 0) return () => { travasSeguras-- }
  const soltar = await acquireTestLock()
  return () => { if (--travasSeguras === 0) soltar() }
}
const devLogs = nome => resolve(root, ".dev-logs", nome)
const lerJson = arq => { try { return JSON.parse(readFileSync(arq, "utf8")) } catch { return null } }

// Aviso (não bloqueia, não mata nada): outra pasta rodando playwright/vitest/workerd/vite deixa tudo lento e provoca estouros.
{
  const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
  const aviso = ps.status === 0 ? avisoMaquina(processosAlheios(ps.stdout, root, process.pid), homedir()) : null
  if (aviso) console.log(aviso)
}

// Repetições: cada uma devolve { ok, instaveis } (instaveis = falharam na 1ª e passaram na 2ª).
const MOTOR_JSON = devLogs("vitest-motor.json"), MOTOR_JSON_2 = devLogs("vitest-motor-repeticao.json")
async function repetirMotor(prefixo) {
  const engine = resolve(root, "engine")
  const antes = falhasVitest(lerJson(MOTOR_JSON), engine)
  if (!antes.arquivos.length) { console.error("motor: não achei os arquivos que falharam no relatório; sem repetição"); return { ok: false } }
  console.log(`\nmotor: repetindo uma vez só o que falhou (${antes.arquivos.join(" ")})`)
  const soltar = await travar()
  rmSync(MOTOR_JSON_2, { force: true })
  const st = await rodar(["npx", "vitest", "run", ...antes.arquivos, "--reporter=default", "--reporter=json", `--outputFile.json=${MOTOR_JSON_2}`], engine, { prefixo })
  soltar()
  return { ok: st === 0, instaveis: st === 0 ? antes.testes : [] }
}
async function repetirPainel(saida, prefixo) {
  const antes = falhasNodeTest(saida.join(""))
  if (!antes.arquivos.length) { console.error("painel: não achei os arquivos que falharam na saída; sem repetição"); return { ok: false } }
  console.log(`\npainel: repetindo uma vez só o que falhou (${antes.arquivos.join(" ")})`)
  const st = await rodar([process.execPath, "--test", ...antes.arquivos], resolve(root, "app-vite"), { prefixo })
  return { ok: st === 0, instaveis: st === 0 ? antes.testes : [] }
}
// Jornadas: lê as falhas do relatório JSON da rodada e repete com --last-failed (no paralelo, cada ambiente lê uma cópia da lista juntada).
const JORNADAS_JSON = devLogs("e2e-relatorio.json"), PARALELO_JSON = devLogs("e2e-blobs/relatorio.json")
async function repetirJornadas(par, prefixo) {
  const antes = falhasPlaywright(lerJson(par ? PARALELO_JSON : JORNADAS_JSON))
  if (!antes.length) { console.error("jornadas: não achei as jornadas que falharam no relatório; sem repetição"); return { ok: false } }
  console.log(`\njornadas: repetindo uma vez só as ${antes.length} que falharam (--last-failed)`)
  const st = par
    // Não sobe mais ambientes do que jornadas a repetir (no máximo um por jornada que falhou).
    ? await rodar([process.execPath, "scripts/e2e-paralelo.mjs", "--last-failed"], root, { prefixo, env: { E2E_AMBIENTES: String(Math.min(antes.length, Number.parseInt(process.env.E2E_AMBIENTES ?? "3", 10) || 3)) } })
    : await rodar(["npm", "run", "e2e", "--", "--last-failed", "--reporter=list,json"], resolve(root, "app-vite"), { prefixo, env: { PLAYWRIGHT_JSON_OUTPUT_FILE: JORNADAS_JSON } })
  return { ok: st === 0, instaveis: st === 0 ? antes : [] }
}
// Jornadas no navegador usam o servidor já rodando (npm run dev:local); sem ele, a etapa é pulada.
// Em worktree as jornadas ficam para a junção no checkout principal (evita disputa pela trava).
function checkoutPrincipal() {
  const g = d => spawnSync("git", ["rev-parse", d], { cwd: root, encoding: "utf8" }).stdout.trim()
  return resolve(root, g("--git-dir")) === resolve(root, g("--git-common-dir"))
}
// Jornadas seletivas: roda só os specs ligados ao que mudou desde a última rodada completa,
// mais um núcleo fixo; a cada 5 rodadas (ou E2E_COMPLETO=1) roda tudo.
const NUCLEO = ["automacao-ciclo", "contatos", "caixa-de-entrada"]
const COMPARTILHADOS = ["app-vite/src/components/shell/", "app-vite/src/components/ui/", "app-vite/src/globals.css", "app-vite/src/styles/"]
let seletivas = null // "21/95" quando as jornadas desta rodada foram seletivas
function jornadasDaVez() {
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" }).stdout.trim()
  const estado = resolve(root, git("rev-parse", "--git-common-dir"), "e2e-seletivo.json")
  let st = { base: null, n: 0 }
  try { st = JSON.parse(readFileSync(estado, "utf8")) } catch {}
  const completo = process.env.E2E_COMPLETO === "1" || !st.base || st.n >= 4
  const gravar = reinicia => ok => { if (!ok) return; writeFileSync(estado, JSON.stringify(reinicia ? { base: git("rev-parse", "HEAD"), n: 0 } : { ...st, n: st.n + 1 })) }
  const salvar = gravar(completo), salvarCompleto = gravar(true)
  if (completo) { console.log("jornadas: rodada completa"); return { args: [], salvar } }
  // Conta também o que ainda não foi commitado (alterado e arquivos novos), não só os commits desde a base.
  const lista = (...a) => git(...a).split("\n").filter(Boolean)
  const mudou = [...new Set([...lista("diff", "--name-only", st.base, "HEAD"), ...lista("diff", "--name-only", "HEAD"), ...lista("ls-files", "--others", "--exclude-standard")])]
  // Casca, componentes de UI e estilos valem para todas as telas: mudou aqui, roda tudo.
  if (mudou.some(f => COMPARTILHADOS.some(p => f.startsWith(p)))) { console.log("jornadas: rodada completa (mudou arquivo compartilhado por todas as telas)"); return { args: [], salvar: salvarCompleto } }
  const specs = readdirSync(resolve(root, "app-vite/e2e")).filter(f => f.endsWith(".spec.ts"))
  const palavras = new Set(mudou.flatMap(f => f.split(/[\/._-]/)).filter(w => w.length > 3))
  const escolhidos = specs.filter(sp => {
    const nome = sp.replace(".spec.ts", "")
    return NUCLEO.includes(nome) || mudou.some(f => f.endsWith(sp)) || nome.split("-").some(w => palavras.has(w))
  })
  console.log(`jornadas seletivas (${escolhidos.length}/${specs.length}): ${escolhidos.join(" ")}`)
  seletivas = `${escolhidos.length}/${specs.length}`
  return { args: escolhidos.map(sp => "e2e/" + sp), salvar }
}

// Mudou código do painel, do engine ou de shared/ (fora de testes/e2e/docs)? Então pular as jornadas não vale como "ok".
function mudouCodigoDeApp() {
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" }).stdout.split("\n").filter(Boolean)
  const base = spawnSync("git", ["rev-parse", "--verify", "-q", "origin/main"], { cwd: root }).status === 0 ? "origin/main" : "main"
  const arquivos = new Set([...git("diff", "--name-only", `${base}...HEAD`), ...git("diff", "--name-only", "HEAD"), ...git("diff", "--name-only", "--cached")])
  return [...arquivos].some(f => /^(app-vite|engine\/src|shared)\//.test(f) && !/(^|\/)(e2e|test|tests)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.md$/.test(f))
}

// Rodada completa (ou E2E_PARALELO=1): ambientes isolados em paralelo (scripts/e2e-paralelo.mjs), sem depender do servidor em 5173/8788.
// Rodada seletiva: o servidor já rodando (npm run dev:local). E2E_PARALELO=0 força o servidor já rodando.
const paralelo = esc => process.env.E2E_PARALELO === "1" || (process.env.E2E_PARALELO !== "0" && esc.args.length === 0)
let escolhaJornadas = null
async function servidorRodando() {
  if (!checkoutPrincipal() && !process.env.E2E_EM_WORKTREE) { console.log("worktree: jornadas rodam na junção (E2E_EM_WORKTREE=1 força)"); return false }
  escolhaJornadas = jornadasDaVez()
  if (paralelo(escolhaJornadas)) return true
  try { return (await fetch(process.env.E2E_PAINEL ?? "http://localhost:5173", { signal: AbortSignal.timeout(2000) })).ok } catch { return false }
}

const etapas = [ // das mais rápidas para as mais lentas; as sem `segue` param o check no primeiro erro
  { nome: "migrações", cwd: ".", cmd: [process.execPath, "scripts/check-migrations.mjs"] },
  { nome: "scripts: testes", cwd: ".", cmd: ["npm", "run", "test:scripts"] },
  { nome: "inventário de rotas da API", cwd: ".", cmd: [process.execPath, "scripts/api-inventario.mjs"] },
  { nome: "engine: testes dos scripts", cwd: "engine", cmd: ["npm", "run", "test:scripts"] },
  { nome: "engine: vazamentos de canal (bloqueante)", cwd: "engine", cmd: ["npm", "run", "check:leaks", "--", "--strict"] },
  { nome: "engine: typecheck", cwd: "engine", cmd: ["npm", "run", "typecheck"] },
  { nome: "painel: typecheck", cwd: "app-vite", cmd: ["npm", "run", "typecheck"] },
  { nome: "painel: lint (hooks do React)", cwd: "app-vite", cmd: ["npm", "run", "lint"] },
  { nome: "engine: testes", cwd: "engine", segue: true, antes: () => rmSync(MOTOR_JSON, { force: true }),
    cmd: ["npm", "test", "--", "--reporter=default", "--reporter=json", `--outputFile.json=${MOTOR_JSON}`], repetir: (_par, _saida, prefixo) => repetirMotor(prefixo) },
  { nome: "painel: testes", cwd: "app-vite", segue: true, guardar: true, cmd: ["npm", "test"], repetir: (_par, saida, prefixo) => repetirPainel(saida, prefixo) },
  { nome: "painel: jornadas no navegador", cwd: "app-vite", segue: true, cmd: ["npm", "run", "e2e", "--", "--reporter=list,json"], env: { PLAYWRIGHT_JSON_OUTPUT_FILE: JORNADAS_JSON },
    antes: () => { rmSync(JORNADAS_JSON, { force: true }); rmSync(PARALELO_JSON, { force: true }) },
    repetir: (par, _saida, prefixo) => repetirJornadas(par, prefixo), soSe: servidorRodando, trava: true, escolher: () => escolhaJornadas,
    paralelo: esc => paralelo(esc) && { cwd: ".", cmd: [process.execPath, "scripts/e2e-paralelo.mjs"] },
    seFalhar: "Para repetir de novo só as que falharam, com trace: cd app-vite && E2E_TRACE=1 npm run e2e -- --last-failed\n(sem o servidor em 5173/8788: E2E_TRACE=1 E2E_AMBIENTES=1 node scripts/e2e-paralelo.mjs --last-failed)" },
]

// Só as jornadas no navegador disputam recursos compartilhados (registro de dev do wrangler, banco local);
// as demais etapas rodam em paralelo entre worktrees.
const t0 = Date.now()
const instaveis = []
const falharam = [] // etapas com `segue` que falharam (as outras param o check na hora)
let pulouJornadasObrigatorias = false
const sair = codigo => { log.end(() => process.exit(codigo)); return new Promise(() => {}) }
// CHECK_SO=<trecho> roda só as etapas cujo nome contém o trecho (ex.: CHECK_SO="engine: testes"), para provar uma etapa sozinha.
const soEtapas = process.env.CHECK_SO
// Etapas lentas (motor, painel, jornadas) juntas em vez de uma depois da outra: padrão com 8 núcleos ou mais;
// CHECK_LENTAS_JUNTAS=1 força, =0 desliga. Cada linha sai com o nome curto da etapa na frente.
const lentasJuntas = process.env.CHECK_LENTAS_JUNTAS === "1" || (process.env.CHECK_LENTAS_JUNTAS !== "0" && cpus().length >= 8)
const curto = { "engine: testes": "motor", "painel: testes": "painel", "painel: jornadas no navegador": "jornadas" }

// Uma etapa: devolve a linha do resumo; `null` quando não rodou por CHECK_SO.
async function executar(e) {
  console.log(`\n=== ${e.nome} ===`)
  if (e.soSe && !(await e.soSe())) {
    console.log("pulado: servidor não está rodando (suba npm run dev:local para rodar as jornadas)")
    if (process.env.E2E_PULAR !== "1" && mudouCodigoDeApp()) pulouJornadasObrigatorias = true
    return `pulado ${e.nome}`
  }
  const release = e.trava ? await travar() : () => {}
  try {
    const esc = e.escolher ? e.escolher() : null
    const t = Date.now()
    const par = esc && e.paralelo ? e.paralelo(esc) : null
    if (par) console.log("jornadas: ambientes isolados em paralelo (scripts/e2e-paralelo.mjs)")
    // No paralelo o relatório JSON sai do próprio e2e-paralelo (merge-reports); repórter e env extras são do caminho sem paralelo.
    const base = par ? par.cmd : e.cmd
    const cmd = esc && esc.args.length ? [...base, ...(par || base.includes("--") ? [] : ["--"]), ...esc.args] : base
    if (par) process.env.E2E_TRAVA_JA_SEGURA = "1" // esta etapa já segura a trava
    e.antes?.()
    const saida = e.guardar ? [] : null
    const status = await rodar(cmd, resolve(root, par ? par.cwd : e.cwd), { env: par ? undefined : e.env, guardar: saida, prefixo: e.prefixo })
    let ok = status === 0, repetida = false
    if (!ok && e.repetir) {
      const r = await e.repetir(par, saida, e.prefixo)
      repetida = true
      ok = r.ok
      if (ok) instaveis.push(...r.instaveis)
    }
    const seg = ((Date.now() - t) / 1000).toFixed(1)
    if (esc) esc.salvar(ok)
    if (!ok) {
      console.error(`\nFALHOU na etapa: ${e.nome}`)
      if (e.seFalhar) console.error(e.seFalhar)
      if (!e.segue) { console.error("\n" + montarResumo({ linhas: [...resumo, `FALHOU ${e.nome} (${seg}s)`] })); await sair(status || 1) }
      falharam.push(e.nome)
    }
    return `${ok ? "ok " : "FALHOU"} ${e.nome} (${seg}s)${repetida ? (ok ? " (passou na repetição)" : " (falhou também na repetição)") : ""}`
  } finally { release() }
}

const resumo = []
const escolhidas = etapas.filter(e => !soEtapas || e.nome.includes(soEtapas))
const lentas = lentasJuntas ? escolhidas.filter(e => e.segue) : []
for (const e of escolhidas.filter(e => !lentas.includes(e))) resumo.push(await executar(e))
if (lentas.length) {
  console.log(`\n=== etapas lentas juntas: ${lentas.map(e => curto[e.nome] ?? e.nome).join(", ")} (CHECK_LENTAS_JUNTAS=0 roda uma depois da outra) ===`)
  // Cada linha (também a da repetição) leva o nome curto da etapa na frente.
  const linhas = await Promise.all(lentas.map(e => executar({ ...e, prefixo: `[${curto[e.nome] ?? e.nome}] ` })))
  resumo.push(...linhas)
}
if (falharam.length) {
  console.error("\n" + montarResumo({ linhas: resumo, instaveis, falharam }))
  await sair(1)
}
if (pulouJornadasObrigatorias) {
  console.error("\n" + montarResumo({ linhas: resumo, instaveis }) + "\n\nFALHOU: jornadas não rodaram: suba npm run dev:local (ou E2E_EM_WORKTREE=1 com E2E_PAINEL/E2E_ENGINE) ou rode com E2E_PULAR=1 para aceitar conscientemente")
  await sair(1)
}
console.log("\n" + montarResumo({ linhas: resumo, instaveis }) + `\ncheck ok em ${((Date.now() - t0) / 1000).toFixed(1)}s${seletivas ? ` (jornadas seletivas ${seletivas})` : ""}`)
