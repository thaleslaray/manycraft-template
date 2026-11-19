import assert from "node:assert/strict"
import { test } from "node:test"
import { registerHooks } from "node:module"
registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context) } })
const { inferredStepChannel, stepOffer, unstableNotice, stepConnections, availableStepChannels, assignStepChannels, stepChannelOf, textSize } = await import("./step-channel.ts")
const { capabilities } = await import("../../../../engine/src/channels/capabilities.ts")
const { effectiveProfile } = await import("../../../../engine/src/channels/core/profile-merge.ts")

// A ficha de verdade (a mesma que /connections/capabilities serve), não uma lista copiada.
const connection = (id, kind, patch = {}, status = "connected") => ({ id, kind, status, profile: { ...capabilities(kind), ...patch } })
const trigger = (channel_type, channel_id = null) => ({ id: `t-${channel_type}`, channel_type, channel_id })

for (const kind of ["whatsapp", "instagram", "telegram", "email"]) {
  test(`o painel de ${kind} oferece exatamente o que a ficha declara`, () => {
    const caps = capabilities(kind)
    const offer = stepOffer([connection("c", kind)])
    assert.deepEqual(offer.text, { max: caps.text.maxLength, unit: caps.text.unit })
    assert.equal(offer.buttons?.max, caps.buttons.maxPerMessage)
    assert.equal(offer.buttons?.titleMax, caps.buttons.titleMax)
    assert.deepEqual(offer.buttons?.types, caps.buttons.types)
    assert.deepEqual(offer.quickReplies, caps.quickReplies)
    assert.equal(offer.cards, caps.cards !== null)
    assert.equal(offer.list, caps.list !== null)
    assert.deepEqual(offer.media, ["image", "video", "audio", "file"].filter(k => caps.media[k]?.maxBytes > 0))
    assert.deepEqual(offer.typing, caps.typing)
  })
}

// Ficha real dos provedores não oficiais do WhatsApp (a mesma que a lista de conexões serve): perfil do canal + remendo do provedor.
for (const provider of ["uazapi", "zapi"]) {
  test(`o painel do WhatsApp pela ${provider} oferece exatamente o que a ficha do provedor declara`, () => {
    const caps = effectiveProfile("whatsapp", provider)
    const offer = stepOffer([{ id: "c", kind: "whatsapp", status: "connected", profile: caps }])
    assert.deepEqual(offer.text, { max: caps.text.maxLength, unit: caps.text.unit })
    assert.equal(offer.buttons?.max, caps.buttons.maxPerMessage)
    assert.equal(offer.buttons?.titleMax, caps.buttons.titleMax)
    assert.deepEqual(offer.buttons?.types, caps.buttons.types)
    assert.deepEqual(offer.quickReplies, caps.quickReplies)
    assert.equal(offer.cards, caps.cards !== null)
    assert.equal(offer.list, caps.list !== null)
    assert.deepEqual(offer.media, ["image", "video", "audio", "file"].filter(k => caps.media[k]?.maxBytes > 0))
    assert.deepEqual(offer.typing, caps.typing)
    assert.deepEqual(offer.unstable, caps.unstable ?? [])
    // O que difere do WhatsApp oficial: sem lista de opções e sem mídia; botões e cards com aviso de instabilidade.
    assert.equal(offer.list, false)
    assert.deepEqual(offer.media, [])
    assert.match(unstableNotice({ kind: "button" }, offer), /WhatsApp Web/)
    assert.equal(unstableNotice({ kind: "button" }, stepOffer([connection("o", "whatsapp")])), null)
  })
}

test("canais diferentes oferecem coisas diferentes", () => {
  const offers = Object.fromEntries(["whatsapp", "instagram", "telegram", "email"].map(k => [k, stepOffer([connection("c", k)])]))
  assert.equal(offers.telegram.quickReplies, null)
  assert.ok(offers.instagram.quickReplies)
  assert.equal(offers.email.typing, null)
  assert.equal(offers.email.media.length, 0)
  assert.ok(offers.whatsapp.list && !offers.instagram.list)
  assert.equal(offers.instagram.text?.unit, "bytes")
})

test("duas conexões do mesmo canal: vale a interseção", () => {
  const strict = connection("b", "whatsapp", { buttons: { ...capabilities("whatsapp").buttons, maxPerMessage: 2, types: ["url"] }, typing: null, media: { image: { maxBytes: 1000, mime: ["image/png"] } }, text: { maxLength: 500, unit: "chars" } })
  const offer = stepOffer([connection("a", "whatsapp"), strict])
  assert.equal(offer.buttons?.max, 2)
  assert.deepEqual(offer.buttons?.types, ["url"])
  assert.equal(offer.typing, null)
  assert.deepEqual(offer.media, ["image"])
  assert.equal(offer.text?.max, 500)
})

