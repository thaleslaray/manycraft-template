import { test } from "node:test"
import assert from "node:assert/strict"
import { relevant, mask } from "./logs.mjs"

test("filtra relevantes", () => {
  assert.ok(relevant("POST /api/webhooks/telegram 200 OK"))
  assert.ok(relevant("GET /api/hooks/x 404"))
  assert.ok(relevant("GET /api/contacts 500 Internal"))
  assert.ok(relevant("Uncaught TypeError: x"))
  assert.ok(relevant("[panel-proxy] POST /api/inbox/x/reply 200 (9ms)"))
  assert.ok(!relevant("QUEUE inbound 1/1 (218ms)"))
})
test("mascara segredos", () => {
  assert.equal(mask("/x?token=abc123&y=1"), "/x?token=***&y=1")
  assert.equal(mask("authorization: Bearer abc.def"), "authorization: ***")
  assert.ok(!mask('{"access_token":"zzz"}').includes("zzz"))
})
