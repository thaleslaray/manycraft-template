import assert from "node:assert/strict"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { registerHooks } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { test } from "node:test"
import { transformSync } from "esbuild"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { graphSchema } from "../../../../engine/src/schemas/graph.ts"

const src = new URL("../../", import.meta.url)
const engineSrc = new URL("../../../../engine/src/", import.meta.url)
const moduleSource = source => `data:text/javascript,${encodeURIComponent(source)}`
registerHooks({
  resolve(specifier, context, nextResolve) {
    // Somente a infraestrutura Cloudflare é substituída. Os validadores e
    // executores de nós abaixo são os arquivos reais do motor.
    if (specifier === "cloudflare:workflows") return nextResolve(moduleSource("export class NonRetryableError extends Error {}"), context)
    if (context.parentURL === new URL("flow/nodes.ts", engineSrc).href) {
      if (specifier === "../inbox/service") return nextResolve(moduleSource("export async function notifyTimeline() {}"), context)
      if (specifier === "./dispatch") return nextResolve(moduleSource("export async function ensureWorkflow(env, id) { env.started.push(id) }"), context)
    }
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
    if (/\.(ts|tsx)$/.test(url) && (url.startsWith(src.href) || url.startsWith(engineSrc.href))) {
      return { format: "module", shortCircuit: true, source: transformSync(readFileSync(new URL(url), "utf8"), {
        loader: url.endsWith(".tsx") ? "tsx" : "ts", format: "esm", jsx: "automatic",
      }).code }
    }
    return nextLoad(url, context)
  },
})

const graph = await import("./graph.ts")
const executor = await import("../../../../engine/src/flow/nodes.ts")
const { ConditionPanel, RandomizerPanel, StartAutomationPanel, FieldValue, CatalogNotice } = await import("./logic-panels.tsx")
const { ActionPanel, DelayPanel } = await import("./node-panels.tsx")
const { FieldOperationControls } = await import("./field-operation.tsx")
const run = { id: "run", workspace_id: "workspace", automation_id: "current", contact_id: "contact", channel_id: "channel", depth: 0 }
const fields = ["text", "number", "boolean", "date", "datetime", "array"].map(type => ({ id: type, name: `Campo ${type}`, type, scope: "contact" }))
const tags = [{ id: "lead", name: "Interessado" }]

test("seletor de regra agrupa como o construtor: recomendados, filtros gerais, sistema por canal, usuário e bot", async () => {
  const { ruleGroups, ruleOptionId, newRule } = await import("./condition-catalog.ts")
  const { systemConditionFields } = await import("../../../../engine/src/schemas/system-fields.ts")
  const { flowConditionSchema } = await import("../../../../engine/src/schemas/temporal.ts")
  const groups = ruleGroups()
  assert.deepEqual(groups.slice(0, 2).map(g => g.label), ["Recomendados", "Filtros gerais"])
  assert.equal(groups.at(-2).label, "Campos do usuário")
  assert.equal(groups.at(-1).label, "Campos do bot")
  assert.ok(groups.some(g => g.label === "Campos do sistema · Instagram"), "campos do Instagram ficam no grupo do canal")
  assert.deepEqual(groups[0].options.map(o => o.id), ["tag", "email", "system:channel_follows_business"])
  const ids = groups.flatMap(g => g.options.map(o => o.id))
  assert.equal(new Set(ids).size, ids.length, "cada opção aparece uma vez")
  // Contrato com o motor: toda opção cria uma regra que o esquema da Condição aceita.
  for (const id of ids.filter(id => id.startsWith("system:"))) assert.ok(systemConditionFields.includes(id.slice(7)), `${id} existe no motor`)
  for (const id of ids) {
    const rule = newRule(id)
    assert.equal(ruleOptionId(rule), id)
    if (["tag", "any_tag", "segment", "sequence", "field", "date", "bot_field"].includes(rule.type)) continue   // ainda sem a referência escolhida
    assert.equal(flowConditionSchema.safeParse({ match: "all", rules: [rule] }).success, true, `${id}: ${JSON.stringify(rule)}`)
  }
})

test("painel Condição: dado do Instagram, nome e janela viram regra de sistema que passa no esquema e na validação", () => {
  const driver = panelDriver(ConditionPanel, "condition", { match: "all", rules: [{ type: "tag", tag_id: "lead", operator: "has" }] }, ["true", "false"])
  driver.choose("rule-type-0", "system:channel_follows_business")
  assert.deepEqual(driver.props.node.data.config.rules, [{ type: "system_field", field: "channel_follows_business", operator: "equals", value: true }])
  driver.input("rule-value-0", "false")
  driver.choose("rule-operator-0", "not_equals")
  assert.deepEqual(driver.saved().nodes[0].config.rules, [{ type: "system_field", field: "channel_follows_business", operator: "not_equals", value: false }])
  driver.choose("rule-type-0", "system:channel_follower_count")
  driver.choose("rule-operator-0", "gt")
  driver.input("rule-value-0", "1000")
  assert.deepEqual(driver.saved().nodes[0].config.rules, [{ type: "system_field", field: "channel_follower_count", operator: "gt", value: 1000 }])
  driver.choose("rule-type-0", "system:status")
  assert.deepEqual(driver.props.node.data.config.rules, [{ type: "system_field", field: "status", operator: "equals", value: "subscribed" }])
  driver.choose("rule-value-0", "unsubscribed")
  assert.equal(driver.props.node.data.config.rules[0].value, "unsubscribed")
  driver.choose("rule-type-0", "system:last_interaction_at")
  assert.deepEqual(driver.props.node.data.config.rules, [{ type: "system_field", field: "last_interaction_at", operator: "within_days", value: 7 }])
  driver.choose("rule-type-0", "system:window_open")
  assert.deepEqual(driver.props.node.data.config.rules, [{ type: "system_field", field: "window_open", operator: "equals", value: true }])
  const reopened = graph.toFlow(driver.saved())
  assert.deepEqual(graph.validateGraph(reopened.nodes, reopened.edges, [], { fields, automations }), {})
  assert.match(driver.render().html, /Janela de 24 h aberta/)
})

