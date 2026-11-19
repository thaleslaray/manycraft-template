import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { test } from "node:test"
import { transformSync } from "esbuild"
import { demoGraph } from "../../../../engine/scripts/seed-telegram.mjs"
import { graphSchema } from "../../../../engine/src/schemas/graph.ts"

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
const ann = await import("./annotations.ts")

const note = { id: "nota-1", kind: "note", position: { x: 300, y: 300 }, size: { w: 220, h: 140 }, color: "yellow", text: "Revisar" }
const group = { id: "grupo-1", kind: "group", position: { x: -40, y: -40 }, size: { w: 700, h: 400 }, color: "blue", title: "Boas-vindas" }
const withAnnotations = () => ({ ...structuredClone(demoGraph), annotations: [note, group] })

test("notas e grupos viram nós do mapa (grupos primeiro) e voltam iguais para o rascunho", () => {
  const flow = graph.toFlow(withAnnotations())
  const kinds = flow.nodes.filter(ann.isAnnotation).map(n => n.type)
  assert.deepEqual(kinds, ["frame", "sticky"])
  assert.equal(flow.nodes.findIndex(n => n.type === "frame"), 0)
  const saved = graph.toGraph(flow.nodes, flow.edges)
  assert.deepEqual(graphSchema.parse(saved).annotations.toSorted((a, b) => a.id.localeCompare(b.id)), [group, note])
  assert.deepEqual(saved.nodes, demoGraph.nodes)
})

test("sem notas o rascunho não ganha a chave annotations", () => {
  const flow = graph.toFlow(structuredClone(demoGraph))
  assert.equal("annotations" in graph.toGraph(flow.nodes, flow.edges), false)
})

test("nota e grupo não geram erro de passo solto nem entram na checagem de publicação", () => {
  const flow = graph.toFlow(withAnnotations())
  const errors = graph.validateGraph(flow.nodes, flow.edges, [])
  assert.equal(errors["nota-1"], undefined)
  assert.equal(errors["grupo-1"], undefined)
})

test("tamanho e posição digitados são limitados ao que o motor aceita", () => {
  assert.deepEqual(ann.clampSize("note", { w: 10, h: 99999 }), { w: 120, h: 2400 })
  assert.deepEqual(ann.clampSize("group", { w: Number.NaN, h: 200 }), { w: 480, h: 200 })
  const flow = graph.toFlow(withAnnotations())
  const sticky = flow.nodes.find(n => n.id === "nota-1")
  sticky.width = 10.4
  sticky.height = 500.6
  const saved = graph.toGraph(flow.nodes, flow.edges).annotations.find(a => a.id === "nota-1")
  assert.deepEqual(saved.size, { w: 120, h: 501 })
})

test("novo item ganha id livre, cor padrão e fica longe de passos existentes", () => {
  const flow = graph.toFlow(withAnnotations())
  const created = ann.createAnnotation("note", flow.nodes, { x: 0, y: 0 })
  assert.equal(created.type, "sticky")
  assert.ok(!flow.nodes.some(n => n.id === created.id))
  assert.equal(created.data.config.color, "yellow")
  const second = ann.createAnnotation("note", [...flow.nodes, created], { x: 0, y: 0 })
  assert.notEqual(second.id, created.id)
  assert.ok(second.position.x !== created.position.x || second.position.y !== created.position.y)
  assert.equal(ann.createAnnotation("group", flow.nodes, { x: 0, y: 0 }).type, "frame")
})

test("mover o grupo leva junto os passos e notas dentro dele, e só eles", () => {
  const flow = graph.toFlow(withAnnotations())
  const frame = flow.nodes.find(n => n.id === "grupo-1")
  frame.width = 400
  frame.height = 300
  frame.position = { x: 0, y: 0 }
  const inside = { id: "dentro", type: "message", position: { x: 50, y: 50 }, data: { config: {} } }
  const outside = { id: "fora", type: "message", position: { x: 900, y: 900 }, data: { config: {} } }
  const nodes = [frame, inside, outside, { ...flow.nodes.find(n => n.id === "nota-1"), position: { x: 100, y: 100 } }]
  const drag = ann.startGroupDrag(frame, nodes)
  assert.deepEqual([...drag.members.keys()].sort(), ["dentro", "nota-1"])
  const moved = ann.dragGroup(nodes, drag, { x: 30, y: -20 })
  assert.deepEqual(moved.find(n => n.id === "dentro").position, { x: 80, y: 30 })
  assert.deepEqual(moved.find(n => n.id === "fora").position, { x: 900, y: 900 })
  assert.deepEqual(moved.find(n => n.id === "nota-1").position, { x: 130, y: 80 })
})

test("remover passos e notas juntos conta cada um separado", () => {
  assert.equal(ann.removedSummary([{ type: "message" }, { type: "action" }, { type: "sticky" }]), "2 passos e 1 nota removidos")
  assert.equal(ann.removedSummary([{ type: "message" }, { type: "sticky" }, { type: "frame" }]), "1 passo e 2 notas removidos")
  assert.equal(ann.removedSummary([{ type: "message" }, { type: "action" }]), "2 passos removidos")
})
