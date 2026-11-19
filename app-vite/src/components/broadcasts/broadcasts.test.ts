/// <reference types="node" />
import assert from "node:assert/strict"
import test, { afterEach } from "node:test"
import { registerHooks } from "node:module"
registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context) } })
const { configureDataMode } = await import("../../data/api")
const { listBroadcasts, getBroadcastOptions, estimateBroadcastAudience, listAudienceContacts, saveBroadcast, getBroadcast, pauseBroadcast, resumeBroadcast, parseBroadcastSchedule, broadcastRecipientStatusLabel, broadcastReasonLabel, broadcastTemplateVariables, broadcastWindowRule, hasBroadcastWindow, defaultBroadcastWindowKind } = await import("../../data/broadcasts")
const originalFetch = globalThis.fetch
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
afterEach(() => { globalThis.fetch = originalFetch; configureDataMode(undefined) })

test("agendamento interpreta fuso civil e rejeita datas inexistentes", () => {
  assert.equal(parseBroadcastSchedule("2099-10-20T09:30", "America/Sao_Paulo"), "2099-10-20T12:30:00.000Z")
  assert.equal(parseBroadcastSchedule("2099-10-20T09:30", "UTC"), "2099-10-20T09:30:00.000Z")
  assert.throws(() => parseBroadcastSchedule("2099-02-30T10:00", "UTC"), /não existe/)
  assert.throws(() => parseBroadcastSchedule("2027-03-14T02:30", "America/New_York"), /não existe/)
  assert.throws(() => parseBroadcastSchedule("2099-10-20T09:30", "Fuso/Invalido"), /não existe/)
})

test("lista, opções e segmento vêm do backend sem workspace controlado pela rota", async () => {
  configureDataMode("real")
  const calls: { url: string; init?: RequestInit }[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init })
    if (url === "/api/session/workspace") return json({ workspace_id: "real", name: "Oficina" })
    if (url.includes("/audience")) return json({ count: 18, eligible: 12 })
    if (url.endsWith("/options")) return json({ channels: [{ id: "ch-real", value: "telegram", label: "Bot" }], tags: [], segments: [{ id: "segmento & real", name: "Leads ativos" }], templates: [], timezones: ["UTC"] })
    return json([])
  }
  assert.deepEqual(await listBroadcasts("demo", { status: "paused", search: "Curso & aula" }), [])
  assert.equal((await getBroadcastOptions("demo")).channels[0].id, "ch-real")
  assert.equal(await estimateBroadcastAudience("demo", { tag: "tag & real", channel: "telegram", channel_id: "ch-real", segment_id: "segmento & real" }), 12)
  const list = new URL(calls[1].url, "http://local")
  assert.equal(list.searchParams.get("search"), "Curso & aula")
  assert.equal(list.searchParams.get("status"), "paused")
  assert.equal(new Headers(calls[1].init?.headers).get("x-workspace"), "real")
  assert.equal(new URL(calls[3].url, "http://local").searchParams.get("tag"), "tag & real")
  assert.equal(new URL(calls[3].url, "http://local").searchParams.get("channel"), "telegram")
  assert.equal(new URL(calls[3].url, "http://local").searchParams.get("segment_id"), "segmento & real")
})