test("validação de publicação confere operador e valor dos dados novos da Condição", () => {
  const erros = rules => { const f = roundTrip("condition", { match: "all", rules }, ["true", "false"]); return graph.validateGraph(f.nodes, f.edges, [], { fields, automations }).logic ?? [] }
  assert.deepEqual(erros([
    { type: "system_field", field: "channel_follows_business", operator: "equals", value: true },
    { type: "system_field", field: "channel_follower_count", operator: "lt", value: 500 },
    { type: "system_field", field: "channel_username", operator: "contains", value: "loja" },
    { type: "system_field", field: "first_name", operator: "equals", value: "Ana" },
    { type: "system_field", field: "gender", operator: "equals", value: "female" },
    { type: "system_field", field: "last_interaction_at", operator: "within_days", value: 3 },
    { type: "system_field", field: "opt_in_whatsapp", operator: "equals", value: false },
  ]), [])
  for (const bad of [
    { type: "system_field", field: "channel_follows_business", operator: "gt", value: 1 },
    { type: "system_field", field: "channel_follows_business", operator: "equals", value: "sim" },
    { type: "system_field", field: "channel_follower_count", operator: "contains", value: 1 },
    { type: "system_field", field: "channel_follower_count", operator: "gt", value: "muitos" },
    { type: "system_field", field: "status", operator: "equals", value: "talvez" },
    { type: "system_field", field: "gender", operator: "not_equals", value: "female" },
  ]) assert.ok(erros([bad]).length, JSON.stringify(bad))
})

test("campo do bot na Condição: escolhe o campo, compara pelo tipo e a validação confere o catálogo", () => {
  const botFields = [{ id: "vagas", name: "Vagas", type: "number", scope: "bot" }, { id: "cupom", name: "Cupom", type: "text", scope: "bot" }]
  const driver = panelDriver(ConditionPanel, "condition", { match: "all", rules: [{ type: "tag", tag_id: "lead", operator: "has" }] }, ["true", "false"])
  driver.props.botFields = botFields
  driver.choose("rule-type-0", "bot_field")
  driver.choose("rule-bot-0", "vagas")
  driver.choose("rule-operator-0", "gt")
  driver.input("rule-value-0", "5")
  assert.deepEqual(driver.saved().nodes[0].config.rules, [{ type: "bot_field", field_id: "vagas", operator: "gt", value: 5 }])
  const flow = graph.toFlow(driver.saved())
  assert.deepEqual(graph.validateGraph(flow.nodes, flow.edges, [], { fields, automations, botFields }), {})
  assert.ok(graph.validateGraph(flow.nodes, flow.edges, [], { fields, automations, botFields: [botFields[1]] }).logic?.length, "campo do bot que sumiu bloqueia")
  driver.choose("rule-bot-0", "cupom")
  assert.deepEqual(driver.props.node.data.config.rules, [{ type: "bot_field", field_id: "cupom", operator: "equals", value: "" }])
  const wrong = roundTrip("condition", { match: "all", rules: [{ type: "bot_field", field_id: "cupom", operator: "gt", value: 1 }] }, ["true", "false"])
  assert.ok(graph.validateGraph(wrong.nodes, wrong.edges, [], { botFields }).logic?.length, "texto não aceita maior que")
})

test("espera até campo de data valida sem duração e mantém deslocamento após reabrir", () => {
  const config = { mode: "date", date: { kind: "field", field_id: "date" }, offset: { value: 2, unit: "days", direction: "before" } }
  const flow = roundTrip("smart_delay", config)
  assert.deepEqual(flow.config, config)
  assert.deepEqual(graph.validateGraph(flow.nodes, flow.edges, [], { fields }), {})
})
const automations = [{ id: "other", name: "Destino publicado", status: "live", published_version_id: "v2" }]

// Banco real: SQLite em memória com o schema das migrações do motor, atrás de
// uma casca compatível com D1 (prepare/bind/first/all/run/batch). Consultas
// novas do motor passam a funcionar sozinhas. Não representa D1 em produção,
// Workflows nem um envio de canal.
const migrations = new URL("../../../../engine/migrations/", import.meta.url)
const schemaSql = readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()
  .map(name => readFileSync(new URL(name, migrations), "utf8")).join("\n")

function seededDatabase({ values, tagged }) {
  const db = new DatabaseSync(":memory:")
  db.exec(schemaSql)
  db.exec(`INSERT INTO workspaces (id,name) VALUES ('workspace','Oficina');
    INSERT INTO contacts (id,workspace_id) VALUES ('contact','workspace');
    INSERT INTO channels (id,workspace_id,type,external_id) VALUES ('channel','workspace','instagram','ext');
    INSERT INTO automations (id,workspace_id,name,status) VALUES ('current','workspace','Atual','draft'),('other','workspace','Destino publicado','live');
    INSERT INTO automation_versions (workspace_id,id,automation_id,version,graph) VALUES ('workspace','v2','other',1,'{"nodes":[],"edges":[]}');
    UPDATE automations SET published_version_id='v2' WHERE id='other';
    INSERT INTO flow_runs (id,workspace_id,contact_id,automation_version_id) VALUES ('run','workspace','contact','v2');
    INSERT INTO tags (id,workspace_id,name) VALUES ('lead','workspace','Interessado');
    INSERT INTO flow_random_assignments (workspace_id,automation_id,contact_id,node_id,variation_id) VALUES ('workspace','current','contact','logic','stable-branch');`)
  if (tagged) db.exec("INSERT INTO contact_tags (workspace_id,contact_id,tag_id) VALUES ('workspace','contact','lead')")
  for (const field of fields) db.prepare("INSERT INTO custom_fields (id,workspace_id,scope,name,type) VALUES (?,?,?,?,?)").run(field.id, "workspace", "contact", field.name, field.type)
  for (const [fieldId, value] of Object.entries(values)) {
    db.prepare("INSERT INTO contact_field_values (workspace_id,contact_id,field_id,value) VALUES ('workspace','contact',?,?)").run(fieldId, JSON.stringify(value))
  }
  return db
}

