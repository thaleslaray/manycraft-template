import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { registerHooks } from "node:module"
import { extname } from "node:path"

registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier.startsWith(".") && !extname(specifier) ? `${specifier}.ts` : specifier, context)
} })
const { configureDataMode } = await import("./api.ts")
const keywords = await import("./keywords.ts")
const sequences = await import("./sequences.ts")
const data = await import("./index.ts")
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; configureDataMode(undefined) })
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
const keywordInput = { name: "Nova resposta", channel: "telegram", automation_id: "real-flow", active: true, rules: [{ condition: "word", words: ["ajuda"] }, { condition: "not_contains", words: ["sair"] }] }
const sequenceInput = { name: "Acompanhamento real", steps: [{ id: "step-1", delay_seconds: 61, sending_time_settings: { type: "timelimit", from: "09:00", to: "24:00", weekdays: [1, 3] }, status: "live", automation_id: "real-flow" }] }

function serve(handler) {
  const calls = []
  configureDataMode("real")
  globalThis.fetch = async (url, init) => {
    if (url === "/api/session/workspace") return json({ workspace_id: "trusted-workspace", name: "Oficina" })
    calls.push({ url, init })
    assert.equal(init.headers.get("x-workspace"), "trusted-workspace")
    assert(!url.includes("untrusted"))
    return handler(url, init)
  }
  return calls
}

test("palavras reais usam CRUD, prioridade e ativo sem enviar id/prioridade como dados editáveis", async () => {
  const row = { ...keywordInput, id: "key/one", priority: 0 }
  const calls = serve((url, init) => init.method === "DELETE" ? new Response(null, { status: 204 }) : json(url.endsWith("priority") || !init.method ? [row] : row))
  assert.deepEqual(await keywords.listKeywords("untrusted"), [row])
  assert.deepEqual(await keywords.saveKeyword("untrusted", keywordInput), row)
  await keywords.saveKeyword("untrusted", row, row.id)
  await keywords.setKeywordActive("untrusted", row.id, false)
  assert.deepEqual(await keywords.moveKeyword("untrusted", row.id, 0), [row])
  await keywords.deleteKeyword("untrusted", row.id)
  assert.deepEqual(calls.map(({ url, init }) => [url, init.method ?? "GET"]), [
    ["/api/keywords", "GET"], ["/api/keywords", "POST"], ["/api/keywords/key%2Fone", "PATCH"],
    ["/api/keywords/key%2Fone", "PATCH"], ["/api/keywords/key%2Fone/priority", "PATCH"], ["/api/keywords/key%2Fone", "DELETE"],
  ])
  assert.deepEqual(JSON.parse(calls[2].init.body), keywordInput)
  assert.deepEqual(JSON.parse(calls[3].init.body), { active: false })
  assert.deepEqual(JSON.parse(calls[4].init.body), { target: 0 })
})

test("sequências reais preservam segundos, janela final 24:00 e vínculos nos contratos do servidor", async () => {
  const row = { ...sequenceInput, id: "seq/one", workspace_id: "trusted-workspace", status: "active", subscribers: 2 }
  const flows = [{ id: "real-flow", name: "Resposta publicada", published: true }]
  const calls = serve((url, init) => init.method === "DELETE" ? new Response(null, { status: 204 }) : json(url.endsWith("/flows") ? flows : !init.method ? [row] : row))
  assert.deepEqual(await sequences.listSequences("untrusted"), [row])
  assert.deepEqual(await sequences.listSequenceFlows("untrusted"), flows)
  assert.deepEqual(await sequences.createSequence("untrusted", sequenceInput), row)
  assert.deepEqual(await sequences.updateSequence("untrusted", row.id, sequenceInput), row)
  await sequences.deleteSequence("untrusted", row.id)
  assert.deepEqual(calls.map(({ url, init }) => [url, init.method ?? "GET"]), [
    ["/api/sequences", "GET"], ["/api/sequences/flows", "GET"], ["/api/sequences", "POST"],
    ["/api/sequences/seq%2Fone", "PATCH"], ["/api/sequences/seq%2Fone", "DELETE"],
  ])
  assert.deepEqual(JSON.parse(calls[2].init.body), sequenceInput)
  assert.deepEqual(JSON.parse(calls[3].init.body), sequenceInput)
})

