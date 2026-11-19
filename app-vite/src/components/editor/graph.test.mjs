import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { test } from "node:test"
import { transformSync } from "esbuild"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ReactFlowProvider, applyNodeChanges, applyEdgeChanges } from "@xyflow/react"
import { demoGraph, demoIds } from "../../../../engine/scripts/seed-telegram.mjs"
import { graphSchema, durationSchema } from "../../../../engine/src/schemas/graph.ts"

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
const graph = await import("./graph.ts")
const { EditorProvider } = await import("./editor-context.tsx")
const { MessageNode, TriggerNode, ActionNode, DelayNode } = await import("./nodes.tsx")
const { DelayPanel } = await import("./node-panels.tsx")
const trigger = {
  id: demoIds.trigger, workspace_id: demoIds.workspace, automation_id: demoIds.automation,
  channel_id: demoIds.channel, channel_type: "telegram", node_id: "trigger", type: "dm_keyword",
  name: "Pedido do link", active: true,
  config: { target: "all", include: [], exclude: [], public_replies: [] },
  keywords: [{ id: demoIds.keyword, rule: "is", words: ["quero"], status: "live", case_sensitive: false, parent_id: null, priority: 0 }],
}
const renderNode = (Component, node) => renderToStaticMarkup(React.createElement(ReactFlowProvider, {},
  React.createElement(EditorProvider, { value: { readOnly: false, stats: null, triggers: [trigger], tags: [{ id: demoIds.tag, name: "lead" }], errors: {}, showErrors: false } },
    React.createElement(Component, node))))

test("cada passo tem nome acessível próprio: tipo e início do texto da mensagem", () => {
  assert.equal(graph.stepAriaLabel("message", { blocks: [{ kind: "text", text: "Oi, tudo bem?" }] }), "Passo Mensagem: Oi, tudo bem?. Enter abre as opções, Delete remove.")
  assert.equal(graph.stepAriaLabel("message", { blocks: [{ kind: "text", text: "x".repeat(200) }] }).length < 130, true)
  assert.equal(graph.stepAriaLabel("smart_delay", {}), "Passo Esperar. Enter abre as opções, Delete remove.")
  const flow = graph.toFlow({ nodes: [{ id: "a", type: "message", position: { x: 0, y: 0 }, config: { blocks: [{ kind: "text", text: "Primeira" }] } }, { id: "b", type: "message", position: { x: 0, y: 300 }, config: { blocks: [{ kind: "text", text: "Segunda" }] } }], edges: [] })
  assert.deepEqual(flow.nodes.map(n => n.ariaLabel), ["Passo Mensagem: Primeira. Enter abre as opções, Delete remove.", "Passo Mensagem: Segunda. Enter abre as opções, Delete remove."])
})

test("rascunho vazio ou incompleto abre com o gatilho, sem quebrar; grafo completo passa igual", () => {
  for (const vazio of [{}, null, undefined, { edges: [] }, { nodes: null, edges: null }]) {
    const flow = graph.toFlow(vazio)
    assert.deepEqual(flow.nodes.map(n => [n.id, n.type, n.deletable]), [["trigger", "trigger", false]])
    assert.deepEqual(flow.edges, [])
    assert.deepEqual(graph.toGraph(flow.nodes, flow.edges), { nodes: [{ id: "trigger", type: "trigger", position: { x: 0, y: 80 }, config: {} }], edges: [] })
  }
  assert.deepEqual(graph.toFlow({ nodes: [], edges: [] }), { nodes: [], edges: [] })
  const completo = structuredClone(demoGraph)
  assert.equal(graph.completeGraph(completo), completo)
  assert.deepEqual(graph.completeGraph({ nodes: completo.nodes }).edges, [])
})

test('publicação marca passo solto mesmo com ligação para si próprio', () => {
  const flow = graph.toFlow(structuredClone(demoGraph))
  flow.nodes.push({ id: 'ilha', type: 'message', position: { x: 0, y: 0 }, data: { config: { blocks: [{ kind: 'text', text: 'Solto' }] } } })
  flow.edges.push({ id: 'ilha:next', source: 'ilha', sourceHandle: 'next', target: 'ilha' })
  assert.match(graph.validateGraph(flow.nodes, flow.edges, [trigger]).ilha?.join(' ') ?? '', /solto/)
})

test('publicar sem nenhum gatilho cadastrado avisa no passo do gatilho', () => {
  const flow = graph.toFlow(structuredClone(demoGraph))
  const erros = graph.validateGraph(flow.nodes, flow.edges, [])
  const passo = flow.nodes.find(n => n.type === 'trigger').id
  assert.match(erros[passo]?.join(' ') ?? '', /Adicione um gatilho/)
  assert.deepEqual(graph.validateGraph(flow.nodes, flow.edges, [trigger]), {})
})

test("grafo real do seed faz ida e volta sem perder duração, botão, timeout, ações e portas do motor", () => {
  const flow = graph.toFlow(structuredClone(demoGraph))
  assert.deepEqual(graphSchema.parse(graph.toGraph(flow.nodes, flow.edges)), demoGraph)
  assert.equal(graph.PORT_THEN, "next")
  assert.equal(graph.triggerOf(flow.nodes[0], [trigger]), trigger)
  assert.deepEqual(graph.getActions(flow.nodes.find(n => n.id === "lead").data.config), [{ type: "add_tag", tag_id: demoIds.tag }])
  assert.deepEqual(graph.validateGraph(flow.nodes, flow.edges, [trigger]), {})
})