function environment({ values = {}, tagged = true } = {}) {
  const writes = [], started = []
  const db = seededDatabase({ values, tagged })
  const isRead = sql => /^\s*SELECT\b/i.test(sql)
  const env = { writes, started, db,
    DB: {
      prepare(sql) {
        return { sql, args: [], bind(...args) { this.args = args; return this },
          async first() { return db.prepare(sql).get(...this.args) ?? null },
          async all() { return { results: db.prepare(sql).all(...this.args), success: true } },
          async run() {
            if (!isRead(sql)) writes.push({ sql, args: this.args })
            const { changes } = db.prepare(sql).run(...this.args)
            return { success: true, meta: { changes } }
          },
        }
      },
      async batch(statements) {
        db.exec("BEGIN")
        try {
          const results = []
          for (const statement of statements) results.push(await statement.run())
          db.exec("COMMIT")
          return results
        } catch (error) { db.exec("ROLLBACK"); throw error }
      },
    },
  }
  return env
}

function roundTrip(type, config, ports = ["next"]) {
  const original = { nodes: [
    { id: "logic", type, position: { x: 0, y: 0 }, config: structuredClone(config) },
    { id: "done", type: "smart_delay", position: { x: 320, y: 0 }, config: { duration: { value: 1, unit: "seconds" } } },
  ], edges: ports.map(port => ({ from: "logic", port, to: "done" })) }
  const flow = graph.toFlow(original)
  const saved = graphSchema.parse(graph.toGraph(flow.nodes, flow.edges))
  assert.deepEqual(saved, original)
  const reopened = graph.toFlow(saved)
  assert.deepEqual(graph.toGraph(reopened.nodes, reopened.edges), original)
  return { ...reopened, config: reopened.nodes[0].data.config }
}

test("condição conserva regras e portas true/false e o executor interpreta todas as comparações", async () => {
  const cases = [
    [{ type: "tag", tag_id: "lead", operator: "has" }, {}, true],
    [{ type: "tag", tag_id: "lead", operator: "not_has" }, {}, false],
    [{ type: "field", field_id: "text", operator: "equals", value: "cliente" }, { text: "cliente" }, true],
    [{ type: "field", field_id: "text", operator: "not_equals", value: "outro" }, { text: "cliente" }, true],
    [{ type: "field", field_id: "text", operator: "contains", value: "lien" }, { text: "cliente" }, true],
    [{ type: "field", field_id: "text", operator: "is_set" }, { text: "" }, true],
    [{ type: "field", field_id: "text", operator: "is_not_set" }, {}, true],
    ...["gt", "gte", "lt", "lte"].map(operator => [{ type: "field", field_id: "number", operator, value: 10 }, { number: ["gt", "gte"].includes(operator) ? 11 : 9 }, true]),
  ]
  for (const [rule, values, outcome] of cases) {
    const reopened = roundTrip("condition", { match: "all", rules: [rule] }, ["true", "false"])
    assert.equal(await executor.condition(environment({ values }), run, reopened.config), String(outcome))
  }
  const rules = [{ type: "tag", tag_id: "lead", operator: "has" }, { type: "field", field_id: "number", operator: "gte", value: 20 }]
  for (const [match, expected] of [["all", "false"], ["any", "true"]]) {
    const { config } = roundTrip("condition", { match, rules }, ["true", "false"])
    assert.equal(await executor.condition(environment({ values: { number: 10 } }), run, config), expected)
  }
})

test("aleatorizador conserva pesos relativos, IDs de portas e atribuição fixa do motor", async () => {
  const variations = [{ id: "path-a", weight: 1 }, { id: "path-b", weight: 3 }]
  const { config, edges } = roundTrip("randomizer", { variations, random_every_time: true }, variations.map(v => v.id))
  assert.deepEqual(edges.map(edge => edge.sourceHandle), ["path-a", "path-b"])
  const selected = await executor.randomize(environment(), run, "logic", config)
  assert.ok(variations.some(v => v.id === selected))
  const fixed = roundTrip("randomizer", { variations: [{ id: "stable-branch", weight: 25 }, { id: "other-branch", weight: 75 }], random_every_time: false }, ["stable-branch", "other-branch"])
  const env = environment()
  assert.equal(await executor.randomize(env, run, "logic", fixed.config), "stable-branch")
  assert.match(env.writes[0].sql, /INSERT INTO flow_random_assignments/)
  for (const invalid of [[], [variations[0]], [{ id: "a", weight: 0 }, { id: "b", weight: 1 }], [{ id: "a", weight: 1 }, { id: "a", weight: 2 }]]) {
    await assert.rejects(() => executor.randomize(environment(), run, "logic", { variations: invalid }))
  }
})

test("ações de campo reabrem com valores JSON tipados e passam no schema executado pelo motor", async () => {
  const samples = { text: "São Paulo", number: 12.5, boolean: false, date: "2026-10-23", datetime: "2026-10-23T15:30:00-03:00", array: ["produto", 2, false] }
  for (const [field_id, value] of Object.entries(samples)) {
    const { config } = roundTrip("action", { actions: [
      { type: "set_custom_field_value", field_id, value },
      { type: "unset_custom_field_value", field_id },
    ] })
    const env = environment()
    await executor.actions(env, run, config)
    const insert = env.writes.find(write => /INSERT INTO contact_field_values/.test(write.sql))
    assert.deepEqual(JSON.parse(insert.args[3]), value)
    assert.equal(typeof JSON.parse(insert.args[3]), typeof value)
    assert.ok(env.writes.some(write => /DELETE FROM contact_field_values/.test(write.sql)))
  }
  await assert.rejects(() => executor.actions(environment(), run, { actions: [{ type: "set_custom_field_value", field_id: "number", value: "12" }] }))
})

