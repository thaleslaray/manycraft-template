import assert from "node:assert/strict"
import { test } from "node:test"
import { registerHooks } from "node:module"
registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context) } })
const { stepCatalog, catalogItems, needsFirstStep, opensDropMenu, dropStepPosition } = await import("./connect-drop.ts")

const conn = (id, kind, status = "connected") => ({ id, kind, status })
const logic = ["Ações", "Condição", "Dividir caminhos", "Esperar", "Iniciar automação"]
const firstLogic = logic.slice(0, 4)
const labels = groups => catalogItems(groups).map(i => i.label)
const group = (groups, key) => groups.find(g => g.key === key)

test("catálogo agrupado como no original: Conteúdo e Lógica, com rótulo e ícone em cada item; sem IA nem SMS", () => {
  const groups = stepCatalog({ triggers: [{ channel_id: "ig", channel_type: "instagram" }], connections: [conn("ig", "instagram"), conn("tg", "telegram"), conn("em", "email")] })
  assert.deepEqual(groups.map(g => [g.key, g.label]), [["content", "Conteúdo"], ["logic", "Lógica"]])
  assert.deepEqual(group(groups, "content").items.map(i => i.label), ["Instagram", "E-mail"])
  assert.deepEqual(group(groups, "logic").items.map(i => i.label), logic)
  assert.deepEqual(group(groups, "content").items[0], { key: "message:instagram", label: "Instagram", type: "message", channel: "instagram", icon: "instagram" })
  assert.deepEqual(group(groups, "logic").items.map(i => i.icon), ["action", "condition", "randomizer", "smart_delay", "start_automation"])
  for (const item of catalogItems(groups)) assert.ok(item.icon, `${item.label} sem ícone`)
  assert.ok(!labels(groups).some(l => /SMS|IA/.test(l)))
})

test("conector e cartão do primeiro passo saem do mesmo catálogo: mesmos grupos, rótulos e ícones; o cartão só não tem Iniciar automação", () => {
  for (const input of [
    { triggers: [], connections: [conn("ig", "instagram"), conn("tg", "telegram"), conn("em", "email")] },
    { triggers: [{ channel_id: "tg", channel_type: "telegram" }], connections: [conn("tg", "telegram")] },
    { triggers: [], connections: [] },
    { triggers: [], connections: [conn("ig", "instagram")], hostChannel: "whatsapp" },
  ]) {
    const connector = stepCatalog(input), card = stepCatalog(input, "first-step")
    assert.deepEqual(card.map(g => g.key), connector.map(g => g.key))
    assert.deepEqual(group(card, "content"), group(connector, "content"))
    assert.deepEqual(group(card, "logic").items, group(connector, "logic").items.filter(i => i.type !== "start_automation"))
    assert.deepEqual(group(card, "logic").items.map(i => i.label), firstLogic)
  }
})

test("o canal do passo de origem vence o dos gatilhos; sem E-mail ligado ele não aparece", () => {
  const groups = stepCatalog({ origin: { channel: "telegram" }, triggers: [{ channel_id: "ig", channel_type: "instagram" }], connections: [conn("ig", "instagram"), conn("tg", "telegram")] })
  assert.deepEqual(labels(groups), ["Telegram", ...logic])
})

test("fluxo de e-mail não repete o E-mail", () => {
  assert.deepEqual(labels(stepCatalog({ origin: { channel: "email" }, triggers: [], connections: [conn("em", "email")] })), ["E-mail", ...logic])
})

test("sem canal conhecido (automação nova, vários canais ligados): todos os canais ligados, nunca os desligados nem os congelados", () => {
  const groups = stepCatalog({ triggers: [], connections: [conn("ig", "instagram"), conn("tg", "telegram"), conn("wa", "whatsapp", "disconnected"), conn("ms", "messenger"), conn("tt", "tiktok")] }, "first-step")
  assert.deepEqual(labels(groups), ["Instagram", "Telegram", ...firstLogic])
  assert.deepEqual(group(groups, "content").items.map(i => i.icon), ["instagram", "telegram"])
})

test("nenhum canal ligado: Mensagem sem canal (o editor pergunta)", () => {
  const groups = stepCatalog({ triggers: [], connections: [] }, "first-step")
  assert.deepEqual(group(groups, "content").items, [{ key: "message", label: "Mensagem", type: "message", icon: "message" }])
  assert.deepEqual(group(groups, "logic").items.map(i => i.label), firstLogic)
})

test("hospedeiro (transmissão): só o canal dele, no conector e no cartão", () => {
  const input = { triggers: [], connections: [conn("ig", "instagram"), conn("em", "email")], hostChannel: "telegram" }
  assert.deepEqual(labels(stepCatalog(input)), ["Telegram", ...logic])
  assert.deepEqual(labels(stepCatalog(input, "first-step")), ["Telegram", ...firstLogic])
})

test("o cartão do primeiro passo aparece só sem nenhum passo além do gatilho; notas, grupos e portais não contam", () => {
  assert.equal(needsFirstStep([{ type: "trigger" }]), true)
  assert.equal(needsFirstStep([]), true, "transmissão vazia")
  assert.equal(needsFirstStep([{ type: "trigger" }, { type: "sticky" }, { type: "frame" }, { type: "portal" }]), true)
  assert.equal(needsFirstStep([{ type: "trigger" }, { type: "message" }]), false)
  assert.equal(needsFirstStep([{ type: "smart_delay" }]), false)
})

test("a caixinha só abre quando o conector sai de uma saída e é solto no vazio", () => {
  const from = { type: "source" }
  assert.equal(opensDropMenu({ isValid: null, fromHandle: from, toHandle: null }, false), true)
  assert.equal(opensDropMenu({ isValid: false, fromHandle: from, toHandle: null }, false), true)
  assert.equal(opensDropMenu({ isValid: true, fromHandle: from, toHandle: { id: null } }, false), false, "ligou num passo: segue o caminho atual")
  assert.equal(opensDropMenu({ isValid: false, fromHandle: from, toHandle: { id: null } }, false), false, "soltou numa entrada recusada")
  assert.equal(opensDropMenu({ isValid: null, fromHandle: from, toHandle: null }, true), false, "soltou em cima de um passo")
  assert.equal(opensDropMenu({ isValid: null, fromHandle: { type: "target" }, toHandle: null }, false), false, "arrastou de uma entrada")
  assert.equal(opensDropMenu({ isValid: null, fromHandle: null, toHandle: null }, false), false)
})

test("o passo novo nasce com a entrada no ponto da soltura", () => {
  assert.deepEqual(dropStepPosition({ x: 500, y: 300 }), { x: 500, y: 276 })
})
