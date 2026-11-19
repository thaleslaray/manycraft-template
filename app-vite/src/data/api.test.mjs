import assert from "node:assert/strict"
import { test, afterEach } from "node:test"
import { registerHooks } from "node:module"

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
  return nextResolve(specifier, context)
} })
const { configureDataMode, isFakeMode, getWorkspace, apiRequest, ApiError } = await import("./api.ts")
const data = await import("./index.ts")
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; configureDataMode(undefined) })
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

test("bootstrap só cria o primeiro espaço para JSON null legítimo, nunca para corpo inválido", async () => {
  configureDataMode("real")
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response("html", { status: 200 })
  }
  await assert.rejects(getWorkspace(), /resposta inválida/)
  assert.deepEqual(calls.map(c => c.url), ["/api/session/workspace"])
  calls.length = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    if (calls.length === 1) return json(null)
    return url === "/api/workspaces" ? json({ id: "new" }, 201) : json({ workspace_id: "new", name: "Meu espaço" })
  }
  assert.deepEqual(await getWorkspace(), { workspace_id: "new", name: "Meu espaço" })
  assert.deepEqual(calls.map(c => c.url), ["/api/session/workspace", "/api/workspaces", "/api/session/workspace"])
  assert.equal(calls[1].init.method, "POST")
})

test("Node preserva fake; override permite contratos reais sem mudar configuração do app", async () => {
  assert.equal(isFakeMode(), true)
  globalThis.fetch = () => { throw new Error("fake não deve usar HTTP") }
  assert.equal((await getWorkspace()).workspace_id, "demo")
  assert.ok((await data.listAutomations("demo")).length)
  configureDataMode("real")
  assert.equal(isFakeMode(), false)
  configureDataMode("fake")
  assert.equal(isFakeMode(), true)
})

test("bootstrap concorrente usa um request e contexto real substitui header/URL do consumidor", async () => {
  configureDataMode("real")
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return url === "/api/session/workspace" ? json({ workspace_id: "real-workspace", name: "Oficina" }) : json({ ok: true })
  }
  await Promise.all([apiRequest("/first"), apiRequest("second", { method: "POST", headers: { "x-workspace": "estranho" }, body: JSON.stringify({ text: "Teste" }) })])
  assert.equal(calls.filter(call => call.url === "/api/session/workspace").length, 1)
  const post = calls.find(call => call.url === "/api/second")
  assert.equal(post.init.headers.get("x-workspace"), "real-workspace")
  assert.equal(post.init.headers.get("Content-Type"), "application/json")
  assert.equal(post.init.cache, "no-store")
})

test("bootstrap com erro pode ser repetido e API preserva erro de domínio/status", async () => {
  configureDataMode("real")
  let tries = 0
  globalThis.fetch = async url => {
    if (url === "/api/session/workspace") return ++tries === 1 ? json({ error: "Dev indisponível" }, 503) : json({ workspace_id: "real", name: "Oficina" })
    return json({ error: "O rascunho mudou. Tente publicar novamente." }, 409)
  }
  await assert.rejects(getWorkspace(), error => error instanceof ApiError && error.status === 503)
  await assert.rejects(data.publishAutomation("auto"), error => error.status === 409 && /rascunho mudou/.test(error.message))
  assert.equal(tries, 2)
})

test("sessão expirada invalida o contexto antes da próxima chamada", async () => {
  configureDataMode("real")
  let bootstraps = 0
  globalThis.fetch = async url => {
    if (url === "/api/session/workspace") { bootstraps++; return json({ workspace_id: "real", name: "Oficina" }) }
    return json({ error: "Entre novamente." }, 401)
  }
  await assert.rejects(apiRequest('/contacts'), error => error.status === 401)
  await assert.rejects(apiRequest('/contacts'), error => error.status === 401)
  assert.equal(bootstraps, 2)
})