test("iniciar automação reabre automation_id e o motor seleciona a versão publicada no mesmo workspace", async () => {
  const { config, edges } = roundTrip("start_automation", { automation_id: "other" })
  assert.equal(edges[0].sourceHandle, "next")
  const env = environment()
  const id = await executor.startAutomation(env, run, 0, config)
  assert.match(id, /^flow-/)
  assert.deepEqual(env.started, [id])
  const inserted = env.writes.find(write => /INSERT INTO flow_runs/.test(write.sql))
  // Sem espera a filha nasce sem pai (com espera guarda quem chamou: coberto em engine/test/flow-iniciar-automacao.test.ts).
  // O último valor é a execução raiz (teto de filhas por raiz).
  assert.deepEqual(inserted.args.slice(1), ["workspace", "contact", "v2", "channel", 1, null, "run"])
  await assert.rejects(() => executor.startAutomation(environment(), run, 0, { automation_id: "" }))
  await assert.rejects(() => executor.startAutomation(environment(), run, 0, { automation_id: "draft" }), /not published/)
})

test("validação de publicação aceita os contratos válidos e bloqueia campos, regras, pesos e destinos inválidos", () => {
  const catalogs = { fields, automations, automationId: "current" }
  const valid = [
    ["condition", { match: "any", rules: [{ type: "field", field_id: "number", operator: "gte", value: 10 }] }, ["true", "false"]],
    ["condition", { match: "all", rules: [{ type: "origin", origin: "ads", operator: "is_not" }] }, ["true", "false"]],
    ["randomizer", { variations: [{ id: "a", weight: 1 }, { id: "b", weight: 3 }], random_every_time: false }, ["a", "b"]],
    ["start_automation", { automation_id: "other" }],
    ...fields.map(field => ["action", { actions: [{ type: "unset_custom_field_value", field_id: field.id }] }]),
    ["action", { actions: [{ type: "set_custom_field_value", field_id: "boolean", value: false }] }],
    ["action", { actions: [{ type: "set_custom_field_value", field_id: "number", value: 0 }] }],
  ]
  for (const [type, config, ports] of valid) {
    const flow = roundTrip(type, config, ports)
    assert.deepEqual(graph.validateGraph(flow.nodes, flow.edges, [], catalogs), {}, `${type}: ${JSON.stringify(config)}`)
    assert.deepEqual(graph.outputPorts(flow.nodes[0]).map(port => port.port), ports ?? ["next"])
  }
  const invalid = [
    ["condition", { match: "all", rules: [] }],
    ["condition", { match: "all", rules: [{ type: "origin", origin: "inventada", operator: "is" }] }],
    ["condition", { match: "all", rules: [{ type: "tag", tag_id: "", operator: "has" }] }],
    ["condition", { match: "all", rules: [{ type: "field", field_id: "number", operator: "gt", value: "10" }] }],
    ["condition", { match: "all", rules: [{ type: "field", field_id: "text", operator: "gt", value: "10" }] }],
    ["randomizer", { variations: [{ id: "a", weight: 1 }] }],
    ["randomizer", { variations: [{ id: "a", weight: 0 }, { id: "b", weight: 1 }] }],
    ["randomizer", { variations: [{ id: "a", weight: 1e308 }, { id: "b", weight: 1e308 }] }],
    ["randomizer", { variations: [{ id: "a", weight: 1 }, { id: "a", weight: 1 }] }],
    ["randomizer", { variations: Array.from({ length: 7 }, (_, i) => ({ id: `v${i}`, weight: 1 })) }],
    ["start_automation", { automation_id: "" }],
    ["start_automation", { automation_id: "current" }],
    ["start_automation", { automation_id: "unpublished" }],
    ["action", { actions: [{ type: "set_custom_field_value", field_id: "number", value: "12" }] }],
    ["action", { actions: [{ type: "set_custom_field_value", field_id: "boolean", value: "false" }] }],
    ["action", { actions: [{ type: "set_custom_field_value", field_id: "date", value: "2026-02-30" }] }],
    ["action", { actions: [{ type: "set_custom_field_value", field_id: "datetime", value: "2026-10-23T15:30" }] }],
    ["action", { actions: [{ type: "set_custom_field_value", field_id: "datetime", value: "2026-02-30T15:30:00Z" }] }],
    ["action", { actions: [{ type: "set_custom_field_value", field_id: "datetime", value: "2026-10-23T24:00:00Z" }] }],
    ["action", { actions: [{ type: "unset_custom_field_value", field_id: "missing" }] }],
  ]
  for (const [type, config] of invalid) {
    const flow = roundTrip(type, config, [])
    assert.ok(graph.validateGraph(flow.nodes, flow.edges, [], catalogs).logic?.length, `${type}: ${JSON.stringify(config)}`)
  }
})

test("publicação bloqueia porta extinta, ligação ambígua e destino removido sem normalizar as saídas do motor", () => {
  const flow = roundTrip("condition", { match: "all", rules: [{ type: "tag", tag_id: "lead", operator: "has" }] }, ["true", "false"])
  const check = edges => graph.validateGraph(flow.nodes, edges, [], { fields, automations })
  assert.deepEqual(check(flow.edges), {})
  assert.ok(check([{ ...flow.edges[0], sourceHandle: "yes" }]).logic?.length)
  assert.ok(check([{ ...flow.edges[0], target: "removed" }]).logic?.length)
  assert.ok(check([...flow.edges, { ...flow.edges[0], id: "duplicate" }]).logic?.length)
  const split = roundTrip("randomizer", { variations: [{ id: "specific-id", weight: 1 }, { id: "another-id", weight: 1 }] }, ["specific-id", "another-id"])
  split.nodes[0].data.config.variations = [{ id: "replacement-id", weight: 1 }, { id: "another-id", weight: 1 }]
  assert.ok(graph.validateGraph(split.nodes, split.edges, [], { fields, automations }).logic?.length)
})

