/**
 * Camada de dados das telas: engine por padrão no Vite; memória nos testes/fake.
 * Operações sem rota no engine permanecem de estudo e não representam persistência real.
 */
import * as seed from "./seed"
import { saveKeyword, type KeywordInput, type Keyword } from "./keywords"
import { fakeInboxContactExists, forgetInboxContact } from "./inbox"
import { apiRequest, ApiError, isFakeMode } from "./api"
import type {
  Automation,
  AutomationDetail,
  AutomationRow,
  AutomationStats,
  AutomationTriggerRow,
  AutomationVersion,
  Contact,
  ContactDetail,
  ContactFilter,
  ContactPage,
  ContactPatch,
  CustomField,
  Folder,
  Graph,
  Id,
  Iso,
  NodeEventType,
  NodeStats,
  Tag,
  Trigger,
  TriggerConfig,
  TriggerInput,
  TriggerKeyword,
  TriggerKeywordRule,
  TriggerState,
  TriggerRepeatMode,
  CommentPost,
} from "./types"

export type * from "./types"
export { automationIds } from "./ids"
export * from "./keywords"
export * from "./dashboard"
export * from "./sequences"
export * from "./broadcasts"

const PAGE_SIZE = 40

// Estado em memória, copiado do seed no carregamento do módulo.
const db = {
  automations: structuredClone(seed.automations),
  folders: structuredClone(seed.folders),
  versions: structuredClone(seed.automationVersions),
  triggers: structuredClone(seed.triggers),
  contacts: structuredClone(seed.contacts),
  contactTags: structuredClone(seed.contactTags),
  tags: structuredClone(seed.tags),
  fieldValues: structuredClone(seed.fieldValues),
  contactChannels: structuredClone(seed.contactChannels),
}

const nowIso = (): Iso => new Date().toISOString()
const out = <T>(v: T): T => structuredClone(v)

/** Todas as funções são async para casar com o backend real. */
async function tick() {
  await Promise.resolve()
}

// ───────── Gatilho em linguagem natural ─────────

function quote(ws: string[]) {
  return ws.map((w) => `“${w}”`).join(", ")
}

export function summarizeTrigger(t: Trigger): string {
  const c = t.config
  switch (t.type) {
    case "ig_comment": {
      const where = c.target === "all" ? "em qualquer post" : c.target === "next" ? "no próximo post" : "em um post específico"
      const kw = c.include.length ? `${quote(c.include)} ` : ""
      const not = c.exclude.length ? `, exceto ${quote(c.exclude)}` : ""
      return `Quando alguém comenta ${kw}${where}${not}`
    }
    case "ig_story_reply": {
      const words = c.words ?? []
      return `Quando alguém responde ${c.target === "specific" ? "a um story específico" : "a qualquer story"}${words.length ? ` ${c.rule === "is" ? "com exatamente" : "com"} ${quote(words)}` : ""}`
    }
    case "ig_story_mention":
      return "Quando alguém menciona você em um story"
    case "dm_keyword":
      return `Quando chega uma mensagem com ${quote(t.keywords?.flatMap(k => k.words) ?? c.include)}`
    case "hotmart": {
      const ids = Array.isArray(t.external?.product_ids) ? (t.external!.product_ids as string[]) : []
      return ids.length ? `Quando uma compra dos produtos ${ids.join(", ")} acontece` : "Quando uma compra acontece (qualquer produto)"
    }
    case "api":
      return `Quando a API dispara “${typeof t.external?.trigger_name === "string" ? t.external.trigger_name : t.name}”`
    case "ad":
      return "Quando alguém abre a conversa por um anúncio"
    case "cart_reply":
      return "Quando o contato envia um carrinho"
    case "ig_share_to_dm":
      return "Quando alguém compartilha um post ou reel no direct"
    case "welcome":
      return "Quando um contato novo manda a primeira mensagem"
    case "default_reply":
      return "Quando nenhuma palavra-chave reconhece a mensagem"
    default:
      return t.name
  }
}

// ───────── Automações ─────────

export async function listAutomations(
  workspaceId: Id,
  opts: { folder_id?: Id | null; status?: Automation["status"]; search?: string } = {}
): Promise<AutomationRow[]> {
  if (!isFakeMode()) {
    const query = new URLSearchParams()
    if (opts.folder_id !== undefined) query.set("folder_id", opts.folder_id === null ? "null" : opts.folder_id)
    if (opts.status) query.set("status", opts.status)
    if (opts.search) query.set("search", opts.search)
    return apiRequest(`/automations?${query}`)
  }
  await tick()
  const q = opts.search?.trim().toLowerCase()
  return db.automations
    .filter((a) => a.workspace_id === workspaceId && !a.deleted_at)
    .filter((a) => (opts.folder_id === undefined ? true : a.folder_id === opts.folder_id))
    .filter((a) => (opts.status ? a.status === opts.status : true))
    .filter((a) => (q ? a.name.toLowerCase().includes(q) : true))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .map((a) => {
      const trs = db.triggers.filter((t) => t.automation_id === a.id)
      const s = computeStats(a.id, 30)
      return out({
        ...a,
        trigger_summary: trs[0] ? summarizeTrigger(trs[0]) : "Sem gatilho",
        trigger_count: trs.length,
        trigger_type: trs[0]?.type ?? null,
        trigger_channel: trs[0]?.channel_type ?? null,
        runs: s.runs,
        ctr: computeCtr(s),
      })
    })
}

export async function getAutomation(workspaceId: Id, id: Id): Promise<AutomationDetail | null> {
  if (!isFakeMode()) {
    let detail: AutomationDetail
    try { detail = await apiRequest<AutomationDetail>(`/automations/${encodeURIComponent(id)}`) }
    catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error }
    return { ...detail, triggers: await listAutomationTriggers(id) }
  }
  await tick()
  const automation = db.automations.find((a) => a.id === id && a.workspace_id === workspaceId)
  if (!automation) return null
  return out({
    automation,
    triggers: await listAutomationTriggers(id),
    published_version: db.versions.find((v) => v.id === automation.published_version_id) ?? null,
  })
}