test("gatilho de grupo envia conexão, modo e grupo; o de conversa privada não manda campos de grupo", async () => {
  const calls = serve(() => json({ id: "key-g" }))
  const group = { ...keywordInput, channel: "whatsapp", rules: [], audience: "group", group_match: "mention", connection_id: "uz-a", group_thread_id: "" }
  await keywords.saveKeyword("x", group)
  await keywords.saveKeyword("x", { ...keywordInput, audience: "direct", group_match: null })
  assert.deepEqual(JSON.parse(calls[0].init.body), { name: group.name, channel: "whatsapp", automation_id: "real-flow", active: true, rules: [],
    audience: "group", group_match: "mention", connection_id: "uz-a", group_thread_id: null })
  assert.deepEqual(Object.keys(JSON.parse(calls[1].init.body)).sort(), ["active", "audience", "automation_id", "channel", "name", "rules"])
})

test("erros reais de listagem e mutação propagam sem ler ou gravar o seed", async () => {
  serve(() => json({ error: "Sem acesso a este espaço." }, 403))
  const operations = [
    () => keywords.listKeywords("demo"), () => keywords.saveKeyword("demo", keywordInput),
    () => keywords.setKeywordActive("demo", "keyword-guide", false), () => keywords.moveKeyword("demo", "keyword-guide", 1),
    () => keywords.deleteKeyword("demo", "keyword-guide"), () => keywords.matchKeyword("demo", "instagram", "guia"),
    () => sequences.listSequences("demo"), () => sequences.listSequenceFlows("demo"),
    () => sequences.createSequence("demo", sequenceInput), () => sequences.updateSequence("demo", "seq-acolhimento", sequenceInput),
    () => sequences.deleteSequence("demo", "seq-acolhimento"),
  ]
  for (const operation of operations) await assert.rejects(operation(), error => error.status === 403 && /Sem acesso/.test(error.message))
  configureDataMode("fake")
  assert.equal((await keywords.listKeywords("demo"))[0].active, true)
  assert.equal((await sequences.listSequences("demo"))[0].name, "Acolhimento de novos inscritos")
})

test("modo fake continua isolado e excluir não remove registros de outro workspace", async () => {
  configureDataMode("fake")
  globalThis.fetch = () => { throw new Error("Fake não deve usar rede") }
  const automation = await data.createAutomation("fake-delete", "Resposta de exemplo")
  await data.saveDraft(automation.id, { nodes: [...automation.draft_graph.nodes, { id: "message", type: "message", position: { x: 0, y: 0 }, config: {} }], edges: [] })
  await data.publishAutomation(automation.id)
  const keyword = await keywords.saveKeyword("fake-delete", { ...keywordInput, automation_id: automation.id })
  await assert.rejects(keywords.deleteKeyword("intruder", keyword.id), /não está mais disponível/)
  await keywords.deleteKeyword("fake-delete", keyword.id)
  assert.deepEqual(await keywords.listKeywords("fake-delete"), [])
  const sequence = await sequences.createSequence("fake-delete", { name: "Sequência de exemplo", steps: [] })
  await assert.rejects(sequences.deleteSequence("intruder", sequence.id), /não foi encontrada/)
  await sequences.deleteSequence("fake-delete", sequence.id)
  assert.deepEqual(await sequences.listSequences("fake-delete"), [])
})

test("inscrição em sequência: o rótulo segue o estado do motor (agendada, aguardando a conexão, em andamento, terminada)", () => {
  const at = Date.parse("2026-11-13T12:00:00Z"), fmt = () => "13/11"
  assert.equal(sequences.enrollmentLabel({ state: "running", pending_run_id: "r", next_at: at, connection_ready: 1 }, fmt), "Passo em andamento")
  assert.equal(sequences.enrollmentLabel({ state: "scheduled", pending_run_id: null, next_at: at, connection_ready: 1 }, fmt), "Próximo passo: 13/11")
  assert.equal(sequences.enrollmentLabel({ state: "scheduled", pending_run_id: null, next_at: at, connection_ready: 0 }, fmt), "Próximo passo: 13/11 (aguardando a conexão poder enviar)")
  assert.equal(sequences.enrollmentLabel({ state: "finished", pending_run_id: null, next_at: null, connection_ready: 1 }, fmt), "Sem próximo envio agendado")
  // Resposta antiga, sem state: deriva das colunas como antes.
  assert.equal(sequences.enrollmentLabel({ pending_run_id: null, next_at: at }, fmt), "Próximo passo: 13/11")
})
