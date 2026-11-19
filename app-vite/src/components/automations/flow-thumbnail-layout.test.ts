import assert from "node:assert/strict"
import test from "node:test"
import { registerHooks } from "node:module"
registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context) } })
const { layoutThumbnail } = await import("./flow-thumbnail-layout")

const preview = {
  nodes: [
    { id: "a", type: "trigger", x: 0, y: 0 },
    { id: "b", type: "message", x: 400, y: 0 },
    { id: "c", type: "action", x: 800, y: 200 },
  ],
  edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "b", to: "fantasma" }],
}

test("todo cartão cabe na área e o fluxo fica centralizado", () => {
  const { cards } = layoutThumbnail(preview, 240, 120)
  assert.equal(cards.length, 3)
  for (const card of cards) {
    assert.ok(card.x >= 0 && card.y >= 0 && card.x + card.w <= 240 && card.y + card.h <= 120, `${card.id} fora da área`)
  }
  const left = Math.min(...cards.map(c => c.x)), right = Math.max(...cards.map(c => c.x + c.w))
  assert.ok(Math.abs(left - (240 - right)) < 1, "margens laterais iguais")
})

test("cada cartão leva faixa de cabeçalho conforme o tipo e linhas de texto", () => {
  const { cards } = layoutThumbnail(preview, 240, 120)
  assert.equal(cards.find(c => c.id === "a")?.tone, "trigger")
  assert.equal(cards.find(c => c.id === "b")?.tone, "message")
  assert.equal(cards.find(c => c.id === "c")?.tone, "action")
  assert.ok(cards.every(c => c.lines.length >= 1 && c.lines.every(l => l.w > 0 && l.y > c.y)))
})

test("ligações curvas saem da direita de um cartão e chegam à esquerda do outro; ponta solta é ignorada", () => {
  const { edges, cards } = layoutThumbnail(preview, 240, 120)
  assert.equal(edges.length, 2)
  const a = cards.find(c => c.id === "a")!, b = cards.find(c => c.id === "b")!
  assert.ok(edges[0].startsWith(`M${(a.x + a.w).toFixed(1)} `))
  assert.ok(edges[0].includes(` ${b.x.toFixed(1)} `))
})

test("a ligação sai da linha de baixo do cartão e entra pelo cabeçalho do próximo: é curva, não reta, mesmo com os dois na mesma altura", () => {
  const { edges, cards } = layoutThumbnail(preview, 240, 120)
  const a = cards.find(c => c.id === "a")!, b = cards.find(c => c.id === "b")!
  const nums = edges[0].match(/-?\d+\.\d/g)!.map(Number), y1 = nums[1], y2 = nums[7]
  assert.ok(y1 > a.y + a.band, "sai abaixo do cabeçalho")
  assert.ok(Math.abs(y2 - (b.y + b.band / 2)) < 0.1, "entra no cabeçalho")
  assert.ok(Math.abs(y1 - y2) > 1, "curva")
})

test("um cartão só ainda é desenhado e sem ligações", () => {
  const { cards, edges } = layoutThumbnail({ nodes: [{ id: "x", type: "trigger", x: 50, y: 50 }], edges: [] }, 240, 120)
  assert.equal(cards.length, 1)
  assert.equal(edges.length, 0)
})
