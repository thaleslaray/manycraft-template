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
const { CommentLikeOption } = await import("./comment-like-option.tsx")

const render = comments => renderToStaticMarkup(React.createElement(CommentLikeOption, { comments, checked: true, disabled: false, onChange() {} }))

test("a conexão que declara curtida mostra o interruptor", () => {
  const html = render({ posts: true, like: true })
  assert.match(html, /Curtir comentário/)
  assert.doesNotMatch(html, /não está disponível/)
})

test("a conexão sem curtida esconde o interruptor e explica o motivo, mesmo com a curtida ligada num gatilho antigo", () => {
  const html = render({ posts: true, like: false })
  assert.doesNotMatch(html, /role="switch"|comment-like/)
  assert.match(html, /não está disponível nesta conexão/)
  assert.match(html, /login com Facebook/)
})

test("sem conexão escolhida não mostra nada", () => {
  assert.equal(render(undefined), "")
})
