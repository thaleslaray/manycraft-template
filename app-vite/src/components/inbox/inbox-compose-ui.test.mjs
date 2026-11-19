import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { transformSync } from "esbuild"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

const src = new URL("../../", import.meta.url)
registerHooks({
  resolve(specifier, context, nextResolve) {
    const target = specifier.startsWith("@/") ? new URL(specifier.slice(2), src) : specifier.startsWith(".") ? new URL(specifier, context.parentURL) : null
    if (target && !/\.[a-z]+$/i.test(target.pathname)) {
      for (const suffix of [".ts", ".tsx", "/index.ts"]) {
        const candidate = `${fileURLToPath(target)}${suffix}`
        if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context)
      }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (/\.(ts|tsx)$/.test(url) && url.startsWith(src.href)) return { format: "module", shortCircuit: true, source: transformSync(readFileSync(new URL(url), "utf8"), { loader: url.endsWith(".tsx") ? "tsx" : "ts", format: "esm", jsx: "automatic" }).code }
    return nextLoad(url, context)
  },
})
const { InboxTimelineItem } = await import("./inbox-timeline-item.tsx")
const { InboxAttachButtons, InboxEmojiPicker } = await import("./inbox-composer-attach.tsx")
const { attachmentOptions } = await import("./inbox-compose.ts")

const profile = { window: null, media: { image: { maxBytes: 8e6, mime: ["image/jpeg", "image/png"] }, file: { maxBytes: 25e6, mime: ["application/pdf"] } } }

test("o compositor mostra um botão por tipo aceito, com o limite, e nenhum para o que a conexão não aceita", () => {
  const html = renderToStaticMarkup(React.createElement(InboxAttachButtons, { options: attachmentOptions(profile), disabled: false, onPick() {}, onError() {} }))
  assert.match(html, /Anexar imagem \(até 8 MB\)/)
  assert.match(html, /Anexar pdf \(até 25 MB\)/)
  assert.doesNotMatch(html, /Anexar áudio|Anexar vídeo/)
  assert.match(html, /accept="image\/jpeg,image\/png"/)
  assert.equal(renderToStaticMarkup(React.createElement(InboxAttachButtons, { options: attachmentOptions({ window: null }), disabled: false, onPick() {}, onError() {} })), "")
})

test("o seletor de emoji começa fechado e tem nome acessível", () => {
  const html = renderToStaticMarkup(React.createElement(InboxEmojiPicker, { disabled: false, onPick() {} }))
  assert.match(html, /aria-label="Inserir emoji"/)
  assert.doesNotMatch(html, /Emojis/)
})

test("mídia enviada pela equipe aparece na conversa como a recebida, sem oferecer reenvio da legenda automática", () => {
  const message = { id: "m", source: "human", author: "Equipe", body: "[Imagem] foto.png", created_at: "2026-10-23T14:00:00.000Z", status: "failed", error: "O canal recusou o envio.",
    media: { kind: "image", status: "stored", url: "/api/inbox/media/11111111-1111-4111-8111-111111111111", name: "foto.png" } }
  const html = renderToStaticMarkup(React.createElement(InboxTimelineItem, { message, busy: false, onRetry() {}, workspaceId: "w" }))
  assert.match(html, /<img[^>]+src="\/api\/inbox\/media\/11111111-1111-4111-8111-111111111111\?workspace=w"/)
  assert.match(html, /enviada pela equipe/)
  assert.match(html, /O canal recusou o envio\./)
  assert.doesNotMatch(html, /Tentar de novo|\[Imagem\]/)
})