test("duration lê e grava todas as unidades do motor, inclusive segundos, preservando os outros nós", () => {
  for (const unit of ["seconds", "minutes", "hours", "days"]) {
    const flow = graph.toFlow(structuredClone(demoGraph))
    const delay = flow.nodes.find(n => n.id === "delay")
    assert.deepEqual(graph.getDuration(delay.data.config), { value: 1, unit: "minutes" })
    delay.data.config = { ...delay.data.config, duration: { value: 2, unit } }
    const saved = graphSchema.parse(graph.toGraph(flow.nodes, flow.edges))
    assert.deepEqual(durationSchema.parse(saved.nodes.find(n => n.id === "delay").config.duration), { value: 2, unit })
    assert.deepEqual(saved.nodes.find(n => n.id === "delay").config, { duration: { value: 2, unit } })
    assert.deepEqual(saved.nodes.filter(n => n.id !== "delay"), demoGraph.nodes.filter(n => n.id !== "delay"))
    const reopened = graph.toFlow(saved)
    assert.deepEqual(graph.getDuration(reopened.nodes.find(n => n.id === "delay").data.config), { value: 2, unit })
    assert.deepEqual(graph.validateGraph(reopened.nodes, reopened.edges, [trigger]), {})
  }
  for (const value of [0, -1, 0.5, NaN]) assert.equal(graph.validDuration({ value, unit: "seconds" }), false)
  assert.equal(graph.validDuration({ value: 365, unit: "days" }), true)
  assert.equal(graph.validDuration({ value: 366, unit: "days" }), false)
})

test("medidas e seleção iniciais do React Flow não sujam; configuração, posição e ligação reais sujam", () => {
  const { nodes, edges } = graph.toFlow(structuredClone(demoGraph))
  const saved = graph.graphSnapshot(nodes, edges)
  const measured = applyNodeChanges([
    { id: "offer", type: "dimensions", dimensions: { width: 320, height: 210 }, setAttributes: true },
    { id: "offer", type: "select", selected: true },
    { id: "offer", type: "position", position: { x: 380, y: 0 }, dragging: false },
  ], nodes)
  const selectedEdges = applyEdgeChanges([{ id: edges[0].id, type: "select", selected: true }], edges)
  assert.equal(graph.graphSnapshot(measured, selectedEdges), saved)
  assert.notEqual(graph.graphSnapshot(applyNodeChanges([{ id: "offer", type: "position", position: { x: 280, y: 40 } }], measured), selectedEdges), saved)
  const edited = structuredClone(measured)
  edited.find(n => n.id === "delay").data.config.duration.value = 2
  assert.notEqual(graph.graphSnapshot(edited, selectedEdges), saved)
  assert.notEqual(graph.graphSnapshot(measured, selectedEdges.slice(1)), saved)
  // Confere que o estado visível do editor usa a mesma comparação persistida.
  const editor = readFileSync(new URL("./flow-editor.tsx", import.meta.url), "utf8")
  assert.match(editor, /const dirty = graphSnapshot\(nodes, edges\) !== savedSnapshot/)
  assert.doesNotMatch(editor, /setDirty\(true\)/)
})

test("nós reais renderizam Telegram, palavra-chave e tag do seed sem depender de config.channel", () => {
  const { nodes } = graph.toFlow(structuredClone(demoGraph))
  const message = renderNode(MessageNode, nodes.find(n => n.id === "offer"))
  assert.match(message, />Telegram</)
  assert.doesNotMatch(message, /Instagram/)
  assert.match(message, /Quero o link/)
  const triggerHtml = renderNode(TriggerNode, nodes[0])
  assert.match(triggerHtml, /quero/)
  assert.doesNotMatch(triggerHtml, /Configure o gatilho/)
  const action = renderNode(ActionNode, nodes.find(n => n.id === "lead"))
  assert.match(action, /lead/)
  assert.equal(graph.messageChannel({}, []), "Canal não definido")
  assert.equal(graph.messageChannel({}, [trigger]), "Telegram")
  assert.equal(graph.messageChannel({ channel: "instagram" }, [trigger]), "Instagram")
  assert.equal(graph.messageChannel({ channel: "pending" }, [trigger]), "Canal a escolher")
  // Passo de e-mail de uma transmissão: sem gatilho nem canal no passo, o conteúdo de e-mail já diz o canal.
  assert.equal(graph.messageChannel({ email: { subject: "Oi" } }, []), "E-mail")
  // Relatório de e-mail sem conteúdo de e-mail guardado: o canal do passo é o da transmissão.
  assert.equal(graph.messageChannel({ channel: "email" }, []), "E-mail")
})

test("painel Esperar abre preenchido a partir de duration e não grava configuração na renderização", () => {
  const flow = graph.toFlow(structuredClone(demoGraph))
  const writes = []
  const html = renderToStaticMarkup(React.createElement(DelayPanel, {
    ...flow, node: flow.nodes.find(n => n.id === "delay"), triggers: [trigger], tags: [], readOnly: false,
    errors: [], showErrors: false, updateConfig: patch => writes.push(patch),
    setLink() {}, onClose() {}, onDeleteNode() {}, onTriggerChange() {},
  }))
  assert.match(html, /id="delay-v"[^>]*value="1"/)
  assert.match(renderNode(DelayNode, flow.nodes.find(n => n.id === "delay")), /1 minuto/)
  assert.deepEqual(writes, [])
})

