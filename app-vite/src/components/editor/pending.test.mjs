import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { test } from "node:test"
import { transformSync } from "esbuild"

const src = new URL("../../", import.meta.url)
registerHooks({
  resolve(specifier, context, nextResolve) {
    let target
    if (specifier.startsWith("@/")) target = new URL(specifier.slice(2), src)
    else if (specifier.startsWith(".")) target = new URL(specifier, context.parentURL)
    if (target && !/\.[a-z]+$/i.test(target.pathname)) {
      for (const suffix of [".ts", ".tsx", "/index.ts"]) {
        const candidate = `${fileURLToPath(target)}${suffix}`
        if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context)
      }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (/\.(ts|tsx)$/.test(url) && url.startsWith(src.href)) {
      const loader = url.endsWith(".tsx") ? "tsx" : "ts"
      return { format: "module", shortCircuit: true, source: transformSync(readFileSync(new URL(url), "utf8"), { loader, format: "esm", jsx: "automatic" }).code }
    }
    return nextLoad(url, context)
  },
})
const { pendingSteps, buttonIndicators } = await import("./pending.ts")
const { separateByHeight } = await import("./graph.ts")

const box = (id, x, y, height, width = 280) => ({ id, type: "message", position: { x, y }, measured: { width, height }, data: { config: {} } })

test("nó alto empurra para baixo o que ele cobre, com folga de 40 px, sem mexer na entrada", () => {
  const input = [box("alto", 0, 0, 600), box("baixo", 0, 260, 120)]
  const out = separateByHeight(input)
  assert.equal(out.find(n => n.id === "alto").position.y, 0)
  assert.equal(out.find(n => n.id === "baixo").position.y, 640)
  assert.equal(input[1].position.y, 260, "o estado original não muda")
})

test("quem já está livre fica onde está, inclusive em colunas diferentes", () => {
  const out = separateByHeight([box("a", 0, 0, 600), box("b", 400, 100, 120), box("c", 0, 700, 100)])
  assert.deepEqual(out.map(n => n.position), [{ x: 0, y: 0 }, { x: 400, y: 100 }, { x: 0, y: 700 }])
})

test("o empurrão se propaga em cascata e sem medida nada muda", () => {
  const out = separateByHeight([box("a", 0, 0, 300), box("b", 0, 100, 300), box("c", 0, 200, 100)])
  assert.deepEqual(out.map(n => n.position.y), [0, 340, 680])
  const raw = [{ id: "x", type: "message", position: { x: 0, y: 0 }, data: { config: {} } }, { id: "y", type: "message", position: { x: 0, y: 10 }, data: { config: {} } }]
  assert.deepEqual(separateByHeight(raw).map(n => n.position.y), [0, 10])
})

const node = (id, type, config = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { config } })

test("a lista de pendências traz um item por passo com erro, na ordem do mapa, com o nome do tipo do passo", () => {
  const nodes = [node("t", "trigger"), node("m", "message"), node("loose", "message"), node("a", "action")]
  const errors = { loose: ["Passo solto: ligue a um passo anterior.", "Anexe um arquivo."], a: ["Escolha uma ação."] }
  assert.deepEqual(pendingSteps(nodes, errors), [
    { id: "loose", title: "Mensagem", issue: "Passo solto: ligue a um passo anterior.", more: 1 },
    { id: "a", title: "Ações", issue: "Escolha uma ação.", more: 0 },
  ])
})

test("sem erros a lista é vazia", () => assert.deepEqual(pendingSteps([node("m", "message")], {}), []))

test("os indicadores do botão resumem o que ele faz, em ordem, sem texto cru de endereço", () => {
  assert.deepEqual(buttonIndicators({ kind: "button", id: "b", label: "Ok", action: { type: "go_to_node" } }, false).map(i => i.kind), ["go_to_node"])
  assert.deepEqual(buttonIndicators({ kind: "button", id: "b", label: "Ok", action: { type: "url", url: "https://x.test" } }, true).map(i => i.kind), ["url", "go_to_node"])
  const withActions = buttonIndicators({ kind: "button", id: "b", label: "Ok", action: { type: "go_to_node" }, actions: [{ type: "add_tag", tag_id: "t" }, { type: "set_custom_field_value", field_id: "f", value: 1 }] }, false)
  assert.deepEqual(withActions.map(i => i.kind), ["go_to_node", "tag", "field"])
  assert.ok(withActions.every(i => i.label && !/https?:/.test(i.label)))
})
