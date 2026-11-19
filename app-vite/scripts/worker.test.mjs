import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import app from "../worker/index.ts"

const run = (request, fetch) => app.fetch(request, { ENGINE: { fetch } })

test("repassa método, corpo, query, cookies e workspace sem alterar a resposta", async () => {
  const request = new Request("https://painel.test/api/inbox/conversations/c1/messages?before=m1", {
    method: "POST", headers: { "content-type": "application/json", "x-workspace": "w1", cookie: "session=private" },
    body: JSON.stringify({ text: "Olá", kind: "note" }),
  })
  const response = new Response(JSON.stringify({ id: "message-1" }), { status: 201, headers: { "set-cookie": "session=new; HttpOnly" } })
  const actual = await run(request, async forwarded => {
    assert.equal(forwarded, request)
    assert.equal(forwarded.headers.get("x-workspace"), "w1")
    assert.equal(forwarded.headers.get("cookie"), "session=private")
    assert.deepEqual(await forwarded.json(), { text: "Olá", kind: "note" })
    return response
  })
  assert.equal(actual, response)
})

test("WebSocket traduz workspace da query para header sem reconstruir a resposta 101", async () => {
  const socket = { testSocket: true }
  // Response nativa do Node não admite 101; o teste de runtime usa workerd.
  const response = { status: 101, webSocket: socket }
  const request = new Request("https://painel.test/api/inbox/live?workspace=w2&keep=yes", {
    headers: { upgrade: "websocket", cookie: "session=private", "x-workspace": "old" },
  })
  const actual = await run(request, async forwarded => {
    assert.equal(new URL(forwarded.url).search, "?keep=yes")
    assert.equal(forwarded.headers.get("x-workspace"), "w2")
    assert.equal(forwarded.headers.get("upgrade"), "websocket")
    assert.equal(forwarded.headers.get("cookie"), "session=private")
    return response
  })
  assert.equal(actual, response)
  assert.equal(actual.webSocket, socket)
})

test("query de endpoints HTTP não vira autenticação nem workspace", async () => {
  await run(new Request("https://painel.test/api/contacts?workspace=query"), async request => {
    assert.equal(request.headers.get("x-workspace"), null)
    assert.equal(new URL(request.url).searchParams.get("workspace"), "query")
    return new Response("[]")
  })
})

test("falha de binding não vaza mensagens internas ou credenciais", async () => {
  const response = await run(new Request("https://painel.test/api/dev/workspace"), async () => { throw new Error("secret-cookie") })
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: "engine_unavailable" })
})

test("ausência de engine retorna erro explícito e não dados fake", async () => {
  const response = await app.fetch(new Request("https://painel.test/api/inbox/conversations"), {})
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: "engine_unavailable" })
})

test("rotas fora de /api não são enviadas ao engine", async () => {
  const response = await run(new Request("https://painel.test/qualquer"), async () => { throw new Error("não deveria chamar") })
  assert.equal(response.status, 404)
})

test("respostas montadas pelo Worker levam nosniff (o _headers só vale para o binding ASSETS)", async () => {
  const assetsSemArquivo = { fetch: async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }) }
  const respostas = [
    await app.fetch(new Request("https://painel.test/api/contacts"), {}),
    await run(new Request("https://painel.test/api/contacts"), async () => { throw new Error("caiu") }),
    await app.fetch(new Request("https://painel.test/assets/index-antigo.js"), { ASSETS: assetsSemArquivo }),
    await app.fetch(new Request("https://painel.test/assets/x.js", { method: "POST" }), {}),
  ]
  assert.deepEqual(respostas.map(r => [r.status, r.headers.get("x-content-type-options")]), [[503, "nosniff"], [503, "nosniff"], [404, "nosniff"], [404, "nosniff"]])
})

