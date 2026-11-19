import test, { afterEach } from "node:test"
import assert from "node:assert/strict"
import { registerHooks } from "node:module"

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context)
  return next(specifier, context)
} })
const { configureDataMode } = await import("./api.ts")
const settings = await import("./settings.ts")
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; configureDataMode(undefined) })

test("campos e tags reais são lidos do motor e mudanças usam o workspace autenticado", async () => {
  configureDataMode("real")
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined, workspace: init.headers?.get?.("x-workspace") })
    const body = url === "/api/session/workspace" ? { workspace_id: "workspace-motor", name: "Oficina" }
      : url === "/api/tags" && !init.method ? [{ id: "lead", name: "lead", contact_count: 3, archived: false, folder_id: null }]
      : url === "/api/fields" && !init.method ? [{ id: "idade", name: "Idade", type: "number", scope: "contact", archived: false, folder_id: null }]
      : url.includes("settings-folders") && !init.method ? []
      : { ok: true }
    return Response.json(body)
  }
  const snapshot = await settings.getSettings("workspace-na-url")
  assert.equal(snapshot.items.find(item => item.id === "lead").contact_count, 3)
  assert.equal(snapshot.items.find(item => item.id === "idade").field_type, "number")
  await settings.saveSettingsItem("workspace-na-url", { kind: "fields", name: "Idade", field_type: "number", scope: "contact", folder_id: null })
  await settings.saveSettingsItem("workspace-na-url", { kind: "tags", name: "Lead renomeado", field_type: "text", scope: "contact", folder_id: null }, "lead")
  await settings.archiveSettingsItem("workspace-na-url", "tags", "lead", true)
  await settings.deleteSettingsItem("workspace-na-url", "fields", "idade", true)
  assert.deepEqual(calls.filter(call => call.method !== "GET").map(({url,method,body}) => ({url,method,body})), [
    { url: "/api/fields", method: "POST", body: { name: "Idade", type: "number", scope: "contact", folder_id: null } },
    { url: "/api/tags/lead", method: "PATCH", body: { name: "Lead renomeado", folder_id: null } },
    { url: "/api/tags/lead", method: "PATCH", body: { archived: true } },
    { url: "/api/fields/idade?confirm=true", method: "DELETE", body: undefined },
  ])
  assert.ok(calls.filter(call => call.url !== "/api/session/workspace").every(call => call.workspace === "workspace-motor"))
})
