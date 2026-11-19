import assert from "node:assert/strict"
import test from "node:test"
import { registerHooks } from "node:module"
registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context) } })
const { filterChoices, moveActive } = await import("./choose-existing-logic")

const itens = [
  { id: "a", label: "Boas-vindas" },
  { id: "b", label: "Carrinho abandonado" },
  { id: "c", label: "Promoção de Páscoa" },
]

test("busca ignora acento e caixa e devolve só o que contém o texto", () => {
  assert.deepEqual(filterChoices(itens, "PASCOA").map(i => i.id), ["c"])
  assert.deepEqual(filterChoices(itens, "  ").map(i => i.id), ["a", "b", "c"])
  assert.deepEqual(filterChoices(itens, "zzz"), [])
})

test("setas andam pela lista sem passar das pontas e Home/End vão às pontas", () => {
  assert.equal(moveActive(0, 3, "ArrowDown"), 1)
  assert.equal(moveActive(2, 3, "ArrowDown"), 2)
  assert.equal(moveActive(0, 3, "ArrowUp"), 0)
  assert.equal(moveActive(1, 3, "End"), 2)
  assert.equal(moveActive(2, 3, "Home"), 0)
  assert.equal(moveActive(0, 0, "ArrowDown"), 0)
})
