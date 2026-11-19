import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { transformSync } from "esbuild"

const code = transformSync(readFileSync(new URL("./post-choice.ts", import.meta.url), "utf8"), { loader: "ts", format: "esm" }).code
const m = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)

test("sem permissão de listar, só 'todas'", () => {
  assert.deepEqual(m.buildPostChoices([{ id: "1" }], false).map(c => c.kind), ["all"])
})
test("com posts: todas, próxima e cada publicação", () => {
  const c = m.buildPostChoices([{ id: "1", caption: "Guia" }, { id: "2" }], true)
  assert.deepEqual(c.map(x => x.label), ["Todas as publicações ou Reels", "A próxima publicação", "Guia", "Publicação 2"])
})
test("escolher post vira alvo específico; todas/próxima limpam o post", () => {
  const [all, next, post] = m.buildPostChoices([{ id: "1", caption: "Guia" }], true)
  assert.equal(m.postChoicePatch(post).target, "specific")
  assert.equal(m.postChoicePatch(post).post_id, "1")
  assert.deepEqual(m.postChoicePatch(next), { target: "next", post_id: undefined, post_snapshot: undefined })
  assert.equal(m.postChoicePatch(all).target, "all")
})
test("nome do gatilho no nó", () => {
  assert.equal(m.triggerNodeTitle(["ig_comment"]), "Comentário no post")
  assert.equal(m.triggerNodeTitle([]), "Gatilho")
  assert.equal(m.triggerNodeTitle(["ig_comment", "dm_keyword"]), "Gatilhos")
})