function findElement(element, predicate) {
  if (!React.isValidElement(element)) return undefined
  if (predicate(element)) return element
  for (const child of React.Children.toArray(element.props.children)) {
    const found = findElement(child, predicate)
    if (found) return found
  }
}
const control = (tree, id) => {
  const found = findElement(tree, element => element.props.id === id)
  assert.ok(found, `Controle ${id} deve existir`)
  return found
}
function capture(Component, props) {
  let tree
  function Capture() { tree = Component(props); return tree }
  const html = renderToStaticMarkup(React.createElement(Capture))
  return { tree, html }
}
function panelDriver(Component, type, config, ports) {
  const flow = roundTrip(type, config, ports)
  const writes = [], links = []
  const props = { ...flow, node: flow.nodes[0], tags, fields, automations, automationId: "current", triggers: [],
    readOnly: false, errors: [], showErrors: false,
    updateConfig(patch) { writes.push(patch); props.node.data.config = { ...props.node.data.config, ...patch } },
    setLink(port, to) { links.push({ port, to }) }, onClose() {}, onDeleteNode() {}, onTriggerChange() {},
  }
  const render = () => capture(Component, props)
  // Os controles de operação ficam num componente filho; desce nele quando o id não está no painel.
  const deep = id => {
    const tree = render().tree
    if (findElement(tree, element => element.props.id === id)) return control(tree, id)
    const operations = findElement(tree, element => element.type === FieldOperationControls)
    assert.ok(operations, `Controle ${id} deve existir`)
    return control(capture(FieldOperationControls, operations.props).tree, id)
  }
  const choose = (id, value) => deep(id).props.onChange(value)
  const input = (id, value) => {
    let element = deep(id)
    if (element.type === FieldValue) element = control(capture(FieldValue, element.props).tree, id)
    // Choice recebe o valor selecionado; Input recebe o evento de digitação.
    element.props.onChange(element.type?.name === "Choice" ? value : { target: { value } })
  }
  const saved = () => graphSchema.parse(graph.toGraph(flow.nodes, flow.edges))
  return { flow, props, writes, links, render, choose, input, saved }
}

test("eventos reais do painel Condição persistem all/any, regra de tag e comparação numérica sem gravar ao abrir", async () => {
  const driver = panelDriver(ConditionPanel, "condition", { match: "all", rules: [{ type: "tag", tag_id: "lead", operator: "has" }], preserved: "ok" }, ["true", "false"])
  const { html } = driver.render()
  assert.match(html, /condition-match/)
  assert.deepEqual(driver.writes, [])
  driver.choose("condition-match", "any")
  driver.choose("rule-operator-0", "not_has")
  assert.equal(driver.props.node.data.config.rules[0].operator, "not_has")
  driver.choose("rule-type-0", "field")
  driver.choose("rule-field-0", "number")
  driver.choose("rule-operator-0", "gte")
  driver.input("rule-value-0", "15")
  const saved = driver.saved()
  assert.deepEqual(saved.nodes[0].config, { match: "any", rules: [{ type: "field", field_id: "number", operator: "gte", value: 15 }], preserved: "ok" })
  const reopened = graph.toFlow(saved)
  assert.deepEqual(graph.validateGraph(reopened.nodes, reopened.edges, [], { fields, automations }), {})
  assert.equal(await executor.condition(environment({ values: { number: 16 } }), run, reopened.nodes[0].data.config), "true")
})

test("painel Aleatorizador grava peso e booleano, mantém IDs das saídas e remove a ligação do caminho excluído", () => {
  const variations = [{ id: "a", weight: 1 }, { id: "b", weight: 3 }, { id: "c", weight: 2 }]
  const driver = panelDriver(RandomizerPanel, "randomizer", { variations, random_every_time: true }, ["a", "b", "c"])
  driver.render()
  assert.deepEqual(driver.writes, [])
  driver.input("variation-weight-0", "2.5")
  driver.choose("random-every-time", "false")
  assert.deepEqual(driver.saved().nodes[0].config, { variations: [{ id: "a", weight: 2.5 }, ...variations.slice(1)], random_every_time: false })
  const remove = findElement(driver.render().tree, element => element.props.onClick
    && React.Children.toArray(element.props.children).filter(child => typeof child === "string" || typeof child === "number").join("").includes("Remover caminho 3"))
  assert.ok(remove)
  remove.props.onClick()
  assert.deepEqual(driver.links, [{ port: "c", to: null }])
  assert.deepEqual(driver.saved().nodes[0].config.variations.map(v => v.id), ["a", "b"])
})

test("painel Ações converte entrada real para todos os tipos e permite limpar sem valor residual", async () => {
  const samples = { text: ["São Paulo", "São Paulo"], number: ["0", 0], boolean: ["false", false], date: ["2026-10-23", "2026-10-23"], datetime: ["2026-10-23T15:30:00-03:00", "2026-10-23T15:30:00-03:00"], array: ['["produto",2,false]', ["produto", 2, false]] }
  for (const [fieldId, [raw, expected]] of Object.entries(samples)) {
    const driver = panelDriver(ActionPanel, "action", { actions: [{ type: "add_tag", tag_id: "lead" }, { type: "remove_tag", tag_id: "lead" }] })
    driver.render()
    assert.deepEqual(driver.writes, [])
    driver.choose("act-op-0", "set_custom_field_value")
    driver.choose("act-field-0", fieldId)
    driver.input("act-value-0", raw)
    const saved = driver.saved()
    assert.deepEqual(saved.nodes[0].config.actions, [{ type: "set_custom_field_value", field_id: fieldId, value: expected }, { type: "remove_tag", tag_id: "lead" }])
    const reopened = graph.toFlow(saved)
    assert.deepEqual(graph.validateGraph(reopened.nodes, reopened.edges, [], { fields, automations }), {})
    await executor.actions(environment(), run, reopened.nodes[0].data.config)
    driver.choose("act-op-0", "unset_custom_field_value")
    assert.deepEqual(driver.saved().nodes[0].config.actions[0], { type: "unset_custom_field_value", field_id: fieldId })
    assert.equal(findElement(driver.render().tree, element => element.props.id === "act-value-0"), undefined)
    driver.choose("act-op-0", "set_custom_field_value")
    assert.deepEqual(driver.saved().nodes[0].config.actions[0].value, graph.initialFieldValue(fields.find(f => f.id === fieldId)))
  }
})