function fromEngineTrigger(t: AutomationTriggerRow): Trigger {
  const { enabled, ...rest } = t
  return { ...rest, active: enabled, config: t.config ?? { target: "all", include: [], exclude: [], public_replies: [] } }
}
export async function listAutomationTriggers(automationId: Id): Promise<Trigger[]> {
  if (!isFakeMode()) {
    const result = await apiRequest<{ rows: AutomationTriggerRow[] }>(`/automations/${encodeURIComponent(automationId)}/triggers`)
    return result.rows.map(fromEngineTrigger)
  }
  await tick()
  return out(db.triggers.filter(t => t.automation_id === automationId).map(t => t.type === "dm_keyword" ? {
    ...t, keywords: t.keywords ?? [{ id: `${t.id}-keyword`, rule: "contains" as const, words: t.config.include,
      status: "live" as const, parent_id: null, case_sensitive: false, priority: 0 }],
  } : t))
}
export async function createKeywordTrigger(automationId: Id, input: {
  name: string; connection_id: Id; node_id: string; words: string[]; rule: TriggerKeywordRule;
}): Promise<Trigger> {
  if (!isFakeMode()) return fromEngineTrigger(await apiRequest<AutomationTriggerRow>(
    `/automations/${encodeURIComponent(automationId)}/triggers`, { method: "POST", body: JSON.stringify(input) }))
  const id = crypto.randomUUID()
  const trigger: Trigger = { id, workspace_id: "demo", automation_id: automationId, channel_id: input.connection_id,
    node_id: input.node_id, name: input.name.trim(), type: "dm_keyword", active: false, state: "initial", repeat_mode: "every_time",
    config: { target: "all", include: input.words, exclude: [], public_replies: [] },
    keywords: [{ id: `${id}-keyword`, rule: input.rule, words: input.words, status: "live", parent_id: null, case_sensitive: false, priority: 0 }],
    created_at: nowIso(), updated_at: nowIso() }
  db.triggers.push(trigger)
  return out(trigger)
}
export async function createCommentTrigger(automationId: Id, input: { name: string; connection_id: Id; node_id: string }, live = false): Promise<Trigger> {
  const config: TriggerConfig = live ? { target: "live", rule: "any", words: [], include: [], exclude: [], public_replies: [] } : { target: "all", include: [], exclude: [], public_replies: [] }
  if (!isFakeMode()) return fromEngineTrigger(await apiRequest<AutomationTriggerRow>(
    `/automations/${encodeURIComponent(automationId)}/triggers`, { method: "POST", body: JSON.stringify({ ...input, type: live ? "ig_live_comment" : "ig_comment", config: live ? { ...config, target: "all" } : config }) }))
  const saved = await upsertTrigger(automationId, { name: input.name, channel_id: input.connection_id, type: live ? "ig_live_comment" : "ig_comment", config, active: false })
  const stored = db.triggers.find(t => t.id === saved.id)!
  stored.node_id = input.node_id
  return out(stored)
}
export type StoryDelay = 0 | 30 | 60 | 300 | 600
export async function createStoryTrigger(automationId: Id, input: { type: "ig_story_reply" | "ig_story_mention"; name: string; connection_id: Id; node_id: string }): Promise<Trigger> {
  const config: TriggerConfig = input.type === "ig_story_reply"
    ? { target: "all", rule: "any", words: [], include: [], exclude: [], public_replies: [] }
    : { target: "all", delay_seconds: 0, heart: false, include: [], exclude: [], public_replies: [] }
  if (!isFakeMode()) return fromEngineTrigger(await apiRequest<AutomationTriggerRow>(
    `/automations/${encodeURIComponent(automationId)}/triggers`,
    { method: "POST", body: JSON.stringify({ type: input.type, name: input.name, connection_id: input.connection_id, node_id: input.node_id,
      config: input.type === "ig_story_reply" ? { target: "all", rule: "any", words: [] } : { delay_seconds: 0, heart: false } }) }))
  const saved = await upsertTrigger(automationId, { name: input.name, channel_id: input.connection_id, type: input.type, config, active: false })
  const stored = db.triggers.find(t => t.id === saved.id)!
  stored.node_id = input.node_id; stored.state = "initial"; stored.repeat_mode = "every_time"
  return out(stored)
}
/** Link de referência (wa.me, m.me, ig.me): só existe com o motor real, porque o endereço e o código nascem lá. */
const needsEngine = () => { if (isFakeMode()) throw new Error("O link de referência precisa do motor real.") }
export async function createRefTrigger(automationId: Id, input: { name: string; connection_id: Id; node_id: string; handle: string; text?: string }): Promise<Trigger> {
  needsEngine()
  return fromEngineTrigger(await apiRequest<AutomationTriggerRow>(`/automations/${encodeURIComponent(automationId)}/triggers`,
    { method: "POST", body: JSON.stringify({ type: "ref_url", name: input.name, connection_id: input.connection_id, node_id: input.node_id,
      config: { handle: input.handle, ...(input.text?.trim() ? { text: input.text.trim() } : {}) } }) }))
}
export async function saveRefTrigger(automationId: Id, trigger: Trigger, next: { name: string; connection_id: Id; handle: string; text?: string; payload_field_id?: string | null; state: TriggerState; repeat_mode: TriggerRepeatMode }): Promise<Trigger> {
  needsEngine()
  return fromEngineTrigger(await apiRequest<AutomationTriggerRow>(`/automations/${encodeURIComponent(automationId)}/triggers/${encodeURIComponent(trigger.id)}`,
    { method: "PATCH", body: JSON.stringify({ name: next.name, connection_id: next.connection_id, state: next.state, repeat_mode: next.repeat_mode,
      config: { handle: next.handle, ...(next.text?.trim() ? { text: next.text.trim() } : {}), ...(next.payload_field_id !== undefined ? { payload_field_id: next.payload_field_id } : {}) } }) }))
}
export async function deleteRefTrigger(automationId: Id, triggerId: Id): Promise<void> {
  needsEngine()
  await apiRequest(`/automations/${encodeURIComponent(automationId)}/triggers/${encodeURIComponent(triggerId)}`, { method: "DELETE" })
}
/** Salva um gatilho de story: a resposta envia alvo e condição; a menção, atraso e coração. O estado e a política seguem o gatilho de palavra-chave. */
/** Liga ou desliga um gatilho de Hotmart, entrada externa, anúncio, direct ou carrinho (só liga com a automação publicada). */
export async function setExternalTriggerState(automationId: Id, trigger: Trigger, state: TriggerState): Promise<Trigger> {
  if (!isFakeMode()) return fromEngineTrigger(await apiRequest<AutomationTriggerRow>(
    `/automations/${encodeURIComponent(automationId)}/triggers/${encodeURIComponent(trigger.id)}`, { method: "PATCH", body: JSON.stringify({ state }) }))
  const stored = db.triggers.find(t => t.id === trigger.id)
  if (!stored) throw new Error("Gatilho não encontrado.")
  stored.state = state; stored.active = state === "active"
  return out(stored)
}
export async function saveStoryTrigger(automationId: Id, trigger: Trigger, next: { connection_id: Id; config: TriggerConfig; state: TriggerState; repeat_mode: TriggerRepeatMode }): Promise<Trigger> {
  const c = next.config
  if (!isFakeMode()) return fromEngineTrigger(await apiRequest<AutomationTriggerRow>(
    `/automations/${encodeURIComponent(automationId)}/triggers/${encodeURIComponent(trigger.id)}`,
    { method: "PATCH", body: JSON.stringify({ connection_id: next.connection_id, state: next.state, repeat_mode: next.repeat_mode,
      config: trigger.type === "ig_story_reply"
        ? { target: c.target === "specific" ? "specific" : "all", ...(c.target === "specific" ? { post_id: c.post_id, post_snapshot: c.post_snapshot } : {}), rule: c.rule ?? "any", words: c.rule === "any" ? [] : c.words ?? [], delay_seconds: c.delay_seconds ?? 0, heart: c.heart ?? false }
        : { delay_seconds: c.delay_seconds ?? 0, heart: c.heart ?? false } }) }))
  const saved = await upsertTrigger(automationId, { id: trigger.id, channel_id: next.connection_id, config: c, active: next.state === "active" })
  const stored = db.triggers.find(t => t.id === saved.id)!
  stored.state = next.state; stored.repeat_mode = next.repeat_mode
  return out(stored)
}
export async function updateKeywordTrigger(automationId: Id, triggerId: Id,
  patch: { enabled?: boolean; state?: TriggerState; repeat_mode?: TriggerRepeatMode; keyword_id?: Id; words?: string[]; rule?: TriggerKeywordRule }): Promise<Trigger> {
  if (!isFakeMode()) return fromEngineTrigger(await apiRequest<AutomationTriggerRow>(
    `/automations/${encodeURIComponent(automationId)}/triggers/${encodeURIComponent(triggerId)}`,
    { method: "PATCH", body: JSON.stringify(patch) }))
  const t = (await listAutomationTriggers(automationId)).find(t => t.id === triggerId)
  if (!t) throw new Error("Gatilho não encontrado.")
  const keyword = t.keywords?.find(k => k.id === patch.keyword_id)
  if (patch.words && ((patch.rule ?? keyword?.rule) !== "any" && !patch.words.length || patch.words.length > 10 || patch.words.some(w => !w.trim() || w.length > 500))) throw new Error("Informe até 10 palavras válidas.")
  if (patch.enabled !== undefined) { t.active = patch.enabled; t.state = patch.enabled ? "active" : "draft" }
  if (patch.state !== undefined) { t.state = patch.state; t.active = patch.state === "active" }
  if (patch.repeat_mode !== undefined) t.repeat_mode = patch.repeat_mode
  if (patch.keyword_id) {
    if (!t.keywords?.some(k => k.id === patch.keyword_id)) throw new Error("Regra não encontrada.")
    t.keywords = t.keywords.map(k => k.id === patch.keyword_id ? { ...k,
      ...(patch.words ? { words: patch.words.map(w => w.trim()) } : {}), ...(patch.rule ? { rule: patch.rule } : {}) } : k)
    t.config.include = t.keywords.flatMap(k => k.words)
  }
  t.updated_at = nowIso()
  const index = db.triggers.findIndex(x => x.id === t.id)
  db.triggers[index] = out(t)
  return out(t)
}