test("criação envia texto ou template, fuso e modo; relatório/pausa/retomada usam o ID codificado", async () => {
  configureDataMode("real")
  const calls: { url: string; init?: RequestInit }[] = []
  globalThis.fetch = async (input, init) => { const url = String(input); calls.push({ url, init }); return json(url === "/api/session/workspace" ? { workspace_id: "real", name: "Oficina" } : { id: "a/b", status: "sending" }) }
  const input = { name: "Aviso da comunidade", content: "Olá {{1}}", audience: { tag: "tag-real", channel: "whatsapp" as const, channel_id: "ch-real", segment_id: "segmento & real" }, status: "scheduled" as const, timezone: "America/Sao_Paulo", scheduled_local: "2099-10-20T09:30", template: { id: "tpl-real", params: { "1": "Ana" } } }
  await saveBroadcast("demo", input)
  assert.equal(calls[1].init?.method, "POST")
  const body = JSON.parse(String(calls[1].init?.body))
  assert.equal(body.scheduled_at, "2099-10-20T12:30:00.000Z")
  assert.deepEqual(body.template, input.template)
  assert.equal(body.audience.channel_id, "ch-real")
  assert.equal(body.audience.segment_id, "segmento & real")
  await saveBroadcast("demo", { ...input, status: "sending", template: undefined })
  assert.equal(JSON.parse(String(calls[2].init?.body)).status, "sending")
  await getBroadcast("demo", "a/b"); await pauseBroadcast("demo", "a/b"); await resumeBroadcast("demo", "a/b")
  assert.deepEqual(calls.slice(3).map((call) => [call.url, call.init?.method ?? "GET"]), [["/api/broadcasts/a%2Fb", "GET"], ["/api/broadcasts/a%2Fb/pause", "POST"], ["/api/broadcasts/a%2Fb/resume", "POST"]])
  await assert.rejects(saveBroadcast("demo", { ...input, scheduled_local: "2020-01-01T10:00" }), /futuro/)
})

test("falhas do servidor continuam visíveis, sem resultados fictícios", async () => {
  configureDataMode("real")
  globalThis.fetch = async input => String(input) === "/api/session/workspace" ? json({ workspace_id: "real", name: "Oficina" }) : json({ error: "Canal bloqueado" }, 409)
  await assert.rejects(listBroadcasts("demo"), /Canal bloqueado/)
  await assert.rejects(resumeBroadcast("demo", "envio"), /Canal bloqueado/)
})


test("relatório traduz situações, motivos e códigos sem exibir detalhes internos desconhecidos", () => {
  assert.equal(broadcastRecipientStatusLabel("uncertain"), "Aguardando confirmação")
  assert.equal(broadcastRecipientStatusLabel("queued"), "Na fila")
  assert.equal(broadcastRecipientStatusLabel("unknown_internal_status"), "Situação indisponível")
  assert.match(broadcastReasonLabel("manual"), /equipe/)
  assert.match(broadcastReasonLabel("rate_limited"), /limite de envios/)
  assert.match(broadcastReasonLabel("outside_window"), /janela de atendimento/)
  assert.match(broadcastReasonLabel("not_opted_in"), /não autorizou/)
  assert.match(broadcastReasonLabel("131049"), /24 horas/)
  // Credencial recusada: o motivo é o do provedor (vem da conexão); sem ele, um texto que ainda aponta o conserto.
  assert.equal(broadcastReasonLabel("token_refused", "O token do bot foi recusado. Use Trocar credencial."), "O token do bot foi recusado. Use Trocar credencial.")
  assert.match(broadcastReasonLabel("token_refused"), /Trocar credencial/)
  assert.doesNotMatch(broadcastReasonLabel("manual", "outro motivo"), /outro motivo/)
  assert.match(broadcastReasonLabel("131050"), /cancelou/)
  assert.match(broadcastReasonLabel("131026"), /Confira o número/)
  assert.match(broadcastReasonLabel("131063"), /marketing pela API de nuvem/)
  assert.match(broadcastReasonLabel("131064"), /categoria de modelo/)
  assert.match(broadcastReasonLabel("131063"), /termos da API de Mensagens de Marketing/)
  assert.match(broadcastReasonLabel("134102"), /não está habilitada/)
  assert.match(broadcastReasonLabel("134101"), /10 minutos/)
  assert.match(broadcastReasonLabel("134100"), /só aceita modelos de marketing/)
  assert.match(broadcastReasonLabel("131065"), /preço máximo/)
  assert.match(broadcastReasonLabel("131070"), /Conversation routing/)
  assert.match(broadcastReasonLabel("connection_unavailable"), /Canais/)
  assert.match(broadcastReasonLabel("connection_restricted"), /restri/)
  assert.doesNotMatch(broadcastReasonLabel("connection_restricted"), /revise a conexão/)
  assert.match(broadcastReasonLabel("132015"), /pausou/)
  assert.match(broadcastReasonLabel("132016"), /desativou/)
  assert.equal(broadcastReasonLabel("sensitive_internal_detail"), "O canal recusou o envio; revise a conexão.")
})