test("painel Definir campo oferece as operações de cada tipo e salva a escolhida sem valor residual", () => {
  const optionsOf = (driver, field) => {
    driver.choose("act-field-0", field)
    const operations = findElement(driver.render().tree, element => element.type === FieldOperationControls)
    const op = control(capture(FieldOperationControls, operations.props).tree, "act-fieldop-0")
    return op.props.options.map(option => option.id)
  }
  const driver = panelDriver(ActionPanel, "action", { actions: [{ type: "set_custom_field_value", field_id: "text", value: "" }] })
  assert.deepEqual(optionsOf(driver, "number"), ["set", "add", "subtract"])
  assert.deepEqual(optionsOf(driver, "text"), ["set", "clear"])
  assert.deepEqual(optionsOf(driver, "date"), ["set", "add_days", "set_now"])
  assert.deepEqual(optionsOf(driver, "datetime"), ["set", "add_days", "set_now"])
  driver.choose("act-field-0", "number")
  driver.choose("act-fieldop-0", "add")
  driver.input("act-value-0", "5")
  assert.deepEqual(driver.saved().nodes[0].config.actions, [{ type: "set_custom_field_value", field_id: "number", operation: "add", value: 5 }])
  driver.choose("act-fieldop-0", "subtract")
  assert.deepEqual(driver.saved().nodes[0].config.actions[0], { type: "set_custom_field_value", field_id: "number", operation: "subtract", value: 0 })
  driver.choose("act-fieldop-0", "set")
  assert.deepEqual(driver.saved().nodes[0].config.actions[0], { type: "set_custom_field_value", field_id: "number", value: "" })
  driver.choose("act-field-0", "date")
  driver.choose("act-fieldop-0", "set_now")
  assert.deepEqual(driver.saved().nodes[0].config.actions[0], { type: "set_custom_field_value", field_id: "date", operation: "set_now" })
  driver.choose("act-fieldop-0", "add_days")
  driver.input("act-value-0", "-3")
  assert.deepEqual(driver.saved().nodes[0].config.actions[0], { type: "set_custom_field_value", field_id: "date", operation: "add_days", value: -3 })
  driver.choose("act-field-0", "text")
  assert.deepEqual(driver.saved().nodes[0].config.actions[0], { type: "set_custom_field_value", field_id: "text", value: "" })
  driver.choose("act-fieldop-0", "clear")
  assert.deepEqual(driver.saved().nodes[0].config.actions[0], { type: "set_custom_field_value", field_id: "text", operation: "clear" })
})

test("somar aceita digitar decimais: o texto fica como foi digitado e vira número só ao salvar", () => {
  const driver = panelDriver(ActionPanel, "action", { actions: [{ type: "set_custom_field_value", field_id: "number", operation: "add", value: 0 }] })
  const shown = () => {
    const operations = findElement(driver.render().tree, element => element.type === FieldOperationControls)
    return control(capture(FieldOperationControls, operations.props).tree, "act-value-0").props.value
  }
  for (const typed of ["1", "1.", "1.5", "1,5", "-"]) {
    driver.input("act-value-0", typed)
    assert.equal(shown(), typed, `o campo deve mostrar ${typed}`)
  }
  driver.input("act-value-0", "1.")
  assert.equal(driver.saved().nodes[0].config.actions[0].value, 1)
  driver.input("act-value-0", "2.5")
  assert.equal(driver.saved().nodes[0].config.actions[0].value, 2.5)
  assert.deepEqual(graph.validateGraph(driver.flow.nodes, driver.flow.edges, [], { fields }), {})
  driver.input("act-value-0", "abc")
  assert.equal(driver.saved().nodes[0].config.actions[0].value, "abc")
  assert.ok(Object.keys(graph.validateGraph(driver.flow.nodes, driver.flow.edges, [], { fields })).length)
})

test("validação e motor aceitam as operações de campo e recusam operação fora do tipo", async () => {
  const check = actions => {
    const flow = roundTrip("action", { actions })
    return graph.validateGraph(flow.nodes, flow.edges, [], { fields })
  }
  const valid = [
    { type: "set_custom_field_value", field_id: "number", operation: "add", value: 2 },
    { type: "set_custom_field_value", field_id: "number", operation: "subtract", value: "{{campo:text|1}}" },
    { type: "set_custom_field_value", field_id: "date", operation: "add_days", value: -3 },
    { type: "set_custom_field_value", field_id: "datetime", operation: "set_now" },
    { type: "set_custom_field_value", field_id: "text", operation: "clear" },
    { type: "set_custom_field_value", field_id: "text", value: "Oi {{primeiro_nome|amigo}}" },
  ]
  assert.deepEqual(check(valid), {})
  for (const invalid of [
    { type: "set_custom_field_value", field_id: "text", operation: "add", value: 1 },
    { type: "set_custom_field_value", field_id: "number", operation: "add_days", value: 1 },
    { type: "set_custom_field_value", field_id: "number", operation: "add", value: "abc" },
    { type: "set_custom_field_value", field_id: "date", operation: "add_days", value: 1.5 },
    { type: "set_custom_field_value", field_id: "date", operation: "multiplicar", value: 1 },
  ]) assert.notDeepEqual(check([invalid]), {}, JSON.stringify(invalid))
  const env = environment()
  await executor.actions(env, run, { actions: [{ type: "set_custom_field_value", field_id: "number", operation: "add", value: 2 }, { type: "set_custom_field_value", field_id: "number", operation: "add", value: 3 }] })
  // Somar acontece no banco (uma instrução atômica por operação): o resultado está no valor final, não no argumento da escrita.
  const writes = env.writes.filter(write => /INSERT INTO contact_field_values/.test(write.sql))
  assert.equal(writes.length, 2)
  assert.equal(JSON.parse(env.db.prepare("SELECT value FROM contact_field_values WHERE field_id='number'").get().value), 5)
})

