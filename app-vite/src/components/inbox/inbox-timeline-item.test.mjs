import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { transformSync } from "esbuild"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

const src = new URL("../../", import.meta.url)
registerHooks({
  resolve(specifier, context, nextResolve) {
    const target = specifier.startsWith("@/") ? new URL(specifier.slice(2), src) : specifier.startsWith(".") ? new URL(specifier, context.parentURL) : null
    if (target && !/\.[a-z]+$/i.test(target.pathname)) {
      for (const suffix of [".ts", ".tsx", "/index.ts"]) {
        const candidate = `${fileURLToPath(target)}${suffix}`
        if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context)
      }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (/\.(ts|tsx)$/.test(url) && url.startsWith(src.href)) return { format: "module", shortCircuit: true, source: transformSync(readFileSync(new URL(url), "utf8"), { loader: url.endsWith(".tsx") ? "tsx" : "ts", format: "esm", jsx: "automatic" }).code }
    return nextLoad(url, context)
  },
})
const { InboxTimelineItem } = await import("./inbox-timeline-item.tsx")
const createdAt = "2026-10-23T14:00:00.000Z"
const base = { id: "event", source: "system", author: "Sistema", body: "", created_at: createdAt, status: "sent" }
const render = (message) => renderToStaticMarkup(React.createElement(InboxTimelineItem, { message, busy: false, onRetry() {} }))
const content = (html) => html.replace(/<[^>]+>/g, "")

test("cada evento vira linha centralizada com ícone, texto e hora, sem bolha nem recibo de envio", () => {
  const fixtures = [
    [{ kind: "tag_added", tag_id: "t", tag_name: "Interesse" }, "Marcador incluído: Interesse"],
    [{ kind: "tag_removed", tag_id: "t", tag_name: "Interesse" }, "Marcador retirado: Interesse"],
    [{ kind: "field_changed", field_id: "f", field_name: "Turma", previous_value: "Inicial", value: "Avançada" }, "Turma: Inicial → Avançada"],
    [{ kind: "field_skipped", field_id: "f", field_name: "Pontos", operation: "add", reason: "operand" }, "Pontos: operação ignorada, o valor informado não é um número"],
    [{ kind: "delay_started", automation_id: "a", automation_name: "Entrega do guia", ends_at: "2026-10-24T14:30:00.000Z" }, "Entrega do guia aguarda até"],
    [{ kind: "trigger", automation_id: "a", automation_name: "Entrega do guia", trigger_kind: "ig_comment" }, "Entrada por comentário: Entrega do guia"],
    [{ kind: "status_changed", previous_status: "closed", status: "open" }, "Situação alterada: encerrada → aberta"],
    [{ kind: "automation_paused", until: "2026-10-23T14:30:00.000Z" }, "Atendimento humano: automações em pausa até"],
  ]
  for (const [event, text] of fixtures) {
    const html = render({ ...base, event })
    assert.ok(content(html).includes(text), html)
    assert.match(html, new RegExp(`data-inbox-event="${event.kind}"`))
    assert.match(html, /justify-center/)
    assert.match(html, /<svg[^>]+aria-hidden="true"/)
    assert.match(html, /<time[^>]+dateTime="2026-10-23T14:00:00.000Z"/)
    assert.ok(content(html).includes(new Date(createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })))
    assert.doesNotMatch(html, /rounded-lg|border-border|Enviada|Entregue|Tentar de novo/)
    if (event.ends_at || event.until) assert.ok(content(html).includes(new Date(event.ends_at ?? event.until).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })))
  }
})

test("conteúdo longo quebra linha e valores de campo preservam vazio, zero e booleanos", () => {
  const name = "Uma automação com nome extenso para testar a largura da conversa"
  const html = render({ ...base, event: { kind: "trigger", automation_id: "a", automation_name: name, trigger_kind: "novo_tipo" } })
  assert.match(html, /wrap-anywhere/)
  assert.ok(content(html).includes(name))
  assert.ok(content(render({ ...base, event: { kind: "field_changed", field_id: "f", field_name: "Quantidade", previous_value: null, value: 0 } })).includes("Quantidade: vazio → 0"))
  assert.ok(content(render({ ...base, event: { kind: "field_changed", field_id: "f", field_name: "Aceite", previous_value: false, value: true } })).includes("Aceite: não → sim"))
})