test("eventos do painel Esperar gravam duration no contrato do motor e reabrem o valor salvo", () => {
  const flow = graph.toFlow(structuredClone(demoGraph))
  const node = flow.nodes.find(n => n.id === "delay")
  const writes = []
  let tree
  const props = { ...flow, node, triggers: [trigger], tags: [], readOnly: false, errors: [], showErrors: false,
    updateConfig(patch) { writes.push(patch); node.data.config = { ...node.data.config, ...patch } },
    setLink() {}, onClose() {}, onDeleteNode() {}, onTriggerChange() {},
  }
  // Captura a árvore pública do painel durante uma renderização React válida.
  function CapturePanel() { tree = DelayPanel(props); return tree }
  const findControl = (element, key) => {
    if (!React.isValidElement(element)) return undefined
    if (element.props.id === key) return element
    for (const child of React.Children.toArray(element.props.children)) {
      const found = findControl(child, key)
      if (found) return found
    }
  }
  renderToStaticMarkup(React.createElement(CapturePanel))
  findControl(tree, "delay-v").props.onChange({ target: { value: "3" } })
  assert.deepEqual(writes.pop(), { duration: { value: 3, unit: "minutes" } })
  renderToStaticMarkup(React.createElement(CapturePanel))
  findControl(tree, "delay-u").props.onChange("seconds")
  assert.deepEqual(writes.pop(), { duration: { value: 3, unit: "seconds" } })
  const reopened = graph.toFlow(graph.toGraph(flow.nodes, flow.edges))
  assert.deepEqual(graph.getDuration(reopened.nodes.find(n => n.id === "delay").data.config), { value: 3, unit: "seconds" })
  assert.deepEqual(graph.validateGraph(reopened.nodes, reopened.edges, [trigger]), {})
})


test("saída antiga then do gatilho abre ligada e salva como next, sem alterar portas de outros tipos", () => {
  const legacy = structuredClone(demoGraph)
  legacy.edges[0].port = "then"
  const flow = graph.toFlow(legacy)
  assert.deepEqual(graph.toGraph(flow.nodes, flow.edges), demoGraph)
  assert.deepEqual(graph.validateGraph(flow.nodes, flow.edges, [trigger]), {})
  const branch = { nodes: [{ id: "branch", type: "randomizer", position: { x: 0, y: 0 }, config: {} }], edges: [{ from: "branch", port: "then", to: "branch" }] }
  const branchFlow = graph.toFlow(branch)
  assert.deepEqual(graph.toGraph(branchFlow.nodes, branchFlow.edges), branch)
})

test("Telegram não mostra entregues/lidas; canais com recibo continuam mostrando", () => {
  assert.equal(graph.hasReceipts({}, [{ channel_type: "telegram" }]), false)
  assert.equal(graph.hasReceipts({ channel: "telegram" }, []), false)
  assert.equal(graph.hasReceipts({}, [{ channel_type: "whatsapp" }]), true)
})

test("com vários gatilhos na entrada, o painel avisa que o destino é compartilhado (como no ManyChat)", async () => {
  const { NodeLinks } = await import("./panel-shared.tsx")
  const node = { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: { config: {} } }
  const other = { ...trigger, id: "trg-2", name: "Segundo gatilho" }
  const props = triggers => ({ node, nodes: [node], edges: [], triggers, readOnly: false, setLink() {} })
  const several = renderToStaticMarkup(React.createElement(NodeLinks, { p: props([trigger, other]) }))
  assert.match(several, /todos os gatilhos desta entrada/)
  assert.match(several, /2 gatilhos/)
  const one = renderToStaticMarkup(React.createElement(NodeLinks, { p: props([trigger]) }))
  assert.doesNotMatch(one, /todos os gatilhos desta entrada/)
})

test("Instagram não informa entrega: o cartão não mostra entregues e lidas é sobre as enviadas, nunca acima de 100%", () => {
  assert.equal(graph.reportsDelivery({}, [{ channel_type: "instagram" }]), false)
  assert.equal(graph.reportsDelivery({}, [{ channel_type: "whatsapp" }]), true)
  assert.equal(graph.reportsDelivery({ channel: "telegram" }, []), false)
  // 5 leituras sobre 3 enviadas (o Instagram avisa a leitura de mensagem que o cartão não contou) fica em 100%, não 166,7%.
  assert.deepEqual(graph.receiptShares({ sent: 3, read: 5 }, false), { delivered: null, read: 1 })
  assert.deepEqual(graph.receiptShares({ sent: 4, delivered: 3, read: 1 }, true), { delivered: 0.75, read: 0.25 })
  assert.deepEqual(graph.receiptShares({ sent: 2, delivered: 3, read: 1 }, true), { delivered: 1, read: 0.5 })
  assert.deepEqual(graph.receiptShares({ sent: 0, read: 2 }, false), { delivered: null, read: null })
})

