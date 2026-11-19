import assert from "node:assert/strict"
import { test } from "node:test"
const { phoneProblem, emailProblem, phoneCountry } = await import("../../../shared/phone.ts")

test("telefone brasileiro: DDD válido e celular com 9", () => {
  assert.equal(phoneProblem("5511987654321"), null)
  assert.equal(phoneProblem("551133334444"), null)
  assert.match(phoneProblem("5511187654321"), /Brasil/)
  assert.match(phoneProblem("55119876543"), /Brasil/)
  assert.equal(phoneCountry("5511987654321")?.name, "Brasil")
})

test("outros países e regra geral", () => {
  assert.equal(phoneProblem("351912345678"), null)
  assert.match(phoneProblem("35191234567"), /Portugal/)
  assert.equal(phoneProblem("14155550123"), null)
  assert.equal(phoneProblem("819012345678"), null)
  assert.match(phoneProblem("123"), /8 a 15/)
})

test("e-mail precisa de um @ e domínio com ponto", () => {
  assert.equal(emailProblem("ana@oficina.com"), null)
  assert.ok(emailProblem("ana.oficina.com"))
  assert.ok(emailProblem("ana@oficina"))
})
