#!/usr/bin/env node
// Teste de prontidão: jornadas por canal, contrato dos provedores (simuladores) e estresse. Escreve .scratch/prontidao/relatorio.md.
// Uso: npm run prontidao   (PRONTIDAO_CONTATOS=200 para um estresse menor)
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"

const root = resolve(fileURLToPath(import.meta.url), "../..")
const r = spawnSync(process.execPath, [resolve(root, "scripts/with-test-lock.mjs"), "npx", "vitest", "run", "--config", "vitest.prontidao.config.ts", "test/prontidao",
  "--reporter=default", "--reporter=./test/prontidao/relatorio-reporter.ts"], { cwd: resolve(root, "engine"), stdio: "inherit" })
process.exit(r.status ?? 1)
