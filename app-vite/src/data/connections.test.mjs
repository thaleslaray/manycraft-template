import assert from "node:assert/strict"
import { test, afterEach } from "node:test"
import { registerHooks } from "node:module"

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
  return nextResolve(specifier, context)
} })
const { configureDataMode } = await import("./api.ts")
const data = await import("./index.ts")
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; configureDataMode(undefined) })
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

test("modo real: catálogo, lista, criar, trocar, passo do webhook e arquivar falam com as rotas do engine", async () => {
  configureDataMode("real")
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined, workspace: init.headers?.get?.("x-workspace") })
    if (url === "/api/session/workspace") return json({ workspace_id: "ws-real", name: "Oficina" })
    if (init.method === "DELETE") return new Response(null, { status: 204 })
    return json({ ok: true })
  }
  await data.getConnectionCatalog()
  await data.listConnections()
  await data.createConnection({ kind: "telegram", credentials: { botToken: "1:abc" } })
  await data.rotateConnectionCredentials("c 1", { botToken: "1:new" })
  await data.getConnectionWebhookStep("c 1").catch(() => {})
  await data.archiveConnection("c 1")
  const sent = calls.filter((call) => call.url !== "/api/session/workspace").map(({ url, method, body }) => ({ url, method, body }))
  assert.deepEqual(sent, [
    { url: "/api/connections/catalog", method: "GET", body: undefined },
    { url: "/api/connections", method: "GET", body: undefined },
    { url: "/api/connections", method: "POST", body: { kind: "telegram", provider: undefined, displayName: undefined, credentials: { botToken: "1:abc" } } },
    { url: "/api/connections/c%201/rotate", method: "POST", body: { credentials: { botToken: "1:new" } } },
    { url: "/api/connections/c%201/webhook", method: "POST", body: undefined },
    { url: "/api/connections/c%201", method: "DELETE", body: undefined },
  ].map((row) => ({ ...row, body: row.body && JSON.parse(JSON.stringify(row.body)) })))
  assert.ok(calls.filter((call) => call.url !== "/api/session/workspace").every((call) => call.workspace === "ws-real"))
})

test("modo real: erro do engine chega com a mensagem do domínio, sem credencial", async () => {
  configureDataMode("real")
  globalThis.fetch = async (url) => url === "/api/session/workspace" ? json({ workspace_id: "w", name: "O" }) : json({ error: "O provedor não aceitou estas credenciais." }, 422)
  await assert.rejects(data.createConnection({ kind: "telegram", credentials: { botToken: "1:segredo" } }), (error) => error.status === 422 && /não aceitou/.test(error.message) && !error.message.includes("segredo"))
})

test("modo de demonstração: criar, listar, recusar duplicada, trocar e arquivar sem rede", async () => {
  globalThis.fetch = () => { throw new Error("demonstração não usa HTTP") }
  const { channels } = await data.getConnectionCatalog()
  assert.deepEqual(channels.map((row) => row.kind).sort(), ["instagram", "telegram", "whatsapp"])
  assert.equal(channels.find((row) => row.kind === "telegram").providers.length, 1)
  await assert.rejects(data.createConnection({ kind: "telegram", credentials: {} }), /Token do bot/)
  const { connection, step } = await data.createConnection({ kind: "whatsapp", credentials: { accessToken: "a", phoneNumberId: "555", appSecret: "s" } })
  assert.equal(step.kind, "manual_webhook")
  assert.equal(connection.status, "pending")
  assert.equal(JSON.stringify(await data.listConnections()).includes('"accessToken"'), false)
  await assert.rejects(data.createConnection({ kind: "whatsapp", credentials: { accessToken: "a", phoneNumberId: "555", appSecret: "s" } }), /já está conectada/)
  await assert.rejects(data.rotateConnectionCredentials(connection.id, {}), /nova credencial/)
  await data.rotateConnectionCredentials(connection.id, { accessToken: "b" })
  await data.archiveConnection(connection.id)
  assert.equal((await data.listConnections()).some((row) => row.id === connection.id), false)
})

test("modo real: QR e opções da conexão falam com as rotas do engine", async () => {
  configureDataMode("real")
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined })
    return url === "/api/session/workspace" ? json({ workspace_id: "ws-real", name: "Oficina" }) : json({ ok: true })
  }
  await data.pollConnectionPairing("c 1")
  await data.updateConnection("c 1", { settings: { typing: true } })
  assert.deepEqual(calls.filter((call) => call.url !== "/api/session/workspace"), [
    { url: "/api/connections/c%201/connect", method: "POST", body: undefined },
    { url: "/api/connections/c%201", method: "PATCH", body: { settings: { typing: true } } },
  ])
})

