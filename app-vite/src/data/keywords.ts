import { listAutomations } from "./index"
import { apiRequest, isFakeMode } from "./api"

// O modo real usa o workspace autenticado do transporte; o seed fica restrito ao modo fake.

export type KeywordCondition = "contains" | "equals" | "word" | "starts" | "not_contains" | "thumbs_up"
export type KeywordRule = { condition: KeywordCondition; words: string[] }
export type KeywordAudience = "direct" | "group"
export type GroupMatch = "keyword" | "mention"
/** Gatilho de grupo: a conexão do grupo, "palavra" ou "só quando mencionado", e um grupo (sem grupo = todos os da conexão). */
export type Keyword = { id: string; name: string; channel: string; automation_id: string; active: boolean; rules: KeywordRule[]; priority?: number
  audience?: KeywordAudience; group_match?: GroupMatch | null; connection_id?: string | null; group_thread_id?: string | null }
export type KeywordInput = Omit<Keyword, "id" | "priority">

export const keywordConditions: { value: KeywordCondition; label: string }[] = [
  { value: "contains", label: "Inclui o trecho" },
  { value: "equals", label: "É igual a" },
  { value: "word", label: "Inclui a palavra inteira" },
  { value: "starts", label: "Inicia com" },
  { value: "not_contains", label: "Não inclui o trecho" },
  { value: "thumbs_up", label: "Curtir (só o polegar para cima)" },
]
/** O polegar para cima sozinho, com ou sem tom de pele; no Messenger é o botão de curtir. */
export const isThumbsUp = (message: string) => /^\s*\u{1F44D}[\u{1F3FB}-\u{1F3FF}]?\uFE0F?\s*$/u.test(message)
export const keywordChannels = ["instagram", "messenger", "whatsapp", "telegram"]
const reserved = new Set(["start", "stop", "subscribe", "unsubscribe", "yes", "unstop", "cancel", "começar", "inscrever", "parar", "cancelar inscrição"])
export function reservedKeywordWords(rules: KeywordRule[]) {
  return rules.flatMap((r) => r.words).filter((word) => reserved.has(word.trim().toLocaleLowerCase("pt-BR")))
}

const stores = new Map<string, Keyword[]>()
let serial = 0
function rows(workspace: string) {
  if (!stores.has(workspace)) stores.set(workspace, workspace === "demo" ? [
    { id: "keyword-guide", name: "Entrega do guia", channel: "instagram", automation_id: "auto-quero", active: true, rules: [{ condition: "contains", words: ["guia", "material"] }, { condition: "not_contains", words: ["cancelar"] }] },
    { id: "keyword-help", name: "Atendimento para dúvidas sobre os próximos encontros da comunidade", channel: "telegram", automation_id: "auto-boas-vindas", active: false, rules: [{ condition: "word", words: ["ajuda", "dúvida"] }] },
  ] : [])
  return stores.get(workspace)!
}
export async function listKeywords(workspace: string): Promise<Keyword[]> {
  if (!isFakeMode()) return apiRequest("/keywords")
  return structuredClone(rows(workspace))
}
export async function saveKeyword(workspace: string, input: KeywordInput, id?: string): Promise<Keyword> {
  if (!isFakeMode()) {
    const { name, channel, automation_id, active, rules, audience, group_match, connection_id, group_thread_id } = input
    return apiRequest(id ? `/keywords/${encodeURIComponent(id)}` : "/keywords", {
      method: id ? "PATCH" : "POST", body: JSON.stringify({ name, channel, automation_id, active, rules, ...(audience ? { audience } : {}),
        ...(connection_id ? { connection_id } : {}),
        ...(audience === "group" ? { group_match, group_thread_id: group_thread_id || null } : {}) }),
    })
  }
  if (!input.name.trim() || !input.automation_id || !keywordChannels.includes(input.channel)) throw new Error("Informe nome, canal e automação de resposta.")
  const mention = input.audience === "group" && input.group_match === "mention"
  if (input.audience === "group" && (!input.group_match || !input.connection_id)) throw new Error("Escolha a conexão e o modo do grupo.")
  if (input.rules.length > 2) throw new Error("Use no máximo duas condições.")
  if ((!input.rules.length && !mention) || input.rules.some((rule) => !keywordConditions.some((c) => c.value === rule.condition) || (rule.condition !== "thumbs_up" && !rule.words.length) || rule.words.length > 10 || rule.words.some((word) => !word.trim()))) throw new Error("Adicione de uma a dez palavras em cada condição.")
  const automation = (await listAutomations(workspace)).find((row) => row.id === input.automation_id)
  if (!automation || input.active && !automation.published_version_id) throw new Error("Escolha uma automação com conteúdo publicado antes de ativar a regra.")
  const list = rows(workspace)
  const index = id ? list.findIndex((row) => row.id === id) : -1
  if (id && index < 0) throw new Error("A regra não está mais disponível.")
  const item = structuredClone({ ...input, name: input.name.trim(), rules: input.rules.map((rule) => ({ ...rule, words: rule.condition === "thumbs_up" ? [] : [...new Set(rule.words.map((word) => word.trim().toLocaleLowerCase("pt-BR")))] })), id: id ?? `keyword-${++serial}` })
  if (index >= 0) list[index] = item
  else list.push(item)
  return structuredClone(item)
}
export async function setKeywordActive(workspace: string, id: string, active: boolean) {
  if (!isFakeMode()) {
    await apiRequest(`/keywords/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ active }) })
    return
  }
  const item = rows(workspace).find((row) => row.id === id)
  if (!item) throw new Error("A regra não está mais disponível.")
  if (active && !(await listAutomations(workspace)).find(a => a.id === item.automation_id)?.published_version_id) {
    throw new Error("Publique a automação antes de ativar a regra.")
  }
  item.active = active
}
export async function moveKeyword(workspace: string, id: string, target: number): Promise<Keyword[]> {
  if (!isFakeMode()) return apiRequest(`/keywords/${encodeURIComponent(id)}/priority`, { method: "PATCH", body: JSON.stringify({ target }) })
  const list = rows(workspace)
  const index = list.findIndex((row) => row.id === id)
  if (index < 0 || !Number.isInteger(target) || target < 0 || target >= list.length) throw new Error("Não foi possível mudar a prioridade.")
  list.splice(target, 0, list.splice(index, 1)[0])
  return structuredClone(list)
}

export async function deleteKeyword(workspace: string, id: string): Promise<void> {
  if (!isFakeMode()) {
    await apiRequest(`/keywords/${encodeURIComponent(id)}`, { method: "DELETE" })
    return
  }
  const list = rows(workspace)
  const index = list.findIndex((row) => row.id === id)
  if (index < 0) throw new Error("A regra não está mais disponível.")
  list.splice(index, 1)
}

/** Prévia local: primeira regra ativa que casa no canal. Condições compostas usam E. */
export async function matchKeyword(workspace: string, channel: string, message: string): Promise<Keyword | null> {
  const normalize = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("pt-BR")
  const text = normalize(message)
  const matches = (rule: KeywordRule) => {
    if (rule.condition === "thumbs_up") return isThumbsUp(message)
    const hit = rule.words.some((word) => {
      const term = normalize(word)
      if (rule.condition === "equals") return text === term
      if (rule.condition === "starts") return text.startsWith(term)
      if (rule.condition === "word") {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "u").test(text)
      }
      return text.includes(term)
    })
    return rule.condition === "not_contains" ? !hit : hit
  }
  return structuredClone((await listKeywords(workspace)).find((row) => row.active && row.channel === channel && row.rules.every(matches)) ?? null)
}
