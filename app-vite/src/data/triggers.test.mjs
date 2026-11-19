import assert from "node:assert/strict"
import { test, afterEach } from "node:test"
import { registerHooks } from "node:module"

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
  return nextResolve(specifier, context)
} })
const { configureDataMode, ApiError } = await import("./api.ts")
const data = await import("./index.ts")
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; configureDataMode(undefined) })
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
const engineTrigger = {
  id: "trigger/real", automation_id: "automation/real", workspace_id: "workspace-real",
  channel_id: "telegram-real", channel_type: "telegram", node_id: "trigger", type: "dm_keyword",
  name: "Pedido do link", enabled: true, created_at: "2026-10-23T12:00:00Z", updated_at: "2026-10-23T12:00:00Z",
  keywords: [{ id: "keyword-real", rule: "is", words: ["quero"], status: "live", case_sensitive: false, parent_id: null, priority: 0 }],
}
const withApi = handler => {
  configureDataMode("real")
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return url === "/api/session/workspace" ? json({ workspace_id: "workspace-real", name: "Oficina" }) : handler(url, init)
  }
  return calls
}

test("gatilhos reais adaptam rows/enabled preservando canal, vínculo ao nó e regras do motor", async () => {
  const calls = withApi(() => json({ rows: [engineTrigger] }))
  const [trigger] = await data.listAutomationTriggers("automation/real")
  assert.equal(calls[1].url, "/api/automations/automation%2Freal/triggers")
  assert.equal(calls[1].init.headers.get("x-workspace"), "workspace-real")
  assert.equal(trigger.active, true)
  assert.equal(trigger.channel_type, "telegram")
  assert.equal(trigger.node_id, "trigger")
  assert.deepEqual(trigger.keywords, engineTrigger.keywords)
  assert.deepEqual(trigger.config, { target: "all", include: [], exclude: [], public_replies: [] })
  assert.equal("enabled" in trigger, false)
  assert.match(data.summarizeTrigger(trigger), /quero/)
})

test("detalhe carrega os gatilhos pela rota real em vez do campo legado da automação", async () => {
  const detail = { automation: { id: "automation/real" }, published_version: null, triggers: [{ id: "legacy-fake" }] }
  const calls = withApi(url => json(url.endsWith("/triggers") ? { rows: [engineTrigger] } : detail))
  const result = await data.getAutomation("demo", "automation/real")
  assert.deepEqual(result.automation, detail.automation)
  assert.equal(result.triggers[0].id, "trigger/real")
  assert.equal(result.triggers[0].active, true)
  assert.equal(calls.length, 3)
})

test("edição envia PATCH com keyword_id, words, rule e enabled e adapta resposta persistida", async () => {
  const patch = { keyword_id: "keyword-real", words: ["guia", "quero guia"], rule: "contains", enabled: false }
  const calls = withApi(() => json({ ...engineTrigger, enabled: false, keywords: [{ ...engineTrigger.keywords[0], words: patch.words, rule: patch.rule }] }))
  const result = await data.updateKeywordTrigger("automation/real", "trigger/real", patch)
  const request = calls[1]
  assert.equal(request.url, "/api/automations/automation%2Freal/triggers/trigger%2Freal")
  assert.equal(request.init.method, "PATCH")
  assert.deepEqual(JSON.parse(request.init.body), patch)
  assert.equal(result.active, false)
  assert.deepEqual(result.keywords[0].words, patch.words)
  assert.equal(result.keywords[0].rule, "contains")
})

test("falha de listagem ou edição propaga erro real sem dados fake ou sucesso aparente", async () => {
  withApi(() => json({ error: "Sem permissão" }, 403))
  await assert.rejects(data.listAutomationTriggers("automation/real"), e => e instanceof ApiError && e.status === 403)
  await assert.rejects(data.getAutomation("demo", "automation/real"), e => e.status === 403)
  await assert.rejects(data.updateKeywordTrigger("automation/real", "trigger/real", { enabled: false }), e => e.status === 403)
  withApi(() => new Response("html inválido"))
  await assert.rejects(data.listAutomationTriggers("automation/real"), /resposta inválida/)
})