test("origens reais do motor descrevem palavra-chave, boas-vindas e outra automação", () => {
  for (const [trigger_kind, origin] of [["keyword", "Entrada por palavra-chave"], ["welcome_message", "Entrada por boas-vindas"], ["another_flow", "Entrada por outra automação"]]) {
    const html = render({ ...base, event: { kind: "trigger", automation_id: "a", automation_name: "Entrega do guia", trigger_kind } })
    assert.ok(content(html).includes(`${origin}: Entrega do guia`))
  }
})

test("cabeçalho de automação tem um único rótulo e mantém nomes específicos", () => {
  const message = { ...base, source: "automation", body: "Seu material está pronto.", author: "Automação" }
  const html = render(message)
  assert.equal(content(html).match(/Automação/g)?.length, 1)
  assert.match(html, /bg-node-condition/)
  assert.ok(content(render({ ...message, author: "Entrega do guia" })).includes("AutomaçãoEntrega do guia"))
})

test("clique de botão permanece mensagem do contato com o rótulo recebido", () => {
  const html = render({ ...base, source: "contact", author: "Contato", body: "Receber meu guia", event: undefined })
  assert.ok(content(html).includes("ContatoReceber meu guia"))
  assert.match(html, /mr-auto w-5\/6/)
  assert.doesNotMatch(html, /data-inbox-event/)
})


test("histórico preserva alteração de e-mail registrada como atividade e mostra assunto no envio", () => {
  const system = render({ ...base, body: "E-mail do contato alterado: antigo@exemplo.test → novo@exemplo.test" })
  assert.ok(content(system).includes("E-mail do contato alterado: antigo@exemplo.test → novo@exemplo.test"))
  const sent = render({ ...base, source: "automation", body: "Corpo de mensagem", email_subject: "Seu pedido" })
  assert.ok(content(sent).includes("E-mail enviado: Seu pedido"))
  assert.ok(!content(sent).includes("Corpo de mensagem"))
  assert.ok(content(render({ ...base, source: "human", body: "Resposta humana", email_subject: "Seu pedido" })).includes("Resposta humana"))
})

// ───────── o que o contato manda além de texto ─────────
const fromContact = { id: "in-1", source: "contact", author: "Contato", body: "", created_at: createdAt, status: "delivered" }
const renderIn = (message) => renderToStaticMarkup(React.createElement(InboxTimelineItem, { message, busy: false, onRetry() {}, workspaceId: "ws-1" }))

