import test from "node:test"
import assert from "node:assert/strict"
import { registerHooks } from "node:module"
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context)
  return next(specifier, context)
} })
const { staleWarning, viaLabel, scopeLabel } = await import("./profile-keys.ts")
const day = 86_400_000
const now = Date.UTC(2026, 10, 17)

test("aviso aparece com 90 dias ou mais sem uso", () => {
  assert.equal(staleWarning({ created_at: now - 200 * day, last_used_at: now - 89 * day }, now), null)
  assert.equal(staleWarning({ created_at: now - 200 * day, last_used_at: now - 90 * day }, now), "Sem uso há 90 dias. Se não precisa mais dela, revogue.")
})

test("chave nunca usada conta desde a criação", () => {
  assert.equal(staleWarning({ created_at: now - 10 * day, last_used_at: null }, now), null)
  assert.equal(staleWarning({ created_at: now - 120 * day, last_used_at: null }, now), "Nunca usada, criada há 120 dias. Se não precisa mais dela, revogue.")
})

test("registro feito pela API mostra nome e final da chave", () => {
  assert.equal(viaLabel({ via: "api", api_key_name: "Zapier", api_key_last4: "1234" }), "pela API (Zapier ••••1234)")
  assert.equal(viaLabel({ via: "api", api_key_name: null, api_key_last4: "1234" }), "pela API (••••1234)")
  assert.equal(viaLabel({ via: "api" }), "pela API")
  assert.equal(viaLabel({ via: "painel" }), null)
  assert.equal(viaLabel({}), null)
})

test("tipo da chave em palavras", () => {
  assert.equal(scopeLabel("read"), "Só ler")
  assert.equal(scopeLabel("write"), "Ler e mudar")
})