test("fake mantém comentário Instagram e edita palavra-chave com o mesmo contrato", async () => {
  configureDataMode("fake")
  globalThis.fetch = () => { throw new Error("Fake não deve fazer HTTP") }
  const [comment] = await data.listAutomationTriggers("auto-quero")
  assert.equal(comment.type, "ig_comment")
  const [keyword] = await data.listAutomationTriggers("auto-faq")
  assert.equal(keyword.type, "dm_keyword")
  assert.ok(keyword.keywords.length)
  const original = structuredClone(keyword)
  try {
    const updated = await data.updateKeywordTrigger("auto-faq", keyword.id, {
      keyword_id: keyword.keywords[0].id, words: ["teste w3"], rule: "starts_with", enabled: true,
    })
    assert.equal(updated.active, true)
    assert.equal(updated.keywords[0].rule, "starts_with")
    assert.deepEqual(updated.keywords[0].words, ["teste w3"])
    const [persisted] = await data.listAutomationTriggers("auto-faq")
    assert.deepEqual(persisted.keywords, updated.keywords)
  } finally {
    await data.updateKeywordTrigger("auto-faq", keyword.id, { keyword_id: original.keywords[0].id,
      words: original.keywords[0].words, rule: original.keywords[0].rule, enabled: original.active })
  }
})

test("comentário real preserva configuração, snapshot e curtir e salva pela rota persistida", async () => {
  const config = { target: "specific", post_id: "post-real", post_snapshot: { id: "post-real", caption: "Guia", publishedAt: 1770000000000 }, include: ["guia"], exclude: ["não"], public_replies: ["Enviei"], like_comment: true }
  const comment = { ...engineTrigger, type: "ig_comment", config, keywords: [] }
  const calls = withApi(() => json(comment))
  const result = await data.upsertTrigger("automation/real", { id: "trigger/real", channel_id: "connection/real", config, active: true })
  assert.equal(calls[1].url, "/api/automations/automation%2Freal/triggers/trigger%2Freal")
  assert.equal(calls[1].init.method, "PATCH")
  assert.deepEqual(JSON.parse(calls[1].init.body), { connection_id: "connection/real", config, enabled: true })
  assert.deepEqual(result.config, config)
  assert.equal(result.active, true)
})

test("comentário real salva a política de disparo escolhida e a devolve ao reabrir", async () => {
  const config = { target: "all", include: [], exclude: [], public_replies: [] }
  for (const repeat_mode of ["every_time", "once_per_24_hours", "once"]) {
    const calls = withApi(() => json({ ...engineTrigger, type: "ig_comment", config, keywords: [], repeat_mode }))
    const result = await data.upsertTrigger("automation/real", { id: "trigger/real", channel_id: "connection/real", config, active: true, repeat_mode })
    assert.equal(JSON.parse(calls[1].init.body).repeat_mode, repeat_mode)
    assert.equal(result.repeat_mode, repeat_mode)
  }
})

test("publicações reais vêm da conexão e falhas não caem no catálogo de demonstração", async () => {
  const post = { id: "post-real", caption: "Post do provedor", mediaType: "IMAGE", publishedAt: 1770000000000 }
  const calls = withApi(() => json({ posts: [post], nextCursor: null }))
  assert.deepEqual(await data.listIgPosts("connection/real"), [post])
  assert.equal(calls[1].url, "/api/connections/connection%2Freal/posts")
  await assert.rejects(data.listIgPosts(null), /conexão/)
  withApi(() => json({ error: "Publicações indisponíveis" }, 503))
  await assert.rejects(data.listIgPosts("connection/real"), /Publicações indisponíveis/)
})

test("cria comentário real com nó e conexão sem campos de palavra-chave", async () => {
  const input = { name: "Guia nos comentários", connection_id: "connection/real", node_id: "trigger" }
  const calls = withApi(() => json({ ...engineTrigger, type: "ig_comment", enabled: false, config: { target: "all", include: [], exclude: [], public_replies: [] }, keywords: [] }))
  const saved = await data.createCommentTrigger("automation/real", input)
  assert.equal(calls[1].init.method, "POST")
  assert.deepEqual(JSON.parse(calls[1].init.body), { ...input, type: "ig_comment", config: { target: "all", include: [], exclude: [], public_replies: [] } })
  assert.equal(saved.type, "ig_comment")
})


