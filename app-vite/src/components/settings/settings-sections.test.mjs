import test from "node:test"
import assert from "node:assert/strict"
import { registerHooks } from "node:module"
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context)
  return next(specifier, context)
} })
const { settingsGroups, activeSettings, unknownChannelRedirect, settingsVisibleTo } = await import("./settings-sections.ts")

const ws = "/demo/settings"
const ids = () => settingsGroups.flatMap(group => group.items.map(item => item.id))

test("o menu segue o original: grupos e títulos na ordem, sem cobrança, pagamentos, pixel nem eventos", () => {
  assert.deepEqual(settingsGroups.map(group => group.title), ["Principal", "Caixa de entrada", "Canais", "Automação", "Extensões"])
  assert.deepEqual(settingsGroups[0].items.map(item => item.title), ["Geral", "Notificações", "Membros da equipe", "Registros", "Conformidade"])
  assert.deepEqual(settingsGroups[2].items.map(item => item.title), ["Instagram", "WhatsApp", "E-mail", "Telegram"])
  assert.ok(!settingsGroups.flatMap(group => group.items).some(item => /cobran|pagamento|pixel|evento|exibir/i.test(item.title)))
})

test("cada canal do menu tem ícone de canal e as demais seções não", () => {
  for (const item of settingsGroups.flatMap(group => group.items)) assert.equal(!!item.channel, ["instagram", "whatsapp", "email", "telegram"].includes(item.id), item.id)
})

test("todo item do menu abre a própria seção pelo endereço", () => {
  for (const group of settingsGroups) for (const item of group.items) assert.equal(activeSettings(`${ws}${item.path}`), item.id, item.title)
  assert.equal(ids().length, new Set(ids()).size)
})

test("endereços antigos e sub-abas abrem a seção certa", () => {
  assert.equal(activeSettings(`${ws}/message-templates`), "whatsapp")
  assert.equal(activeSettings(`${ws}/topics`), "email")
  assert.equal(activeSettings(`${ws}/channels`), "channels")
  assert.equal(activeSettings(`${ws}/fields/bot`), "fields")
  assert.equal(activeSettings(`${ws}/team/groups`), "team")
  assert.equal(activeSettings(`${ws}/logs/activity`), "logs")
  assert.equal(activeSettings(`${ws}/channels/telegram`), "telegram")
})

test("a caixa de entrada das configurações não é confundida com a caixa de entrada do atendimento", () => {
  assert.equal(activeSettings(`${ws}/inbox`), "inbox")
  assert.equal(activeSettings(`${ws}/assignment`), "assignment")
  assert.equal(activeSettings("/demo/settings"), "general")
})

test("canal desconhecido em /settings/channels/:kind volta para a lista de canais, em vez de abrir Geral", () => {
  assert.equal(unknownChannelRedirect("/demo/settings/channels/messenger"), "/demo/settings/channels")
  assert.equal(unknownChannelRedirect("/demo/settings/channels/qualquer-coisa/"), "/demo/settings/channels")
  assert.equal(unknownChannelRedirect("/demo/settings/channels/telegram"), null)
  assert.equal(unknownChannelRedirect("/demo/settings/channels/instagram"), null)
  assert.equal(unknownChannelRedirect("/demo/settings/channels"), null)
  assert.equal(unknownChannelRedirect("/demo/settings"), null)
})

test("cada papel só vê no menu as seções que o motor deixa abrir", () => {
  const visibles = role => ids().filter(id => settingsVisibleTo(role, id))
  assert.deepEqual(visibles("owner"), ids())
  assert.deepEqual(visibles("administrator"), ids())
  // Editor e leitor não administram: sem equipe, conformidade e chaves de API (o motor responde 403 a essas leituras).
  for (const role of ["editor", "viewer"]) {
    const vistas = visibles(role)
    for (const escondida of ["team", "compliance", "api"]) assert.ok(!vistas.includes(escondida), `${role} não vê ${escondida}`)
    assert.ok(!vistas.includes("integrations"), `${role} não vê integrations: oculta até ser provada no publicado (lib/hidden-features)`)
    for (const oculta of ["apps", "installed"]) assert.ok(!vistas.includes(oculta), `${role} não vê ${oculta}: menu oculto (lib/hidden-features)`)
    for (const aberta of ["general", "notices", "logs", "fields", "tags", "telegram", "email"]) assert.ok(vistas.includes(aberta), `${role} vê ${aberta}`)
  }
  // O atendente também não lê automações: perde Registros, Aplicativos, Integrações e Modelos instalados.
  const atendente = visibles("livechat_agent")
  for (const escondida of ["team", "compliance", "api", "logs", "apps", "integrations", "installed"]) assert.ok(!atendente.includes(escondida), `atendente não vê ${escondida}`)
  for (const aberta of ["general", "notices", "inbox", "assignment", "instagram", "whatsapp", "telegram", "fields", "tags"]) assert.ok(atendente.includes(aberta), `atendente vê ${aberta}`)
})
