import test from "node:test"
import assert from "node:assert/strict"
import { registerHooks } from "node:module"
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context)
  return next(specifier, context)
} })
const { getSettings, updateGeneralSettings, saveSettingsFolder, deleteSettingsFolder, saveSettingsItem, deleteSettingsItem, inviteSettingsMember, changeSettingsRole, generateSettingsToken, revokeSettingsToken } = await import("../../data/settings.ts")
const workspace = () => `settings-test-${crypto.randomUUID()}`

test("configurações isolam workspaces e respostas não alteram a memória", async () => {
  const first = workspace()
  const second = workspace()
  const snapshot = await getSettings(first)
  snapshot.general.name = "Mutação externa"
  assert.notEqual((await getSettings(first)).general.name, "Mutação externa")
  await updateGeneralSettings(first, { name: "  Equipe principal  ", timezone: "UTC" })
  assert.equal((await getSettings(first)).general.name, "Equipe principal")
  assert.equal((await getSettings(second)).general.name, "Meu espaço de trabalho")
  await assert.rejects(updateGeneralSettings(first, { name: "", timezone: "UTC" }), /nome/)
  await assert.rejects(updateGeneralSettings(first, { name: "Time", timezone: "invalid" }), /fuso/)
})

test("pastas e itens aceitam CRUD, troca de pasta, tipos e remoção sem apagar conteúdo", async () => {
  const id = workspace()
  await saveSettingsFolder(id, "fields", "Perfil")
  await saveSettingsFolder(id, "tags", "Vendas")
  const snapshot = await getSettings(id)
  const fieldFolder = snapshot.folders.find((row) => row.kind === "fields")
  const tagFolder = snapshot.folders.find((row) => row.kind === "tags")
  await assert.rejects(saveSettingsFolder(id, "fields", "perfil"), /Já existe/)
  for (const field_type of ["text", "number", "date", "datetime", "boolean"]) {
    await saveSettingsItem(id, { name: `Campo ${field_type}`, kind: "fields", field_type, scope: "contact", folder_id: fieldFolder.id })
  }
  await saveSettingsItem(id, { name: "Primeiro contato", kind: "tags", field_type: "text", scope: "contact", folder_id: tagFolder.id })
  await assert.rejects(saveSettingsItem(id, { name: "Outro campo", kind: "fields", field_type: "text", scope: "contact", folder_id: tagFolder.id }), /pasta/)
  const field = (await getSettings(id)).items.find((row) => row.kind === "fields")
  await saveSettingsItem(id, { ...field, name: "Campo renomeado", scope: "bot", folder_id: null }, field.id)
  assert.equal((await getSettings(id)).items.find((row) => row.id === field.id).scope, "bot")
  await saveSettingsFolder(id, "fields", "Dados pessoais", fieldFolder.id)
  await deleteSettingsFolder(id, "fields", fieldFolder.id)
  const remaining = await getSettings(id)
  assert.equal(remaining.items.filter((row) => row.kind === "fields").length, 5)
  assert.ok(remaining.items.filter((row) => row.kind === "fields").every((row) => row.folder_id === null))
  assert.equal(remaining.items.find((row) => row.kind === "tags").folder_id, tagFolder.id)
  await deleteSettingsItem(id, "fields", field.id)
  assert.equal((await getSettings(id)).items.length, 5)
  await assert.rejects(deleteSettingsItem(id, "fields", field.id), /não encontrado/)
})

test("a equipe mantém exatamente um proprietário e valida os convites", async () => {
  const id = workspace()
  await assert.rejects(changeSettingsRole(id, "owner", "administrator"), /Transfira/)
  await assert.rejects(inviteSettingsMember(id, "invalido", "editor"), /e-mail/)
  await await assert.rejects(inviteSettingsMember("demo", "convite-teste@exemplo.com", "inbox_agent"), /papel válido/)
  await assert.rejects(inviteSettingsMember("demo", "convite-teste@exemplo.com", "admin"), /papel válido/)
  await assert.rejects(changeSettingsRole("demo", "member-ana", "admin"), /papel inválido/)
  await inviteSettingsMember("demo", "convite-teste@exemplo.com", "livechat_agent")
  await assert.rejects(inviteSettingsMember("demo", "convite-teste@exemplo.com", "editor"), /já está/)
  const invitation = (await getSettings("demo")).members.find((row) => row.status === "invited")
  await assert.rejects(changeSettingsRole("demo", invitation.id, "owner"), /membro ativo/)
  await changeSettingsRole("demo", "member-ana", "owner")
  let members = (await getSettings("demo")).members
  assert.equal(members.filter((row) => row.role === "owner").length, 1)
  assert.equal(members.find((row) => row.id === "owner").role, "administrator")
  await changeSettingsRole("demo", "owner", "owner")
  members = (await getSettings("demo")).members
  assert.equal(members.filter((row) => row.role === "owner").length, 1)
})

test("token só é devolvido ao gerar, leituras só têm metadados e revogação remove referência", async () => {
  const first = await generateSettingsToken("demo")
  const second = await generateSettingsToken("demo")
  assert.notEqual(first, second)
  assert.match(second, /^estudo_[a-f0-9]{64}$/)
  const snapshot = await getSettings("demo")
  assert.deepEqual(Object.keys(snapshot.api).sort(), ["created_at", "last4"])
  assert.equal(snapshot.api.last4, second.slice(-4))
  assert.equal(JSON.stringify(snapshot).includes(second), false)
  await revokeSettingsToken("demo")
  assert.equal((await getSettings("demo")).api, null)
})
