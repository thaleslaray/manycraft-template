import type {
  Automation,
  AutomationVersion,
  Channel,
  Contact,
  ContactChannel,
  ContactFieldValue,
  CustomField,
  Folder,
  Graph,
  NodeEvent,
  Tag,
  Trigger,
  Workspace,
} from "./types"

/** Relógio fixo: o seed é determinístico (sem hydration mismatch, prints repetíveis). */
export const NOW = Date.parse("2026-10-23T12:00:00Z")
const iso = (ms: number) => new Date(ms).toISOString()
const MIN = 60_000
const DAY = 24 * 60 * MIN

// PRNG simples (mulberry32) para dados inventados repetíveis.
function rng(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = rng(2610)
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]

export const WS = "demo"
export const CH_IG = "ch-ig"
export const CH_TG = "ch-tg"

export const workspace: Workspace = {
  id: WS,
  name: "Demo",
  timezone: "America/Sao_Paulo",
  created_at: iso(NOW - 200 * DAY),
  updated_at: iso(NOW - 2 * DAY),
}

export const channels: Channel[] = [
  { id: CH_IG, workspace_id: WS, type: "instagram", external_id: "ig-1001", display_name: "@loja.demo", status: "connected", created_at: iso(NOW - 180 * DAY), updated_at: iso(NOW - 3 * DAY) },
  { id: CH_TG, workspace_id: WS, type: "telegram", external_id: "tg-2002", display_name: "demo_bot", status: "connected", created_at: iso(NOW - 90 * DAY), updated_at: iso(NOW - 10 * DAY) },
]

export const tags: Tag[] = [
  "lead-quero", "cliente", "vip", "newsletter", "sorteio", "suporte", "evento", "frio",
].map((name, i) => ({ id: `tag-${i + 1}`, workspace_id: WS, name, contact_count: 0, created_at: iso(NOW - (150 - i * 10) * DAY) }))

export const fields: CustomField[] = [
  { id: "fld-1", workspace_id: WS, scope: "contact", name: "cidade", type: "text", description: "Cidade informada pelo contato", bot_value: null, created_at: iso(NOW - 120 * DAY) },
  { id: "fld-2", workspace_id: WS, scope: "contact", name: "idade", type: "number", description: null, bot_value: null, created_at: iso(NOW - 120 * DAY) },
  { id: "fld-3", workspace_id: WS, scope: "contact", name: "aceita_novidades", type: "boolean", description: null, bot_value: null, created_at: iso(NOW - 100 * DAY) },
  { id: "fld-4", workspace_id: WS, scope: "bot", name: "link_material", type: "text", description: "Link entregue na DM", bot_value: "https://exemplo.com/material", created_at: iso(NOW - 100 * DAY) },
]

export const folders: Folder[] = [
  { id: "fol-1", workspace_id: WS, parent_id: null, name: "Captação", created_at: iso(NOW - 90 * DAY) },
  { id: "fol-2", workspace_id: WS, parent_id: null, name: "Atendimento", created_at: iso(NOW - 60 * DAY) },
]

// ───────── Contatos (nomes inventados) ─────────

const firstNames = ["Ana", "Bruno", "Carla", "Davi", "Elisa", "Fábio", "Gisele", "Heitor", "Iara", "Joana", "Kauê", "Lívia", "Márcio", "Nina", "Otávio", "Paula", "Rafa", "Sílvia", "Tiago", "Valéria"]
const lastNames = ["Alvorada", "Brisa", "Campina", "Duarte Lima", "Estrela", "Fontana", "Granada", "Horizonte", "Itaúna", "Jacarandá", "Lacerda Neto", "Mirante", "Nogueira Prado", "Ouro Verde", "Pinhal", "Quintal", "Ribeira", "Serrano", "Tamoio", "Vargem"]
const cities = ["Campinas", "Recife", "Curitiba", "Goiânia", "Belém", "Porto Alegre", "Natal"]

export const contacts: Contact[] = []
export const contactChannels: ContactChannel[] = []
export const contactTags: { contact_id: string; tag_id: string }[] = []
export const fieldValues: ContactFieldValue[] = []