test("seletor de publicações alcança posts das páginas seguintes", async () => {
  const recent = { id: "recent", caption: "Recente" }, older = { id: "older", caption: "Anterior" }
  const calls = withApi(url => json(url.includes("after=") ? { posts: [older], nextCursor: null } : { posts: [recent], nextCursor: "cursor/antigo" }))
  assert.deepEqual(await data.listIgPosts("connection/real"), [recent, older])
  assert.equal(calls[2].url, "/api/connections/connection%2Freal/posts?after=cursor%2Fantigo")
})

test("gatilhos de story criam e salvam pela rota persistida com o contrato do motor", async () => {
  const reply = { ...engineTrigger, type: "ig_story_reply", enabled: false, state: "initial", config: { target: "all", rule: "any", words: [], include: [], exclude: [], public_replies: [] }, keywords: [] }
  let calls = withApi(() => json(reply))
  const created = await data.createStoryTrigger("automation/real", { type: "ig_story_reply", name: "Resposta ao story", connection_id: "connection/real", node_id: "trigger" })
  assert.equal(calls[1].init.method, "POST")
  assert.deepEqual(JSON.parse(calls[1].init.body), { type: "ig_story_reply", name: "Resposta ao story", connection_id: "connection/real", node_id: "trigger", config: { target: "all", rule: "any", words: [] } })
  assert.equal(created.type, "ig_story_reply")
  const config = { target: "specific", post_id: "story-1", post_snapshot: { id: "story-1", caption: "Hoje" }, rule: "contains", words: ["preço"], include: [], exclude: [], public_replies: [] }
  calls = withApi(() => json({ ...reply, config }))
  await data.saveStoryTrigger("automation/real", { ...created, id: "trigger/real" }, { connection_id: "connection/real", config, state: "active", repeat_mode: "once_per_24_hours" })
  assert.equal(calls[1].url, "/api/automations/automation%2Freal/triggers/trigger%2Freal")
  assert.deepEqual(JSON.parse(calls[1].init.body), { connection_id: "connection/real", state: "active", repeat_mode: "once_per_24_hours",
    config: { target: "specific", post_id: "story-1", post_snapshot: { id: "story-1", caption: "Hoje" }, rule: "contains", words: ["preço"], delay_seconds: 0, heart: false } })
  const mention = { ...engineTrigger, type: "ig_story_mention", enabled: true, config: { target: "all", delay_seconds: 300, heart: true, include: [], exclude: [], public_replies: [] }, keywords: [] }
  calls = withApi(() => json(mention))
  await data.saveStoryTrigger("automation/real", { ...created, id: "trigger/mention", type: "ig_story_mention" }, { connection_id: "connection/real", config: mention.config, state: "active", repeat_mode: "every_time" })
  assert.deepEqual(JSON.parse(calls[1].init.body), { connection_id: "connection/real", state: "active", repeat_mode: "every_time", config: { delay_seconds: 300, heart: true } })
})

test("stories ativos vêm da conexão e resumo descreve a condição", async () => {
  const story = { id: "story-1", caption: "Hoje", publishedAt: 1770000000000 }
  const calls = withApi(() => json({ posts: [story], nextCursor: null }))
  assert.deepEqual(await data.listIgStories("connection/real"), [story])
  assert.equal(calls[1].url, "/api/connections/connection%2Freal/stories")
  await assert.rejects(data.listIgStories(null), /conexão/)
  assert.equal(data.summarizeTrigger({ type: "ig_story_reply", config: { target: "specific", rule: "contains", words: ["preço"], include: [], exclude: [], public_replies: [] } }), "Quando alguém responde a um story específico com “preço”")
  assert.equal(data.summarizeTrigger({ type: "ig_story_mention", config: { target: "all", include: [], exclude: [], public_replies: [] } }), "Quando alguém menciona você em um story")
})
