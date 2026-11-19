import assert from "node:assert/strict"
import { test } from "node:test"
const { offersConversationStarters, webhookState } = await import("./connection-rows.ts")

const base = { status: "connected", webhook: { mode: "auto", registered: true, url: "https://motor.test/api/webhooks/meta", subscribedAt: null, note: "Webhook configurado no número pela API da Meta." } }

test("linha de iniciadores de conversa só quando o perfil do canal tem iniciadores", () => {
  assert.equal(offersConversationStarters({ profile: { conversationStarters: { maxItems: 4, titleMax: 80 } } }), true)
  assert.equal(offersConversationStarters({ profile: { conversationStarters: null } }), false)
  assert.equal(offersConversationStarters({ profile: {} }), false)
  assert.equal(offersConversationStarters({}), false)
})

test("webhook automático e já recebendo: selo de configurado automaticamente no meio, com o endereço", () => {
  const state = webhookState(base)
  assert.equal(state.tone, "ok")
  assert.equal(state.label, "Configurado automaticamente")
  assert.match(state.text, /número pela API da Meta/)
  assert.equal(state.url, "https://motor.test/api/webhooks/meta")
  assert.equal(state.guide, false)
})

test("assinado mas sem evento ainda: aguardando o primeiro evento, com a instrução para testar", () => {
  const state = webhookState({ ...base, status: "pending", webhook: { ...base.webhook, subscribedAt: 1700000000000 } })
  assert.equal(state.tone, "waiting")
  assert.equal(state.label, "Aguardando o primeiro evento")
  assert.match(state.text, /mande uma mensagem para este número/i)
})

test("manual pendente: não configurado, com o passo manual; manual confirmado: configurado", () => {
  const pending = webhookState({ status: "pending", webhook: { mode: "manual", registered: false, url: "https://motor.test/x", subscribedAt: null } })
  assert.equal(pending.tone, "off")
  assert.equal(pending.label, "Não configurado")
  assert.equal(pending.guide, true)
  const done = webhookState({ status: "connected", webhook: { mode: "manual", registered: true, url: "https://motor.test/x", subscribedAt: null } })
  assert.equal(done.label, "Configurado")
  assert.equal(done.tone, "ok")
})

test("automático que falhou: não configurado, mandando trocar a credencial", () => {
  const state = webhookState({ status: "error", webhook: { mode: "auto", registered: false, url: null, subscribedAt: null } })
  assert.equal(state.tone, "off")
  assert.match(state.text, /Trocar credencial/)
})