for (let i = 0; i < 120; i++) {
  const id = `ct-${String(i + 1).padStart(3, "0")}`
  const first = firstNames[i % firstNames.length]
  const last = pick(lastNames)
  const subscribed = NOW - (i * 55 + Math.floor(rand() * 40)) * MIN * (1 + Math.floor(i / 30))
  const r = rand()
  contacts.push({
    id,
    workspace_id: WS,
    first_name: first,
    last_name: last,
    gender: ["f", "m", null][Math.floor(rand() * 3)],
    locale: "pt_BR",
    timezone: "America/Sao_Paulo",
    profile_pic_url: null,
    status: r < 0.82 ? "subscribed" : "unsubscribed",
    optin_source: pick(["trigger:trg-quero", "trigger:trg-quero", "api", "import", "ad"]),
    automation_paused_until: i % 23 === 0 ? iso(NOW + 2 * DAY) : null,
    last_input_text: pick([null, "quero", "eu quero o link", "oi", "valor?"]),
    subscribed_at: iso(subscribed),
    last_interaction_at: iso(subscribed + Math.floor(rand() * 5 * DAY)),
    created_at: iso(subscribed),
    updated_at: iso(subscribed),
  })
  const onTg = rand() < 0.2
  const chId = onTg ? CH_TG : CH_IG
  contactChannels.push({
    id: `cc-${id}`,
    contact_id: id,
    channel_id: chId,
    external_user_id: `${onTg ? "tg" : "igsid"}-${100000 + i * 37}`,
    username: `${first.toLowerCase()}.${last.split(" ")[0].toLowerCase()}`,
    opted_in: contacts[i].status === "subscribed",
    window_expires_at: rand() < 0.3 ? iso(NOW + Math.floor(rand() * DAY)) : null,
    human_window_expires_at: null,
  })
  const nTags = Math.floor(rand() * 3)
  const used = new Set<string>()
  for (let k = 0; k < nTags; k++) {
    const t = pick(tags).id
    if (used.has(t)) continue
    used.add(t)
    contactTags.push({ contact_id: id, tag_id: t })
  }
  if (rand() < 0.5) fieldValues.push({ contact_id: id, field_id: "fld-1", value: pick(cities) })
  if (rand() < 0.3) fieldValues.push({ contact_id: id, field_id: "fld-2", value: 18 + Math.floor(rand() * 40) })
}
for (const t of tags) t.contact_count = contactTags.filter((x) => x.tag_id === t.id).length

// ───────── Automações ─────────

/** comenta "quero" → DM com botão → espera 2 min → segunda DM */
const graphQuero: Graph = {
  nodes: [
    { id: "t1", type: "trigger", position: { x: 0, y: 80 }, config: { trigger_id: "trg-quero" } },
    {
      id: "m1", type: "message", position: { x: 360, y: 40 },
      config: {
        channel: "instagram",
        blocks: [
          { kind: "text", text: "Oi! Toca no botão para receber o material." },
          { kind: "button", id: "b1", label: "Quero o link", action: { type: "go_to_node" } },
        ],
      },
    },
    { id: "d1", type: "smart_delay", position: { x: 760, y: 80 }, config: { duration: { value: 2, unit: "minutes" } } },
    {
      id: "m2", type: "message", position: { x: 1100, y: 40 },
      config: {
        channel: "instagram",
        blocks: [
          { kind: "text", text: "Aqui está o material:" },
          { kind: "typing", seconds: 3 },
          { kind: "button", id: "b2", label: "Abrir material", action: { type: "url", url: "https://exemplo.com/material" } },
        ],
      },
    },
  ],
  edges: [
    { from: "t1", port: "next", to: "m1" },
    { from: "m1", port: "btn:b1", to: "d1" },
    { from: "d1", port: "next", to: "m2" },
  ],
}

const simpleGraph = (text: string, trigId: string): Graph => ({
  nodes: [
    { id: "t1", type: "trigger", position: { x: 0, y: 80 }, config: { trigger_id: trigId } },
    { id: "m1", type: "message", position: { x: 360, y: 40 }, config: { channel: "instagram", blocks: [{ kind: "text", text }] } },
  ],
  edges: [{ from: "t1", port: "next", to: "m1" }],
})

const emptyGraph: Graph = { nodes: [], edges: [] }

function auto(
  id: string, name: string, folder: string | null, status: Automation["status"], graph: Graph,
  ageDays: number, unpublished = false, versionId: string | null = null
): Automation {
  return {
    id, workspace_id: WS, folder_id: folder, name, status, draft_graph: graph,
    published_version_id: versionId, has_unpublished_changes: unpublished, deleted_at: null,
    created_at: iso(NOW - (ageDays + 20) * DAY), updated_at: iso(NOW - ageDays * DAY),
  }
}

export const automations: Automation[] = [
  auto("auto-quero", "Comentou “quero”, recebe o link", "fol-1", "live", graphQuero, 1, false, "ver-quero-1"),
  auto("auto-boas-vindas", "Boas-vindas no Telegram", "fol-2", "live", simpleGraph("Olá! Bem-vindo(a).", "trg-boas-vindas"), 6, true, "ver-boas-vindas-1"),
  auto("auto-faq", "Respostas rápidas (preço, prazo)", "fol-2", "stopped", simpleGraph("Nosso prazo é de 3 dias úteis.", "trg-faq"), 14, false, "ver-faq-1"),
  auto("auto-sorteio", "Sorteio de aniversário", "fol-1", "stopped", simpleGraph("Você está participando!", "trg-sorteio"), 40, false, "ver-sorteio-1"),
  auto("auto-rascunho", "Nova ideia (sem nome)", null, "draft", emptyGraph, 0),
]