export async function saveDraft(id: Id, graph: Graph): Promise<{ ok: true; updated_at: Iso }> {
  if (!isFakeMode()) return apiRequest(`/automations/${encodeURIComponent(id)}/draft`, { method: "PUT", body: JSON.stringify({ graph }) })
  await tick()
  const a = mustAutomation(id)
  a.draft_graph = out(graph)
  a.has_unpublished_changes = a.published_version_id !== null
  a.updated_at = nowIso()
  return { ok: true, updated_at: a.updated_at }
}

/** Desativa o link público de compartilhamento: quem tiver o link deixa de abrir e de copiar a automação. */
export async function revokeAutomationShare(id: Id): Promise<{ revoked: number }> {
  if (!isFakeMode()) return apiRequest(`/automations/${encodeURIComponent(id)}/share`, { method: "DELETE" })
  await tick()
  mustAutomation(id)
  return { revoked: 0 }
}

export async function publishAutomation(id: Id): Promise<AutomationVersion> {
  if (!isFakeMode()) return apiRequest(`/automations/${encodeURIComponent(id)}/publish`, { method: "POST" })
  await tick()
  const a = mustAutomation(id)
  const g = a.draft_graph
  if (!g.nodes.some((n) => n.type === "trigger")) throw new Error("Falta o gatilho.")
  if (!g.nodes.some((n) => n.type === "message")) throw new Error("Falta ao menos uma mensagem.")
  const last = db.versions.filter((v) => v.automation_id === id).reduce((m, v) => Math.max(m, v.version), 0)
  const version: AutomationVersion = {
    id: `ver-${id}-${last + 1}`, automation_id: id, version: last + 1,
    graph: out(g), published_by: null, created_at: nowIso(),
  }
  db.versions.push(version)
  a.published_version_id = version.id
  a.has_unpublished_changes = false
  a.status = "live"
  a.updated_at = version.created_at
  return out(version)
}

