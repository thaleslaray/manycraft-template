import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { inventariar, tabelaMarkdown } from "./api-inventario-lib.mjs"

const { Hono } = createRequire(new URL("../engine/package.json", import.meta.url))("hono")

function appMinimo() {
  const app = new Hono()
  app.post("/api/webhooks/x", c => c.text("ok")) // antes do painel: fora do inventário
  app.use("/api/*", async (_c, next) => next())  // middleware não é rota
  const contatos = new Hono()
  contatos.get("/", c => c.text("")).delete("/:id", c => c.text(""))
  app.route("/api/contacts", contatos)
  app.post("/api/api-keys", c => c.text(""))
  app.get("/", c => c.text("")) // fora de /api
  return app
}
const bloqueadas = [{ method: "*", path: "/api/api-keys", motivo: "chave" }]
const fora = p => p.startsWith("/api/webhooks/")

test("app coberto: sem erros e tabela com área e situação", () => {
  const r = inventariar(appMinimo(), { liberadas: ["GET /api/contacts", "DELETE /api/contacts/:id"], bloqueadas, fora })
  assert.deepEqual(r.erros, [])
  assert.deepEqual(r.linhas, [
    { metodo: "POST", caminho: "/api/api-keys", area: "api-keys", situacao: "bloqueada" },
    { metodo: "DELETE", caminho: "/api/contacts/:id", area: "contacts", situacao: "liberada" },
    { metodo: "GET", caminho: "/api/contacts", area: "contacts", situacao: "liberada" },
  ])
  const md = tabelaMarkdown(r.linhas)
  assert.match(md, /\| DELETE \| `\/api\/contacts\/:id` \| contacts \| liberada \|/)
  assert.match(md, /2 liberadas, 1 bloqueadas/)
})

test("rota montada fora das duas listas falha", () => {
  const r = inventariar(appMinimo(), { liberadas: ["GET /api/contacts"], bloqueadas, fora })
  assert.deepEqual(r.erros, ["rota sem lista: DELETE /api/contacts/:id"])
})

test("entrada que sumiu falha (liberada ou bloqueada)", () => {
  const r = inventariar(appMinimo(), {
    liberadas: ["GET /api/contacts", "DELETE /api/contacts/:id", "GET /api/velha"],
    bloqueadas: [...bloqueadas, { method: "POST", path: "/api/sumiu", motivo: "x" }], fora })
  assert.deepEqual(r.erros, ["liberada que sumiu: GET /api/velha", "bloqueada que sumiu: POST /api/sumiu"])
})

test("rota nas duas listas falha", () => {
  const r = inventariar(appMinimo(), { liberadas: ["GET /api/contacts", "DELETE /api/contacts/:id", "POST /api/api-keys"], bloqueadas, fora })
  assert.deepEqual(r.erros, ["rota nas duas listas: POST /api/api-keys"])
})