test("painel Iniciar automação salva destino publicado, preserva nome longo e mostra vazios/erro com nova tentativa", () => {
  const driver = panelDriver(StartAutomationPanel, "start_automation", { automation_id: "" })
  driver.render()
  assert.deepEqual(driver.writes, [])
  driver.choose("automation-id", "other")
  assert.deepEqual(driver.saved().nodes[0].config, { automation_id: "other" })
  driver.props.automations = [{ ...automations[0], name: "Automação de destino com um nome que alcança sessenta caracteres" }]
  assert.match(driver.render().html, /Automação de destino com um nome/)
  driver.props.automations = []
  assert.match(driver.render().html, /Nenhuma opção disponível/)
  driver.props.catalogErrors = { automations: true }
  assert.match(driver.render().html, /Não foi possível listar as automações/)
  let retries = 0
  driver.props.reloadCatalogs = () => retries++
  const errorTree = capture(CatalogNotice, { p: driver.props, kind: "automations" }).tree
  findElement(errorTree, element => element.props.onClick).props.onClick()
  assert.equal(retries, 1)
  driver.props.catalogLoading = true
  assert.match(driver.render().html, /role="status"/)
})

test("catálogo de campos consulta API real e propaga falha sem oferecer campos simulados", async () => {
  const { configureDataMode, ApiError } = await import("../../data/api.ts")
  const { listEditorFields } = await import("../../data/index.ts")
  const originalFetch = globalThis.fetch
  const calls = []
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  try {
    configureDataMode("real")
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init })
      return url === "/api/session/workspace" ? json({ workspace_id: "workspace-real", name: "Oficina" }) : json(fields)
    }
    assert.deepEqual(await listEditorFields("demo"), fields)
    assert.equal(calls[1].url, "/api/fields")
    assert.equal(calls[1].init.headers.get("x-workspace"), "workspace-real")
    globalThis.fetch = async () => json({ error: "Rota não disponível" }, 404)
    await assert.rejects(() => listEditorFields("demo"), error => error instanceof ApiError && error.status === 404)
    globalThis.fetch = async () => json([])
    assert.deepEqual(await listEditorFields("demo"), [])
  } finally {
    globalThis.fetch = originalFetch
    configureDataMode(undefined)
  }
})

test("canvas renderiza os novos nós com portas do executor e ligações equivalentes no painel por teclado", async () => {
  const { ReactFlowProvider } = await import("@xyflow/react")
  const { EditorProvider } = await import("./editor-context.tsx")
  const { nodeTypes } = await import("./nodes.tsx")
  const { NodeLinks } = await import("./panel-shared.tsx")
  const samples = [
    ["condition", { match: "all", rules: [{ type: "tag", tag_id: "lead", operator: "has" }] }, ["true", "false"]],
    ["randomizer", graph.defaultConfig("randomizer"), ["v1", "v2"]],
    ["start_automation", { automation_id: "other" }, ["next"]],
    ["action", { actions: [{ type: "set_custom_field_value", field_id: "boolean", value: false }] }, ["next"]],
  ]
  for (const [type, config, ports] of samples) {
    const { nodes } = roundTrip(type, config, ports)
    const node = nodes[0]
    const html = renderToStaticMarkup(React.createElement(ReactFlowProvider, {},
      React.createElement(EditorProvider, { value: { readOnly: false, stats: null, triggers: [], tags, fields, automations, errors: {}, showErrors: false } },
        React.createElement(nodeTypes[type], { ...node, data: node.data, selected: false }))))
    for (const port of ports) assert.ok(html.includes(`data-handleid="${port}"`), `Porta ${port} do ${type} precisa existir no canvas`)
    if (type === "condition" || type === "randomizer") assert.doesNotMatch(html, /data-handleid="next"/)
    const panel = NodeLinks({ p: { node, nodes, edges: [], readOnly: false, setLink() {} } })
    assert.deepEqual(panel.props.ports.map(p => p.port), ports)
    if (type === "start_automation") assert.match(html, /Destino publicado/)
    if (type === "action") assert.match(html, /false/)
  }
})


test("painel Condição escolhe segmento dinâmico, salva e reabre com comparação e nome", () => {
  const driver = panelDriver(ConditionPanel, "condition", { match: "all", rules: [{ type: "tag", tag_id: "lead", operator: "has" }] }, ["true", "false"])
  driver.props.segments = [{ id: "engajados", name: "Contatos engajados" }]
  driver.choose("rule-type-0", "segment")
  driver.choose("rule-segment-0", "engajados")
  driver.choose("rule-operator-0", "not_in")
  const saved = driver.saved()
  assert.deepEqual(saved.nodes[0].config.rules, [{ type: "segment", segment_id: "engajados", operator: "not_in" }])
  const reopened = panelDriver(ConditionPanel, "condition", saved.nodes[0].config, ["true", "false"])
  reopened.props.segments = driver.props.segments
  assert.match(reopened.render().html, /Contatos engajados/)
  assert.deepEqual(reopened.writes, [])
  assert.deepEqual(graph.validateGraph(reopened.flow.nodes, reopened.flow.edges, [], { segments: driver.props.segments }), {})
})

