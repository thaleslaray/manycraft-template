import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const css = readFileSync(new URL("../../styles/tokens.css", import.meta.url), "utf8")
const token = name => new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css)?.[1]

const channel = h => { const v = parseInt(h, 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
const luminance = hex => { const n = hex.slice(1); return 0.2126 * channel(n.slice(0, 2)) + 0.7152 * channel(n.slice(2, 4)) + 0.0722 * channel(n.slice(4, 6)) }
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }
const hue = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  if (!d) return 0
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

test("a cor de link é da marca (laranja escuro), não azul, e passa AA nos fundos claros", () => {
  const link = token("link")
  assert.ok(link, "token --color-link existe")
  assert.ok(hue(link) >= 5 && hue(link) <= 35, `matiz do link ${hue(link)} fora do laranja`)
  for (const fundo of ["bg", "surface", "surface-muted", "accent-soft"]) assert.ok(contrast(link, token(fundo)) >= 4.5, `link sobre ${fundo}`)
})

test("nenhum componente de configurações ou de acesso fixa cor em hexadecimal ou rgb()", () => {
  const dirs = ["../settings", "../auth"].map(d => new URL(d, import.meta.url).pathname)
  const files = dirs.flatMap(dir => readdirSync(dir).filter(f => f.endsWith(".tsx")).map(f => join(dir, f)))
  assert.ok(files.length > 10)
  for (const file of files) {
    const bad = readFileSync(file, "utf8").match(/#[0-9a-fA-F]{6}\b|\brgba?\(|\bhsla?\(/g)
    assert.equal(bad, null, `${file}: ${bad}`)
  }
})
