import { test } from "node:test"
import assert from "node:assert/strict"
import { contarGrupos, dividir, duracoesDoRelatorio, listaDeTestes } from "./e2e-divisao.mjs"

const relatorio = {
  suites: [
    { file: "a.spec.ts", specs: [
      { tests: [{ projectName: "desktop", results: [{ duration: 30_000 }] }] },
      { tests: [{ projectName: "mobile", results: [{ duration: 10_000 }] }] },
    ] },
    { file: "b.spec.ts", specs: [], suites: [{ specs: [
      { tests: [{ projectName: "desktop", results: [{ duration: 5_000 }, { duration: 1_000 }] }] },
      { tests: [{ projectName: "desktop", results: [] }] },
    ] }] },
  ],
}

test("conta testes e soma duração por arquivo e projeto, inclusive em describe", () => {
  assert.deepEqual([...contarGrupos(relatorio)], [["desktop › a.spec.ts", 1], ["mobile › a.spec.ts", 1], ["desktop › b.spec.ts", 2]])
  assert.deepEqual(duracoesDoRelatorio(relatorio), { "desktop › a.spec.ts": 30, "mobile › a.spec.ts": 10, "desktop › b.spec.ts": 6 })
})

test("divide pelo tempo medido, o maior primeiro na lista mais leve; sem medida vale 15 s por teste", () => {
  const grupos = new Map([["desktop › a", 1], ["desktop › b", 1], ["desktop › c", 1], ["mobile › d", 4]])
  const caixas = dividir(grupos, { "desktop › a": 100, "desktop › b": 60, "desktop › c": 50 }, 2)
  assert.deepEqual(caixas.map(c => c.grupos), [["desktop › a", "desktop › c"], ["desktop › b", "mobile › d"]])
  assert.deepEqual(caixas.map(c => c.segundos), [150, 120])
  assert.equal(dividir(new Map([["desktop › a", 1]]), {}, 3).filter(c => c.grupos.length).length, 1)
})

test("lista de testes no formato do --test-list", () => {
  assert.equal(listaDeTestes(["desktop › a.spec.ts", "mobile › b.spec.ts"]), "[desktop] › a.spec.ts\n[mobile] › b.spec.ts\n")
})
