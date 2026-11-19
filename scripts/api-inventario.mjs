#!/usr/bin/env node
// Inventário das rotas /api/* do motor: empacota engine/src/index.ts para Node (módulos `cloudflare:*` viram
// esboço vazio; nada roda além da montagem das rotas), lê `app.routes` e cruza com as listas versionadas.
// Falha com rota fora das duas listas, rota nas duas, ou entrada que sumiu. Grava .scratch/api-total/inventario.md.
// Também confere o catálogo da documentação (engine/src/api-docs/catalogo/) e grava .scratch/api-docs/openapi.json.
import { build } from "../engine/node_modules/esbuild/lib/main.js"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { inventariar, tabelaMarkdown } from "./api-inventario-lib.mjs"
import { API_KEY_BLOCKED, isOutsidePanel } from "../engine/src/api-key-access.ts"
import { API_KEY_ALLOWED } from "../engine/src/api-rotas-liberadas.ts"

const root = resolve(fileURLToPath(import.meta.url), "../..")
const dir = mkdtempSync(join(tmpdir(), "api-inventario-"))
try {
  const out = join(dir, "app.mjs")
  await build({
    stdin: { resolveDir: resolve(root, "engine/src"), loader: "ts", sourcefile: "entrada-inventario.ts",
      contents: "export { app } from './index'; export { AREAS, v1 } from './api-docs/catalogo'; export { conferirCatalogo } from './api-docs/conferir'; export { documentoOpenApi } from './api-docs/rotas'" },
    bundle: true, platform: "node", format: "esm", outfile: out,
    logLevel: "error", conditions: ["workerd", "worker"],
    plugins: [{ name: "cloudflare-esboco", setup(b) {
      b.onResolve({ filter: /^cloudflare:/ }, a => ({ path: a.path, namespace: "esboco" }))
      b.onLoad({ filter: /.*/, namespace: "esboco" }, () => ({
        contents: "class Base {}; export class DurableObject extends Base {}; export class WorkflowEntrypoint extends Base {}; export class WorkerEntrypoint extends Base {}; export class NonRetryableError extends Error {}; export const env = {}; export default {}",
        loader: "js" }))
    } }],
  })
  const { app, AREAS, v1, conferirCatalogo, documentoOpenApi } = await import(pathToFileURL(out).href)
  const { linhas, erros } = inventariar(app, { liberadas: API_KEY_ALLOWED, bloqueadas: API_KEY_BLOCKED, fora: isOutsidePanel })
  const destino = resolve(root, ".scratch/api-total/inventario.md")
  mkdirSync(resolve(destino, ".."), { recursive: true })
  writeFileSync(destino, tabelaMarkdown(linhas))
  const n = s => linhas.filter(l => l.situacao === s).length
  if (erros.length) {
    console.error(`inventário de rotas: ${erros.length} divergência(s)\n  ${erros.join("\n  ")}`)
    console.error("Acrescente em engine/src/api-rotas-liberadas.ts (liberada) ou API_KEY_BLOCKED em engine/src/api-key-access.ts (só no painel).")
    process.exitCode = 1
  } else console.log(`inventário de rotas ok: ${n("liberada")} liberadas, ${n("bloqueada")} bloqueadas (.scratch/api-total/inventario.md)`)

  // Documentação: toda rota liberada tem entrada no catálogo (sem lista de pendências); sem entrada órfã.
  const rotasV1 = [...new Set(app.routes.filter(r => r.path.startsWith("/api/public/v1/") && ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(r.method)).map(r => `${r.method} ${r.path}`))]
  const errosDoc = conferirCatalogo({ liberadas: API_KEY_ALLOWED, areas: AREAS, rotasV1, v1 })
  const docDestino = resolve(root, ".scratch/api-docs/openapi.json")
  mkdirSync(resolve(docDestino, ".."), { recursive: true })
  writeFileSync(docDestino, JSON.stringify(JSON.parse(documentoOpenApi()), null, 2) + "\n")
  if (errosDoc.length) {
    console.error(`catálogo da documentação: ${errosDoc.length} problema(s)\n  ${errosDoc.join("\n  ")}`)
    console.error("Veja as instruções no topo de engine/src/api-docs/catalogo/index.ts.")
    process.exitCode = 1
  } else {
    const soDev = AREAS.flatMap(a => a.entradas).filter(e => e.soDesenvolvimento).length
    console.log(`documentação da API ok: ${AREAS.flatMap(a => a.entradas).length} rotas no catálogo (${soDev} só de desenvolvimento, fora do documento) + ${v1.entradas.length} v1 (.scratch/api-docs/openapi.json)`)
  }
} finally { rmSync(dir, { recursive: true, force: true }) }
