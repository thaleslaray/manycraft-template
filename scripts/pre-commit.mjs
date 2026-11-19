#!/usr/bin/env node
// Pre-commit rápido (segundos): typecheck só dos pacotes com arquivos staged, testes ligados a eles, vazamentos de canal
// e regras das migrações. shared/ conta como engine e painel.
// O check completo continua em `npm run check`.
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { resolve, basename } from "node:path"
import { readdirSync } from "node:fs"

const root = resolve(fileURLToPath(import.meta.url), "../..")
const staged = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMRD"], { cwd: root, encoding: "utf8" }).stdout.split("\n").filter(Boolean)
const doPacote = pkg => staged.filter(f => f.startsWith(pkg + "/")).map(f => f.slice(pkg.length + 1))
const codigo = fs => fs.filter(f => /\.[cm]?[jt]sx?$/.test(f))
const env = { ...process.env, VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS ?? "2" }

function roda(nome, cwd, cmd) {
  console.log(`\n=== pre-commit: ${nome} ===`)
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: resolve(root, cwd), stdio: "inherit", env })
  if (r.status !== 0) { console.error(`\nFALHOU no pre-commit: ${nome} (check completo: npm run check)`); process.exit(r.status || 1) }
}

const engine = codigo(doPacote("engine")), painel = codigo(doPacote("app-vite")), shared = codigo(doPacote("shared"))
const migracoes = doPacote("engine").filter(f => f.startsWith("migrations/"))
// --cached: pega migração commitada editada no que vai entrar no commit, não na árvore de trabalho.
if (migracoes.length) roda("migrações", ".", [process.execPath, "scripts/check-migrations.mjs", "--cached"])
if (engine.length || shared.length) {
  roda("engine: typecheck", "engine", ["npm", "run", "typecheck"])
  // `vitest related` seguiria o grafo de imports (providers.ts alimenta ~140 arquivos de teste); aqui vão os testes
  // staged mais os test/*.test.ts cujo nome contém o nome de um arquivo de src staged (src/foo.ts -> test/foo*.test.ts).
  const todos = readdirSync(resolve(root, "engine/test")).filter(f => f.endsWith(".test.ts"))
  const stems = engine.filter(f => f.startsWith("src/")).map(f => basename(f).replace(/\.[cm]?[jt]sx?$/, "")).filter(s => s.length > 3)
  const testes = new Set([...engine.filter(f => f.startsWith("test/") && f.endsWith(".test.ts")), ...todos.filter(f => stems.some(s => f.includes(s))).map(f => "test/" + f)])
  if (testes.size) roda("engine: testes dos arquivos", "engine", ["npx", "vitest", "run", ...testes])
  roda("engine: vazamentos de canal", "engine", ["npm", "run", "check:leaks", "--", "--strict"])
}
if (painel.length || shared.length) {
  roda("painel: typecheck", "app-vite", ["npm", "run", "typecheck"])
  roda("painel: lint", "app-vite", ["npm", "run", "lint"])
  // O painel usa node:test (não vitest): roda só os arquivos de teste que entraram no commit.
  const testes = painel.filter(f => /\.test\.[cm]?[jt]s$/.test(f) && !f.startsWith("e2e/"))
  if (testes.length) roda("painel: testes dos arquivos", "app-vite", [process.execPath, "--test", ...testes])
}
if (!engine.length && !painel.length && !shared.length && !migracoes.length) console.log("pre-commit: nada de engine/, app-vite/ ou shared/ no commit, nada a checar")
