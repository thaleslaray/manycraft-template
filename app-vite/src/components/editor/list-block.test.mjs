import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { test } from "node:test"
import { transformSync } from "esbuild"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

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
const graph = await import("./graph.ts")
const { sharedListLimits, emptyList, newListRowId, listError } = await import("./list-block.ts")
const { ChatMessagePanel } = await import("./message-panel.tsx")
const { capabilities } = await import("../../../../engine/src/channels/capabilities.ts")

// A ficha de verdade (a mesma que /connections/capabilities serve), não uma lista copiada.
const connection = (id, kind, patch = {}) => ({ id, kind, status: "connected", displayName: `Conexão ${id}`, profile: { ...capabilities(kind), ...patch } })
const trigger = (kind, id) => ({ id: `t-${id}`, channel_type: kind, channel_id: id, node_id: "trigger", type: "dm_keyword", active: true, config: {}, keywords: [] })
const list = () => ({ kind: "list", buttonText: "Ver assuntos", sections: [{ title: "Vendas", rows: [{ id: "l1", title: "Preços" }, { id: "l2", title: "Planos", description: "Mensal" }] }, { title: "Ajuda", rows: [{ id: "l3", title: "Suporte" }] }] })
const step = (blocks, channel) => ({ id: "m", type: "message", position: { x: 0, y: 0 }, data: { config: { channel, blocks } } })

const render = (node, connections, triggers) => renderToStaticMarkup(React.createElement(ChatMessagePanel, {
  node, nodes: [node], edges: [], triggers, tags: [], connections, readOnly: false, errors: [], showErrors: false,
  updateConfig() {}, setLink() {}, onClose() {}, onDeleteNode() {}, onTriggerChange() {},
}))

test("o painel oferece Lista de opções só quando a ficha do canal declara lista", () => {
  const wa = render(step([{ kind: "text", text: "Oi" }], "whatsapp"), [connection("wa", "whatsapp")], [trigger("whatsapp", "wa")]).replaceAll("<!-- -->", "")
  assert.match(wa, /Lista de opções/)
  for (const kind of ["instagram", "telegram"]) {
    const html = render(step([{ kind: "text", text: "Oi" }], kind), [connection("c", kind)], [trigger(kind, "c")])
    assert.doesNotMatch(html, /Lista de opções/, `${kind} não declara lista`)
  }
})

test("duas conexões do canal: sem lista em uma delas, o painel não oferece; com lista nas duas, vale o menor limite", () => {
  const semLista = connection("wa2", "whatsapp", { list: null })
  assert.doesNotMatch(render(step([{ kind: "text", text: "Oi" }], "whatsapp"), [connection("wa", "whatsapp"), semLista], [trigger("whatsapp", "wa")]), /Lista de opções/)
  const apertada = connection("wa3", "whatsapp", { list: { maxRows: 4, maxSections: 2, rowTitleMax: 20, rowDescMax: 50 } })
  assert.deepEqual(sharedListLimits([connection("wa", "whatsapp"), apertada]), { maxRows: 4, maxSections: 2, rowTitleMax: 20, rowDescMax: 50 })
  assert.equal(sharedListLimits([]), null)
})

test("o bloco de lista aparece no painel com os campos e o contador do limite da ficha", () => {
  const html = render(step([{ kind: "text", text: "Oi" }, list()], "whatsapp"), [connection("wa", "whatsapp")], [trigger("whatsapp", "wa")]).replaceAll("<!-- -->", "")
  for (const text of ["Texto do botão que abre a lista", "Título da seção 2", "Título da opção 3", "Descrição da opção 2 (opcional)", "6 / 24", "Adicionar seção"]) assert.ok(html.includes(text), text)
})

test("cada opção da lista ganha uma saída no mapa, na ordem das seções", () => {
  const ports = graph.outputPorts(step([{ kind: "text", text: "Oi" }, list()], "whatsapp")).map(p => p.port)
  assert.deepEqual(ports, ["btn:l1", "btn:l2", "btn:l3", "next"])
})

test("publicar no editor recusa lista sem saída ligada, acima do limite da ficha e em canal sem lista", () => {
  const wa = connection("wa", "whatsapp")
  const t = trigger("whatsapp", "wa")
  const node = step([{ kind: "text", text: "Oi" }, list()], "whatsapp")
  const target = { id: "x", type: "message", position: { x: 0, y: 0 }, data: { config: { channel: "whatsapp", blocks: [{ kind: "text", text: "Fim" }] } } }
  assert.match(graph.validateGraph([node, target], [], [t], { connections: [wa] }).m.join(" "), /Opção “Preços” da lista não leva a nenhum passo/)
  const linked = ["l1", "l2", "l3"].map(id => ({ id, source: "m", sourceHandle: `btn:${id}`, target: "x" }))
  assert.doesNotMatch((graph.validateGraph([node, target], linked, [t], { connections: [wa] }).m ?? []).join(" "), /lista/)
  const big = list(); big.sections[0].rows = Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, title: `Opção ${i}` }))
  assert.match(graph.validateGraph([step([{ kind: "text", text: "Oi" }, big], "whatsapp"), target], [], [t], { connections: [wa] }).m.join(" "), /até 10 opções/)
  const tg = connection("tg", "telegram")
  assert.match(graph.validateGraph([step([{ kind: "text", text: "Oi" }, list()], "telegram"), target], [], [trigger("telegram", "tg")], { connections: [tg] }).m.join(" "), /não oferece lista/)
})

test("lista nova nasce com duas opções e identificadores que não se repetem", () => {
  const block = emptyList()
  assert.deepEqual(block.sections[0].rows.map(r => r.id), ["l1", "l2"])
  assert.equal(newListRowId(block), "l3")
  assert.equal(listError([{ kind: "text", text: "Oi" }, block], [capabilities("whatsapp")]), "Dê um texto ao botão que abre a lista.")
})
