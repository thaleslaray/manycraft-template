import assert from "node:assert/strict"
import { test } from "node:test"
import { registerHooks } from "node:module"
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
  return nextResolve(specifier, context)
} })
const { attachmentError, attachmentOptions, formatLimit, insertAtCursor, sendLabel } = await import("./inbox-compose.ts")

const instagram = { window: null, media: {
  image: { maxBytes: 8e6, mime: ["image/jpeg", "image/png"] },
  audio: { maxBytes: 25e6, mime: ["audio/aac", "audio/mp4", "audio/wav"] },
  file: { maxBytes: 25e6, mime: ["application/pdf"] },
} }

test("só oferece o que a ficha do canal aceita, com o limite de cada tipo", () => {
  assert.deepEqual(attachmentOptions(instagram).map(o => [o.kind, o.label, o.limit]), [
    ["image", "Imagem", "até 8 MB"], ["file", "PDF", "até 25 MB"], ["audio", "Áudio", "até 25 MB"],
  ])
  assert.equal(attachmentOptions(instagram)[0].accept, "image/jpeg,image/png")
  assert.deepEqual(attachmentOptions({ window: null }), [])
  assert.deepEqual(attachmentOptions(undefined), [])
})

test("arquivo de documentos genéricos aparece como Arquivo, não como PDF", () => {
  const telegram = { window: null, media: { file: { maxBytes: 20e6, mime: ["application/pdf", "text/plain"] } } }
  assert.equal(attachmentOptions(telegram)[0].label, "Arquivo")
})

test("recusa tipo ou tamanho fora da ficha antes de enviar", () => {
  const image = attachmentOptions(instagram)[0]
  assert.equal(attachmentError(image, { type: "image/png", size: 1e6 }), undefined)
  assert.match(attachmentError(image, { type: "image/gif", size: 1e6 }), /não aceita/)
  assert.match(attachmentError(image, { type: "image/png", size: 9e6 }), /até 8 MB/)
})

test("o botão de enviar leva o nome do canal", () => {
  assert.equal(sendLabel("reply", "instagram"), "Enviar pelo Instagram")
  assert.equal(sendLabel("reply", "whatsapp"), "Enviar pelo WhatsApp")
  assert.equal(sendLabel("reply", "email"), "Enviar por e-mail")
  assert.equal(sendLabel("note", "instagram"), "Salvar nota")
  assert.equal(sendLabel("reply", undefined), "Enviar resposta")
})

test("limite legível e emoji no ponto do cursor", () => {
  assert.equal(formatLimit(8e6), "8 MB")
  assert.equal(formatLimit(500_000), "500 KB")
  assert.deepEqual(insertAtCursor("Olá !", 4, 4, "😊"), { text: "Olá 😊!", cursor: 6 })
  assert.deepEqual(insertAtCursor("abc", 1, 3, "👍"), { text: "a👍", cursor: 3 })
})
