import test from "node:test"
import assert from "node:assert/strict"
const { nomeOuEmail, primeiroNome } = await import("./pessoa.ts")

test("nome vazio cai para o e-mail, sem undefined nem espaço em branco", () => {
  assert.equal(nomeOuEmail("Lia Exemplo", "lia@example.test"), "Lia Exemplo")
  assert.equal(nomeOuEmail("  Lia  ", "lia@example.test"), "Lia")
  for (const vazio of ["", "   ", null, undefined]) assert.equal(nomeOuEmail(vazio, "nova@example.test"), "nova@example.test")
})

test("saudação usa o primeiro nome e nunca o e-mail", () => {
  assert.equal(primeiroNome("Lia Exemplo"), "Lia")
  assert.equal(primeiroNome("  Ana   Ribeiro "), "Ana")
  assert.equal(primeiroNome("nova@example.test"), undefined)
  for (const vazio of ["", "  ", null, undefined]) assert.equal(primeiroNome(vazio), undefined)
})
