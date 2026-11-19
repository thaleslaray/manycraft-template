/// <reference types="node" />
import assert from "node:assert/strict"
import { test } from "node:test"
import { registerHooks } from "node:module"
registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context) } })
const { mapViewport, NARROW_MAP } = await import("./map-fit")

const no = (id: string, type: string, x: number, width = 210) => ({ id, type, position: { x, y: 0 }, data: {}, measured: { width, height: 160 } })

test("transmissão no celular: zoom de leitura e o primeiro passo inteiro na tela, mesmo com o início do envio à esquerda", () => {
  const nos = [no("broadcast-start", "broadcast_start", -300, 224), no("m1", "message", 0), no("m2", "message", 360)]
  const caixa = { width: 326, height: 544 }
  const v = mapViewport(caixa, nos, { x: -300, y: 0, width: 870, height: 160 }, { readOnly: true })
  assert.equal(v.zoom, NARROW_MAP.minZoom)
  const direita = (0 + 210) * v.zoom + v.x
  assert.ok(direita <= caixa.width - 16, `passo termina em ${direita}`)
  assert.ok(0 * v.zoom + v.x >= 16, "o passo começa dentro da tela")
})

test("transmissão no celular com o primeiro passo cabendo: alinha ao início do envio", () => {
  const nos = [no("broadcast-start", "broadcast_start", -300, 224), no("m1", "message", 0)]
  const v = mapViewport({ width: 600, height: 544 }, nos, { x: -300, y: 0, width: 510, height: 160 }, {})
  assert.equal(v.x, 16 + 300 * v.zoom)
})

test("automação: centrada e sem passar do zoom máximo", () => {
  const v = mapViewport({ width: 1200, height: 800 }, [no("t", "trigger", 0)], { x: 0, y: 0, width: 210, height: 160 })
  assert.equal(v.zoom, 1.5)
  assert.equal(v.x, (1200 - 210 * 1.5) / 2)
})