test("automação usa filtros T3, identifica ausência e salva/publica o grafo original", async () => {
  configureDataMode("real")
  const calls = []
  const graph = { nodes: [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 }, config: {} }], edges: [] }
  const version = { id: "v1", automation_id: "a/b", version: 1, graph, published_by: null, created_at: "2026-10-23T12:00:00Z" }
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    if (url === "/api/session/workspace") return json({ workspace_id: "real", name: "Oficina" })
    if (url.includes("missing")) return json({ error: "Ausente" }, 404)
    if (url.endsWith("/draft")) return json({ ok: true, updated_at: version.created_at })
    if (url.endsWith("/publish")) return json(version, 201)
    return json([])
  }
  assert.deepEqual(await data.listAutomations("demo", { folder_id: null, status: "live", search: "Guia & curso" }), [])
  const query = new URL(calls[1].url, "http://localhost").searchParams
  assert.equal(query.get("folder_id"), "null")
  assert.equal(query.get("status"), "live")
  assert.equal(query.get("search"), "Guia & curso")
  assert.equal(query.has("workspace"), false)
  assert.equal(await data.getAutomation("demo", "missing"), null)
  await data.saveDraft("a/b", graph)
  const saved = calls.find(call => call.url.endsWith("/draft"))
  assert.equal(saved.url, "/api/automations/a%2Fb/draft")
  assert.equal(saved.init.method, "PUT")
  assert.deepEqual(JSON.parse(saved.init.body), { graph })
  assert.deepEqual(await data.publishAutomation("a/b"), version)
})

test("contatos preservam cursor opaco/filtros, perfil e tags sem seed de demo", async () => {
  configureDataMode("real")
  const calls = []
  const page = { rows: [], next_cursor: "eyJpZCI6IngiKys=", total: 0 }
  const profile = { contact: { id: "real-contact" }, channels: [], tags: [], field_values: [] }
  const tags = [{ id: "tag-real", name: "Interesse" }]
  const folders = { folders: [{ id: "pasta-real", name: "Oficinas", parent_id: null, count: 1 }], total: 1, unfiled: 0, trashed: 2, can_edit: true }
  globalThis.fetch = async url => {
    calls.push(url)
    if (url === "/api/session/workspace") return json({ workspace_id: "real", name: "Oficina" })
    if (url === "/api/tags") return json(tags)
    if (url === "/api/folders") return json(folders)
    if (url.includes("/contacts/missing")) return json({ error: "Ausente" }, 404)
    if (url.includes("/contacts/")) return json(profile)
    if (url.startsWith("/api/automations")) return json([{ id: "real-auto", folder_id: null }])
    return json(page)
  }
  assert.deepEqual(await data.listContacts("demo", page.next_cursor, { search: "João Silva", channel_type: "telegram", tag_id: "tag-real" }), page)
  const query = new URL(calls[1], "http://localhost").searchParams
  assert.equal(query.get("cursor"), page.next_cursor)
  assert.equal(query.get("channel_type"), "telegram")
  assert.equal(query.get("search"), "João Silva")
  assert.deepEqual(await data.getContact("real-contact"), profile)
  assert.equal(await data.getContact("missing"), null)
  assert.deepEqual(await data.listTags("demo"), tags)
  assert.deepEqual(await data.listFolders("demo"), folders)
})

test("erro de rede ou resposta inválida nunca vira dados fake", async () => {
  configureDataMode("real")
  globalThis.fetch = async url => url === "/api/session/workspace" ? json({ workspace_id: "real", name: "Oficina" }) : new Response("html", { status: 200 })
  await assert.rejects(data.listTags("demo"), /resposta inválida/)
  globalThis.fetch = async () => { throw new Error("Offline") }
  await assert.rejects(data.listAutomations("demo"), /Offline/)
})

test("editar contato real grava no motor sem procurar a base de demonstração", async () => {
  configureDataMode("real")
  globalThis.fetch = async (url, init) => {
    if (url === "/api/session/workspace") return json({ workspace_id: "real", name: "Oficina" })
    assert.equal(url, "/api/contacts/real-contact")
    assert.equal(init.method, "PATCH")
    assert.deepEqual(JSON.parse(init.body), { first_name: "Mariana" })
    return json({ id: "real-contact", first_name: "Mariana" })
  }
  assert.equal((await data.updateContact("real-contact", { first_name: "Mariana" })).first_name, "Mariana")
})

