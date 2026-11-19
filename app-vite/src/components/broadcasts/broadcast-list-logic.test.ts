/// <reference types="node" />
import assert from "node:assert/strict"
import test from "node:test"
import { registerHooks } from "node:module"
registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context) } })
const { isOverdue, isPausedSchedule, formatBroadcastDate, groupBroadcasts, visibleRows, sectionLimit, rateCell, hasHiddenRows } = await import("./broadcast-list-logic")

test("a data sai no fuso da transmissão sem mostrar o nome técnico do fuso", () => {
  const texto = formatBroadcastDate("2099-10-20T12:30:00.000Z", "America/Sao_Paulo")
  assert.match(texto, /20/)
  assert.match(texto, /09:30/)
  assert.doesNotMatch(texto, /America|Sao_Paulo|UTC|GMT|-03/)
  assert.equal(formatBroadcastDate(null, "UTC"), "—")
})

test("agrupa em agendado, rascunhos e histórico", () => {
  const item = (id: string, status: string) => ({ id, status }) as never
  const grupos = groupBroadcasts([item("a", "scheduled"), item("b", "draft"), item("c", "sent"), item("d", "sending"), item("e", "paused"), item("f", "cancelled")])
  assert.deepEqual(grupos.scheduled.map((x: { id: string }) => x.id), ["a"])
  assert.deepEqual(grupos.drafts.map((x: { id: string }) => x.id), ["b"])
  assert.deepEqual(grupos.history.map((x: { id: string }) => x.id), ["c", "d", "e", "f"])
})

test("mostra poucas linhas até pedir todas", () => {
  const linhas = [1, 2, 3, 4, 5]
  assert.deepEqual(visibleRows(linhas, false), [1, 2, 3])
  assert.deepEqual(visibleRows(linhas, true), linhas)
  assert.deepEqual(visibleRows([1, 2], false), [1, 2])
})

test("agendado mostra 3 linhas; rascunhos e histórico mostram 5", () => {
  assert.equal(sectionLimit("scheduled"), 3)
  assert.equal(sectionLimit("drafts"), 5)
  assert.equal(sectionLimit("history"), 5)
  assert.deepEqual(visibleRows([1, 2, 3, 4, 5, 6, 7], false, 5), [1, 2, 3, 4, 5])
})

test("célula de taxa: valor e porcentagem sobre os enviados", () => {
  assert.deepEqual(rateCell(18, 116), { value: "18", percent: "(15,5%)" })
  assert.deepEqual(rateCell(116, 116), { value: "116", percent: "(100%)" })
  assert.deepEqual(rateCell(0, 0), { value: "0", percent: "(0%)" })
  assert.deepEqual(rateCell(undefined, 10), { value: "0", percent: "(0%)" })
})

test('"Ver todas" só aparece quando há mais linhas do que cabem', () => {
  assert.equal(hasHiddenRows(3, "scheduled"), false)
  assert.equal(hasHiddenRows(4, "scheduled"), true)
  assert.equal(hasHiddenRows(5, "history"), false)
  assert.equal(hasHiddenRows(6, "drafts"), true)
  assert.equal(hasHiddenRows(0, "history"), false)
})

test("agendada pausada antes de começar continua em Agendado; pausada de um envio em andamento vai ao histórico", () => {
  const antes = { id: "p1", status: "paused", started: false, scheduled_at: "2099-12-20T13:00:00.000Z" } as never
  const durante = { id: "p2", status: "paused", started: true, scheduled_at: "2026-10-01T13:00:00.000Z" } as never
  assert.equal(isPausedSchedule(antes), true)
  assert.equal(isPausedSchedule(durante), false)
  const grupos = groupBroadcasts([antes, durante])
  assert.deepEqual(grupos.scheduled.map((x: { id: string }) => x.id), ["p1"])
  assert.deepEqual(grupos.history.map((x: { id: string }) => x.id), ["p2"])
})

test("agendada com a hora vencida e sem envio aparece como atrasada", () => {
  const agora = Date.parse("2026-11-03T14:00:00Z")
  assert.equal(isOverdue({ status: "scheduled", started: false, scheduled_at: "2026-11-03T08:00:00Z" }, agora), true)
  assert.equal(isOverdue({ status: "scheduled", started: false, scheduled_at: "2026-11-03T13:59:30Z" }, agora), false)
  assert.equal(isOverdue({ status: "scheduled", started: false, scheduled_at: "2026-11-04T08:00:00Z" }, agora), false)
  assert.equal(isOverdue({ status: "sent", started: true, scheduled_at: "2026-11-03T08:00:00Z" }, agora), false)
})