export async function upsertTrigger(automationId: Id, input: TriggerInput): Promise<Trigger> {
  if (!isFakeMode()) {
    if (!input.id) throw new Error("Informe o gatilho que deseja editar.")
    return fromEngineTrigger(await apiRequest<AutomationTriggerRow>(
      `/automations/${encodeURIComponent(automationId)}/triggers/${encodeURIComponent(input.id)}`,
      { method: "PATCH", body: JSON.stringify({ config: input.config, connection_id: input.channel_id, enabled: input.active, name: input.name, repeat_mode: input.repeat_mode }) }))
  }
  await tick()
  mustAutomation(automationId)
  const existing = input.id ? db.triggers.find((t) => t.id === input.id) : undefined
  if (existing) {
    existing.config = out(input.config)
    if (input.name !== undefined) existing.name = input.name
    if (input.type !== undefined) existing.type = input.type
    if (input.channel_id !== undefined) {
      existing.channel_id = input.channel_id
      existing.channel_type = seed.channels.find(c => c.id === input.channel_id)?.type
    }
    if (input.active !== undefined) existing.active = input.active
    if (input.repeat_mode !== undefined) existing.repeat_mode = input.repeat_mode
    existing.updated_at = nowIso()
    return out(existing)
  }
  const n = db.triggers.filter((t) => t.automation_id === automationId).length + 1
  const t: Trigger = {
    id: `trg-${automationId}-${n}`, workspace_id: seed.WS, automation_id: automationId,
    channel_id: input.channel_id ?? seed.CH_IG, channel_type: seed.channels.find(c => c.id === (input.channel_id ?? seed.CH_IG))?.type, name: input.name ?? `Gatilho #${n}`,
    type: input.type ?? "ig_comment", config: out(input.config), active: input.active ?? true,
    created_at: nowIso(), updated_at: nowIso(),
  }
  db.triggers.push(t)
  return out(t)
}

function computeStats(automationId: Id, periodDays: number): AutomationStats {
  const since = seed.NOW - periodDays * 24 * 60 * 60_000
  const nodes: Record<string, NodeStats> = {}
  const contacts = new Set<string>()
  for (const e of seed.nodeEvents) {
    if (e.automation_id !== automationId || Date.parse(e.created_at) < since) continue
    const n = (nodes[e.node_id] ??= {})
    n[e.type as NodeEventType] = (n[e.type as NodeEventType] ?? 0) + 1
    if (e.button_id) {
      n.buttons ??= {}
      n.buttons[e.button_id] = (n.buttons[e.button_id] ?? 0) + 1
    }
    contacts.add(e.contact_id)
  }
  const runs = Object.values(nodes).reduce((m, n) => Math.max(m, n.sent ?? 0), 0)
  return { automation_id: automationId, period_days: periodDays, nodes, runs, unique_contacts: contacts.size }
}

function computeCtr(s: AutomationStats): number | null {
  let clicked = 0
  let sent = 0
  for (const n of Object.values(s.nodes)) {
    if (n.clicked) {
      clicked += n.clicked
      sent += n.sent ?? 0
    }
  }
  return sent > 0 ? clicked / sent : null
}

export async function automationStats(id: Id, periodDays = 30): Promise<AutomationStats> {
  if (!isFakeMode()) return apiRequest(`/automations/${encodeURIComponent(id)}/stats?period_days=${periodDays}`)
  await tick()
  mustAutomation(id)
  return out(computeStats(id, periodDays))
}

function mustAutomation(id: Id): Automation {
  const a = db.automations.find((x) => x.id === id)
  if (!a) throw new Error("Automação não encontrada.")
  return a
}

// ───────── Contatos ─────────

function contactMatches(c: Contact, f: ContactFilter): boolean {
  if (f.status && c.status !== f.status) return false
  if (f.search) {
    const q = f.search.trim().toLowerCase()
    if (!`${c.first_name ?? ""} ${c.last_name ?? ""}`.toLowerCase().includes(q)) return false
  }
  if (f.tag_id && !db.contactTags.some((x) => x.contact_id === c.id && x.tag_id === f.tag_id)) return false
  if (f.channel_type) {
    const ok = db.contactChannels.some((cc) => {
      if (cc.contact_id !== c.id) return false
      return seed.channels.find((ch) => ch.id === cc.channel_id)?.type === f.channel_type
    })
    if (!ok) return false
  }
  if (f.connection_id && !db.contactChannels.some((cc) => cc.contact_id === c.id && cc.channel_id === f.connection_id)) return false
  if (f.trigger_id && c.optin_source !== `trigger:${f.trigger_id}`) return false
  return true
}

/** Cursor = posição na ordenação (subscribed_at desc). Opaco para as telas. */
export type ContactFacets = { triggers: { id: Id; name: string; count: number }[]; sequences: { id: Id; name: string; count: number }[] }
/** Atalhos da lateral de contatos (por gatilho de entrada e por sequência). */
export async function getContactFacets(): Promise<ContactFacets> {
  if (isFakeMode()) return { triggers: [], sequences: [] }
  return apiRequest("/contact-facets")
}