test("as variáveis do modelo seguem a regra do motor: minúsculas ou número, sem espaços", () => {
  const template = { body: "Olá {{1}}, {{ nome }} e {{Pedido}} e {{nome_cliente}} e {{1}}", header_type: "text", header_text: "Pedido {{codigo}} {{ Outro }}",
    buttons: JSON.stringify([{ text: "Rastrear", url: "https://x.test/{{rastreio}}/{{ errado }}" }, { text: "Ligar" }]) }
  assert.deepEqual(broadcastTemplateVariables(template), [
    { key: "1", label: "Valor de 1" }, { key: "nome_cliente", label: "Valor de nome_cliente" },
    { key: "header:codigo", label: "Cabeçalho: valor de codigo" }, { key: "button:0:rastreio", label: "Botão Rastrear: valor de rastreio" }])
  assert.deepEqual(broadcastTemplateVariables({ ...template, header_type: "image", buttons: "[]", body: "Sem variáveis" }), [])
})

test("tipo da transmissão: regras de conteúdo, seletor só em canal com janela e contador pelo tipo escolhido", async () => {
  assert.deepEqual(broadcastWindowRule("in_window"), { text: true, template: false, note: "Só chega a quem falou com você nas últimas 24 horas. A mensagem é texto livre." })
  assert.equal(broadcastWindowRule("promotional").text, false)
  assert.match(broadcastWindowRule("promotional").note, /modelo aprovado/)
  assert.deepEqual([broadcastWindowRule("automatic").text, broadcastWindowRule("automatic").template], [true, true])
  assert.equal(hasBroadcastWindow({ window: { standardHours: 24 } }), true)
  assert.equal(hasBroadcastWindow({ window: null }), false)
  assert.equal(hasBroadcastWindow(undefined), false)
  configureDataMode("real")
  const calls: { url: string; init?: RequestInit }[] = []
  globalThis.fetch = async (input, init) => { const url = String(input); calls.push({ url, init }); return json(url === "/api/session/workspace" ? { workspace_id: "real", name: "Oficina" } : { count: 5, eligible: 3 }) }
  assert.equal(await estimateBroadcastAudience("demo", { tag: "all", channel: "whatsapp", channel_id: "ch" }, undefined, "in_window"), 3)
  assert.equal(calls[1].init?.method, "POST")
  assert.equal(JSON.parse(String(calls[1].init?.body)).window_kind, "in_window")
})

test("nova transmissão no WhatsApp oficial com modelos aprovados já vem como promocional; sem modelos ou em outro canal, não", () => {
  const whatsapp = { windowChannel: true, canUseTemplates: true, isNew: true }
  assert.equal(defaultBroadcastWindowKind({ ...whatsapp, approvedTemplates: 2 }), "promotional")
  assert.equal(defaultBroadcastWindowKind({ ...whatsapp, approvedTemplates: 0 }), "in_window")
  assert.equal(defaultBroadcastWindowKind({ ...whatsapp, canUseTemplates: false, approvedTemplates: 2 }), "in_window")
  assert.equal(defaultBroadcastWindowKind({ ...whatsapp, isNew: false, approvedTemplates: 2 }), "in_window")
  assert.equal(defaultBroadcastWindowKind({ ...whatsapp, windowChannel: false, approvedTemplates: 2 }), "automatic")
})

test("prévia do público pede a página de contatos ao motor", async () => {
  configureDataMode("real")
  const calls: { url: string; init?: RequestInit }[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init })
    if (url === "/api/session/workspace") return json({ workspace_id: "real", name: "Oficina" })
    return json({ total: 1, page: 2, limit: 20, contacts: [{ id: "c1", name: "Ana Silva", photo: null }] })
  }
  const result = await listAudienceContacts({ tag: "all", channel: "telegram", channel_id: "ch-real" }, undefined, "automatic", 2)
  assert.equal(result.contacts[0].name, "Ana Silva")
  const call = calls.find(item => item.url.endsWith("/broadcasts/audience/contacts"))!
  assert.deepEqual(JSON.parse(String(call.init?.body)), { tag: "all", channel: "telegram", channel_id: "ch-real", window_kind: "automatic", page: 2, limit: 20 })
})