test("primeira resposta a comentário mantém restrição após ação e aceita 1 botão, de link ou de toque", () => {
  const comment = { ...trigger, type: "ig_comment" }
  const raw = { nodes: [
    { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, config: {} },
    { id: "tag", type: "action", position: { x: 200, y: 0 }, config: { actions: [{ type: "add_tag", tag_id: "lead" }] } },
    { id: "reply", type: "message", position: { x: 400, y: 0 }, config: { blocks: [{ kind: "text", text: "Seu guia" }, { kind: "button", id: "link", label: "Quero o guia", action: { type: "go_to_node" } }] } },
    { id: "follow", type: "message", position: { x: 600, y: 0 }, config: { blocks: [{ kind: "text", text: "Pronto" }] } },
  ], edges: [{ from: "trigger", port: "next", to: "tag" }, { from: "tag", port: "next", to: "reply" }, { from: "reply", port: "btn:link", to: "follow" }] }
  const flow = graph.toFlow(raw)
  assert.equal(graph.isFirstAfterComment("reply", flow.nodes, flow.edges, [comment]), true)
  assert.equal(graph.isFirstAfterComment("follow", flow.nodes, flow.edges, [comment]), false)
  // Botão de toque com saída só depois do toque: vale (a decisão do bug 4; a doc da Meta não proíbe, ver comment-flow.test.ts no motor).
  assert.equal(graph.validateGraph(flow.nodes, flow.edges, [comment]).reply, undefined)
  // Saída direta ou de tempo esgotado enviaria mensagem a quem ainda não respondeu.
  const direct = [...flow.edges, { id: "reply:next", source: "reply", sourceHandle: "next", target: "follow" }]
  assert.match(graph.validateGraph(flow.nodes, direct, [comment]).reply.join(" "), /só o botão de toque/)
  const timeout = [...flow.edges, { id: "reply:timeout", source: "reply", sourceHandle: "timeout", target: "follow" }]
  assert.match(graph.validateGraph(flow.nodes, timeout, [comment]).reply.join(" "), /só o botão de toque/)
  // Dois botões não; outro tipo de botão não.
  const reply = flow.nodes.find(n => n.id === "reply")
  reply.data.config.blocks.push({ kind: "button", id: "outro", label: "Outro", action: { type: "url", url: "https://example.com" } })
  assert.match(graph.validateGraph(flow.nodes, flow.edges, [comment]).reply.join(" "), /1 texto e 1 botão/)
  reply.data.config.blocks.pop()
  reply.data.config.blocks[1].action = { type: "start_automation", automation_id: "x" }
  assert.match(graph.validateGraph(flow.nodes, flow.edges, [comment]).reply.join(" "), /link ou de toque/)
  // Botão de link: continua sem nenhuma saída.
  reply.data.config.blocks[1].action = { type: "url", url: "https://example.com/guia" }
  assert.match(graph.validateGraph(flow.nodes, flow.edges, [comment]).reply.join(" "), /só o botão de toque/)
  flow.edges = flow.edges.filter(e => e.source !== "reply")
  assert.equal(graph.validateGraph(flow.nodes, flow.edges, [comment]).reply, undefined)
})

test("condição de segmento preserva referência e valida catálogo e operador", () => {
  const config = { match: "all", rules: [{ type: "segment", segment_id: "engajados", operator: "in" }] }
  const flow = graph.toFlow({ nodes: [{ id: "condition", type: "condition", position: { x: 0, y: 0 }, config }], edges: [] })
  const catalogs = { segments: [{ id: "engajados", name: "Engajados" }] }
  assert.deepEqual(graph.validateGraph(flow.nodes, [], [], catalogs), {})
  assert.deepEqual(graph.toGraph(flow.nodes, []).nodes[0].config, config)
  flow.nodes[0].data.config.rules[0].operator = "not_in"
  assert.deepEqual(graph.validateGraph(flow.nodes, [], [], catalogs), {})
  assert.ok(graph.validateGraph(flow.nodes, [], [], { segments: [] }).condition?.length)
  flow.nodes[0].data.config.rules[0].operator = "has"
  assert.deepEqual(graph.validateGraph(flow.nodes, [], [], catalogs), {})
  flow.nodes[0].data.config.rules[0].operator = "equals"
  assert.ok(graph.validateGraph(flow.nodes, [], [], catalogs).condition?.length)
})

test("variáveis com reserva preservam o contrato do motor e identificam o passo do campo apagado", () => {
  const input = structuredClone(demoGraph)
  const message = input.nodes.find(n => n.id === "offer")
  message.config.blocks[0].text = "Olá {{primeiro_nome|cliente}} {{campo:interesse|sem%20interesse}}"
  message.config.blocks[1].label = "{{sobrenome|cliente}}"
  const flow = graph.toFlow(input)
  assert.deepEqual(graphSchema.parse(graph.toGraph(flow.nodes, flow.edges)), input)
  const catalogs = { fields: [{ id: "interesse", name: "Interesse", scope: "contact", type: "text" }] }
  assert.deepEqual(graph.validateGraph(flow.nodes, flow.edges, [trigger], catalogs), {})
  assert.match(graph.validateGraph(flow.nodes, flow.edges, [trigger], { fields: [] }).offer[0], /Variável.*inexistente/)
  message.config.blocks[0].text = "Olá {{primeiro_nome|cliente"
  const malformed = graph.toFlow(input)
  assert.match(graph.validateGraph(malformed.nodes, malformed.edges, [trigger]).offer[0], /Variável incompleta/)
})

test('condições de e-mail aceitam segmentos e métricas com valores tipados', () => {
  const rules=[{type:'segment',segment_id:'saved-email-segment',operator:'has'},{type:'email',filter:'opened_not_clicked'},{type:'system_field',field:'email_opens',operator:'gte',value:2},{type:'system_field',field:'email_opted_in',operator:'equals',value:false}]
  const flow=graph.toFlow({nodes:[{id:'t',type:'trigger',position:{x:0,y:0},config:{}},{id:'c',type:'condition',position:{x:1,y:0},config:{match:'all',rules}}],edges:[{from:'t',port:'next',to:'c'}]})
  assert.deepEqual(graph.validateGraph(flow.nodes,flow.edges,[{ ...trigger, node_id: 't' }]),{})
  const bad=graph.toFlow({nodes:[{id:'t',type:'trigger',position:{x:0,y:0},config:{}},{id:'c',type:'condition',position:{x:1,y:0},config:{match:'all',rules:[{type:'system_field',field:'email_opens',operator:'gte',value:'muitas'}]}}],edges:[{from:'t',port:'next',to:'c'}]})
  assert.ok(graph.validateGraph(bad.nodes,bad.edges,[{ ...trigger, node_id: 't' }]).c.length)
})

