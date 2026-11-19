/// <reference types="node" />
import assert from "node:assert/strict"
import { test } from "node:test"
import { registerHooks } from "node:module"
registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context) } })
const { mergeKeywords, withPending } = await import("./keyword-merge")

test("texto pendente entra na lista final, aparado e sem repetir", () => {
  assert.deepEqual(withPending([], "  teste123 "), ["teste123"])
  assert.deepEqual(withPending(["Oi"], "oi"), ["Oi"])
  assert.deepEqual(withPending(["a"], "   "), ["a"])
  assert.deepEqual(withPending([], "a, b"), ["a", "b"])
})

test("merge respeita limite e avisa repetida", () => {
  const r = mergeKeywords(["a", "b"], ["A", "c"], 3)
  assert.deepEqual(r.next, ["a", "b", "c"])
  assert.equal(r.dup, "A")
  assert.equal(mergeKeywords(["a"], ["b"], 1).full, true)
})
