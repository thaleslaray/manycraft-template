/// <reference types="node" />
import assert from "node:assert/strict"
import test from "node:test"
import { registerHooks } from "node:module"
registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context) } })
const { recipientsLabel, reportStats } = await import("./broadcast-editor-logic")

test("contador de destinatários: singular, plural e carregando", () => {
  assert.deepEqual(recipientsLabel(undefined, true), { value: "…", text: "Calculando público" })
  assert.deepEqual(recipientsLabel(1, false), { value: "1", text: "contato receberá esta transmissão" })
  assert.deepEqual(recipientsLabel(0, false), { value: "0", text: "contatos receberão esta transmissão" })
  assert.deepEqual(recipientsLabel(2500, false), { value: "2.500", text: "contatos receberão esta transmissão" })
})

const { newBroadcastFlow, flowStart, flowContent } = await import("./broadcast-editor-logic")
const step = (id: string, text: string) => ({ id, type: "message" as const, position: { x: 0, y: 0 }, config: { blocks: [{ kind: "text", text }] } })

test("fluxo novo da transmissão: um passo de mensagem no canal, sem gatilho", () => {
  const flow = newBroadcastFlow("telegram", "Olá")
  assert.deepEqual(flow.edges, [])
  assert.equal(flow.nodes.length, 1)
  assert.deepEqual(flow.nodes[0], { id: "broadcast-message", type: "message", position: { x: 0, y: 0 }, config: { blocks: [{ kind: "text", text: "Olá" }], channel: "telegram" } })
})

test("o início do envio é o passo sem ligação de entrada; o conteúdo é o texto dele", () => {
  const flow = { nodes: [step("b", "Segundo"), step("a", "Primeiro")], edges: [{ from: "a", port: "next", to: "b" }] }
  assert.equal(flowStart(flow)?.id, "a")
  assert.equal(flowContent(flow), "Primeiro")
  assert.equal(flowStart({ nodes: [step("a", "x"), step("b", "y")], edges: [] }), undefined)
  assert.equal(flowContent({ nodes: [], edges: [] }), "")
})

test("o mapa da transmissão não mostra o gatilho de uma cópia de automação nem as ligações dele", async () => {
  const { withoutTrigger } = await import("./broadcast-editor-logic")
  const gatilho = { id: "g", type: "trigger" as const, position: { x: 0, y: 0 }, config: {} }
  const flow = { nodes: [gatilho, step("a", "Um")], edges: [{ from: "g", port: "next", to: "a" }] }
  assert.deepEqual(withoutTrigger(flow), { nodes: [step("a", "Um")], edges: [] })
})

test("trocar de conexão leva o canal para os passos de mensagem e mantém as ligações", async () => {
  const { retargetFlow } = await import("./broadcast-editor-logic")
  const flow = { nodes: [step("a", "Um"), step("b", "Dois")], edges: [{ from: "a", port: "next", to: "b" }] }
  const next = retargetFlow(flow, "whatsapp")
  assert.deepEqual(next.nodes.map(node => node.config.channel), ["whatsapp", "whatsapp"])
  assert.deepEqual(next.edges, flow.edges)
})

test("métricas por nó do relatório: cada mensagem com os seus números, o total no passo único", () => {
  const flow = { nodes: [{ id: "a", type: "message", position: { x: 0, y: 0 }, config: {} }, { id: "b", type: "message", position: { x: 0, y: 0 }, config: {} }], edges: [{ from: "a", from_port: "next", to: "b" }] } as never
  const total = { sent: 5, delivered: 4, read: 3, clicked: 2, failed: 0, queued: 0, skipped: 0, uncertain: 0 }
  const varias = reportStats(flow, { ...total, messages: [{ node_id: "a", summary: "x", sent: 5, delivered: 4, read: 3, clicked: 2 }, { node_id: "b", summary: "y", sent: 5, delivered: 1, read: 0, clicked: 0 }] })
  assert.deepEqual(varias.nodes, { a: { sent: 5, delivered: 4, read: 3, clicked: 2 }, b: { sent: 5, delivered: 1, read: 0, clicked: 0 } })
  const unico = reportStats({ nodes: [(flow as { nodes: unknown[] }).nodes[0]], edges: [] } as never, total)
  assert.deepEqual(unico.nodes, { a: { sent: 5, delivered: 4, read: 3, clicked: 2 } })
  assert.deepEqual(reportStats(flow, null).nodes, {})
})

test("relatório: passo sem canal herda o canal da transmissão; passo com canal ou e-mail fica como está", async () => {
  const { reportFlow } = await import("./broadcast-editor-logic")
  const step = (id: string, config: Record<string, unknown>) => ({ id, type: "message", position: { x: 0, y: 0 }, config })
  const flow = { nodes: [step("a", { blocks: [] }), step("b", { blocks: [], channel: "whatsapp" }), step("c", { blocks: [], email: { subject: "Oi" } })], edges: [] }
  const next = reportFlow(flow as never, "email")
  assert.equal(next.nodes[0].config.channel, "email")
  assert.equal(next.nodes[1].config.channel, "whatsapp")
  assert.equal(next.nodes[2].config.channel, undefined)
})