export async function listContacts(workspaceId: Id, cursor: string | null, filter: ContactFilter = {}): Promise<ContactPage> {
  if (!isFakeMode()) {
    const query = new URLSearchParams()
    if (cursor) query.set("cursor", cursor)
    for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") query.set(key, value)
    return apiRequest(`/contacts?${query}`)
  }
  await tick()
  const all = db.contacts
    .filter((c) => c.workspace_id === workspaceId && contactMatches(c, filter))
    .sort((a, b) => b.subscribed_at.localeCompare(a.subscribed_at))
  const start = cursor ? Number(cursor) : 0
  const rows = all.slice(start, start + PAGE_SIZE)
  const end = start + rows.length
  return out({ rows, next_cursor: end < all.length ? String(end) : null, total: all.length })
}

export async function getContact(id: Id): Promise<ContactDetail | null> {
  if (!isFakeMode()) {
    try { return await apiRequest(`/contacts/${encodeURIComponent(id)}`) }
    catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error }
  }
  await tick()
  const contact = db.contacts.find((c) => c.id === id)
  if (!contact) return null
  const tagIds = new Set(db.contactTags.filter((x) => x.contact_id === id).map((x) => x.tag_id))
  return out({
    contact,
    channels: db.contactChannels
      .filter((cc) => cc.contact_id === id)
      .map((cc) => ({ ...cc, channel_type: seed.channels.find((ch) => ch.id === cc.channel_id)!.type,
        connection_name: seed.channels.find((ch) => ch.id === cc.channel_id)?.display_name, channel_fields: {}, phone_e164: null })),
    tags: db.tags.filter((t) => tagIds.has(t.id)),
    field_values: db.fieldValues.filter((v) => v.contact_id === id),
  })
}

export type ContactDeletion = { deleted_ids: Id[]; conversation_ids: Id[] }

/** Leitura do espaço e transporte seguem a mesma camada usada pelas telas. */
export async function deleteContact(workspaceId: Id, id: Id): Promise<ContactDeletion> {
  if (!isFakeMode()) {
    const result = await apiRequest<ContactDeletion>(`/contacts/${encodeURIComponent(id)}`, { method: "DELETE" })
    forgetInboxContact(workspaceId, id, result.conversation_ids)
    return result
  }
  return deleteFakeContacts(workspaceId, [id])
}

export async function bulkDeleteContacts(workspaceId: Id, ids: Id[]): Promise<ContactDeletion> {
  if (!ids.length || ids.length > 100 || ids.some(id => typeof id !== "string" || !id.trim())) {
    throw new Error("Selecione de 1 a 100 contatos para excluir.")
  }
  const unique = [...new Set(ids)]
  if (!isFakeMode()) {
    const result = await apiRequest<ContactDeletion>("/contacts/bulk-delete", { method: "POST", body: JSON.stringify({ ids: unique }) })
    result.deleted_ids.forEach(id => forgetInboxContact(workspaceId, id, result.conversation_ids))
    return result
  }
  return deleteFakeContacts(workspaceId, unique)
}

async function deleteFakeContacts(workspaceId: Id, ids: Id[]): Promise<ContactDeletion> {
  await tick()
  // Valida o lote inteiro antes de modificar a base de demonstração.
  for (const id of ids) {
    if (!db.contacts.some(c => c.id === id && c.workspace_id === workspaceId) && !fakeInboxContactExists(workspaceId, id)) {
      throw new Error("Contato não encontrado neste espaço.")
    }
  }
  const conversationIds: Id[] = []
  for (const id of ids) {
    const contact = db.contacts.find(c => c.id === id && c.workspace_id === workspaceId)
    if (contact) Object.assign(contact, {
      first_name: null, last_name: null, gender: null, locale: null, timezone: null,
      profile_pic_url: null, optin_source: null, last_input_text: null, last_interaction_at: null,
      automation_paused_until: null, status: "deleted", updated_at: nowIso(),
    })
    for (const entry of db.contactTags.filter(t => t.contact_id === id)) {
      const tag = db.tags.find(t => t.id === entry.tag_id)
      if (tag) tag.contact_count = Math.max(0, tag.contact_count - 1)
    }
    db.contactTags = db.contactTags.filter(t => t.contact_id !== id)
    db.fieldValues = db.fieldValues.filter(v => v.contact_id !== id)
    db.contactChannels = db.contactChannels.filter(c => c.contact_id !== id)
    conversationIds.push(...forgetInboxContact(workspaceId, id))
  }
  return out({ deleted_ids: ids, conversation_ids: conversationIds })
}