test("ações de sequência reabrem com o contrato do motor, cancelam e reinscrevem no primeiro passo", async () => {
  const env = environment()
  env.db.exec(`INSERT INTO sequences(id,workspace_id,name) VALUES ('series','workspace','Conteúdo');
    INSERT INTO sequence_steps(id,workspace_id,sequence_id,position,delay_seconds,status) VALUES ('first','workspace','series',0,60,'live');`)
  const add = roundTrip("action", { actions: [{ type: "add_to_sequence", sequence_id: "series" }] })
  const remove = roundTrip("action", { actions: [{ type: "remove_from_sequence", sequence_id: "series" }] })
  const catalogs = { sequences: [{ id: "series", name: "Conteúdo" }] }
  assert.deepEqual(graph.validateGraph(add.nodes, add.edges, [], catalogs), {})
  assert.deepEqual(graph.validateGraph(remove.nodes, remove.edges, [], catalogs), {})
  await executor.actions(env, run, add.config, 1)
  const original = env.db.prepare("SELECT * FROM sequence_subscriptions WHERE sequence_id='series'").get()
  assert.equal(original.next_step, 0)
  assert.equal(original.channel_id, "channel")
  await executor.actions(env, run, add.config, 1)
  assert.deepEqual(env.db.prepare("SELECT * FROM sequence_subscriptions WHERE sequence_id='series'").get(), original)
  await executor.actions(env, run, remove.config, 2)
  assert.equal(env.db.prepare("SELECT * FROM sequence_subscriptions WHERE sequence_id='series'").get(), undefined)
  await executor.actions(env, run, add.config, 3)
  const restarted = env.db.prepare("SELECT * FROM sequence_subscriptions WHERE sequence_id='series'").get()
  assert.notEqual(restarted.enrollment_id, original.enrollment_id)
  assert.equal(restarted.next_step, 0)
  assert.ok(Object.keys(graph.validateGraph(add.nodes, add.edges, [], { sequences: [] })).length)
})

test("ticket 21: ações de atendimento conservam contrato e impedem publicação incompleta", () => {
  const valid = [
    { type: "assign_conversation", assignee_id: "member" },
    { type: "open_conversation" }, { type: "close_conversation" },
    { type: "notify_admin", message: "Precisa de atendimento" },
    { type: "pause_automations", duration: { value: 30, unit: "minutes" } },
    { type: "subscribe_to_account", connection_id: "connection" },
    { type: "unsubscribe_to_account", connection_id: "connection" },
    { type: "delete_subscriber" }, { type: "fire_custom_event", event_name: "Compra", value: 49.9 },
    ...["instagram", "whatsapp", "email", "tiktok", "telegram"].flatMap(c => [{ type: `set_${c}_opt_in` }, { type: `set_${c}_opt_out` }]),
  ]
  for (const action of valid) {
    const flow = roundTrip("action", { actions: [action] })
    assert.deepEqual(graph.validateGraph(flow.nodes, flow.edges, []), {}, action.type)
  }
  const invalid = [
    { type: "notify_admin" }, { type: "fire_custom_event" }, { type: "pause_automations" },
    { type: "assign_conversation", assignee_id: "" },
    { type: "notify_admin", message: " " },
    { type: "pause_automations", duration: { value: 0, unit: "minutes" } },
    { type: "subscribe_to_account", connection_id: "" },
    { type: "unsubscribe_to_account", connection_id: "" },
    { type: "fire_custom_event", event_name: "" },
    { type: "fire_custom_event", event_name: "Compra", value: -1 },
  ]
  for (const action of invalid) {
    const flow = roundTrip("action", { actions: [action] })
    assert.ok(graph.validateGraph(flow.nodes, flow.edges, []).logic?.length, action.type)
  }
})


test("inscrição por canal: seletor oferece as 12 ações e cada uma descreve o que faz sem parâmetros", () => {
  for (const channel of ["instagram", "whatsapp", "email", "tiktok", "telegram"]) {
    for (const dir of ["in", "out"]) {
      const type = `set_${channel}_opt_${dir}`
      assert.match(graph.actionLabels[type], dir === "in" ? /^Inscrever no / : /^Cancelar inscrição no /, type)
      assert.deepEqual(graph.initialAction(type, { type: "open_conversation" }), { type })
      assert.equal(graph.describeAction({ type }), graph.actionLabels[type])
    }
  }
})

test("ticket 24: requisição externa só publica com endereço público, cabeçalhos e mapeamentos válidos", () => {
  const base = { type: "external_request", method: "GET", url: "https://api.exemplo.com/", headers: [], mappings: [] }
  const catalogs = { fields: [{ id: "field", name: "Plano", scope: "contact", type: "text" }] }
  const valid = [
    { ...base, method: "POST", url: "https://api.exemplo.com/clientes/{primeiro_nome}", headers: [{ name: "X-Chave", value: "abc" }], body: "{\"a\":1}", mappings: [{ path: "data.plano", field_id: "field" }] },
    base,
  ]
  for (const action of valid) {
    const flow = roundTrip("action", { actions: [action] })
    assert.deepEqual(graph.validateGraph(flow.nodes, flow.edges, [], catalogs), {}, action.url)
  }
  const invalid = [
    { ...base, url: "" }, { ...base, url: "http://127.0.0.1:8787/x" }, { ...base, url: "http://192.168.0.10/x" },
    { ...base, url: "https://{primeiro_nome}.exemplo.com/" }, { ...base, method: "TRACE" },
    { ...base, headers: [{ name: "Host", value: "x" }] }, { ...base, mappings: [{ path: "", field_id: "field" }] },
    { ...base, mappings: [{ path: "a", field_id: "field" }, { path: "b", field_id: "field" }] },
    { ...base, mappings: [{ path: "a", field_id: "outro" }] }, { ...base, url: "https://api.exemplo.com/{{campo:nao-existe|x}}" },
  ]
  for (const action of invalid) {
    const flow = roundTrip("action", { actions: [action] })
    assert.ok(graph.validateGraph(flow.nodes, flow.edges, [], catalogs).logic?.length, JSON.stringify(action))
  }
})

test("trocar espera de data incompleta para período permite publicar a duração válida", () => {
  const driver = panelDriver(DelayPanel, "smart_delay", { mode: "duration", duration: { value: 5, unit: "minutes" } })
  // O tipo de espera agora é a faixa de abas Duração/Data do painel.
  const aba = value => findElement(driver.render().tree, element => typeof element.props.onValueChange === "function" && ["duration", "date"].includes(element.props.value)).props.onValueChange(value)
  aba("date")
  aba("duration")
  assert.deepEqual(graph.validateGraph(driver.flow.nodes, driver.flow.edges, [], { fields }), {})
})
