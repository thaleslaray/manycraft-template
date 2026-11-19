/// <reference types="node" />
import assert from "node:assert/strict"
import { test } from "node:test"
import { registerHooks } from "node:module"
registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context) } })
const { autoLayout, copySelection, History, pasteClip } = await import("./clipboard")

const node = (id: string, type = "message", selected = false) => ({ id, type, position: { x: 0, y: 0 }, data: { config: { n: id } }, selected })

test("copiar ignora o gatilho e leva só as ligações internas; colar cria ids novos, desloca e seleciona", () => {
  const nodes = [node("t", "trigger", true), node("m1", "message", true), node("m2", "message", true), node("m3")]
  const edges = [{ id: "t:next", source: "t", target: "m1", sourceHandle: "next" }, { id: "m1:next", source: "m1", target: "m2", sourceHandle: "next" }, { id: "m2:next", source: "m2", target: "m3", sourceHandle: "next" }]
  const clip = copySelection(nodes, edges)!
  assert.deepEqual(clip.nodes.map(n => n.id), ["m1", "m2"])
  assert.deepEqual(clip.edges.map(e => e.id), ["m1:next"])
  const once = pasteClip(clip, nodes, edges)
  assert.deepEqual(once.nodes.filter(n => n.selected).map(n => n.id), ["m1-c1", "m2-c1"])
  assert.deepEqual(once.nodes.find(n => n.id === "m1-c1")!.position, { x: 40, y: 40 })
  assert.deepEqual(once.edges.at(-1), { id: "m1-c1:next", source: "m1-c1", target: "m2-c1", sourceHandle: "next" })
  const twice = pasteClip(clip, once.nodes, once.edges)
  assert.ok(twice.nodes.some(n => n.id === "m1-c2"))
  assert.equal(copySelection([node("t", "trigger", true)], []), null)
})

test("histórico desfaz e refaz e ignora estados iguais", () => {
  const history = new History<{ v: number; sel?: boolean }>(s => String(s.v))
  history.record({ v: 1 }, { v: 1, sel: true })
  assert.equal(history.undo({ v: 1 }), undefined)
  history.record({ v: 1 }, { v: 2 })
  history.record({ v: 2 }, { v: 3 })
  assert.deepEqual(history.undo({ v: 3 }), { v: 2 })
  assert.deepEqual(history.undo({ v: 2 }), { v: 1 })
  assert.deepEqual(history.redo({ v: 1 }), { v: 2 })
  history.record({ v: 2 }, { v: 9 })
  assert.equal(history.redo({ v: 9 }), undefined)
})

test("auto-organizar põe cada passo na coluna da distância ao gatilho e os soltos no fim", async () => {
  const nodes = [node("m2"), node("t", "trigger"), node("m1"), node("solto"), { ...node("nota", "note"), position: { x: 5, y: 5 } }]
  const edges = [{ id: "a", source: "t", target: "m1" }, { id: "b", source: "m1", target: "m2" }, { id: "c", source: "t", target: "m2" }]
  const out = autoLayout(nodes, edges, { x: 100, y: 10 }, n => n.type === "note")
  const at = (id: string) => out.find(n => n.id === id)!.position
  assert.deepEqual([at("t"), at("m1"), at("m2"), at("solto"), at("nota")], [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 10 }, { x: 200, y: 0 }, { x: 5, y: 5 }])
})

test("colar em outra conta troca etiquetas, campos e sequências pelo nome e avisa o que não existe", async () => {
  const { collectRefs, remapRefs } = await import("./clipboard")
  const origem = { tag: [{ id: "t1", name: "VIP" }, { id: "t2", name: "Lead" }], field: [{ id: "f1", name: "Cidade" }], sequence: [{ id: "s1", name: "Boas-vindas" }] }
  const destino = { tag: [{ id: "T9", name: "vip" }], field: [{ id: "F9", name: "Cidade" }], sequence: [] }
  const passo = { id: "a", type: "action", position: { x: 0, y: 0 }, selected: true, data: { config: { actions: [{ type: "add_tag", tag_id: "t1" }, { type: "set_custom_field_value", field_id: "f1", value: "x" }, { type: "add_to_sequence", sequence_id: "s1" }], rule: { type: "any_tag", tag_ids: ["t1", "t2"] }, other: { field_id: "first_name" } } } }
  const clip = { ...copySelection([passo], [])!, refs: collectRefs([passo], origem) }
  assert.deepEqual(clip.refs, { t1: { kind: "tag", name: "VIP" }, t2: { kind: "tag", name: "Lead" }, f1: { kind: "field", name: "Cidade" }, s1: { kind: "sequence", name: "Boas-vindas" } })
  const { clip: colado, missing } = remapRefs(clip, destino)
  const config = (colado.nodes[0].data as typeof passo.data).config
  assert.deepEqual(config.actions.map(a => ("tag_id" in a ? a.tag_id : "field_id" in a ? a.field_id : a.sequence_id)), ["T9", "F9", "s1"])
  assert.deepEqual(config.rule.tag_ids, ["T9", "t2"])
  assert.equal(config.other.field_id, "first_name")
  assert.deepEqual(missing.sort(), ['sequência "Boas-vindas"', 'tag "Lead"'])
  // Mesma conta: nada muda nem é avisado.
  assert.deepEqual(remapRefs(clip, origem), { clip: { ...clip, nodes: clip.nodes.map(n => ({ ...n })) }, missing: [] })
})