export async function updateContact(id: Id, patch: ContactPatch): Promise<Contact> {
  if (!isFakeMode()) return apiRequest(`/contacts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) })
  await tick()
  const c = mustContact(id)
  Object.assign(c, patch, { updated_at: nowIso() })
  return out(c)
}

/** until = null retoma as automações. */
export async function pauseContact(id: Id, until: Iso | null): Promise<Contact> {
  if (!isFakeMode()) return apiRequest(`/contacts/${encodeURIComponent(id)}/pause`, { method: "PUT", body: JSON.stringify({ until }) })
  await tick()
  const c = mustContact(id)
  c.automation_paused_until = until
  c.updated_at = nowIso()
  return out(c)
}

/** Edição individual do perfil emite evento; a operação em lote continua silenciosa. */
export async function tagContact(contactId: Id, tagId: Id, op: "add" | "remove" = "add"): Promise<unknown> {
  if (!isFakeMode()) return apiRequest(`/contacts/${encodeURIComponent(contactId)}/tags`, { method: "POST", body: JSON.stringify({ tag_id: tagId, op }) })
  return tagContacts([contactId], tagId, op)
}

export async function tagContacts(contactIds: Id[], tagId: Id, op: "add" | "remove" = "add"): Promise<{ count: number }> {
  if (!isFakeMode()) return apiRequest("/contacts/bulk-tag", { method: "POST", body: JSON.stringify({ ids: contactIds, tag_id: tagId, op }) })
  await tick()
  const tag = db.tags.find((t) => t.id === tagId)
  if (!tag) throw new Error("Tag não encontrada.")
  let count = 0
  for (const cid of contactIds) {
    const i = db.contactTags.findIndex((x) => x.contact_id === cid && x.tag_id === tagId)
    if (op === "add" && i === -1) {
      db.contactTags.push({ contact_id: cid, tag_id: tagId })
      tag.contact_count++
      count++
    } else if (op === "remove" && i !== -1) {
      db.contactTags.splice(i, 1)
      tag.contact_count--
      count++
    }
  }
  return { count }
}

function mustContact(id: Id): Contact {
  const c = db.contacts.find((x) => x.id === id)
  if (!c) throw new Error("Contato não encontrado.")
  return c
}

// ───────── Settings ─────────

export async function listTags(workspaceId: Id): Promise<Tag[]> {
  if (!isFakeMode()) return apiRequest("/tags")
  await tick()
  return out(db.tags.filter((t) => t.workspace_id === workspaceId))
}

export async function createContactTag(workspaceId: Id, name: string): Promise<Tag> {
  if (!isFakeMode()) return apiRequest("/tags", { method: "POST", body: JSON.stringify({ name }) })
  await tick()
  const clean = name.trim()
  if (!clean) throw new Error("Informe o nome da tag.")
  if (db.tags.some(t => t.workspace_id === workspaceId && t.name === clean)) throw new Error("Já existe uma tag com esse nome.")
  const tag: Tag = { id: crypto.randomUUID(), workspace_id: workspaceId, name: clean, contact_count: 0, created_at: nowIso() }
  db.tags.push(tag)
  return out(tag)
}

export async function listEditorFields(workspaceId: Id): Promise<CustomField[]> {
  if (!isFakeMode()) return apiRequest("/fields")
  return listFields(workspaceId)
}

export async function listFields(workspaceId: Id): Promise<CustomField[]> {
  if (!isFakeMode()) return apiRequest("/fields")
  await tick()
  return out(seed.fields.filter((f) => f.workspace_id === workspaceId))
}

// ───────── Adições da fatia vertical (mesmo padrão assíncrono) ─────────

export type FolderRow = Folder & { count: number }
export type IgPost = CommentPost & { posted_at?: Iso }

export async function listFolders(workspaceId: Id): Promise<{ folders: FolderRow[]; total: number; unfiled: number; trashed?: number; can_edit?: boolean }> {
  if (!isFakeMode()) return apiRequest("/folders")
  await tick()
  const live = db.automations.filter((a) => a.workspace_id === workspaceId && !a.deleted_at)
  return out({
    can_edit: true,
    folders: db.folders
      .filter((f) => f.workspace_id === workspaceId)
      .map((f) => ({ ...f, count: live.filter((a) => a.folder_id === f.id).length })),
    total: live.length,
    unfiled: live.filter((a) => a.folder_id === null).length,
    trashed: db.automations.filter(a => a.workspace_id === workspaceId && a.deleted_at).length,
  })
}

/** No motor, começa com um passo inicial sem conexão nem gatilho presumido. */
export async function createAutomation(workspaceId: Id, name = "Nova automação", folderId: Id | null = null): Promise<Automation> {
  if (!isFakeMode()) return apiRequest("/automations", { method: "POST", body: JSON.stringify({ name, folder_id: folderId }) })
  await tick()
  const id = `auto-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
  const trigId = `trg-${id}-1`
  const now = nowIso()
  db.triggers.push({
    id: trigId, workspace_id: workspaceId, automation_id: id, channel_id: seed.CH_IG, channel_type: "instagram",
    name: "Gatilho #1", type: "ig_comment",
    config: { target: "all", include: [], exclude: [], public_replies: [] },
    active: true, created_at: now, updated_at: now,
  })
  const a: Automation = {
    id, workspace_id: workspaceId, folder_id: folderId, name, status: "draft",
    draft_graph: { nodes: [{ id: "t1", type: "trigger", position: { x: 0, y: 80 }, config: { trigger_id: trigId } }], edges: [] },
    published_version_id: null, has_unpublished_changes: false, deleted_at: null, created_at: now, updated_at: now,
  }
  db.automations.push(a)
  return out(a)
}

/** Salva a entrada pausada e cria uma resposta nova antes de abrir o editor. */
export async function createKeywordAutomation(workspace: Id, input: Omit<KeywordInput, "automation_id" | "active">, keywordId?: Id): Promise<Keyword> {
  if (!isFakeMode()) {
    const { name, channel, rules, audience, group_match, connection_id, group_thread_id } = input
    return apiRequest("/keywords/automation", { method: "POST", body: JSON.stringify({ name, channel, rules, audience, group_match, connection_id, group_thread_id,
      ...(keywordId ? { keyword_id: keywordId } : {}) }) })
  }
  const automation = await createAutomation(workspace, `Resposta a ${input.name}`)
  let keyword: Keyword
  try { keyword = await saveKeyword(workspace, { ...input, automation_id: automation.id, active: false }, keywordId) }
  catch (e) {
    db.automations = db.automations.filter(a => a.id !== automation.id)
    db.triggers = db.triggers.filter(t => t.automation_id !== automation.id)
    throw e
  }
  const triggerId = `trigger-${automation.id}`
  const grouped = keyword.rules.length > 1
  const kinds = { contains: "contains", equals: "is", word: "word_match", starts: "starts_with", not_contains: "does_not_contain", thumbs_up: "thumbs_up" } as const
  const keywords: TriggerKeyword[] = keyword.rules.map((r, n) => ({ id: `${keyword.id}-${n}`, rule: kinds[r.condition], words: r.words,
    status: "draft", case_sensitive: false, parent_id: grouped ? keyword.id : null, priority: n }))
  if (!keywords.length) keywords.unshift({ id: keyword.id, rule: "any", words: [], status: "draft", case_sensitive: false, parent_id: null, priority: 0 })
  db.triggers = db.triggers.filter(t => t.automation_id !== automation.id)
  db.triggers.push({ id: triggerId, workspace_id: workspace, automation_id: automation.id, channel_id: keyword.connection_id ?? null,
    node_id: "trigger", name: keyword.name, type: "dm_keyword", active: false, state: "draft", repeat_mode: "every_time", keywords,
    audience: keyword.audience, group_match: keyword.group_match,
    config: { target: "all", include: keyword.rules.filter(r => r.condition !== "not_contains").flatMap(r => r.words),
      exclude: keyword.rules.filter(r => r.condition === "not_contains").flatMap(r => r.words), public_replies: [] }, created_at: nowIso(), updated_at: nowIso() })
  db.automations.find(a => a.id === automation.id)!.draft_graph = {
    nodes: [{ id: "trigger", type: "trigger", position: { x: 0, y: 80 }, config: { trigger_id: triggerId } }], edges: [],
  }
  return keyword
}

export async function renameAutomation(id: Id, name: string): Promise<Automation> {
  if (!isFakeMode()) return apiRequest(`/automations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) })
  await tick()
  const a = mustAutomation(id)
  a.name = name.trim() || a.name
  a.updated_at = nowIso()
  return out(a)
}

export const lockableActions = { edit: "Editar e publicar", move: "Mover de pasta", delete: "Mandar para a lixeira", restore: "Restaurar", export: "Duplicar, copiar e converter", share: "Compartilhar", purge: "Excluir de vez" } as const
export type LockableAction = keyof typeof lockableActions
export function lockedActionsOf(a: Pick<Automation, "locked" | "locked_actions">): LockableAction[] {
  if (!a.locked) return []
  const raw = a.locked_actions ? JSON.parse(a.locked_actions) as LockableAction[] : null
  return raw?.length ? raw : Object.keys(lockableActions) as LockableAction[]
}
export async function setAutomationLock(id: Id, locked: boolean, actions?: LockableAction[]): Promise<void> {
  if (!isFakeMode()) { await apiRequest(`/automations/${encodeURIComponent(id)}/lock`, { method: "POST", body: JSON.stringify({ locked, ...(locked && actions ? { actions } : {}) }) }); return }
  const a = mustAutomation(id); a.locked = locked; a.locked_actions = locked && actions ? JSON.stringify(actions) : null
}

export async function setAutomationStatus(id: Id, status: "live" | "stopped"): Promise<Automation> {
  if (!isFakeMode()) return apiRequest(`/automations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status }) })
  const a = mustAutomation(id)
  if (!a.published_version_id) throw new Error("Publique a automação antes de pausar ou retomar.")
  a.status = status
  a.updated_at = nowIso()
  return out(a)
}

