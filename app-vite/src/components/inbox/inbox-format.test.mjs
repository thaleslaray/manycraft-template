import assert from "node:assert/strict"
import { test } from "node:test"
const { shortAgo } = await import("./inbox-format.ts")

const now = Date.parse("2026-05-10T12:00:00Z")
const ago = ms => new Date(now - ms).toISOString()
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR

test("tempo curto da lista de conversas: minutos, horas, dias, semanas", () => {
  assert.equal(shortAgo(ago(20_000), now), "agora")
  assert.equal(shortAgo(ago(5 * MIN), now), "5min")
  assert.equal(shortAgo(ago(4 * HOUR + 10 * MIN), now), "4h")
  assert.equal(shortAgo(ago(21 * HOUR), now), "21h")
  assert.equal(shortAgo(ago(DAY + HOUR), now), "1d")
  assert.equal(shortAgo(ago(6 * DAY), now), "6d")
  assert.equal(shortAgo(ago(15 * DAY), now), "2sem")
  assert.equal(shortAgo(ago(90 * DAY), now), "12sem")
})