test("pausa, tags em lote e campos reais usam o motor", async () => {
  configureDataMode("real")
  const calls = []
  globalThis.fetch = async (url, init) => {
    if (url === "/api/session/workspace") return json({ workspace_id: "real", name: "Oficina" })
    calls.push([url, init.method ?? "GET", init.body && JSON.parse(init.body)])
    if (url === "/api/fields") return json([{ id: "field-real", name: "Cidade" }])
    if (url === "/api/contacts/real/fields/cidade") return json({ ok: true })
    if (url === "/api/contacts/real" && !init.method) return json({ contact: { id: "real" }, field_values: [{ field_id: "cidade", value: "Recife" }] })
    if (url === "/api/contacts/bulk-tag") return json({ count: 2 })
    return json({ id: "real", automation_paused_until: null })
  }
  assert.equal((await data.pauseContact("real", null)).automation_paused_until, null)
  assert.deepEqual(await data.tagContacts(["real", "outro"], "tag-real", "remove"), { count: 2 })
  assert.deepEqual(await data.setFieldValue("real", "cidade", "Recife"), [{ field_id: "cidade", value: "Recife" }])
  assert.equal((await data.listFields("demo"))[0].id, "field-real")
  assert.deepEqual(calls, [
    ["/api/contacts/real/pause", "PUT", { until: null }],
    ["/api/contacts/bulk-tag", "POST", { ids: ["real", "outro"], tag_id: "tag-real", op: "remove" }],
    ["/api/contacts/real/fields/cidade", "PUT", { value: "Recife" }],
    ["/api/contacts/real", "GET", undefined],
    ["/api/fields", "GET", undefined],
  ])
})

test("desativar o link de compartilhamento chama DELETE /automations/:id/share", async () => {
  configureDataMode("real")
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return url === "/api/session/workspace" ? json({ workspace_id: "real", name: "Oficina" }) : json({ revoked: 1 })
  }
  assert.deepEqual(await data.revokeAutomationShare("auto/1"), { revoked: 1 })
  const call = calls.find(c => c.url !== "/api/session/workspace")
  assert.equal(call.url, "/api/automations/auto%2F1/share")
  assert.equal(call.init.method, "DELETE")
  assert.equal(call.init.headers.get("x-workspace"), "real")
})

test("GETs idênticos em voo compartilham um pedido; depois de resolvido, nada fica em cache", async () => {
  configureDataMode("real")
  const calls = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  globalThis.fetch = async (url, init) => {
    if (url === "/api/session/workspace") return json({ workspace_id: "ws", name: "Oficina" })
    calls.push({ url, method: init.method ?? "GET" })
    if (url === "/api/lento") await gate
    if (url === "/api/falha") return json({ error: "ruim" }, 500)
    return json({ n: calls.length })
  }
  const [a, b] = [apiRequest("/lento"), apiRequest("/lento")]
  await new Promise(r => setTimeout(r, 5))
  release()
  assert.deepEqual(await a, await b)
  assert.equal(calls.filter(c => c.url === "/api/lento").length, 1)
  await apiRequest("/lento")
  assert.equal(calls.filter(c => c.url === "/api/lento").length, 2, "resolvido não é reaproveitado")
  await Promise.all([apiRequest("/x", { method: "POST" }), apiRequest("/x", { method: "POST" })])
  assert.equal(calls.filter(c => c.url === "/api/x").length, 2)
  await Promise.all([apiRequest("/y?a=1"), apiRequest("/y?a=2")])
  assert.equal(calls.filter(c => c.url.startsWith("/api/y")).length, 2)
  await assert.rejects(Promise.all([apiRequest("/falha"), apiRequest("/falha")]), /ruim/)
  assert.equal(calls.filter(c => c.url === "/api/falha").length, 1)
  await assert.rejects(apiRequest("/falha"), /ruim/)
  assert.equal(calls.filter(c => c.url === "/api/falha").length, 2)
})
