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

const { describeWaitPhrase, timezoneChoices } = await import("./temporal.ts")

test("frase do nó de Espera: Aguarde X depois continue", () => {
  assert.equal(describeWaitPhrase({ duration: { value: 2, unit: "minutes" } }, "2 minutos"), "Aguarde 2 minutos depois continue")
  assert.equal(describeWaitPhrase({ mode: "date", date: { kind: "specific", at: "2030-10-24T10:00" } }, "5 minutos"), "Aguarde até 24/10/2030 às 10:00 depois continue")
})

test("fusos: busca sem acento nem caixa, com nome legível", () => {
  assert.ok(timezoneChoices("").some(c => c.id === "America/Sao_Paulo"))
  const achados = timezoneChoices("sao paulo")
  assert.deepEqual(achados.map(c => c.id), ["America/Sao_Paulo"])
  assert.equal(achados[0].label, "America/Sao Paulo")
  assert.equal(timezoneChoices("zzzz-nada").length, 0)
})
