import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { test } from "node:test"
import { transformSync } from "esbuild"

const src = new URL("../../", import.meta.url)
registerHooks({
  resolve(specifier, context, nextResolve) {
    let target
    if (specifier.startsWith("@/")) target = new URL(specifier.slice(2), src)
    else if (specifier.startsWith(".")) target = new URL(specifier, context.parentURL)
    if (target && !/\.[a-z]+$/i.test(target.pathname)) {
      for (const suffix of [".ts", ".tsx", "/index.ts"]) {
        const candidate = `${fileURLToPath(target)}${suffix}`
        if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context)
      }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (/\.(ts|tsx)$/.test(url) && url.startsWith(src.href)) {
      const loader = url.endsWith(".tsx") ? "tsx" : "ts"
      return { format: "module", shortCircuit: true, source: transformSync(readFileSync(new URL(url), "utf8"), { loader, format: "esm", jsx: "automatic" }).code }
    }
    return nextLoad(url, context)
  },
})
const { startPreview, choosePreview, answerPreview } = await import("./preview.ts")

const node = (id, type, config = {}) => ({ id, type, position: { x: 0, y: 0 }, config })
const edge = (from, port, to) => ({ from, port, to })
const catalog = { tags: [{ id: "t1", name: "quente" }], fields: [{ id: "f1", name: "Cidade", type: "text" }, { id: "f2", name: "Idade", type: "number" }], sequences: [{ id: "s1", name: "Boas-vindas" }], automations: [{ id: "a2", name: "Outra" }] }
const env = (nodes, edges) => ({ graph: { nodes, edges }, catalog })
const texts = (state, kind) => state.items.filter(i => i.kind === kind).map(i => i.text)

test("percorre mensagens em sequência com variáveis de exemplo e termina no fim do fluxo", () => {
  const e = env([
    node("trigger", "trigger"),
    node("m1", "message", { blocks: [{ kind: "text", text: "Oi {{primeiro_nome|amigo}}!" }, { kind: "text", text: "Cidade: {{campo:f1|sua cidade}}" }] }),
    node("m2", "message", { blocks: [{ kind: "text", text: "Fim" }] }),
  ], [edge("trigger", "next", "m1"), edge("m1", "next", "m2")])
  const s = startPreview(e)
  assert.deepEqual(texts(s, "text"), ["Oi Maria!", "Cidade: sua cidade", "Fim"])
  assert.equal(s.wait, null)
  assert.ok(s.ended)
})

test("botão espera o toque, mostra o texto tocado e segue pela porta do botão", () => {
  const e = env([
    node("trigger", "trigger"),
    node("m1", "message", { blocks: [{ kind: "text", text: "Escolha" }, { kind: "button", id: "b1", label: "Quero", action: { type: "go_to_node" }, actions: [{ type: "add_tag", tag_id: "t1" }] }, { kind: "button", id: "b2", label: "Site", action: { type: "url", url: "https://x.com.br" } }] }),
    node("m2", "message", { blocks: [{ kind: "text", text: "Ótimo" }] }),
  ], [edge("trigger", "next", "m1"), edge("m1", "btn:b1", "m2")])
  let s = startPreview(e)
  assert.equal(s.wait.kind, "choices")
  assert.deepEqual(s.wait.choices.map(c => c.label), ["Quero", "Não tocar em nada"])
  s = choosePreview(e, s, "btn:b1")
  assert.deepEqual(texts(s, "contact"), ["Quero"])
  assert.ok(texts(s, "note").some(t => t.includes("quente") && t.includes("seria")))
  assert.deepEqual(texts(s, "text"), ["Escolha", "Ótimo"])
  assert.ok(s.ended)
})

test("botão de link sem saída ligada não espera: mostra o endereço e segue pelo próximo passo", () => {
  const e = env([node("trigger", "trigger"), node("m1", "message", { blocks: [{ kind: "text", text: "Veja" }, { kind: "button", id: "b2", label: "Site", action: { type: "url", url: "https://x.com.br" } }] }),
    node("m2", "message", { blocks: [{ kind: "text", text: "Depois" }] })], [edge("trigger", "next", "m1"), edge("m1", "next", "m2")])
  const s = startPreview(e)
  assert.equal(s.wait, null)
  assert.ok(texts(s, "note").some(t => t.includes("https://x.com.br") && t.includes("não espera")))
  assert.deepEqual(texts(s, "text"), ["Veja", "Depois"])
})