test('condições de sistema (telefone, idioma, fuso, última mensagem, ID) validam por dado', () => {
  const montar = rules => graph.toFlow({nodes:[{id:'t',type:'trigger',position:{x:0,y:0},config:{}},{id:'c',type:'condition',position:{x:1,y:0},config:{match:'all',rules}}],edges:[{from:'t',port:'next',to:'c'}]})
  const erros = rules => { const f = montar(rules); return graph.validateGraph(f.nodes,f.edges,[]).c ?? [] }
  assert.deepEqual(erros([
    {type:'system_field',field:'phone',operator:'is_set'},{type:'system_field',field:'phone',operator:'starts_with',value:'5511'},
    {type:'system_field',field:'locale',operator:'equals',value:'pt_BR'},{type:'system_field',field:'timezone',operator:'not_equals',value:'America/Sao_Paulo'},
    {type:'system_field',field:'last_input_text',operator:'contains',value:'curso'},{type:'system_field',field:'last_input_text',operator:'not_contains',value:'curso'},
    {type:'system_field',field:'contact_id',operator:'equals',value:'abc'},
  ]), [])
  assert.ok(erros([{type:'system_field',field:'last_input_text',operator:'equals',value:'x'}]).length, 'última mensagem só contém/não contém')
  assert.ok(erros([{type:'system_field',field:'contact_id',operator:'starts_with',value:'x'}]).length, 'ID só é/não é')
  assert.ok(erros([{type:'system_field',field:'locale',operator:'equals'}]).length, 'comparação com valor exige o valor')
})

test("pergunta preserva captura e portas próprias; campo incompatível bloqueia publicação", () => {
  const config = { text: "Qual é seu e-mail?", answer_type: "email", field_id: "email", retry_message: "Confira seu e-mail.", max_attempts: 3, skip: true, timeout: { value: 5, unit: "minutes" }, choices: [] }
  const flow = graph.toFlow({ nodes: [{ id: "q", type: "question", position: { x: 0, y: 0 }, config }], edges: [] })
  assert.deepEqual(graph.outputPorts(flow.nodes[0]).map(p => p.port), ["success", "no_response"])
  assert.equal(graph.defaultConfig("question").answer_type, "text")
  assert.deepEqual(graph.toGraph(flow.nodes, flow.edges).nodes[0].config, config)
  assert.deepEqual(graph.validateGraph(flow.nodes, [], [], { fields: [{ id: "email", name: "E-mail", type: "text", scope: "contact" }] }), {})
  assert.ok(graph.validateGraph(flow.nodes, [], [], { fields: [{ id: "email", name: "E-mail", type: "number", scope: "contact" }] }).q.length)
})

test("pergunta de data e hora exige campo do tipo Data e hora", () => {
  const config = { ...graph.defaultConfig("question"), text: "Quando?", answer_type: "datetime", field_id: "quando" }
  const flow = graph.toFlow({ nodes: [{ id: "q", type: "question", position: { x: 0, y: 0 }, config }], edges: [] })
  assert.deepEqual(graphSchema.parse(graph.toGraph(flow.nodes, flow.edges)).nodes[0].config, config)
  assert.deepEqual(graph.validateGraph(flow.nodes, [], [], { fields: [{ id: "quando", name: "Quando", type: "datetime", scope: "contact" }] }), {})
  assert.ok(graph.validateGraph(flow.nodes, [], [], { fields: [{ id: "quando", name: "Quando", type: "date", scope: "contact" }] }).q.length)
})

test("pergunta usa a ficha efetiva da conexão do gatilho para múltipla escolha", () => {
  const config = { ...graph.defaultConfig("question"), text: "Qual oficina?", answer_type: "multiple_choice", field_id: "interesse", choices: ["Cerâmica", "Pintura"] }
  const flow = graph.toFlow({ nodes: [{ id: "q", type: "question", position: { x: 0, y: 0 }, config }], edges: [] })
  assert.deepEqual(graphSchema.parse(graph.toGraph(flow.nodes, flow.edges)).nodes[0].config, config)
  const connection = { id: trigger.channel_id, displayName: "Oficina", status: "connected", profile: { inbound: { message: true }, buttons: { types: [], maxPerMessage: 0, titleMax: 0 }, quickReplies: null } }
  const catalogs = { fields: [{ id: "interesse", name: "Interesse", scope: "contact", type: "text" }], connections: [connection] }
  assert.match(graph.validateGraph(flow.nodes, [], [trigger], catalogs).q.join(" "), /ficha da conexão Oficina/)
  connection.profile.quickReplies = { max: 3, titleMax: 20 }
  assert.deepEqual(graph.validateGraph(flow.nodes, [], [trigger], catalogs), {})
  connection.profile.quickReplies = null
  connection.profile.buttons = { types: ["postback"], maxPerMessage: 3, titleMax: 20 }
  assert.deepEqual(graph.validateGraph(flow.nodes, [], [trigger], catalogs), {})
  connection.profile.buttons.maxPerMessage = 1
  assert.ok(graph.validateGraph(flow.nodes, [], [trigger], catalogs).q.length)
})

test("pergunta aceita a alternativa que comporta os títulos e inclui Pular na validação", async () => {
  const { questionCapabilityError } = await import("../../../../engine/src/schemas/question.ts")
  const config = { answer_type: "multiple_choice", choices: ["Oficina de cerâmica para iniciantes", "Oficina de pintura para iniciantes"], skip: false }
  const profile = { inbound: { message: true }, buttons: { types: ["postback"], maxPerMessage: 3, titleMax: 20 }, quickReplies: { max: 2, titleMax: 80 } }
  assert.equal(questionCapabilityError(config, profile), undefined)
  assert.ok(questionCapabilityError({ ...config, choices: ["A", "B"], skip: true }, { ...profile, buttons: undefined, quickReplies: { max: 3, titleMax: 2 } }))
})


