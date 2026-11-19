#!/usr/bin/env node
// Reports code outside the messaging layer that decides something by channel name (replica/arquitetura-mensageria.md §8).
// Report mode by default (exit 0). `--strict` exits 1 when anything in engine/src outside the allowlist remains (blocking since F3).
// The panel (app-vite/src) is always report only: its labels and option lists move to the catalog in F4.
// A field called channel_type or a read of the kind is data, not a decision: a decision needs a channel name, which the pattern catches.
// Usage: node scripts/check-channel-leaks.mjs [--strict] [--json]
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
// Env credential prefixes are upper case; matching them case-insensitively would flag names like ig_comment.
// The lookbehind (not \b) lets a prefix after an underscore match, as in DEV_TELEGRAM_TOKEN.
const envPrefix = /(?<![A-Za-z0-9])(?:TELEGRAM|IG|META|WHATSAPP)_[A-Z]/
const names = /whatsapp|instagram|telegram|messenger|caps\.type|'tg-|'wa-|'ig-/i
const targets = ['engine/src', 'app-vite/src']

// Allowlist: path prefix -> why it is not a leak. Add a line here only with a reason.
const allow = [
  ['engine/src/channels/', 'the layer itself'],
  ['engine/src/schemas/graph.ts', 'graph vocabulary (ManyChat data, not transport decisions)'],
  ['engine/src/db/automations.ts', 'graph vocabulary'],
  ['engine/src/flow/matcher.ts', 'comment only'],
  ['engine/src/db/trigger-metrics.ts', 'trigger widget vocabulary (ManyChat data): which widget types report an impression'],
  ['engine/src/schemas/temporal.ts', 'trigger widget vocabulary (ManyChat data): origin options of the flow condition'],
  ['engine/src/api-docs/catalogo/', 'API documentation text and request examples (channel names in prose), not transport decisions'],
  ['engine/src/api-docs/rascunho.ts', 'API documentation of the flow format: node type names and descriptions in prose, not transport decisions'],
  ['app-vite/src/data/seed.ts', 'demo data'],
  ['engine/src/db/contacts.ts', 'WhatsApp identity repository (BSUID rules); becomes a per-provider identity strategy before the UAZAPI slice (F5)'],
]
const skipFile = /\.(test|spec)\.[mc]?[jt]sx?$/
const exts = /\.(ts|tsx|mjs|js)$/

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (exts.test(name) && !skipFile.test(name)) yield path
  }
}

const perFile = new Map()
let scanned = 0
for (const target of targets) {
  for (const file of walk(join(root, target))) {
    const rel = relative(root, file)
    if (allow.some(([prefix]) => rel.startsWith(prefix))) continue
    scanned++
    const hits = readFileSync(file, 'utf8').split('\n').flatMap((line, index) => (names.test(line) || envPrefix.test(line)) ? [index + 1] : [])
    if (hits.length) perFile.set(rel, hits)
  }
}

// A provider id is data of the provider's own files plus its registration lines. Anywhere else it is a branch on a provider name,
// and the next provider would have to edit the engine. Provider files are named after the provider (channels/uazapi*.ts).
const providerIds = /uazapi/i
const providerFiles = ['engine/src/channels/uazapi', 'engine/src/channels/providers.ts', 'engine/src/channels/registry.ts', 'engine/src/channels/contract.ts']
const providerLeaks = new Map()
for (const file of walk(join(root, 'engine/src'))) {
  const rel = relative(root, file)
  if (providerFiles.some(prefix => rel.startsWith(prefix))) continue
  const hits = readFileSync(file, 'utf8').split('\n').flatMap((line, index) => providerIds.test(line) ? [index + 1] : [])
  if (hits.length) providerLeaks.set(rel, hits)
}
const total = [...perFile.values()].reduce((sum, hits) => sum + hits.length, 0)
const engineTotal = [...perFile].filter(([file]) => file.startsWith('engine/')).reduce((sum, [, hits]) => sum + hits.length, 0)
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ filesScanned: scanned, filesWithHits: perFile.size, lines: total, files: Object.fromEntries(perFile) }, null, 2))
} else {
  console.log(`Channel leak report (outside the layer, after allowlist)`)
  for (const [file, hits] of [...perFile].sort((a, b) => b[1].length - a[1].length)) console.log(`${String(hits.length).padStart(4)}  ${file}`)
  console.log(`\n${total} matching lines in ${perFile.size} files (${scanned} files scanned, allowlist: ${allow.length} entries)`)
  console.log(process.argv.includes('--strict') ? `Mode: strict (engine/src: ${engineTotal} outside the allowlist)` : 'Mode: report (exit 0). Use --strict to fail the build.')
}
const providerTotal = [...providerLeaks.values()].reduce((sum, hits) => sum + hits.length, 0)
if (providerTotal) {
  console.log(`\nProvider ids outside provider files and registration (${providerTotal} lines in ${providerLeaks.size} files):`)
  for (const [file, hits] of providerLeaks) console.log(`${String(hits.length).padStart(4)}  ${file}  lines ${hits.join(',')}`)
}
if (process.argv.includes('--strict') && (engineTotal > 0 || providerTotal > 0)) process.exit(1)