test("sem conexão do canal nada é oferecido", () => {
  const offer = stepOffer([])
  assert.equal(offer.connections, 0)
  assert.equal(offer.buttons, null)
  assert.deepEqual(offer.media, [])
})

test("o passo usa as conexões do próprio canal, não as do gatilho", () => {
  const list = [connection("wa", "whatsapp"), connection("tg", "telegram"), connection("wa2", "whatsapp", {}, "error")]
  assert.deepEqual(stepConnections({ channel: "whatsapp" }, [trigger("telegram", "tg")], list).map(c => c.id), ["wa"])
  assert.deepEqual(stepConnections({}, [trigger("telegram", "tg")], list).map(c => c.id), ["tg"])
  assert.equal(stepChannelOf({ channel: "messenger" }), undefined)
})

test("o seletor de canal lista só canais ativos com conexão ligada", () => {
  const list = [connection("m", "messenger"), connection("t", "tiktok"), connection("tg", "telegram"), connection("ig", "instagram", {}, "disconnected"), connection("e", "email")]
  assert.deepEqual(availableStepChannels(list), ["telegram", "email"])
  assert.deepEqual(availableStepChannels(undefined), [])
})

const step = (id, config = {}) => ({ id, type: "message", data: { config } })
test("fluxo antigo: um só canal no gatilho marca o passo; vários canais deixam a escolher; conteúdo intacto", () => {
  const blocks = [{ kind: "text", text: "Oi" }]
  const one = assignStepChannels([step("m", { blocks }), step("n", { channel: "email" })], [trigger("telegram")])
  assert.equal(one[0].data.config.channel, "telegram")
  assert.deepEqual(one[0].data.config.blocks, blocks)
  assert.equal(one[1].data.config.channel, "email")
  const many = assignStepChannels([step("m", { blocks })], [trigger("telegram"), trigger("whatsapp")])
  assert.equal(many[0].data.config.channel, "pending")
  assert.deepEqual(assignStepChannels([step("m")], [trigger("messenger")])[0].data.config, {})
  assert.deepEqual(assignStepChannels([step("m")], [])[0].data.config, {})
})

test("o texto conta na unidade da ficha", () => {
  assert.equal(textSize("ação", "chars"), 4)
  assert.equal(textSize("ação", "bytes"), 6)
})

test("recurso instável em qualquer conexão do canal vale para o passo todo", () => {
  const estavel = connection("a", "whatsapp")
  const instavel = connection("b", "whatsapp", { unstable: ["buttons", "cards"] })
  assert.deepEqual(stepOffer([estavel]).unstable, [])
  assert.deepEqual(stepOffer([estavel, instavel]).unstable, ["buttons", "cards"])
  assert.deepEqual(stepOffer([connection("c", "whatsapp", { unstable: ["list"] }), instavel]).unstable, ["buttons", "list", "cards"])
})

test("o aviso aparece só para o bloco cujo recurso é instável", () => {
  const offer = stepOffer([connection("b", "whatsapp", { unstable: ["buttons", "cards"] })])
  assert.match(unstableNotice({ kind: "button" }, offer), /botões/i)
  assert.match(unstableNotice({ kind: "card" }, offer), /cards/i)
  assert.match(unstableNotice({ kind: "gallery" }, offer), /cards/i)
  assert.equal(unstableNotice({ kind: "list" }, offer), null)
  assert.equal(unstableNotice({ kind: "text" }, offer), null)
  assert.equal(unstableNotice({ kind: "button" }, stepOffer([connection("a", "whatsapp")])), null)
})

test("passo novo herda o canal sem perguntar quando só há uma resposta", () => {
  const wa = { id: "wa", kind: "whatsapp", status: "connected" }, mail = { id: "mail", kind: "email", status: "connected" }
  // Do passo de origem (botão, próximo passo): vale o canal dele, mesmo com gatilhos de vários canais.
  assert.equal(inferredStepChannel({ channel: "email" }, [{ channel_id: "wa" }], [wa, mail]), "email")
  // Passo solto num fluxo cujos gatilhos são todos de um canal.
  assert.equal(inferredStepChannel(undefined, [{ channel_id: "wa" }, { channel_id: null, channel_type: "whatsapp" }], [wa, mail]), "whatsapp")
  // Gatilhos de canais diferentes: pergunta.
  assert.equal(inferredStepChannel(undefined, [{ channel_id: "wa" }, { channel_id: "mail" }], [wa, mail]), undefined)
  // Origem ainda sem canal ("escolher depois") não decide; sem gatilho, só um canal ligado decide.
  assert.equal(inferredStepChannel({ channel: "pending" }, [], [wa]), "whatsapp")
  assert.equal(inferredStepChannel(undefined, [], [wa, mail]), undefined)
})
