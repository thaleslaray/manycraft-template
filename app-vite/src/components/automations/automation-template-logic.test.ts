import assert from "node:assert/strict"
import test from "node:test"
import { registerHooks } from "node:module"
registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context) } })
const { listCategories, filterTemplates } = await import("./automation-template-logic")

const modelos = [
  { name: "Boas-vindas", description: "Saúda quem chega", category: "Recepção", trigger: { kind: "welcome_message" } },
  { name: "Link por palavra-chave", description: "Envia o material", category: "Vendas", trigger: { kind: "keyword" } },
  { name: "Horário de atendimento", description: "Avisa fora do horário", category: "Atendimento", trigger: { kind: "keyword" } },
  { name: "Dúvidas frequentes", description: "Responde perguntas", category: "Atendimento", trigger: { kind: "keyword" } },
]

test("categorias: Todos primeiro com o total, depois cada categoria com sua contagem", () => {
  assert.deepEqual(listCategories(modelos), [
    { name: "Todos", count: 4 }, { name: "Recepção", count: 1 }, { name: "Vendas", count: 1 }, { name: "Atendimento", count: 2 },
  ])
})

test("filtro por categoria e busca sem acento nem caixa", () => {
  assert.deepEqual(filterTemplates(modelos, "Atendimento", "").map(m => m.name), ["Horário de atendimento", "Dúvidas frequentes"])
  assert.deepEqual(filterTemplates(modelos, "Todos", "SAUDA").map(m => m.name), ["Boas-vindas"])
  assert.deepEqual(filterTemplates(modelos, "Vendas", "horario"), [])
})

test("filtro por gatilho (Por gatilho) combina com objetivo e busca", () => {
  assert.deepEqual(filterTemplates(modelos, "Todos", "", "welcome_message").map(m => m.name), ["Boas-vindas"])
  assert.deepEqual(filterTemplates(modelos, "Atendimento", "", "keyword").map(m => m.name), ["Horário de atendimento", "Dúvidas frequentes"])
  assert.deepEqual(filterTemplates(modelos, "Vendas", "", "welcome_message"), [])
  assert.deepEqual(filterTemplates(modelos, "Todos", "perguntas", "keyword").map(m => m.name), ["Dúvidas frequentes"])
})