export type LibraryFilter = {
  folder_id?: string | null; trash?: boolean; status?: Automation["status"]; search?: string
  trigger_type?: Trigger["type"]; trigger_status?: string
}
export type AutomationPage = { items: AutomationRow[]; next_cursor: string | null }

export async function listAutomationLibrary(workspaceId: string, filter: LibraryFilter, cursor?: string | null): Promise<AutomationPage> {
  if (!isFakeMode()) {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(filter)) if (value !== undefined) query.set(key, value === null ? "null" : String(value))
    if (cursor) query.set("cursor", cursor)
    return apiRequest(`/automation-library?${query}`)
  }
  const rows = db.automations.filter(a => a.workspace_id === workspaceId && Boolean(a.deleted_at) === Boolean(filter.trash))
    .filter(a => filter.folder_id === undefined || a.folder_id === filter.folder_id)
    .filter(a => !filter.status || a.status === filter.status)
    .filter(a => !filter.search || a.name.toLowerCase().includes(filter.search.toLowerCase()))
    .filter(a => !filter.trigger_type && !filter.trigger_status || db.triggers.some(t => t.automation_id === a.id
      && (!filter.trigger_type || t.type === filter.trigger_type)
      && (!filter.trigger_status || (t.active ? "active" : "inactive") === filter.trigger_status)))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id))
  const start = cursor ? rows.findIndex(a => a.id === cursor) + 1 : 0
  const items = rows.slice(start, start + 30).map(a => {
    const triggers = db.triggers.filter(t => t.automation_id === a.id)
    return out({ ...a, trigger_summary: triggers[0] ? summarizeTrigger(triggers[0]) : "Sem gatilho", trigger_count: triggers.length, runs: computeStats(a.id, 30).runs, ctr: computeCtr(computeStats(a.id, 30)) })
  })
  return { items, next_cursor: start + 30 < rows.length ? items.at(-1)!.id : null }
}

export async function saveFolder(workspaceId: string, input: { name?: string; parent_id?: string | null }, id?: string): Promise<Folder> {
  if (!isFakeMode()) return apiRequest(`/folders${id ? `/${encodeURIComponent(id)}` : ""}`, { method: id ? "PATCH" : "POST", body: JSON.stringify(input) })
  const existing = db.folders.find(f => f.id === id && f.workspace_id === workspaceId)
  if (id && !existing) throw new Error("Pasta não encontrada.")
  if (input.parent_id) {
    let parent = db.folders.find(f => f.id === input.parent_id && f.workspace_id === workspaceId)
    if (!parent) throw new Error("Pasta de destino não encontrada.")
    while (parent) {
      if (parent.id === id) throw new Error("Uma pasta não pode ficar dentro dela mesma.")
      parent = db.folders.find(f => f.id === parent?.parent_id)
    }
  }
  if (existing) Object.assign(existing, input)
  else db.folders.push({ id: crypto.randomUUID(), workspace_id: workspaceId, name: input.name!.trim(), parent_id: input.parent_id ?? null, created_at: nowIso() })
  return out(existing ?? db.folders.at(-1)!)
}

/** `moveItems`: automações vão para Sem pasta e subpastas sobem um nível, em vez de a exclusão ser recusada. */
export async function deleteFolder(id: string, moveItems = false): Promise<void> {
  if (!isFakeMode()) { await apiRequest(`/folders/${encodeURIComponent(id)}${moveItems ? "?move_items=1" : ""}`, { method: "DELETE" }); return }
  const folder = db.folders.find(f => f.id === id)
  const hasItems = db.automations.some(a => a.folder_id === id) || db.folders.some(f => f.parent_id === id)
  if (hasItems && !moveItems) throw new Error("A pasta ainda tem subpastas ou automações. Mova esses itens antes, ou use “Mover itens para Sem pasta e excluir”.")
  for (const a of db.automations) if (a.folder_id === id) a.folder_id = null
  for (const f of db.folders) if (f.parent_id === id) f.parent_id = folder?.parent_id ?? null
  db.folders = db.folders.filter(f => f.id !== id)
}