test("botão de link com saída ligada espera o toque e segue por ela", () => {
  const e = env([node("trigger", "trigger"), node("m1", "message", { blocks: [{ kind: "text", text: "Veja" }, { kind: "button", id: "b2", label: "Site", action: { type: "url", url: "https://x.com.br" } }] }),
    node("m2", "message", { blocks: [{ kind: "text", text: "Voltou" }] })], [edge("trigger", "next", "m1"), edge("m1", "btn:b2", "m2")])
  let s = startPreview(e)
  assert.equal(s.wait.kind, "choices")
  s = choosePreview(e, s, "btn:b2")
  assert.ok(texts(s, "note").some(t => t.includes("https://x.com.br")))
  assert.deepEqual(texts(s, "text"), ["Veja", "Voltou"])
})

test("sem toque em botões segue só pela saída Sem resposta; sem ela o fluxo termina", () => {
  const nodes = [node("trigger", "trigger"), node("m1", "message", { blocks: [{ kind: "text", text: "Escolha" }, { kind: "button", id: "b1", label: "Quero", action: { type: "go_to_node" } }] }),
    node("seguinte", "message", { blocks: [{ kind: "text", text: "PROXIMO" }] }), node("tempo", "message", { blocks: [{ kind: "text", text: "TEMPO" }] })]
  const semSaida = env(nodes, [edge("trigger", "next", "m1"), edge("m1", "next", "seguinte")])
  const parado = choosePreview(semSaida, startPreview(semSaida), "__none")
  assert.deepEqual(texts(parado, "text"), ["Escolha"])
  assert.ok(parado.ended)
  const comSaida = env(nodes, [edge("trigger", "next", "m1"), edge("m1", "next", "seguinte"), edge("m1", "timeout", "tempo")])
  assert.deepEqual(texts(choosePreview(comSaida, startPreview(comSaida), "__none"), "text"), ["Escolha", "TEMPO"])
})

test("Pular sem saída própria cai no próximo passo; com saída segue por ela", () => {
  const nodes = [node("trigger", "trigger"), node("m1", "message", { blocks: [{ kind: "text", text: "Quer?" }, { kind: "quick_reply", id: "q2", label: "Pular", skip: true }] }),
    node("n", "message", { blocks: [{ kind: "text", text: "PROXIMO" }] }), node("p", "message", { blocks: [{ kind: "text", text: "PULOU" }] })]
  const sem = env(nodes, [edge("trigger", "next", "m1"), edge("m1", "next", "n")])
  assert.deepEqual(texts(choosePreview(sem, startPreview(sem), "btn:q2"), "text"), ["Quer?", "PROXIMO"])
  const com = env(nodes, [edge("trigger", "next", "m1"), edge("m1", "next", "n"), edge("m1", "btn:q2", "p")])
  assert.deepEqual(texts(choosePreview(com, startPreview(com), "btn:q2"), "text"), ["Quer?", "PULOU"])
})

test("Iniciar automação diz se o fluxo espera ou segue em paralelo, como o motor", () => {
  const make = config => env([node("trigger", "trigger"), node("s", "start_automation", { automation_id: "a2", ...config })], [edge("trigger", "next", "s")])
  assert.ok(texts(startPreview(make({ wait_for_finish: true })), "note").some(t => t.includes("esperaria ela terminar")))
  assert.ok(texts(startPreview(make({})), "note").some(t => t.includes("em paralelo") && t.includes("sem esperar")))
  assert.ok(texts(startPreview(make({ wait_for_finish: false })), "note").some(t => t.includes("sem esperar")))
})

test("resposta rápida e Pular seguem pelas portas e 'não tocar' segue pelo próximo", () => {
  const e = env([
    node("trigger", "trigger"),
    node("m1", "message", { blocks: [{ kind: "text", text: "Quer?" }, { kind: "quick_reply", id: "q1", label: "Sim" }, { kind: "quick_reply", id: "q2", label: "Pular", skip: true }] }),
    node("y", "message", { blocks: [{ kind: "text", text: "Sim!" }] }),
    node("n", "message", { blocks: [{ kind: "text", text: "Sem resposta" }] }),
  ], [edge("trigger", "next", "m1"), edge("m1", "btn:q1", "y"), edge("m1", "next", "n")])
  const s = startPreview(e)
  assert.deepEqual(s.wait.choices.map(c => c.tone), ["reply", "skip", "timeout"])
  assert.deepEqual(texts(choosePreview(e, s, "btn:q1"), "text"), ["Quer?", "Sim!"])
  assert.deepEqual(texts(choosePreview(e, s, "__none"), "text"), ["Quer?", "Sem resposta"])
})

