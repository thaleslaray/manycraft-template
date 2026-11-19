#!/usr/bin/env node
// Consulta o D1 local do engine e imprime só as linhas. Uso: npm run db -- "SELECT ...; SELECT ..."
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"

const MAX = 80
const cell = v => { const s = v === null ? "NULL" : String(v).replace(/\s+/g, " "); return s.length > MAX ? s.slice(0, MAX - 1) + "…" : s }
export function table(rows) {
  if (!rows.length) return "(0 linhas)"
  const cols = Object.keys(rows[0])
  const data = rows.map(r => cols.map(c => cell(r[c])))
  const w = cols.map((c, i) => Math.max(c.length, ...data.map(r => r[i].length)))
  const line = r => r.map((v, i) => v.padEnd(w[i])).join("  ").trimEnd()
  return [line(cols), line(w.map(n => "-".repeat(n))), ...data.map(line)].join("\n")
}
// Divide por ';' fora de aspas simples.
export function split(sql) {
  const out = []; let cur = "", q = false
  for (const ch of sql) { if (ch === "'") q = !q; if (ch === ";" && !q) { out.push(cur); cur = "" } else cur += ch }
  out.push(cur)
  return out.map(s => s.trim()).filter(Boolean)
}
function run(sql) {
  const r = spawnSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--env", "dev", "--json", "--command", sql], { cwd: resolve(fileURLToPath(import.meta.url), "../../engine"), encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } })
  const text = (r.stdout || "") + ""
  const start = text.indexOf("[")
  try {
    const parsed = JSON.parse(text.slice(start))
    return parsed.flatMap(p => p.results ?? [])
  } catch {
    try { const e = JSON.parse(text.slice(text.indexOf("{"))); return { error: e.error?.text ?? e.error?.message ?? e.message ?? "erro" } } catch {}
    const msg = ((r.stderr || "") + text).split("\n").find(l => /error|erro/i.test(l)) ?? "falha ao consultar o D1 local"
    return { error: msg.replace(/\x1b\[[0-9;]*m/g, "").replace(/^[^\w]*(✘\s*)?\[?ERROR\]?\s*/i, "").trim() }
  }
}
function main() {
  const stmts = split(process.argv.slice(2).join(" "))
  if (!stmts.length) { console.error('uso: npm run db -- "SELECT ..."'); process.exit(2) }
  for (const s of stmts) {
    const res = run(s)
    if (res.error) { console.error(`erro: ${res.error.slice(0, 200)}`); process.exit(1) }
    console.log(table(res))
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