test("pergunta não antecede a resposta privada de comentário", () => {
  const flow = graph.toFlow({ nodes: [
    { id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'q', type: 'question', position: { x: 100, y: 0 }, config: {
      text: 'Qual seu nome?', answer_type: 'text', field_id: 'field-a', retry_message: 'Responda seu nome.',
      max_attempts: 1, skip: false, timeout: { value: 1, unit: 'minutes' }, choices: [],
    } },
    { id: 'm', type: 'message', position: { x: 200, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Seu guia está aqui.' }] } },
  ], edges: [{ from: 't', port: 'next', to: 'q' }, { from: 'q', port: 'success', to: 'm' }] })
  const errors = graph.validateGraph(flow.nodes, flow.edges, [{ ...trigger, type: 'ig_comment', node_id: 't' }])
  assert.match((errors.q ?? []).join(' '), /pergunta.*resposta privada/i)
})

test('card e galeria fazem ida e volta pelo contrato e validam a ficha efetiva', () => {
  const blocks = [{ kind: 'card', aspectRatio: 'square', cards: [{ title: 'Oficina', imageUrl: 'https://media.test/a.png', actionUrl: 'https://example.test/oficina', buttons: [{ type: 'url', title: 'Conhecer', url: 'https://example.test/oficina' }] }] }, { kind: 'gallery', aspectRatio: 'horizontal', cards: [{ title: 'Primeiro' }, { title: 'Segundo' }] }]
  const original = { nodes: [{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} }, { id: 'm', type: 'message', position: { x: 300, y: 0 }, config: { blocks } }], edges: [{ from: 't', port: 'next', to: 'm' }] }
  const flow = graph.toFlow(original)
  assert.deepEqual(graphSchema.parse(graph.toGraph(flow.nodes, flow.edges)), original)
  const connection = { id: 'vitrine', displayName: 'Catálogo principal', status: 'connected', profile: { cards: { maxCards: 10, maxButtons: 3, titleMax: 80, subtitleMax: 80 }, buttons: { types: ['url'], titleMax: 20, payloadMaxBytes: 1000, maxPerMessage: 3 } } }
  const triggers = [{ channel_id: 'vitrine' }]
  assert.deepEqual(graph.validateGraph(flow.nodes, flow.edges, triggers, { connections: [connection] }), {})
  connection.profile.cards = null
  assert.match(graph.validateGraph(flow.nodes, flow.edges, triggers, { connections: [connection] }).m.join(' '), /Catálogo principal/)
  const compatible = { ...connection, id: 'outra', displayName: 'Vitrine compatível', profile: { ...connection.profile, cards: { maxCards: 10, maxButtons: 3, titleMax: 80, subtitleMax: 80 } } }
  const issues = graph.validateGraph(flow.nodes, flow.edges, [{ channel_id: 'vitrine' }, { channel_id: 'outra' }], { connections: [connection, compatible] }).m.join(' ')
  assert.match(issues, /Catálogo principal/)
  assert.doesNotMatch(issues, /Vitrine compatível/)
})

test('galeria do WhatsApp oficial é validada como carrossel: o texto antes dela é a abertura e os limites aparecem no editor', () => {
  const card = (n, extra = {}) => ({ title: `Planta ${n}`, imageUrl: `https://media.test/${n}.png`, buttons: [{ type: 'url', title: 'Comprar', url: 'https://loja.test/p' }], ...extra })
  const run = (blocks, connection) => {
    const flow = graph.toFlow({ nodes: [{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} }, { id: 'm', type: 'message', position: { x: 300, y: 0 }, config: { blocks } }], edges: [{ from: 't', port: 'next', to: 'm' }] })
    return (graph.validateGraph(flow.nodes, flow.edges, [{ channel_id: 'zap' }], { connections: [connection] }).m ?? []).join(' ')
  }
  const whatsapp = { id: 'zap', displayName: 'WhatsApp da loja', status: 'connected', profile: { cards: { maxCards: 10, maxButtons: 3, titleMax: 1024, subtitleMax: 1024, adaptation: 'interactive_carousel' }, buttons: { types: ['postback', 'url'], titleMax: 20, payloadMaxBytes: 256, maxPerMessage: 3 } } }
  const gallery = { kind: 'gallery', aspectRatio: 'horizontal', cards: [card(1), card(2)] }
  assert.equal(run([{ kind: 'text', text: 'Veja:' }, gallery], whatsapp), '')
  assert.match(run([gallery], whatsapp), /WhatsApp da loja: .*texto de abertura/)
  assert.match(run([{ kind: 'text', text: 'Veja:' }, { ...gallery, cards: [card(1), card(2, { imageUrl: '' })] }], whatsapp), /precisa de imagem/)
  assert.match(run([{ kind: 'text', text: 'Veja:' }, { ...gallery, cards: [card(1), card(2, { subtitle: 'a'.repeat(160) })] }], whatsapp), /160 caracteres/)
  assert.equal(run([{ kind: 'card', aspectRatio: 'square', cards: [card(1)] }], whatsapp), '')   // um card só não é carrossel e não pede texto
})