test("cartões entram como item e botões de retorno viram escolhas", () => {
  const card = { kind: "card", aspectRatio: "horizontal", cards: [{ title: "Oi {{primeiro_nome}}", buttons: [{ type: "postback", title: "Ver", id: "p1" }, { type: "url", title: "Site", url: "https://a.com.br" }] }] }
  const e = env([node("trigger", "trigger"), node("m1", "message", { blocks: [card] }), node("m2", "message", { blocks: [{ kind: "text", text: "Visto" }] })], [edge("trigger", "next", "m1"), edge("m1", "next", "m2")])
  let s = startPreview(e)
  const shown = s.items.find(i => i.kind === "cards")
  assert.equal(shown.block.cards[0].title, "Oi Maria")
  assert.deepEqual(s.wait.choices.map(c => c.label), ["Ver", "Não tocar em nada"])
  s = choosePreview(e, s, s.wait.choices[0].id)
  assert.deepEqual(texts(s, "text"), ["Visto"])
})

test("pergunta valida a resposta, guarda só na prévia e usa o valor nas variáveis seguintes", () => {
  const e = env([
    node("trigger", "trigger"),
    node("q", "question", { text: "Seu e-mail?", answer_type: "email", field_id: "system:email", retry_message: "Tente de novo", max_attempts: 2, skip: false, choices: [] }),
    node("q2", "question", { text: "Cidade?", answer_type: "text", field_id: "f1", retry_message: "r", max_attempts: 3, skip: false, choices: [] }),
    node("m", "message", { blocks: [{ kind: "text", text: "Em {{campo:f1|?}}" }] }),
  ], [edge("trigger", "next", "q"), edge("q", "success", "q2"), edge("q2", "success", "m")])
  let s = startPreview(e)
  assert.equal(s.wait.kind, "answer")
  s = answerPreview(e, s, "isso não é e-mail")
  assert.deepEqual(texts(s, "text").slice(-1), ["Tente de novo"])
  assert.equal(s.wait.node, "q")
  s = answerPreview(e, s, "ana@exemplo.com")
  assert.equal(s.wait.node, "q2")
  s = answerPreview(e, s, "Recife")
  assert.deepEqual(texts(s, "text").slice(-1), ["Em Recife"])
  assert.ok(texts(s, "note").some(t => t.includes("Cidade") && t.includes("Recife")))
})

test("pergunta esgota as tentativas e segue por Sem resposta; tempo esgotado também", () => {
  const nodes = [
    node("trigger", "trigger"),
    node("q", "question", { text: "Idade?", answer_type: "number", field_id: "f2", retry_message: "de novo", max_attempts: 2, skip: true, choices: [] }),
    node("ok", "message", { blocks: [{ kind: "text", text: "OK" }] }),
    node("no", "message", { blocks: [{ kind: "text", text: "NADA" }] }),
  ]
  const e = env(nodes, [edge("trigger", "next", "q"), edge("q", "success", "ok"), edge("q", "no_response", "no")])
  let s = startPreview(e)
  assert.ok(s.wait.skip)
  s = answerPreview(e, s, "abc")
  s = answerPreview(e, s, "xyz")
  assert.deepEqual(texts(s, "text").slice(-1), ["NADA"])
  assert.deepEqual(texts(choosePreview(e, startPreview(e), "__timeout"), "text").slice(-1), ["NADA"])
  assert.deepEqual(texts(choosePreview(e, startPreview(e), "__skip"), "text").slice(-1), ["OK"])
})

test("pergunta de múltipla escolha oferece as opções", () => {
  const e = env([node("trigger", "trigger"), node("q", "question", { text: "Cor?", answer_type: "multiple_choice", field_id: "f1", retry_message: "r", max_attempts: 3, skip: false, choices: ["Azul", "Verde"] }), node("m", "message", { blocks: [{ kind: "text", text: "{{campo:f1}}" }] })], [edge("trigger", "next", "q"), edge("q", "success", "m")])
  let s = startPreview(e)
  assert.deepEqual(s.wait.options, ["Azul", "Verde"])
  s = answerPreview(e, s, "verde")
  assert.deepEqual(texts(s, "text").slice(-1), ["Verde"])
})

test("ações viram notas sem efeito real e esperas são puladas com aviso", () => {
  const e = env([
    node("trigger", "trigger"),
    node("a", "action", { actions: [{ type: "add_tag", tag_id: "t1" }, { type: "set_custom_field_value", field_id: "f1", value: "Rio" }, { type: "add_to_sequence", sequence_id: "s1" }, { type: "external_request", method: "POST", url: "https://api.x.com/h", headers: [], mappings: [] }] }),
    node("d", "smart_delay", { duration: { value: 2, unit: "days" } }),
    node("m", "message", { blocks: [{ kind: "text", text: "{{campo:f1|?}}" }] }),
  ], [edge("trigger", "next", "a"), edge("a", "next", "d"), edge("d", "next", "m")])
  const s = startPreview(e)
  const notes = texts(s, "note")
  assert.ok(notes.some(t => t.includes("etiqueta") && t.includes("quente")))
  assert.ok(notes.some(t => t.includes("Cidade") && t.includes("Rio")))
  assert.ok(notes.some(t => t.includes("Boas-vindas")))
  assert.ok(notes.some(t => t.includes("POST") && t.includes("api.x.com")))
  assert.ok(notes.some(t => t.includes("2 dias") && t.toLowerCase().includes("pulada")))
  assert.deepEqual(texts(s, "text"), ["Rio"])
})