export async function moveAutomation(id: string, folder_id: string | null): Promise<Automation> {
  if (!isFakeMode()) return apiRequest(`/automations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ folder_id }) })
  const a = mustAutomation(id)
  a.folder_id = folder_id
  a.updated_at = nowIso()
  return out(a)
}

export async function libraryAction(id: string, action: "duplicate" | "trash" | "restore" | "delete"): Promise<unknown> {
  if (!isFakeMode()) return apiRequest(`/automations/${encodeURIComponent(id)}${action === "delete" ? "" : `/${action}`}`, { method: action === "delete" ? "DELETE" : "POST" })
  const a = mustAutomation(id)
  if (action === "duplicate") {
    const copy = out(a), triggerIds = new Map<string, string>()
    copy.id = crypto.randomUUID(); copy.name += " (cópia)"; copy.status = "draft"; copy.published_version_id = null
    copy.has_unpublished_changes = false; copy.created_at = copy.updated_at = nowIso()
    for (const t of db.triggers.filter(t => t.automation_id === id)) {
      const triggerId = crypto.randomUUID(); triggerIds.set(t.id, triggerId)
      db.triggers.push({ ...out(t), id: triggerId, automation_id: copy.id, active: false,
        keywords: t.keywords?.map(k => ({ ...out(k), status: "draft" })) })
    }
    for (const node of copy.draft_graph.nodes) if (typeof node.config.trigger_id === "string" && triggerIds.has(node.config.trigger_id)) node.config.trigger_id = triggerIds.get(node.config.trigger_id)!
    db.automations.push(copy)
    return out(copy)
  }
  if (action === "delete") { db.automations = db.automations.filter(x => x.id !== id); db.triggers = db.triggers.filter(t => t.automation_id !== id); return { ok: true } }
  a.deleted_at = action === "trash" ? nowIso() : null
  a.status = a.published_version_id ? "stopped" : "draft"
  a.updated_at = nowIso()
  for (const trigger of db.triggers.filter(t => t.automation_id === id)) trigger.active = false
  return out(a)
}

export async function listIgPosts(connectionId?: Id | null): Promise<IgPost[]> {
  if (!isFakeMode()) {
    if (!connectionId) throw new Error("Escolha uma conexão para carregar as publicações.")
    const posts: IgPost[] = [], cursors = new Set<string>()
    let after: string | null = null
    do {
      const query = after ? `?after=${encodeURIComponent(after)}` : ""
      const result: { posts: IgPost[]; nextCursor: string | null } = await apiRequest(`/connections/${encodeURIComponent(connectionId)}/posts${query}`)
      posts.push(...result.posts)
      after = result.nextCursor
      if (after && cursors.has(after)) throw new Error("Não consegui concluir a lista de publicações. Tente novamente.")
      if (after) cursors.add(after)
    } while (after)
    return posts
  }
  await tick()
  return [
    { id: "post-9001", caption: "Sorteio de aniversário: comente participo", posted_at: "2026-10-12T15:00:00Z" },
    { id: "post-9002", caption: "Bastidores da nova coleção", posted_at: "2026-10-16T13:30:00Z" },
    { id: "post-9003", caption: "Guia gratuito: comente quero", posted_at: "2026-10-20T18:10:00Z" },
  ]
}

/** Stories ativos da conta: só existem enquanto estão no ar (24 h). */
export async function listIgStories(connectionId?: Id | null): Promise<IgPost[]> {
  if (!isFakeMode()) {
    if (!connectionId) throw new Error("Escolha uma conexão para carregar os stories.")
    const stories: IgPost[] = [], cursors = new Set<string>()
    let after: string | null = null
    do {
      const query = after ? `?after=${encodeURIComponent(after)}` : ""
      const result: { posts: IgPost[]; nextCursor: string | null } = await apiRequest(`/connections/${encodeURIComponent(connectionId)}/stories${query}`)
      stories.push(...result.posts)
      after = result.nextCursor
      if (after && cursors.has(after)) throw new Error("Não consegui concluir a lista de stories. Tente novamente.")
      if (after) cursors.add(after)
    } while (after)
    return stories
  }
  await tick()
  return [{ id: "story-7001", caption: "Story de hoje: bastidores", posted_at: "2026-10-24T09:00:00Z" }, { id: "story-7002", caption: "Story: novidade da semana", posted_at: "2026-10-24T11:30:00Z" }]
}

/** value = null limpa o campo. */
export async function setFieldValue(contactId: Id, fieldId: Id, value: unknown): Promise<ContactDetail["field_values"]> {
  if (!isFakeMode()) {
    await apiRequest(`/contacts/${encodeURIComponent(contactId)}/fields/${encodeURIComponent(fieldId)}`, { method: "PUT", body: JSON.stringify({ value }) })
    return (await getContact(contactId))?.field_values ?? []
  }
  await tick()
  mustContact(contactId)
  const i = db.fieldValues.findIndex((v) => v.contact_id === contactId && v.field_id === fieldId)
  if (value === null || value === "") {
    if (i !== -1) db.fieldValues.splice(i, 1)
  } else if (i === -1) db.fieldValues.push({ contact_id: contactId, field_id: fieldId, value })
  else db.fieldValues[i].value = value
  return out(db.fieldValues.filter((v) => v.contact_id === contactId))
}

export type { TriggerConfig }

// Telas T2: dados de estudo isolados por workspace.
export * from "./insights"
export * from "./inbox"
export * from "./settings"
export * from "./connections"
export * from "./account-health"