/** Regras do public/_headers por caminho: { "/*": { "Content-Security-Policy": "..." } }. */
async function regrasDoHeaders() {
  const regras = {}
  let atual
  for (const linha of (await readFile(new URL("../public/_headers", import.meta.url), "utf8")).split("\n")) {
    if (!linha.trim() || linha.trimStart().startsWith("#")) continue
    if (!/^\s/.test(linha)) { atual = regras[linha.trim()] = {}; continue }
    // "! Nome" (sem dois-pontos) tira o cabeçalho que uma regra mais ampla pôs.
    const separador = linha.indexOf(":")
    if (separador < 0) { atual[linha.trim()] = ""; continue }
    atual[linha.slice(0, separador).trim()] = linha.slice(separador + 1).trim()
  }
  return regras
}
const diretivas = politica => Object.fromEntries(politica.split(";").map(d => d.trim()).filter(Boolean).map(d => d.split(/\s+/)).map(([nome, ...fontes]) => [nome, fontes]))

test("_headers protege o HTML, o estúdio de e-mail e os /assets/*", async () => {
  const todos = (await regrasDoHeaders())["/*"]
  assert.equal(todos["X-Content-Type-Options"], "nosniff")
  assert.equal(todos["Referrer-Policy"], "strict-origin-when-cross-origin")
  // O painel enquadra o próprio estúdio de e-mail: SAMEORIGIN, nunca DENY.
  assert.equal(todos["X-Frame-Options"], "SAMEORIGIN")
  assert.match(todos["Permissions-Policy"], /camera=\(\), microphone=\(\), geolocation=\(\)/)
  const csp = diretivas(todos["Content-Security-Policy"])
  assert.deepEqual(csp["default-src"], ["'self'"])
  assert.deepEqual(csp["frame-ancestors"], ["'self'"])
  assert.deepEqual(csp["object-src"], ["'none'"])
  assert.deepEqual(csp["base-uri"], ["'self'"])
  assert.ok(!csp["script-src"].some(fonte => ["'unsafe-inline'", "*", "https:", "data:"].includes(fonte)), csp["script-src"].join(" "))
  // O beacon do Web Analytics (static.cloudflareinsights.com) envia as medições para cloudflareinsights.com: sem ele no connect-src o envio é barrado.
  assert.ok(csp["connect-src"].includes("https://cloudflareinsights.com"), csp["connect-src"].join(" "))
  assert.ok(!csp["connect-src"].some(fonte => ["*", "https:"].includes(fonte)), csp["connect-src"].join(" "))
  // Sem eval no painel: o Zod roda sem JIT (engine/src/schemas/zod-sem-eval.ts, primeiro import do main.tsx).
  assert.ok(!csp["script-src"].includes("'unsafe-eval'"), csp["script-src"].join(" "))
  assert.equal(todos["Content-Security-Policy-Report-Only"], undefined)
})

test("o painel desliga o JIT do Zod no primeiro import, antes de qualquer esquema", async () => {
  const main = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8")
  const imports = [...main.matchAll(/^import\s+(?:[^"]+from\s+)?"([^"]+)"/gm)].map(m => m[1])
  assert.equal(imports[0], "../../engine/src/schemas/zod-sem-eval")
  const modulo = await readFile(new URL("../../engine/src/schemas/zod-sem-eval.ts", import.meta.url), "utf8")
  assert.match(modulo, /z\.config\(\{ jitless: true \}\)/)
})

test("o estúdio de e-mail segue a política do /*, sem 'unsafe-eval' nem bloco próprio", async () => {
  const regras = await regrasDoHeaders()
  // O "Json source" do Easy Email lia o bloco com eval; agora é JSON.parse (src/email-studio/build.mjs), e o /* vale para o estúdio também.
  assert.equal(regras["/email-studio/*"], undefined)
  for (const regra of Object.values(regras)) assert.ok(!(regra["Content-Security-Policy"] ?? "").includes("'unsafe-eval'"), regra["Content-Security-Policy"])
})
