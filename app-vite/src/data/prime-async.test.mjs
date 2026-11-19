import assert from "node:assert/strict"
import { test } from "node:test"
const { primeAsync, clearAsyncCache, forgetAsync } = await import("../hooks/use-async.ts")
const keys = await import("./screen-keys.ts")

test("aquecimento grava e não repete enquanto o dado tem menos de 30 s", async () => {
  clearAsyncCache()
  let calls = 0
  const fn = async () => { calls++; return { ok: true } }
  await primeAsync("tela|a", fn)
  await primeAsync("tela|a", fn)
  assert.equal(calls, 1)
})

test("dois aquecimentos ao mesmo tempo viram um pedido só", async () => {
  clearAsyncCache()
  let calls = 0
  let release
  const fn = () => { calls++; return new Promise(resolve => { release = resolve }) }
  const first = primeAsync("tela|b", fn)
  const second = primeAsync("tela|b", fn)
  await new Promise(r => setTimeout(r, 0))
  release("dado")
  await Promise.all([first, second])
  assert.equal(calls, 1)
})

test("erro é engolido e não grava: o próximo aquecimento tenta de novo", async () => {
  clearAsyncCache()
  let calls = 0
  await primeAsync("tela|c", async () => { calls++; throw new Error("falhou") })
  await primeAsync("tela|c", async () => { calls++; return 1 })
  assert.equal(calls, 2)
})

test("dado com mais de 30 s pode ser aquecido de novo", async () => {
  clearAsyncCache()
  const realNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    let calls = 0
    const fn = async () => { calls++; return calls }
    await primeAsync("tela|d", fn)
    now += 29_000
    await primeAsync("tela|d", fn)
    assert.equal(calls, 1)
    now += 2_000
    await primeAsync("tela|d", fn)
    assert.equal(calls, 2)
  } finally { Date.now = realNow }
})

test("identidades das telas no formato que o cache já usava", () => {
  assert.equal(keys.inboxListKey("ws", keys.inboxListFilter(keys.inboxDefaults)), 'inbox-list|ws|{"folder":"all","status":"open","channel":"all","unread":false,"sort":"newest","search":""}')
  assert.equal(keys.contactsListKey("ws", { tagId: null, q: "", advanced: { match: "all", rules: [] }, emailFilters: {}, onlySubscribed: true }), 'contacts|ws|null||{"match":"all","rules":[]}|{}|true')
  assert.deepEqual(keys.contactsListFilter(null, "", {}, true), { search: "", status: "subscribed" })
  assert.deepEqual(keys.contactsListFilter("trigger:t1", "ana", {}, false), { trigger_id: "t1", search: "ana" })
  assert.equal(keys.dashboardKey("ws", keys.dashboardDefaults.period, keys.dashboardDefaults.channel), "dashboard|ws|7|all")
  assert.equal(keys.insightsKey("ws", keys.insightsDefaults.period, keys.insightsDefaults.channel), "insights|ws|7|all")
})

test("forgetAsync descarta todas as variações do prefixo e mais nada", async () => {
  clearAsyncCache()
  let calls = 0
  const fn = async () => ++calls
  await primeAsync("automation-library|ws|{\"trash\":false}", fn)
  await primeAsync("automation-library|ws|{\"trash\":true}", fn)
  await primeAsync("automation-folders|ws", fn)
  assert.equal(calls, 3)
  forgetAsync("automation-library|")
  // As duas variações da lista pedem de novo; as pastas seguem frescas no cache.
  await primeAsync("automation-library|ws|{\"trash\":false}", fn)
  await primeAsync("automation-library|ws|{\"trash\":true}", fn)
  await primeAsync("automation-folders|ws", fn)
  assert.equal(calls, 5)
})

test("leitura que começou antes do descarte não grava o estado de antes da gravação", async () => {
  clearAsyncCache()
  let release
  let calls = 0
  const slow = () => { calls++; return new Promise(resolve => { release = resolve }) }
  const old = primeAsync("automation-library|ws|x", slow)
  await new Promise(r => setTimeout(r, 0))
  forgetAsync("automation-library|")
  release("antes da gravação")
  await old
  // Nada ficou no cache: o próximo aquecimento pede de novo.
  await primeAsync("automation-library|ws|x", async () => { calls++; return "depois" })
  assert.equal(calls, 2)
})

test("gravações descartam o cache das telas que mudam; leituras não", () => {
  assert.deepEqual(keys.staleAfterWrite("GET", "/automations"), [])
  for (const path of ["/automations/a1", "/automations/a1/draft", "/automations/a1/trash", "/folders/f1?move_items=1", "/keywords/automation", "/triggers/t1/replace", "/quick-automations", "/automation-templates", "/basic/c1/welcome"])
    assert.ok(keys.staleAfterWrite("POST", path).includes("automation-library|"), path)
  assert.ok(keys.staleAfterWrite("POST", "/automation-templates").includes("installed-templates|"))
  assert.deepEqual(keys.staleAfterWrite("PATCH", "/workspace-settings"), ["settings-general|"])
  assert.deepEqual(keys.staleAfterWrite("DELETE", "/api-keys"), ["settings-api|"])
  assert.deepEqual(keys.staleAfterWrite("POST", "/settings-folders"), ["settings-fields|", "settings-tags|"])
  assert.deepEqual(keys.staleAfterWrite("PUT", "/inbox/assignment-rules"), ["inbox-assignment|"])
  assert.deepEqual(keys.staleAfterWrite("POST", "/inbox/labels"), ["inbox-labels-settings|", "inbox-labels|"])
  // "/teams" não é "/team"; "/automation-library" é leitura de outra rota.
  assert.deepEqual(keys.staleAfterWrite("POST", "/teams"), [])
  assert.deepEqual(keys.staleAfterWrite("POST", "/automation-library"), [])
})

test("filtro da lista de automações: abertura pelo menu é a raiz, igual ao que a tela calcula do endereço", () => {
  const root = keys.automationLibraryFilter(new URLSearchParams())
  assert.equal(keys.automationLibraryKey("ws", root), 'automation-library|ws|{"folder_id":null,"trash":false}')
  assert.equal(JSON.stringify(keys.automationLibraryFilter(new URLSearchParams("view=all"))), '{"trash":false}')
  assert.equal(JSON.stringify(keys.automationLibraryFilter(new URLSearchParams("folder=f1&search=oi"))), '{"folder_id":"f1","trash":false,"search":"oi"}')
  assert.equal(JSON.stringify(keys.automationLibraryFilter(new URLSearchParams("view=trash"))), '{"trash":true}')
  assert.equal(JSON.stringify(keys.automationLibraryFilter(new URLSearchParams("folder=none"))), '{"folder_id":null,"trash":false}')
})