test("modo de demonstração: WhatsApp não oficial pede QR, avisa do risco e guarda opções só dele", async () => {
  globalThis.fetch = () => { throw new Error("demonstração não usa HTTP") }
  const { channels } = await data.getConnectionCatalog()
  const whatsapp = channels.find((row) => row.kind === "whatsapp")
  assert.deepEqual(whatsapp.providers.map((row) => row.id), ["meta_whatsapp_cloud", "uazapi"])
  assert.match(whatsapp.providers[1].notice, /bloquear o número/)
  assert.equal(whatsapp.providers[0].options, undefined)
  const { connection, step } = await data.createConnection({ kind: "whatsapp", provider: "uazapi", credentials: { serverUrl: "https://loja.uazapi.com", token: "abcdef123" } })
  assert.equal(step.kind, "qr")
  assert.equal(connection.status, "connecting")
  assert.equal((await data.pollConnectionPairing(connection.id)).step.kind, "done")
  const saved = await data.updateConnection(connection.id, { settings: { typing: true, rejectCallMessage: "Escreva aqui." } })
  assert.deepEqual(saved.settings, { typing: true, rejectCallMessage: "Escreva aqui." })
  assert.deepEqual((await data.updateConnection(connection.id, { settings: { rejectCallMessage: "" } })).settings, { typing: true })
  await assert.rejects(data.updateConnection(connection.id, { settings: { apiBase: "x" } }), /Opção desconhecida/)
  assert.equal(JSON.stringify(await data.listConnections()).includes("abcdef123"), false)
})

test("credenciais são enviadas sem espaço nas pontas e sem campos vazios", async () => {
  configureDataMode("real")
  const bodies = []
  globalThis.fetch = async (url, init = {}) => {
    if (url === "/api/session/workspace") return json({ workspace_id: "w", name: "O" })
    bodies.push(JSON.parse(init.body)); return json({ ok: true })
  }
  await data.createConnection({ kind: "telegram", credentials: { botToken: " 1:abc\n", extra: "  " } })
  await data.rotateConnectionCredentials("c1", { botToken: "2:def " })
  assert.deepEqual(bodies[0].credentials, { botToken: "1:abc" })
  assert.deepEqual(bodies[1].credentials, { botToken: "2:def" })
})

test("demonstração: dois bots do Telegram com tokens diferentes convivem; o mesmo bot é recusado", async () => {
  globalThis.fetch = () => { throw new Error("sem HTTP") }
  await data.createConnection({ kind: "telegram", credentials: { botToken: "111:aaa" } })
  await data.createConnection({ kind: "telegram", credentials: { botToken: "222:bbb" } })
  await assert.rejects(data.createConnection({ kind: "telegram", credentials: { botToken: "111:zzz" } }), /já está conectada/)
})

test("demonstração: o Instagram tem um provedor só, o login unificado, e a conexão nasce nele sem escolher", async () => {
  globalThis.fetch = () => { throw new Error("sem HTTP") }
  const { channels } = await data.getConnectionCatalog()
  const instagram = channels.find((row) => row.kind === "instagram")
  assert.deepEqual(instagram.providers.map((row) => [row.id, row.label]), [["instagram_unified", "Instagram"]])
  assert.match(instagram.providers[0].notice, /Unified login/)
  assert.match(instagram.providers[0].notice, /'O token nunca expira'/)
  const credentials = { accessToken: "t", accountId: "17841400000000001", appSecret: "s" }
  const { connection } = await data.createConnection({ kind: "instagram", credentials })
  assert.equal(connection.provider, "instagram_unified")
  await assert.rejects(data.createConnection({ kind: "instagram", provider: "instagram_unified", credentials }), /arquive-a em Configurações > Canais/)
  await assert.rejects(data.createConnection({ kind: "instagram", provider: "instagram_unified", credentials: { ...credentials, accountId: "abc" } }), /ID da conta do Instagram/)
})

test("revisão de recursos da Meta: o botão aparece para o Instagram unificado conectado, e só conectado", () => {
  for (const provider of ["instagram_unified", "meta_whatsapp_cloud", "messenger_page"]) {
    assert.equal(data.hasMetaReview({ provider, status: "connected" }), true, provider)
    assert.equal(data.hasMetaReview({ provider, status: "pending" }), false, provider)
  }
  assert.equal(data.hasMetaReview({ provider: "telegram_bot", status: "connected" }), false)
})

test("demonstração: confere o formato dos campos como o engine", async () => {
  globalThis.fetch = () => { throw new Error("sem HTTP") }
  await assert.rejects(data.createConnection({ kind: "telegram", credentials: { botToken: "sem-formato" } }), /Token do bot/)
  await assert.rejects(data.createConnection({ kind: "whatsapp", credentials: { accessToken: "a", phoneNumberId: "abc", appSecret: "s" } }), /ID do número/)
})

test("demonstração: cada workspace enxerga só as suas conexões", async () => {
  globalThis.fetch = () => { throw new Error("sem HTTP") }
  await data.createConnection({ kind: "telegram", credentials: { botToken: "333:ccc" } }, "ws-a")
  assert.equal((await data.listConnections("ws-a")).some((row) => row.externalId === "333"), true)
  assert.equal((await data.listConnections("ws-b")).some((row) => row.externalId === "333"), false)
})
