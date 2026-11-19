import assert from "node:assert/strict"
import { test } from "node:test"
const { roleCan } = await import("../../../shared/permissions.ts")

test("leitor vê tudo e não altera nada", () => {
  assert.equal(roleCan("viewer", "read"), true)
  assert.equal(roleCan("viewer", "automation:read"), true)
  assert.equal(roleCan("viewer", "edit"), false)
  assert.equal(roleCan("viewer", "team"), false)
})

test("atendente não vê automações nem edita", () => {
  assert.equal(roleCan("livechat_agent", "automation:read"), false)
  assert.equal(roleCan("livechat_agent", "edit"), false)
})

test("editor altera mas não mexe na equipe; administrador e dono mexem", () => {
  assert.equal(roleCan("editor", "edit"), true)
  assert.equal(roleCan("editor", "team"), false)
  assert.equal(roleCan("administrator", "team"), true)
  assert.equal(roleCan("owner", "upload"), true)
})