test('resposta rápida e digitação fazem ida e volta, expõem portas próprias e validam a ficha efetiva', () => {
  const blocks = [{ kind: 'text', text: 'Qual caminho?' }, { kind: 'typing', seconds: 2 }, { kind: 'quick_reply', id: 'q1', label: 'Preços' }, { kind: 'quick_reply', id: 'q2', label: 'Pular', skip: true }]
  const original = { nodes: [{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} }, { id: 'm', type: 'message', position: { x: 300, y: 0 }, config: { blocks, reply_attempts: 2, click_timeout: { value: 1, unit: 'hours' } } },
    { id: 'p', type: 'message', position: { x: 600, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Tabela' }] } }], edges: [{ from: 't', port: 'next', to: 'm' }, { from: 'm', port: 'btn:q1', to: 'p' }] }
  const flow = graph.toFlow(original)
  assert.deepEqual(graphSchema.parse(graph.toGraph(flow.nodes, flow.edges)), original)
  const ports = graph.outputPorts(flow.nodes.find(n => n.id === 'm'))
  assert.deepEqual(ports.map(p => p.port), ['btn:q1', 'btn:q2', 'next'])
  assert.match(ports.at(-1).label, /Se não tocar/)
  const connection = (quickReplies, buttons = { types: ['postback'], titleMax: 60, payloadMaxBytes: 64, maxPerMessage: 10 }) => ({ id: 'canal', displayName: 'Canal de teste', status: 'connected', profile: { quickReplies, buttons } })
  const triggers = [{ channel_id: 'canal' }]
  assert.deepEqual(graph.validateGraph(flow.nodes, flow.edges, triggers, { connections: [connection({ max: 13, titleMax: 20 })] }), {})
  // Sem a resposta nativa a ficha ainda oferece botões de toque; sem nenhum dos dois a publicação é bloqueada.
  assert.deepEqual(graph.validateGraph(flow.nodes, flow.edges, triggers, { connections: [connection(null)] }), {})
  assert.match(graph.validateGraph(flow.nodes, flow.edges, triggers, { connections: [connection(null, { types: [], titleMax: 0, payloadMaxBytes: 0, maxPerMessage: 0 })] }).m.join(' '), /não oferece resposta rápida/)
  assert.match(graph.validateGraph(flow.nodes, flow.edges, triggers, { connections: [connection({ max: 1, titleMax: 20 })] }).m.join(' '), /até 1 respostas/)
  const withButton = graph.toFlow({ ...original, nodes: original.nodes.map(n => n.id === 'm' ? { ...n, config: { blocks: [...blocks, { kind: 'button', id: 'b1', label: 'Botão', action: { type: 'url', url: 'https://example.test' } }] } } : n) })
  assert.match(graph.validateGraph(withButton.nodes, withButton.edges, triggers, { connections: [connection({ max: 13, titleMax: 20 })] }).m.join(' '), /não coexistem/)
  // Resposta comum precisa levar a algum passo; Pular segue pelo próximo passo.
  const loose = graph.toFlow({ ...original, edges: [{ from: 't', port: 'next', to: 'm' }] })
  const issues = graph.validateGraph(loose.nodes, loose.edges, triggers, { connections: [connection({ max: 13, titleMax: 20 })] }).m.join(' ')
  assert.match(issues, /“Preços” não leva a nenhum passo/)
  assert.doesNotMatch(issues, /Pular/)
})

test("botão de link tem saída opcional e o grafo com ela passa no esquema", () => {
  const original = { nodes: [{ id: 'm', type: 'message', position: { x: 0, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Veja' }, { kind: 'button', id: 'u1', label: 'Loja', action: { type: 'url', url: 'https://exemplo.test' } }] } },
    { id: 'p', type: 'message', position: { x: 300, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Depois' }] } }], edges: [{ from: 'm', port: 'btn:u1', to: 'p' }] }
  const flow = graph.toFlow(original)
  assert.deepEqual(graph.outputPorts(flow.nodes[0]).map(p => p.port), ['btn:u1', 'next'])
  assert.deepEqual(graphSchema.parse(graph.toGraph(flow.nodes, flow.edges)), original)
})

test('editor limita botões pela ficha da conexão (3; Telegram 10) e bloqueia a publicação acima do limite', () => {
  const button = i => ({ kind: 'button', id: `b${i}`, label: `Botão ${i}`, action: { type: 'url', url: 'https://example.test' } })
  const build = n => graph.toFlow({ nodes: [{ id: 'm', type: 'message', position: { x: 0, y: 0 }, config: { blocks: [{ kind: 'text', text: 'Escolha' }, ...Array.from({ length: n }, (_, i) => button(i))] } }], edges: [] })
  const connection = max => ({ id: 'canal', displayName: 'Canal de teste', status: 'connected', profile: { quickReplies: null, buttons: { types: ['postback', 'url'], titleMax: 20, payloadMaxBytes: 64, maxPerMessage: max } } })
  const triggers = [{ channel_id: 'canal' }]
  const issues = (n, max) => (graph.validateGraph(build(n).nodes, [], triggers, { connections: [connection(max)] }).m ?? []).join(' ')
  assert.doesNotMatch(issues(3, 3), /botões/)
  assert.match(issues(4, 3), /até 3 botões/)
  assert.doesNotMatch(issues(10, 10), /botões/)
  assert.match(issues(11, 10), /até 10 botões/)
  assert.equal(graph.buttonLimitFor([connection(10)]), 10)
  assert.equal(graph.buttonLimitFor([connection(10), connection(3)]), 3)
  assert.equal(graph.buttonLimitFor([]), 3)
})

test("pergunta: a mensagem de nova tentativa acompanha o tipo datetime e volta ao padrão ao sair dele, sem tocar em texto do usuário", () => {
  const standard = graph.defaultConfig("question").retry_message
  const date = graph.questionRetryMessage("datetime", standard)
  assert.match(date, /24\/10\/2026 14:30/)
  assert.equal(graph.questionRetryMessage("email", date), standard)
  assert.equal(graph.questionRetryMessage("text", date), standard)
  assert.equal(graph.questionRetryMessage("datetime", "Confira a data."), "Confira a data.")
  assert.equal(graph.questionRetryMessage("email", "Confira a data."), "Confira a data.")
  assert.equal(graph.questionRetryMessage("email", standard), standard)
})

test("nome do passo fica no idioma em que foi criado", () => {
  assert.equal(graph.creationTitle("message", "en-US"), "Message")
  assert.equal(graph.creationTitle("condition", "es"), "Condición")
  assert.equal(graph.creationTitle("message", "pt-BR"), "Mensagem")
  assert.equal(graph.creationTitle("message", "fr"), "Mensagem")
})

test("passo com canal escolhido valida pela ficha do canal, não pela do gatilho", async () => {
  const { capabilities } = await import("../../../../engine/src/channels/capabilities.ts")
  const connected = (id, kind) => ({ id, kind, status: "connected", profile: capabilities(kind) })
  const connections = [connected("c-tg", "telegram"), connected("c-ig", "instagram")]
  const withText = (channel, text) => {
    const flow = graph.toFlow(structuredClone(demoGraph))
    const message = flow.nodes.find(n => n.id === "offer")
    message.data.config = { ...message.data.config, channel, blocks: [{ kind: "text", text }] }
    flow.edges = flow.edges.filter(e => e.source !== "offer")
    return graph.validateGraph(flow.nodes, flow.edges, [trigger], { connections }).offer ?? []
  }
  // 1500 caracteres cabem no Telegram (4096) e passam do limite do Instagram (1000 bytes).
  assert.deepEqual(withText("telegram", "a".repeat(1500)), [])
  assert.match(withText("instagram", "a".repeat(1500)).join(" "), /acima de 1\.000 bytes/)
  assert.match(withText("whatsapp", "Oi").join(" "), /Não há conexão de WhatsApp ligada/)
})

test('abrir grafo com posições apertadas separa os cartões sem mexer em quem já tem espaço', () => {
  const tight = { nodes: [
    { id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'm', type: 'message', position: { x: 250, y: 0 }, config: {} },
    { id: 'n', type: 'message', position: { x: 300, y: 40 }, config: {} },
    { id: 'far', type: 'message', position: { x: 1200, y: 0 }, config: {} },
    { id: 'low', type: 'message', position: { x: 0, y: 400 }, config: {} },
  ], edges: [] }
  const { nodes } = graph.toFlow(tight)
  const boxes = nodes.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y }))
  for (const a of boxes) for (const b of boxes) {
    if (a.id >= b.id) continue
    const overlap = Math.abs(a.x - b.x) < graph.NODE_WIDTH && Math.abs(a.y - b.y) < 140
    assert.equal(overlap, false, `${a.id} e ${b.id} se cobrem`)
  }
  assert.deepEqual(nodes.find((n) => n.id === 'far').position, { x: 1200, y: 0 })
  assert.deepEqual(nodes.find((n) => n.id === 'low').position, { x: 0, y: 400 })
  assert.equal(tight.nodes[1].position.x, 250, 'o grafo de entrada não é alterado')
})

test("primeiro passo pela lista do celular: nasce à direita do gatilho, ligado ao Então, com o canal escolhido", () => {
  const base = { nodes: [{ id: "trigger", type: "trigger", position: { x: 10, y: 80 }, config: {} }], edges: [] }
  const { graph: g, id } = graph.withFirstStep(base, "message", "telegram", "pt-BR")
  assert.equal(id, "m1")
  assert.deepEqual(g.edges, [{ from: "trigger", port: graph.PORT_THEN, to: "m1" }])
  const step = g.nodes.find(n => n.id === "m1")
  assert.deepEqual(step.position, { x: 390, y: 80 })
  assert.equal(step.config.channel, "telegram")
  assert.deepEqual(step.config.blocks, [{ kind: "text", text: "" }])
  assert.equal(graph.withFirstStep(base, "smart_delay", undefined, "pt").graph.nodes[1].config.channel, undefined)
  assert.equal(base.nodes.length, 1, "não muda o grafo recebido")
})

test("cartão do primeiro passo: título, grupos com rótulo e um botão de verdade por item, com nome acessível", async () => {
  const { FirstStepNode } = await import("./connect-drop-menu.tsx")
  const { stepCatalog } = await import("./connect-drop.ts")
  const groups = stepCatalog({ triggers: [], connections: [{ id: "ig", kind: "instagram", status: "connected" }, { id: "em", kind: "email", status: "connected" }] }, "first-step")
  const html = renderToStaticMarkup(React.createElement(ReactFlowProvider, {}, React.createElement(FirstStepNode, { id: "first-step-card", data: { config: {}, groups, onPick: () => {} } })))
  assert.match(html, /Escolha o primeiro passo <span aria-hidden="true">👇<\/span>/)
  assert.deepEqual([...html.matchAll(/role="group" aria-labelledby="[^"]+"><p id="[^"]+" class="[^"]*">([^<]+)<\/p>/g)].map(m => m[1]), ["Conteúdo", "Lógica"])
  assert.deepEqual([...html.matchAll(/<button type="button"[^>]*>.*?<\/span>([^<]+)<\/button>/g)].map(m => m[1]), ["Instagram", "E-mail", "Ações", "Condição", "Dividir caminhos", "Esperar"])
  assert.match(html, /border-dashed/)
})
