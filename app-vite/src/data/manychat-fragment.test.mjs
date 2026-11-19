import assert from "node:assert/strict"
import { test } from "node:test"
import { registerHooks } from "node:module"
registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context) } })
const { fragmentCreatedSummary } = await import("./manychat-import.ts")

test("colar da ManyChat avisa as etiquetas, campos, sequências e mídias criadas na conta", () => {
  assert.equal(fragmentCreatedSummary({ references: [{ kind: "tag", name: "VIP", created: false, missing_in_origin: false }], media: [{ source_url: "x", status: "reused" }] }), "")
  assert.equal(fragmentCreatedSummary({
    references: [
      { kind: "tag", name: "VIP", created: true, missing_in_origin: false }, { kind: "tag", name: "Lead", created: true, missing_in_origin: false },
      { kind: "field", name: "Cidade", created: true, missing_in_origin: false }, { kind: "sequence", name: "Boas-vindas", created: false, missing_in_origin: false },
    ],
    media: [{ source_url: "a", status: "copied" }, { source_url: "b", status: "failed" }],
  }), 'Criado nesta conta (fica mesmo sem salvar): etiquetas "VIP", "Lead"; campo "Cidade"; 1 arquivo de mídia copiado.')
})