export const automationVersions: AutomationVersion[] = [
  { id: "ver-quero-1", automation_id: "auto-quero", version: 1, graph: graphQuero, published_by: null, created_at: iso(NOW - 1 * DAY) },
  { id: "ver-boas-vindas-1", automation_id: "auto-boas-vindas", version: 1, graph: simpleGraph("Olá! Bem-vindo(a).", "trg-boas-vindas"), published_by: null, created_at: iso(NOW - 8 * DAY) },
  { id: "ver-faq-1", automation_id: "auto-faq", version: 1, graph: simpleGraph("Nosso prazo é de 3 dias úteis.", "trg-faq"), published_by: null, created_at: iso(NOW - 20 * DAY) },
  { id: "ver-sorteio-1", automation_id: "auto-sorteio", version: 1, graph: simpleGraph("Você está participando!", "trg-sorteio"), published_by: null, created_at: iso(NOW - 45 * DAY) },
]

export const triggers: Trigger[] = [
  {
    id: "trg-quero", workspace_id: WS, automation_id: "auto-quero", channel_id: CH_IG, channel_type: "instagram",
    name: "Comentário em post #1", type: "ig_comment",
    config: { target: "all", include: ["quero", "eu quero"], exclude: ["cancelar"], public_replies: ["Te chamei no privado!", "Mandei um direct, dá uma olhada."] },
    active: true, created_at: iso(NOW - 21 * DAY), updated_at: iso(NOW - 1 * DAY),
  },
  {
    id: "trg-boas-vindas", workspace_id: WS, automation_id: "auto-boas-vindas", channel_id: CH_TG, channel_type: "telegram",
    name: "Boas-vindas #1", type: "welcome",
    config: { target: "all", include: [], exclude: [], public_replies: [] },
    active: true, created_at: iso(NOW - 26 * DAY), updated_at: iso(NOW - 6 * DAY),
  },
  {
    id: "trg-faq", workspace_id: WS, automation_id: "auto-faq", channel_id: CH_IG, channel_type: "instagram",
    name: "Palavra-chave #1", type: "dm_keyword",
    config: { target: "all", include: ["preço", "valor", "prazo"], exclude: [], public_replies: [] },
    active: false, created_at: iso(NOW - 34 * DAY), updated_at: iso(NOW - 14 * DAY),
  },
  {
    id: "trg-sorteio", workspace_id: WS, automation_id: "auto-sorteio", channel_id: CH_IG, channel_type: "instagram",
    name: "Comentário em post #2", type: "ig_comment",
    config: { target: "specific", post_id: "post-9001", include: ["participo"], exclude: [], public_replies: ["Boa sorte!"] },
    active: false, created_at: iso(NOW - 60 * DAY), updated_at: iso(NOW - 40 * DAY),
  },
]

// ───────── Eventos por nó (funil 84 → 29, como no fluxo estudado) ─────────

export const nodeEvents: NodeEvent[] = []
let evId = 1
function ev(automation: string, node: string, type: NodeEvent["type"], n: number, button: string | null = null) {
  for (let i = 0; i < n; i++) {
    nodeEvents.push({
      id: evId++, workspace_id: WS, automation_id: automation, node_id: node, button_id: button,
      contact_id: contacts[i % contacts.length].id, flow_run_id: null, type,
      created_at: iso(NOW - Math.floor(rand() * 6 * DAY)),
    })
  }
}
ev("auto-quero", "m1", "sent", 84); ev("auto-quero", "m1", "delivered", 84); ev("auto-quero", "m1", "read", 42)
ev("auto-quero", "m1", "clicked", 29, "b1")
ev("auto-quero", "d1", "entered", 29); ev("auto-quero", "d1", "waiting", 0); ev("auto-quero", "d1", "passed", 29)
ev("auto-quero", "m2", "sent", 29); ev("auto-quero", "m2", "delivered", 29); ev("auto-quero", "m2", "read", 22)
ev("auto-boas-vindas", "m1", "sent", 40); ev("auto-boas-vindas", "m1", "delivered", 39); ev("auto-boas-vindas", "m1", "read", 30)
ev("auto-faq", "m1", "sent", 15); ev("auto-faq", "m1", "delivered", 15)
ev("auto-sorteio", "m1", "sent", 200); ev("auto-sorteio", "m1", "delivered", 190)