test("foto guardada abre no balão, com a legenda embaixo e o espaço na consulta (o <img> não manda cabeçalho)", () => {
  const html = renderIn({ ...fromContact, body: "Taj Mahal", media: { kind: "image", status: "stored", url: "/api/inbox/media/abc", mime: "image/png", caption: "Taj Mahal" } })
  assert.match(html, /<img[^>]+src="\/api\/inbox\/media\/abc\?workspace=ws-1"/)
  assert.match(html, /loading="lazy"/)
  assert.ok(content(html).includes("Taj Mahal"))
  assert.ok(html.indexOf("<img") < html.indexOf("Taj Mahal"), "a imagem vem antes da legenda")
})
test("foto sem legenda não repete o texto automático do motor", () => {
  const html = renderIn({ ...fromContact, body: "[Imagem]", media: { kind: "image", status: "stored", url: "/api/inbox/media/abc" } })
  assert.ok(!content(html).includes("[Imagem]"))
})
test("áudio e vídeo têm controles; figurinha é imagem menor; documento é link para baixar com nome e tamanho", () => {
  const audio = renderIn({ ...fromContact, media: { kind: "audio", status: "stored", url: "/api/inbox/media/a1", voice: true } })
  assert.match(audio, /<audio[^>]+controls/); assert.match(audio, /Mensagem de voz do contato/)
  assert.match(renderIn({ ...fromContact, media: { kind: "video", status: "stored", url: "/api/inbox/media/v1" } }), /<video[^>]+controls/)
  assert.match(renderIn({ ...fromContact, media: { kind: "sticker", status: "stored", url: "/api/inbox/media/s1" } }), /<img[^>]+max-h-32/)
  const file = renderIn({ ...fromContact, media: { kind: "file", status: "stored", url: "/api/inbox/media/d1", name: "recibo.pdf", size: 2 * 1024 * 1024 } })
  assert.match(file, /<a[^>]+download="recibo.pdf"/)
  assert.ok(content(file).includes("recibo.pdf") && content(file).includes("2,0 MB"))
})
test("arquivo baixando mostra o andamento; arquivo que falhou mostra o motivo, sem link quebrado", () => {
  const pending = renderIn({ ...fromContact, media: { kind: "image", status: "pending" } })
  assert.match(pending, /role="status"/); assert.ok(content(pending).includes("Baixando imagem…"))
  const failed = renderIn({ ...fromContact, media: { kind: "video", status: "failed", error: "O arquivo não está mais disponível no canal." } })
  assert.match(failed, /role="alert"/); assert.ok(content(failed).includes("Vídeo não disponível. O arquivo não está mais disponível no canal."))
  assert.doesNotMatch(failed, /<video|<img|<a /)
})
test("localização mostra nome, endereço, coordenadas e o link do mapa em nova aba", () => {
  const html = renderIn({ ...fromContact, body: "Localização: ...", location: { latitude: -23.5614, longitude: -46.6559, name: "Avenida Paulista", address: "São Paulo, SP" } })
  for (const text of ["Avenida Paulista", "São Paulo, SP", "-23.56140, -46.65590", "Abrir no mapa"]) assert.ok(content(html).includes(text), text)
  assert.match(html, /href="https:\/\/www\.google\.com\/maps\?q=-23\.5614,-46\.6559"[^>]*>/)
  assert.match(html, /rel="noopener noreferrer"/)
  assert.ok(!content(html).includes("Localização: ..."), "o texto automático não aparece junto do cartão")
})
test("contatos compartilhados e pedido aparecem em cartões legíveis", () => {
  const contacts = renderIn({ ...fromContact, shared_contacts: [{ name: "Barbara Johnson", company: "Social Tsunami", phones: ["+55 11 99999-0000"], emails: ["b@example.test"] }] })
  for (const text of ["Barbara Johnson", "Social Tsunami", "+55 11 99999-0000", "b@example.test"]) assert.ok(content(contacts).includes(text), text)
  assert.match(contacts, /aria-label="Contatos compartilhados"/)
  const order = renderIn({ ...fromContact, order: { catalogId: "c", text: "Quero estes", items: [{ productId: "p1", quantity: 2, price: 30, currency: "BRL" }] } })
  for (const text of ["Pedido do catálogo", "2 × p1", "Quero estes"]) assert.ok(content(order).includes(text), text)
  assert.ok(content(order).replace(/\s/g, " ").includes("R$"), "preço em reais")
})
test("tipo que o canal não entrega mostra o texto do motor", () => {
  assert.ok(content(renderIn({ ...fromContact, body: "[Mensagem de um tipo que este canal não entrega]", unsupported: { type: "edit" } })).includes("não entrega"))
})
test("reação do contato aparece junto do balão, com nome acessível", () => {
  const html = renderIn({ ...fromContact, body: "bom dia", reaction: { emoji: "👍" } })
  assert.ok(content(html).includes("bom dia") && content(html).includes("👍"))
  assert.match(html, /aria-label="Reação do contato: 👍"/)
  assert.doesNotMatch(renderIn({ ...fromContact, body: "bom dia" }), /Reação do contato/)
})

test("mensagem de transmissão, sem autor, abre como automação em vez de quebrar a conversa", () => {
  const html = render({ id: "b1", source: "broadcast", body: "Promoção de hoje", created_at: createdAt, status: "sent" })
  assert.match(content(html), /Automação/)
  assert.match(content(html), /Promoção de hoje/)
  const withAuthor = render({ id: "b2", source: "automation", author: "Transmissão", body: "Outra", created_at: createdAt, status: "sent" })
  assert.match(content(withAuthor), /Transmissão/)
})