test("condição e divisão deixam escolher o caminho; iniciar automação só avisa", () => {
  const e = env([
    node("trigger", "trigger"),
    node("c", "condition", { match: "all", rules: [{ type: "tag", tag_id: "t1", operator: "has" }] }),
    node("yes", "message", { blocks: [{ kind: "text", text: "SIM" }] }),
    node("no", "message", { blocks: [{ kind: "text", text: "NAO" }] }),
    node("s", "start_automation", { automation_id: "a2" }),
    node("end", "message", { blocks: [{ kind: "text", text: "FIM" }] }),
  ], [edge("trigger", "next", "c"), edge("c", "true", "yes"), edge("c", "false", "no"), edge("yes", "next", "s"), edge("s", "next", "end")])
  let s = startPreview(e)
  assert.equal(s.wait.kind, "choices")
  assert.deepEqual(s.wait.choices.map(c => c.tone), ["path", "path"])
  s = choosePreview(e, s, "false")
  assert.deepEqual(texts(s, "text"), ["NAO"])
  s = choosePreview(e, startPreview(e), "true")
  assert.deepEqual(texts(s, "text"), ["SIM", "FIM"])
  assert.ok(texts(s, "note").some(t => t.includes("Outra")))
})

test("porta sem ligação encerra com aviso; ciclo infinito é interrompido", () => {
  const open = env([node("trigger", "trigger"), node("m", "message", { blocks: [{ kind: "text", text: "a" }] })], [edge("trigger", "next", "m")])
  assert.ok(startPreview(open).ended.includes("termina"))
  const loop = env([node("trigger", "trigger"), node("m", "message", { blocks: [{ kind: "text", text: "a" }] })], [edge("trigger", "next", "m"), edge("m", "next", "m")])
  const s = startPreview(loop)
  assert.ok(s.ended.includes("limite"))
  assert.ok(s.items.length < 500)
})

test("mensagem vazia não vira balão e grafo sem gatilho conectado avisa", () => {
  const e = env([node("trigger", "trigger"), node("m", "message", { blocks: [{ kind: "text", text: "  " }] })], [edge("trigger", "next", "m")])
  assert.deepEqual(startPreview(e).items.filter(i => i.kind === "text"), [])
  const none = env([node("trigger", "trigger")], [])
  assert.ok(startPreview(none).ended)
})

test("excluir contato encerra a prévia e e-mail vira nota", () => {
  const e = env([node("trigger", "trigger"), node("a", "action", { actions: [{ type: "delete_subscriber" }] }), node("m", "message", { blocks: [{ kind: "text", text: "nunca" }] })], [edge("trigger", "next", "a"), edge("a", "next", "m")])
  const s = startPreview(e)
  assert.deepEqual(texts(s, "text"), [])
  assert.ok(s.ended.includes("exclu"))
  const mail = env([node("trigger", "trigger"), node("m", "message", { blocks: [{ kind: "text", text: "x" }], email: { subject: "Olá", preheader: "p" } })], [edge("trigger", "next", "m")])
  assert.ok(texts(startPreview(mail), "note").some(t => t.includes("Olá")))
})

test("o celular simulado renderiza a conversa, o aviso de simulação e as opções do contato", async () => {
  const React = (await import("react")).default
  const { renderToStaticMarkup } = await import("react-dom/server")
  const { AutomationPreview } = await import("./automation-preview.tsx")
  const e = env([node("trigger", "trigger"), node("m1", "message", { blocks: [{ kind: "text", text: "Oi {{primeiro_nome}}" }, { kind: "quick_reply", id: "q1", label: "Sim" }] })], [edge("trigger", "next", "m1")])
  const html = renderToStaticMarkup(React.createElement(AutomationPreview, { env: e, issue: "Alguns nomes não carregaram.", onClose() {} }))
  assert.match(html, /role="region"/)
  assert.match(html, /nada é enviado, gravado nem chamado/)
  assert.match(html, /role="log"/)
  assert.match(html, /Oi Maria/)
  assert.match(html, /Sim/)
  assert.match(html, /Não tocar em nada/)
  assert.match(html, /Alguns nomes não carregaram/)
  const vazio = renderToStaticMarkup(React.createElement(AutomationPreview, { env: env([], []), onClose() {} }))
  assert.match(vazio, /ainda não tem gatilho/)
  assert.match(vazio, /Nada para mostrar ainda/)
})
