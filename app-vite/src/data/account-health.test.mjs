import assert from "node:assert/strict"
import { test } from "node:test"
const { describeAccountHealth, dailyLimitLabel } = await import("./account-health.ts")

test("sem aviso da Meta, nada a mostrar e tom ok", () => {
  assert.deepEqual(describeAccountHealth({ alerts: {} }), { tone: "ok", items: [] })
  assert.deepEqual(describeAccountHealth(undefined), { tone: "ok", items: [] })
})
test("restrição do exemplo oficial vira aviso crítico em português, com a data e o que fazer", () => {
  const { tone, items } = describeAccountHealth({ restrictions: { items: [{ type: "RESTRICTED_BIZ_INITIATED_MESSAGING", expiresAt: 1641330498000 }, { type: "RESTRICTED_ADD_PHONE_NUMBER_ACTION", expiresAt: 1641330498000 }] } }, 1600000000000)
  assert.equal(tone, "critical")
  assert.equal(items.length, 2)
  assert.match(items[0].text, /iniciar conversas novas/)
  assert.match(items[0].text, /Vale até 04\/01\/2022/)
  assert.match(items[0].action, /Central de Qualidade/)
})
test("restrição já vencida some da lista; a sem prazo e a que ainda vale ficam", () => {
  const venceu = { type: "RESTRICTED_BIZ_INITIATED_MESSAGING", expiresAt: 1641330498000 }
  assert.deepEqual(describeAccountHealth({ restrictions: { items: [venceu] } }, 1700000000000), { tone: "ok", items: [] })
  const { items } = describeAccountHealth({ restrictions: { items: [venceu, { type: "RESTRICTED_ADD_PHONE_NUMBER_ACTION" }, { type: "OUTRA", expiresAt: 1800000000000 }] } }, 1700000000000)
  assert.deepEqual(items.map(i => i.id), ["restriction-RESTRICTED_ADD_PHONE_NUMBER_ACTION", "restriction-OUTRA"])
})
test("alerta de aumento de limite negado do exemplo oficial", () => {
  const { tone, items } = describeAccountHealth({ alerts: { INCREASED_CAPABILITIES_ELIGIBILITY_DEFERRED: { severity: "WARNING", description: "Limits cannot be increased" } } })
  assert.equal(tone, "attention")
  assert.equal(items[0].title, "A Meta adiou o aumento do seu limite")
  assert.match(items[0].action, /ativa/)
})
test("alerta desconhecido mostra o texto da Meta e manda ver o Gerenciador", () => {
  const { items } = describeAccountHealth({ alerts: { ALGO_NOVO: { severity: "CRITICAL", description: "Something" } } })
  assert.equal(items[0].tone, "critical")
  assert.match(items[0].text, /Something/)
  assert.match(items[0].action, /Gerenciador de Negócios/)
})
test("limites do exemplo oficial: 2.000 pessoas por dia e 25 números", () => {
  const { items } = describeAccountHealth({ limits: { maxDaily: 2000, maxNumbers: 25 } })
  assert.match(items[0].text, /até 2\.000 pessoas diferentes por dia/)
  assert.match(items[0].text, /até 25 números/)
})
test("nível de limite e sem limite", () => {
  assert.match(describeAccountHealth({ limits: { maxDaily: "TIER_10K" } }).items[0].text, /10\.000/)
  assert.match(describeAccountHealth({ limits: { maxDaily: "TIER_UNLIMITED" } }).items[0].text, /qualquer quantidade/)
})
test("upgrade de vazão do exemplo oficial é bom e não repete o limite", () => {
  const { tone, items } = describeAccountHealth({ quality: { event: "THROUGHPUT_UPGRADE", limit: "TIER_UNLIMITED" } })
  assert.equal(tone, "ok")
  assert.equal(items[0].title, "Velocidade de envio ampliada")
  assert.doesNotMatch(items[0].text, /Limite atual/)
})
test("qualidade em queda pede ação", () => {
  const { tone, items } = describeAccountHealth({ quality: { event: "FLAGGED" } })
  assert.equal(tone, "attention")
  assert.match(items[0].action, /revise o texto dos modelos/)
})
test("revisão, violação, desativação e conta excluída; o pior aviso vem primeiro", () => {
  const { tone, items } = describeAccountHealth({ review: { decision: "APPROVED" }, violation: { type: "ADULT" }, disabled: { state: "DISABLE" }, removed: { event: "deleted" } })
  assert.equal(tone, "critical")
  assert.deepEqual(items.map(i => i.id), ["removed", "disabled", "violation", "review"])
  assert.match(items.find(i => i.id === "violation").text, /conteúdo adulto/)
  assert.equal(describeAccountHealth({ review: { decision: "APPROVED" } }).tone, "ok")
  assert.equal(describeAccountHealth({ disabled: { state: "REINSTATE" } }).items[0].title, "Conta reativada pela Meta")
})
test("desativação agendada ainda envia: é atenção, não conta desativada", () => {
  const { tone, items } = describeAccountHealth({ disabled: { state: "SCHEDULE_FOR_DISABLE" } })
  assert.equal(tone, "attention")
  assert.match(items[0].title, /agendou a desativação/)
  assert.match(items[0].text, /continua enviando|ainda envia/)
  assert.equal(describeAccountHealth({ disabled: { state: "DISABLE" } }).items[0].title, "A Meta desativou a conta")
  assert.equal(describeAccountHealth({ disabled: { state: "DISABLE" } }).tone, "critical")
  assert.notEqual(describeAccountHealth({ disabled: { state: "ESTADO_NOVO" } }).tone, "critical")
})
test("conta desconectada do app manda reconectar", () => {
  assert.match(describeAccountHealth({ removed: { event: "offboarded" } }).items[0].action, /Reconecte/)
})
test("limite de mensagens do cartão da conta: nível, número, sem limite e sem aviso", () => {
  assert.equal(dailyLimitLabel({ limits: { maxDaily: "TIER_100K" } }), "100.000 conversas / 24 horas")
  assert.equal(dailyLimitLabel({ quality: { event: "UPGRADE", limit: "TIER_2K" } }), "2.000 conversas / 24 horas")
  assert.equal(dailyLimitLabel({ limits: { maxDaily: "TIER_UNLIMITED" } }), "Sem limite")
  assert.equal(dailyLimitLabel({ limits: { maxDaily: 250 } }), "250 conversas / 24 horas")
  assert.equal(dailyLimitLabel({ alerts: {} }), null)
  assert.equal(dailyLimitLabel(undefined), null)
})
test("envio bloqueado lido na Meta (141006, forma de pagamento) vira aviso crítico por entidade, com o que fazer", () => {
  const { tone, items } = describeAccountHealth({ alerts: {}, sending: { status: "BLOCKED", items: [{ entity: "WABA", status: "BLOCKED", errors: [{ code: 141006, description: "There is an error with the payment method." }] }] } })
  assert.equal(tone, "critical")
  assert.equal(items.length, 1)
  assert.equal(items[0].id, "sending-WABA")
  assert.match(items[0].title, /bloqueou o envio/)
  assert.match(items[0].text, /conta do WhatsApp Business/i)
  assert.match(items[0].text, /forma de pagamento/)
  assert.match(items[0].text, /141006/)
  assert.match(items[0].action, /forma de pagamento/)
  assert.match(items[0].action, /Atualizar conexão/)
})
test("erro de envio desconhecido mostra o texto da Meta; limitação vira atenção", () => {
  const { tone, items } = describeAccountHealth({ sending: { status: "BLOCKED", items: [
    { entity: "APP", status: "BLOCKED", errors: [{ code: 999, description: "Something else", solution: "Fix it" }] },
    { entity: "PHONE_NUMBER", status: "LIMITED", errors: [], info: ["Your display name has not been approved yet."] },
  ] } })
  assert.equal(tone, "critical")
  assert.match(items[0].text, /Something else/)
  assert.match(items[0].action, /Fix it/)
  assert.equal(items[1].tone, "attention")
  assert.match(items[1].title, /limitou/)
  assert.match(items[1].text, /display name/)
})
