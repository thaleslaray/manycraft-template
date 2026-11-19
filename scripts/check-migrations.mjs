#!/usr/bin/env node
// Regras das migrações: prefixo único, numeração sem buraco, migração já commitada não muda.
// Uso: node scripts/check-migrations.mjs [--cached]  (--cached: edição só no que está staged, para o pre-commit)
import { readdirSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"

export function checkMigrations(files, modified = []) {
  const errors = []
  const sql = files.filter(f => f.endsWith(".sql")).sort()
  const byNum = new Map()
  for (const f of sql) {
    const m = /^(\d+)_/.exec(f)
    if (!m) { errors.push(`nome sem prefixo numérico: ${f}`); continue }
    const n = Number(m[1])
    byNum.set(n, [...(byNum.get(n) ?? []), f])
  }
  for (const [n, list] of byNum) if (list.length > 1) errors.push(`prefixo ${n} repetido: ${list.join(", ")}`)
  const nums = [...byNum.keys()].sort((a, b) => a - b)
  for (let i = 0; i < nums.length; i++) {
    const esperado = (nums[0] === 0 ? 0 : 1) + i
    if (nums[i] !== esperado) { errors.push(`buraco na numeração: esperado ${String(esperado).padStart(4, "0")}, achei ${String(nums[i]).padStart(4, "0")}`); break }
  }
  for (const f of modified) errors.push(`migração já commitada foi modificada, renomeada ou apagada: ${f} (crie uma nova em vez de mexer nela)`)
  return errors
}

// cached: só o que está staged (pre-commit); sem ele, árvore de trabalho e staged contra HEAD.
export function modifiedCommitted(root, cached = false) {
  try {
    return execFileSync("git", ["diff", "--name-only", "--diff-filter=MDR", "--no-renames", cached ? "--cached" : "HEAD", "--", "engine/migrations"], { cwd: root, encoding: "utf8" })
      .split("\n").filter(Boolean)
  } catch { return [] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(import.meta.url), "../..")
  const errors = checkMigrations(readdirSync(resolve(root, "engine/migrations")), modifiedCommitted(root, process.argv.includes("--cached")))
  if (errors.length) { for (const e of errors) console.error("x " + e); process.exit(1) }
  console.log("migrações ok")
}
