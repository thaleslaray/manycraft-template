import { test } from "node:test"
import assert from "node:assert/strict"
import { avisoMaquina, falhasNodeTest, falhasPlaywright, falhasVitest, montarResumo, processosAlheios } from "./check-repetir.mjs"

test("vitest: arquivos que falharam, relativos ao engine, com os testes falhos (ou o arquivo inteiro)", () => {
  const json = { testResults: [
    { name: "/r/engine/test/a.test.ts", status: "passed", assertionResults: [{ status: "passed", fullName: "ok" }] },
    { name: "/r/engine/test/b.test.ts", status: "failed", assertionResults: [{ status: "passed", fullName: "x" }, { status: "failed", fullName: "grupo estoura 5 s", title: "estoura 5 s" }] },
    { name: "/r/engine/test/c.test.ts", status: "failed", assertionResults: [] },
  ] }
  assert.deepEqual(falhasVitest(json, "/r/engine"), {
    arquivos: ["test/b.test.ts", "test/c.test.ts"],
    testes: [{ arquivo: "test/b.test.ts", teste: "grupo estoura 5 s" }, { arquivo: "test/c.test.ts", teste: "(arquivo)" }],
  })
  assert.deepEqual(falhasVitest(null, "/r"), { arquivos: [], testes: [] })
})

test("node --test: lê o bloco de testes que falharam do reporter spec", () => {
  const saida = [
    "✖ src/c.test.mjs (99.1ms)", "ℹ fail 2", "", "\x1b[31m✖ failing tests:\x1b[39m", "",
    "test at src/a.test.mjs:4:1", "✖ quebra aqui (0.375041ms)", "  AssertionError [ERR_ASSERTION]: 1 == 2", "",
    "test at src/c.test.mjs:1:1", "✖ src/c.test.mjs (99.160083ms)", "  'test failed'",
  ].join("\n")
  assert.deepEqual(falhasNodeTest(saida), {
    arquivos: ["src/a.test.mjs", "src/c.test.mjs"],
    testes: [{ arquivo: "src/a.test.mjs", teste: "quebra aqui" }, { arquivo: "src/c.test.mjs", teste: "src/c.test.mjs" }],
  })
  assert.deepEqual(falhasNodeTest("ℹ fail 0\n"), { arquivos: [], testes: [] })
})

test("playwright: só os inesperados, com describe e projeto", () => {
  const json = { suites: [
    { title: "a.spec.ts", file: "a.spec.ts", specs: [
      { title: "abre", file: "a.spec.ts", tests: [{ projectName: "desktop", status: "expected" }, { projectName: "mobile", status: "unexpected" }] },
    ], suites: [{ title: "grupo", file: "a.spec.ts", specs: [
      { title: "salva", file: "a.spec.ts", tests: [{ projectName: "desktop", status: "unexpected" }, { projectName: "desktop", status: "flaky" }] },
    ] }] },
  ] }
  assert.deepEqual(falhasPlaywright(json), [
    { arquivo: "a.spec.ts", teste: "abre [mobile]" },
    { arquivo: "a.spec.ts", teste: "grupo > salva [desktop]" },
  ])
  assert.deepEqual(falhasPlaywright(undefined), [])
})

test("resumo: etapas, instáveis e o que falhou", () => {
  assert.equal(montarResumo({ linhas: ["ok  a (1s)", "ok  b (2s)"] }), "ok  a (1s)\nok  b (2s)")
  assert.equal(
    montarResumo({ linhas: ["ok  motor (9s)", "FALHOU jornadas (5s)"], instaveis: [{ arquivo: "test/b.test.ts", teste: "estoura" }], falharam: ["jornadas"] }),
    "ok  motor (9s)\nFALHOU jornadas (5s)\n\ninstável: test/b.test.ts > estoura\n\nFALHOU: jornadas",
  )
})

test("máquina ocupada: conta processos de teste de outras pastas, agrupa worktrees no projeto e ignora este checkout", () => {
  const ps = [
    " 9600 npm exec playwright test e2e/casca.spec.ts",
    " 6141 /bin/zsh -c source x && /Users/u/Projetos/outro/node_modules/.bin/vitest run",
    " 9678 node /Users/u/Projetos/member/.claude/worktrees/ag1/app/node_modules/.bin/playwright test e2e/casca.spec.ts",
    "10379 node /Users/u/Projetos/member/.claude/worktrees/ag2/app/node_modules/.bin/vite dev",
    "10642 /Users/u/Projetos/member/.claude/worktrees/ag1/app/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd serve --binary",
    "12134 /opt/homebrew/bin/node /Users/u/Projetos/member/app/node_modules/playwright/lib/worker/workerProcessEntry.js",
    "12190 /Users/u/Library/Caches/ms-playwright/chromium/chrome-headless-shell --disable",
    "34553 /opt/node --experimental-import-meta-resolve --require /Users/u/Projetos/crm/node_modules/vitest/suppress-warnings.cjs --conditions",
    "32631 /Users/u/Projetos/manycraft/app-vite/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd serve",
    "40000 node /Users/u/Projetos/manycraft/.claude/worktrees/x/engine/node_modules/.bin/vitest run",
    "62167 /opt/node node_modules/vite/bin/vite.js --port 5173",
    "777 node /Users/u/Projetos/crm/node_modules/.bin/vitest run",
  ].join("\n")
  const lista = processosAlheios(ps, "/Users/u/Projetos/manycraft", 777)
  assert.deepEqual(lista, [{ pasta: "/Users/u/Projetos/member", n: 4 }, { pasta: "/Users/u/Projetos/crm", n: 1 }])
  assert.equal(avisoMaquina(lista, "/Users/u"), "máquina ocupada: 5 processos de teste de ~/Projetos/member (4), ~/Projetos/crm (1); tempos e estouros podem vir disso")
  assert.equal(avisoMaquina([], "/Users/u"), null)
})
