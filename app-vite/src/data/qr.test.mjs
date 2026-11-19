import assert from "node:assert/strict"
import { test } from "node:test"
import { registerHooks } from "node:module"

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
  return nextResolve(specifier, context)
} })
const { qrModules } = await import("../lib/qr.ts")

test("o QR dos três tipos de link sai quadrado, com o padrão de localização nos três cantos", () => {
  for (const url of ["https://wa.me/5511999990000?text=Quero%20o%20guia%20abcd2345", "https://m.me/oficina.horizonte?ref=abcd2345", "https://ig.me/m/oficina?ref=abcd2345"]) {
    const m = qrModules(url)
    assert.ok(m.length >= 21 && (m.length - 17) % 4 === 0, `lado ${m.length} não é de uma versão de QR`)
    assert.ok(m.every(row => row.length === m.length))
    const finder = (r, c) => m[r][c] && m[r][c + 6] && m[r + 6][c] && m[r + 6][c + 6] && !m[r + 1][c + 1] && m[r + 2][c + 2]
    assert.ok(finder(0, 0) && finder(0, m.length - 7) && finder(m.length - 7, 0))
  }
})

test("textos diferentes geram QR diferentes e o mesmo texto gera o mesmo QR", () => {
  const a = JSON.stringify(qrModules("https://ig.me/m/oficina?ref=abcd2345"))
  assert.equal(a, JSON.stringify(qrModules("https://ig.me/m/oficina?ref=abcd2345")))
  assert.notEqual(a, JSON.stringify(qrModules("https://ig.me/m/oficina?ref=zzzz2345")))
})
