#!/usr/bin/env node
// Mostra só o que importa do log do engine (.dev-logs/engine.log). Uso: npm run logs [-- --since N]
import { createReadStream, existsSync, statSync, readFileSync, watchFile } from "node:fs"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"

const RELEVANT = /\/api\/|\b(Error|Uncaught)\b|(?:^|\s)5\d\d(?:\s|$)/
export function relevant(line) { return RELEVANT.test(line) }
export function mask(line) {
  return line
    .replace(/((?:access_)?token=)[^&\s"']+/gi, "$1***")
    .replace(/(access_token["']?\s*[:=]\s*["']?)[^"'\s,&}]+/gi, "$1***")
    .replace(/(Authorization["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^"'\s,}]+/gi, "$1***")
}

function main() {
  const file = resolve(fileURLToPath(import.meta.url), "../../.dev-logs/engine.log")
  const i = process.argv.indexOf("--since")
  const since = i > 0 ? Number(process.argv[i + 1]) : 200
  if (!Number.isInteger(since) || since < 0) { console.error("--since espera um número de linhas"); process.exit(2) }
  const out = l => { if (relevant(l)) console.log(mask(l)) }
  if (!existsSync(file)) { console.error(`sem log ainda: ${file}\nSuba o motor com "npm run dev:local" no app-vite.`); process.exit(1) }
  for (const l of readFileSync(file, "utf8").split("\n").slice(-since - 1)) out(l)
  let pos = statSync(file).size, buf = ""
  watchFile(file, { interval: 500 }, st => {
    if (st.size < pos) pos = 0
    if (st.size === pos) return
    const s = createReadStream(file, { start: pos, end: st.size - 1, encoding: "utf8" })
    pos = st.size
    s.on("data", d => { buf += d; const p = buf.split("\n"); buf = p.pop(); p.forEach(out) })
  })
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
