import assert from "node:assert/strict"
import { test } from "node:test"
const { typeAndChannel, triggerTypeOf, triggerTypeSql } = await import("../../../shared/trigger-types.ts")

test("a lista e o painel falam 'Tipo · Canal' com o mesmo texto", () => {
  assert.equal(typeAndChannel("ig_comment", "instagram"), "Comentário · Instagram")
  assert.equal(typeAndChannel("ref_url", "messenger"), "Link de referência · Messenger")
  assert.equal(typeAndChannel("welcome", null), "Boas-vindas")
})

test("o tipo do banco vira o tipo da tela por uma tabela só", () => {
  assert.equal(triggerTypeOf("widget", "messenger_ref_url"), "ref_url")
  assert.equal(triggerTypeOf("keyword", null), "dm_keyword")
  assert.match(triggerTypeSql("t"), /t\.widget_type IN \('messenger_ref_url'\) THEN 'ref_url'/)
})
