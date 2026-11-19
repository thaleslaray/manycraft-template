import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import { extname } from "node:path"
import { test } from "node:test"

// O Vite resolve imports TS sem extensão; reproduzimos apenas essa resolução no Node.
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier.startsWith(".") && !extname(specifier) ? `${specifier}.ts` : specifier, context)
} })
const { listSequences, listSequenceFlows, createSequence, updateSequence, sequenceDelayUnit, formatSequenceDelay } = await import("../../data/sequences.ts")
const { createAutomation } = await import("../../data/index.ts")
const step = (patch = {}) => ({ id: "step-test", delay_seconds: 420, sending_time_settings: { type: "all" }, status: "draft", automation_id: null, ...patch })

test("seed representa sequência ativa, passos ao vivo/rascunho e ausência de fluxo", async () => {
  const sequences = await listSequences("demo")
  assert(sequences.every((sequence) => sequence.status === "active"))
  assert(sequences.some((sequence) => sequence.steps.length === 0))
  assert(sequences.some((sequence) => sequence.steps.some((step) => step.status === "live")))
  assert(sequences.some((sequence) => sequence.steps.some((step) => step.automation_id === null)))
  assert.deepEqual(await listSequences("outro-espaco"), [])
})

test("criação e edição preservam segundos exatos, janelas e isolamento de espaço", async () => {
  const input = { name: "  Jornada inventada  ", steps: [step()] }
  const created = await createSequence("test-sequences", input)
  input.steps[0].delay_seconds = 900
  assert.equal(created.name, "Jornada inventada")
  assert.equal((await listSequences("test-sequences"))[0].steps[0].delay_seconds, 420)
  const saved = await updateSequence("test-sequences", created.id, { name: "Jornada editada", steps: [step({ delay_seconds: 86400, sending_time_settings: { type: "timelimit", from: "08:30", to: "17:45", weekdays: [1, 3, 5] } })] })
  assert.deepEqual(saved.steps[0].sending_time_settings.weekdays, [1, 3, 5])
  assert.equal(saved.steps[0].delay_seconds, 86400)
  saved.steps[0].sending_time_settings.weekdays.push(6)
  assert.deepEqual((await listSequences("test-sequences"))[0].steps[0].sending_time_settings.weekdays, [1, 3, 5])
  await assert.rejects(updateSequence("espaço-invasor", created.id, { name: "Invadida", steps: [] }), /não foi encontrada/)
})

test("passo ao vivo exige fluxo do próprio espaço e falha não grava alterações", async () => {
  const created = await createSequence("demo", { name: "Validação de passos", steps: [step()] })
  await assert.rejects(updateSequence("demo", created.id, { name: "Não deve gravar", steps: [step({ status: "live" })] }), /Vincule/)
  await assert.rejects(createSequence("outro-espaco", { name: "Fluxo alheio", steps: [step({ automation_id: "auto-quero", status: "live" })] }), /não pertence/)
  assert.equal((await listSequences("demo")).find((item) => item.id === created.id).name, "Validação de passos")
  const flows = await listSequenceFlows("demo")
  const saved = await updateSequence("demo", created.id, { name: "Passo pronto", steps: [step({ automation_id: flows.find((flow) => flow.published).id, status: "live" })] })
  assert.equal(saved.steps[0].status, "live")
})

test("valida atrasos, nomes, dias e janela sem cruzar meia-noite", async () => {
  const invalidSteps = [
    step({ delay_seconds: -1 }), step({ delay_seconds: 1.5 }), step({ delay_seconds: NaN }),
    step({ sending_time_settings: { type: "timelimit", from: "23:00", to: "06:00", weekdays: [1] } }),
    step({ sending_time_settings: { type: "timelimit", from: "09:00", to: "18:00", weekdays: [] } }),
    step({ sending_time_settings: { type: "timelimit", from: "09:00", to: "18:00", weekdays: [7] } }),
  ]
  for (const invalid of invalidSteps) await assert.rejects(createSequence("test-invalid", { name: "Teste", steps: [invalid] }))
  await assert.rejects(createSequence("test-invalid", { name: "  ", steps: [] }))
  assert.equal((await listSequences("test-invalid")).length, 0)
  const created = await createSequence("test-empty", { name: "Coleção ".repeat(8), steps: [] })
  assert.equal(created.steps.length, 0)
})

test("atraso deriva unidade sem usar o nome da sequência", () => {
  assert.equal(formatSequenceDelay(0), "Sem espera")
  assert.equal(formatSequenceDelay(420), "7 min")
  assert.equal(formatSequenceDelay(7200), "2 h")
  assert.equal(formatSequenceDelay(86400), "1 dia")
  assert.equal(formatSequenceDelay(172800), "2 dias")
  assert.deepEqual(sequenceDelayUnit(61), { value: 61, unit: 1 })
})

test("novas automações aparecem no seletor, mas rascunhos não permitem passo ao vivo", async () => {
  const created = await createAutomation("test-new-flow", "Fluxo recém-criado")
  const flows = await listSequenceFlows("test-new-flow")
  assert.equal(flows.find((flow) => flow.id === created.id).published, false)
  const saved = await createSequence("test-new-flow", { name: "Acompanhamento", steps: [step({ automation_id: created.id })] })
  assert.equal(saved.steps[0].automation_id, created.id)
  await assert.rejects(updateSequence("test-new-flow", saved.id, { name: saved.name, steps: [step({ automation_id: created.id, status: "live" })] }), /Publique/)
  assert.equal((await listSequences("test-new-flow"))[0].steps[0].status, "draft")
})

test("duplicar copia o passo ao vivo cuja automação está em rascunho, desligando só esse passo" , async () => {
  const { duplicateSequence } = await import("../../data/sequences.ts")
  const rascunho = await createAutomation("test-dup-seq", "Fluxo ainda em rascunho")
  const origem = { id: "seq-origem", workspace_id: "test-dup-seq", name: "Origem", subscribers: 3, status: "active", steps: [
    step({ id: "a", status: "draft", automation_id: rascunho.id }),
    step({ id: "b", status: "live", automation_id: rascunho.id }),
    step({ id: "c", status: "draft", automation_id: null }),
  ] }
  const { sequence, turnedOff } = await duplicateSequence("test-dup-seq", origem)
  assert.equal(turnedOff, 1)
  assert.equal(sequence.name, "Origem (cópia)")
  assert.deepEqual(sequence.steps.map((s) => s.status), ["draft", "draft", "draft"])
  assert.equal(sequence.steps[1].automation_id, rascunho.id, "o vínculo com a automação é mantido")
})
