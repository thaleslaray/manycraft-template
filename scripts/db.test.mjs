import test from "node:test"
import assert from "node:assert/strict"
import { table, split } from "./db.mjs"

test("split respeita aspas", () => assert.deepEqual(split("SELECT 'a;b'; SELECT 2;"), ["SELECT 'a;b'", "SELECT 2"]))
test("tabela compacta e corta colunas", () => {
  const t = table([{ id: 1, v: "x".repeat(100) }])
  assert.ok(t.split("\n")[2].length < 100)
  assert.equal(table([]), "(0 linhas)")
})
